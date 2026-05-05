/**
 * Debug File Manager - Creates and manages debug run files for workflow executions
 *
 * Debug files capture execution context in a compressed format for:
 * - Debugging failed executions
 * - Attaching to PRs for context
 * - Feeding into subsequent runs
 */

import { mkdir, writeFile, readFile, readdir, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import { z } from 'zod';
import type { WorkflowContext, WorkflowMetrics } from '../core/types.js';
import { createLogger } from './logger.js';

/**
 * Schema for validating stage results from workflow execution
 */
const StageResultSchema = z
  .object({
    status: z.string().optional(),
    output: z.string().optional(),
    error: z.string().optional(),
    duration: z.number().optional(),
    agent: z.string().optional(),
  })
  .passthrough();

const logger = createLogger('debug-file-manager');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * Default debug directory for storing debug files
 */
export const DEFAULT_DEBUG_DIR = '.airunx-state/debug';

/**
 * Debug file format version
 */
const DEBUG_FILE_VERSION = '1.0.0';

/**
 * Default retention period for debug files in days
 */
export const DEFAULT_DEBUG_RETENTION_DAYS = 7;

/**
 * Debug file extension
 */
const DEBUG_FILE_EXT = '.debug.json.gz';

/**
 * Human-readable debug file extension (uncompressed)
 */
const DEBUG_FILE_EXT_READABLE = '.debug.json';

/**
 * Structure of a debug run file
 */
export interface DebugRunFile {
  // Metadata
  version: string;
  createdAt: string;
  workflowId: string;
  status: 'completed' | 'failed' | 'error';

  // Execution context
  input: {
    raw: string;
    type: string;
    title?: string;
    description?: string;
  };

  // Configuration
  config: {
    mode: string;
    fidelityLevel?: string;
    backend?: string;
    pipeline?: string;
    worktreePath?: string;
    branchName?: string;
    repoPath?: string;
  };

  // Execution results
  execution: {
    stages: StageResult[];
    iterationCount: number;
    metrics: WorkflowMetrics;
  };

  // Error information (if failed)
  error?: {
    message: string;
    stack?: string;
    stage?: string;
  };

  // Compressed logs (base64 encoded gzip of log output)
  logs?: string;

  // Summary for quick reference
  summary: {
    duration: number;
    totalTokens: number;
    totalCost: number;
    stagesCompleted: number;
    totalStages: number;
    success: boolean;
  };
}

/**
 * Stage execution result for debug file
 */
interface StageResult {
  name: string;
  agent: string;
  status: 'completed' | 'failed' | 'skipped';
  duration?: number;
  output?: string;
  error?: string;
}

/**
 * Options for creating a debug file
 */
export interface CreateDebugFileOptions {
  workflowContext: WorkflowContext;
  stageResults?: Record<string, unknown>;
  error?: Error;
  logs?: string;
  /** Execution start time for accurate duration calculation (defaults to workflowContext.createdAt) */
  executionStartTime?: Date;
}

/**
 * Debug File Manager class
 */
export class DebugFileManager {
  private debugDir: string;

  constructor(debugDir: string = DEFAULT_DEBUG_DIR) {
    this.debugDir = debugDir;
  }

  /**
   * Initialize debug directory
   */
  async initialize(): Promise<void> {
    if (!existsSync(this.debugDir)) {
      await mkdir(this.debugDir, { recursive: true });
      logger.info(`Created debug directory: ${this.debugDir}`);
    }
  }

  /**
   * Create a debug file for a workflow execution
   * Always creates a debug file whether the execution succeeded or failed
   */
  async create(
    options: CreateDebugFileOptions
  ): Promise<{ compressed: string; readable: string }> {
    await this.initialize();

    const { workflowContext, stageResults, error, logs, executionStartTime } =
      options;
    const status = error
      ? 'error'
      : workflowContext.status === 'failed'
        ? 'failed'
        : 'completed';

    // Build stage results array
    const stages: StageResult[] = [];
    if (stageResults) {
      for (const [name, result] of Object.entries(stageResults)) {
        const parseResult = StageResultSchema.safeParse(result);
        if (parseResult.success) {
          const stageResult = parseResult.data;
          stages.push({
            name,
            agent: stageResult.agent || name,
            status: ((): StageResult['status'] => {
              switch (stageResult.status) {
                case 'completed':
                  return 'completed';
                case 'failed':
                  return 'failed';
                default:
                  return 'skipped';
              }
            })(),
            duration: stageResult.duration,
            output: this.truncateString(stageResult.output, 5000),
            error: stageResult.error,
          });
        } else {
          logger.warn(
            `Could not parse stage result for stage '${name}'`,
            parseResult.error
          );
        }
      }
    }

    // Calculate summary
    const startTime = (
      executionStartTime || workflowContext.createdAt
    ).getTime();
    const endTime = Date.now();
    const duration = endTime - startTime;

    const debugFile: DebugRunFile = {
      version: DEBUG_FILE_VERSION,
      createdAt: new Date().toISOString(),
      workflowId: workflowContext.id,
      status,

      input: {
        raw: this.truncateString(workflowContext.input, 2000) || '',
        type: workflowContext.inputType,
        title: workflowContext.taskTitle,
        description: this.truncateString(workflowContext.taskDescription, 1000),
      },

      config: {
        mode: workflowContext.mode,
        fidelityLevel: workflowContext.fidelityLevel,
        backend: workflowContext.backend,
        worktreePath: workflowContext.worktreePath,
        branchName: workflowContext.branchName,
        repoPath: workflowContext.repoPath,
      },

      execution: {
        stages,
        iterationCount: workflowContext.iterationCount || 0,
        metrics: workflowContext.metrics,
      },

      summary: {
        duration,
        totalTokens:
          workflowContext.metrics.totalTokens ??
          workflowContext.metrics.tokensUsed,
        totalCost:
          workflowContext.metrics.totalCost ??
          workflowContext.metrics.actualCost ??
          0,
        stagesCompleted: workflowContext.metrics.stagesCompleted,
        totalStages: workflowContext.metrics.totalStages,
        success: status === 'completed',
      },
    };

    // Add error information if present
    if (error) {
      debugFile.error = {
        message: error.message,
        stack: error.stack,
        stage: workflowContext.currentStage,
      };
    }

    // Compress and encode logs if present
    if (logs) {
      const compressedLogs = await gzip(Buffer.from(logs, 'utf-8'));
      debugFile.logs = compressedLogs.toString('base64');
    }

    // Generate filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${workflowContext.id}-${timestamp}${DEBUG_FILE_EXT}`;
    const filepath = path.join(this.debugDir, filename);

    // Compress and write the debug file
    const jsonContent = JSON.stringify(debugFile, null, 2);
    const compressed = await gzip(Buffer.from(jsonContent, 'utf-8'));
    await writeFile(filepath, compressed);

    // Also write a human-readable version for easy inspection
    const readableFilename = `${workflowContext.id}-${timestamp}${DEBUG_FILE_EXT_READABLE}`;
    const readableFilepath = path.join(this.debugDir, readableFilename);
    await writeFile(readableFilepath, jsonContent, 'utf-8');

    logger.info(`Created debug file: ${filepath}`);
    logger.info(`Created readable debug file: ${readableFilepath}`);

    return { compressed: filepath, readable: readableFilepath };
  }

  /**
   * Read a debug file
   */
  async read(filepath: string): Promise<DebugRunFile> {
    const content = await readFile(filepath);

    // Check if compressed
    if (filepath.endsWith('.gz')) {
      const decompressed = await gunzip(content);
      return JSON.parse(decompressed.toString('utf-8'));
    }

    return JSON.parse(content.toString('utf-8'));
  }

  /**
   * List all debug files
   */
  async list(): Promise<
    Array<{
      filepath: string;
      workflowId: string;
      createdAt: Date;
      status: string;
    }>
  > {
    await this.initialize();

    const files = await readdir(this.debugDir);
    const debugFiles: Array<{
      filepath: string;
      workflowId: string;
      createdAt: Date;
      status: string;
    }> = [];

    for (const file of files) {
      // Only process compressed files (avoid duplicates with readable versions)
      if (!file.endsWith(DEBUG_FILE_EXT)) {
        continue;
      }

      const filepath = path.join(this.debugDir, file);
      try {
        const debugFile = await this.read(filepath);
        debugFiles.push({
          filepath,
          workflowId: debugFile.workflowId,
          createdAt: new Date(debugFile.createdAt),
          status: debugFile.status,
        });
      } catch (error) {
        logger.warn(`Failed to read debug file: ${file}`, error);
      }
    }

    // Sort by creation date, newest first
    return debugFiles.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );
  }

  /**
   * Get debug files for a specific workflow
   */
  async getForWorkflow(workflowId: string): Promise<string[]> {
    await this.initialize();

    const files = await readdir(this.debugDir);
    return files
      .filter(
        (file) => file.startsWith(workflowId) && file.endsWith(DEBUG_FILE_EXT)
      )
      .map((file) => path.join(this.debugDir, file));
  }

  /**
   * Get the most recent debug file for a workflow
   */
  async getMostRecent(workflowId: string): Promise<string | null> {
    const files = await this.getForWorkflow(workflowId);
    if (files.length === 0) {
      return null;
    }

    // Files are named with timestamp, so sorting alphabetically gives us chronological order
    return files.sort().reverse()[0];
  }

  /**
   * Get list of debug files older than specified days
   * Centralizes the logic for identifying old files
   */
  async getOldFiles(
    maxAgeDays: number = DEFAULT_DEBUG_RETENTION_DAYS
  ): Promise<string[]> {
    await this.initialize();

    const files = await readdir(this.debugDir);
    const cutoffTime = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const oldFiles: string[] = [];

    for (const file of files) {
      const filepath = path.join(this.debugDir, file);
      try {
        const stats = await stat(filepath);
        if (stats.mtimeMs < cutoffTime) {
          oldFiles.push(filepath);
        }
      } catch (error) {
        logger.warn(`Failed to check debug file: ${file}`, error);
      }
    }

    return oldFiles;
  }

  /**
   * Delete debug files older than specified days
   */
  async cleanupOldFiles(
    maxAgeDays: number = DEFAULT_DEBUG_RETENTION_DAYS
  ): Promise<number> {
    const oldFiles = await this.getOldFiles(maxAgeDays);

    const deletePromises = oldFiles.map(async (filepath) => {
      try {
        await rm(filepath);
        logger.debug(`Deleted old debug file: ${path.basename(filepath)}`);
        return true;
      } catch (error) {
        logger.warn(`Failed to delete debug file: ${filepath}`, error);
        return false;
      }
    });

    const results = await Promise.all(deletePromises);
    const deletedCount = results.filter(Boolean).length;

    if (deletedCount > 0) {
      logger.info(`Cleaned up ${deletedCount} old debug file(s)`);
    }

    return deletedCount;
  }

  /**
   * Delete all debug files for a specific workflow
   * Reads directory once and filters for both compressed and readable files
   */
  async deleteForWorkflow(workflowId: string): Promise<number> {
    await this.initialize();

    const allFilesInDir = await readdir(this.debugDir);

    // Filter for both compressed (.gz) and readable (.json) files in a single pass
    const filesToDelete = allFilesInDir.filter(
      (file) =>
        file.startsWith(workflowId) &&
        (file.endsWith(DEBUG_FILE_EXT) ||
          file.endsWith(DEBUG_FILE_EXT_READABLE))
    );

    const deletePromises = filesToDelete.map(async (file) => {
      const filepath = path.join(this.debugDir, file);
      try {
        await rm(filepath);
        logger.debug(`Deleted debug file: ${filepath}`);
        return true;
      } catch (error) {
        logger.warn(`Failed to delete debug file: ${filepath}`, error);
        return false;
      }
    });

    const results = await Promise.all(deletePromises);
    const deletedCount = results.filter(Boolean).length;

    return deletedCount;
  }

  /**
   * Get summary markdown for including in PR body
   */
  async getSummaryMarkdown(workflowId: string): Promise<string | null> {
    const filepath = await this.getMostRecent(workflowId);
    if (!filepath) {
      return null;
    }

    const debugFile = await this.read(filepath);

    const lines: string[] = [
      '<details>',
      '<summary>🔍 Agent Run Summary</summary>',
      '',
      `**Workflow ID:** \`${debugFile.workflowId}\``,
      `**Status:** ${debugFile.status === 'completed' ? '✅ Completed' : debugFile.status === 'failed' ? '❌ Failed' : '💥 Error'}`,
      `**Duration:** ${this.formatDuration(debugFile.summary.duration)}`,
      `**Tokens Used:** ${debugFile.summary.totalTokens.toLocaleString()}`,
      `**Cost:** $${debugFile.summary.totalCost.toFixed(4)}`,
      `**Stages:** ${debugFile.summary.stagesCompleted}/${debugFile.summary.totalStages}`,
      '',
      '**Configuration:**',
      `- Mode: ${debugFile.config.mode}`,
      `- Fidelity: ${debugFile.config.fidelityLevel || 'standard'}`,
      `- Backend: ${debugFile.config.backend || 'unknown'}`,
      '',
    ];

    if (debugFile.execution.stages.length > 0) {
      lines.push('**Stage Results:**');
      for (const stage of debugFile.execution.stages) {
        const statusIcon =
          stage.status === 'completed'
            ? '✅'
            : stage.status === 'failed'
              ? '❌'
              : '⏭️';
        lines.push(`- ${statusIcon} ${stage.name}`);
      }
      lines.push('');
    }

    if (debugFile.error) {
      lines.push('**Error:**');
      lines.push('```');
      lines.push(debugFile.error.message);
      lines.push('```');
      lines.push('');
    }

    lines.push('</details>');

    return lines.join('\n');
  }

  /**
   * Get the debug directory path
   */
  getDebugDir(): string {
    return this.debugDir;
  }

  /**
   * Format duration in human-readable format
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    }
    if (ms < 60000) {
      return `${(ms / 1000).toFixed(1)}s`;
    }
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  }

  /**
   * Truncate string to max length with ellipsis
   */
  private truncateString(
    str: string | undefined,
    maxLength: number
  ): string | undefined {
    if (!str) return str;
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - 3) + '...';
  }
}
