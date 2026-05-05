/**
 * Script Cleanup - Comprehensive cleanup mechanism for AIRunX executions
 *
 * Handles cleanup of:
 * - Git worktrees (including orphaned ones)
 * - Debug files (with configurable retention)
 * - Workflow state files
 * - Todo files
 *
 * Designed to run at the end of every execution (success or failure)
 * and can also be invoked manually via CLI.
 */

import { rm, readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GitWorktreeManager } from '../tools/git-worktree.js';
import { DebugFileManager, DEFAULT_DEBUG_DIR } from './debug-file-manager.js';
import {
  DEFAULT_STATE_DIR,
  DEFAULT_TODO_DIR,
} from '../orchestrator/constants.js';
import { createLogger } from './logger.js';
import { WorkflowContextSchema } from '../core/types.js';

const execFileAsync = promisify(execFile);

const logger = createLogger('script-cleanup');

/**
 * Extract error message from unknown error type
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Cleanup options
 */
export interface CleanupOptions {
  /** Clean up worktrees (default: true) */
  worktrees?: boolean;
  /** Clean up debug files older than this many days (default: 7, 0 to skip) */
  debugFilesMaxAgeDays?: number;
  /** Clean up workflow state files (default: false - keep for resumability) */
  workflowState?: boolean;
  /** Clean up todo files (default: false) */
  todos?: boolean;
  /** Force cleanup even if worktree has uncommitted changes (default: false) */
  force?: boolean;
  /** Only clean up resources related to this workflow ID */
  workflowId?: string;
  /** Base path for git operations (default: cwd) */
  basePath?: string;
  /** Dry run - only report what would be cleaned up */
  dryRun?: boolean;
}

/**
 * Cleanup result summary
 */
export interface CleanupResult {
  worktreesRemoved: number;
  debugFilesRemoved: number;
  workflowStatesRemoved: number;
  todosRemoved: number;
  errors: string[];
  skipped: string[];
}

/**
 * Script Cleanup class
 */
export class ScriptCleanup {
  private basePath: string;
  private worktreeManager: GitWorktreeManager;
  private debugFileManager: DebugFileManager;

  constructor(basePath?: string) {
    this.basePath = basePath || process.cwd();
    this.worktreeManager = new GitWorktreeManager(this.basePath);
    this.debugFileManager = new DebugFileManager(
      path.join(this.basePath, DEFAULT_DEBUG_DIR)
    );
  }

  /**
   * Run comprehensive cleanup
   */
  async cleanup(options: CleanupOptions = {}): Promise<CleanupResult> {
    const {
      worktrees = true,
      debugFilesMaxAgeDays = 7,
      workflowState = false,
      todos = false,
      force = false,
      workflowId,
      dryRun = false,
    } = options;

    const result: CleanupResult = {
      worktreesRemoved: 0,
      debugFilesRemoved: 0,
      workflowStatesRemoved: 0,
      todosRemoved: 0,
      errors: [],
      skipped: [],
    };

    logger.info(`Starting cleanup${dryRun ? ' (dry run)' : ''}...`);

    // Clean up worktrees
    if (worktrees) {
      const worktreeResult = await this.cleanupWorktrees({
        workflowId,
        force,
        dryRun,
      });
      result.worktreesRemoved = worktreeResult.removed;
      result.errors.push(...worktreeResult.errors);
      result.skipped.push(...worktreeResult.skipped);
    }

    // Clean up debug files
    if (debugFilesMaxAgeDays > 0) {
      const debugResult = await this.cleanupDebugFiles({
        maxAgeDays: debugFilesMaxAgeDays,
        workflowId,
        dryRun,
      });
      result.debugFilesRemoved = debugResult.removed;
      result.errors.push(...debugResult.errors);
    }

    // Clean up workflow state files
    if (workflowState) {
      const stateResult = await this.cleanupWorkflowState({
        workflowId,
        dryRun,
      });
      result.workflowStatesRemoved = stateResult.removed;
      result.errors.push(...stateResult.errors);
    }

    // Clean up todo files
    if (todos) {
      const todoResult = await this.cleanupTodos({ dryRun });
      result.todosRemoved = todoResult.removed;
      result.errors.push(...todoResult.errors);
    }

    this.logResult(result, dryRun);
    return result;
  }

  /**
   * Clean up a specific workflow's resources
   * Used at the end of workflow execution
   */
  async cleanupWorkflow(
    workflowId: string | undefined,
    options: {
      worktreePath?: string;
      branchName?: string;
      force?: boolean;
      dryRun?: boolean;
    } = {}
  ): Promise<CleanupResult> {
    const { worktreePath, branchName, force = false, dryRun = false } = options;
    const displayId = workflowId || 'unknown-workflow';

    const result: CleanupResult = {
      worktreesRemoved: 0,
      debugFilesRemoved: 0,
      workflowStatesRemoved: 0,
      todosRemoved: 0,
      errors: [],
      skipped: [],
    };

    logger.info(
      `Cleaning up workflow: ${displayId}${dryRun ? ' (dry run)' : ''}`
    );

    // Clean up the specific worktree if provided
    if (worktreePath) {
      try {
        // Check if worktree has uncommitted changes
        const hasChanges = await this.worktreeManager.hasChanges(worktreePath);

        if (hasChanges && !force) {
          result.skipped.push(
            `Worktree ${worktreePath} has uncommitted changes`
          );
          logger.warn(
            `Skipping worktree cleanup: ${worktreePath} has uncommitted changes`
          );
        } else {
          if (!dryRun) {
            await this.worktreeManager.removeWorktree(worktreePath, force);

            // Also delete the branch if provided
            if (branchName) {
              try {
                await execFileAsync('git', ['branch', '-D', branchName], {
                  cwd: this.basePath,
                });
                logger.info(`Deleted branch: ${branchName}`);
              } catch (error) {
                // Branch might not exist or be in use - add to errors for visibility
                const branchError = `Could not delete branch ${branchName}: ${getErrorMessage(error)}`;
                result.errors.push(branchError);
                logger.warn(branchError, error);
              }
            }
          }
          result.worktreesRemoved = 1;
          logger.info(
            `${dryRun ? 'Would remove' : 'Removed'} worktree: ${worktreePath}`
          );
        }
      } catch (error) {
        const errorMsg = `Failed to remove worktree ${worktreePath}: ${getErrorMessage(error)}`;
        result.errors.push(errorMsg);
        logger.error(errorMsg, error instanceof Error ? error : undefined);
      }
    }

    // Prune stale worktrees
    try {
      if (!dryRun) {
        await this.worktreeManager.pruneWorktrees();
      }
      logger.debug('Pruned stale worktrees');
    } catch (error) {
      logger.warn(`Failed to prune worktrees`, error);
    }

    return result;
  }

  /**
   * Clean up orphan worktrees (worktrees without active workflows)
   * Only removes worktrees that are NOT associated with active/paused workflows
   */
  async cleanupOrphanWorktrees(
    options: {
      force?: boolean;
      dryRun?: boolean;
    } = {}
  ): Promise<{ removed: number; errors: string[]; skipped: string[] }> {
    const { force = false, dryRun = false } = options;
    const result = {
      removed: 0,
      errors: [] as string[],
      skipped: [] as string[],
    };

    try {
      // First, prune any stale worktree entries
      if (!dryRun) {
        await this.worktreeManager.pruneWorktrees();
      }

      // Get list of all worktrees
      const worktrees = await this.worktreeManager.listWorktrees();

      // Filter to only airunx worktrees
      const airunxWorktrees = worktrees.filter(
        (wt) =>
          wt.branch.startsWith('airunx/') || wt.path.includes('.worktrees/')
      );

      // Build set of active worktree paths from workflow state files
      const activeWorktreePaths = new Set<string>();
      const stateDir = path.join(this.basePath, DEFAULT_STATE_DIR);

      if (existsSync(stateDir)) {
        const stateFiles = (await readdir(stateDir)).filter((f) =>
          f.endsWith('.json')
        );

        await Promise.all(
          stateFiles.map(async (file) => {
            try {
              const statePath = path.join(stateDir, file);
              const stateContent = await readFile(statePath, 'utf-8');
              const workflowState = WorkflowContextSchema.parse(
                JSON.parse(stateContent)
              );
              // Only consider workflows that are not completed/failed as active
              if (
                workflowState.worktreePath &&
                workflowState.status !== 'completed' &&
                workflowState.status !== 'failed'
              ) {
                activeWorktreePaths.add(workflowState.worktreePath);
              }
            } catch (error) {
              const errorMsg = `Failed to read workflow state file ${file}: ${getErrorMessage(error)}`;
              result.errors.push(errorMsg);
              logger.warn(errorMsg, error);
            }
          })
        );
      }

      // Remove worktrees that are NOT in the set of active worktree paths
      for (const worktree of airunxWorktrees) {
        // Skip the main worktree
        if (!worktree.path.includes('.worktrees/')) {
          continue;
        }

        // Skip worktrees that belong to active workflows
        if (activeWorktreePaths.has(worktree.path)) {
          result.skipped.push(`${worktree.path} (belongs to active workflow)`);
          continue;
        }

        // Check if worktree has uncommitted changes
        const hasChanges = await this.worktreeManager.hasChanges(worktree.path);

        if (hasChanges && !force) {
          result.skipped.push(`${worktree.path} (has uncommitted changes)`);
          continue;
        }

        try {
          if (!dryRun) {
            await this.worktreeManager.removeWorktree(worktree.path, force);
          }
          result.removed++;
          logger.info(
            `${dryRun ? 'Would remove' : 'Removed'} orphan worktree: ${worktree.path}`
          );
        } catch (error) {
          result.errors.push(
            `Failed to remove ${worktree.path}: ${getErrorMessage(error)}`
          );
        }
      }
    } catch (error) {
      result.errors.push(`Failed to list worktrees: ${getErrorMessage(error)}`);
    }

    return result;
  }

  /**
   * Clean up worktrees
   */
  private async cleanupWorktrees(options: {
    workflowId?: string;
    force?: boolean;
    dryRun?: boolean;
  }): Promise<{ removed: number; errors: string[]; skipped: string[] }> {
    const { workflowId, force = false, dryRun = false } = options;

    // If a specific workflow ID is provided, look up its worktree from state
    if (workflowId) {
      const result = {
        removed: 0,
        errors: [] as string[],
        skipped: [] as string[],
      };
      const stateDir = path.join(this.basePath, DEFAULT_STATE_DIR);
      const statePath = path.join(stateDir, `${workflowId}.json`);

      if (existsSync(statePath)) {
        try {
          const stateContent = await readFile(statePath, 'utf-8');
          const workflowState = WorkflowContextSchema.parse(
            JSON.parse(stateContent)
          );

          if (workflowState.worktreePath) {
            const cleanupResult = await this.cleanupWorkflow(workflowId, {
              worktreePath: workflowState.worktreePath,
              branchName: workflowState.branchName,
              force,
              dryRun,
            });
            result.removed = cleanupResult.worktreesRemoved;
            result.errors.push(...cleanupResult.errors);
            result.skipped.push(...cleanupResult.skipped);
          } else {
            result.skipped.push(
              `Workflow ${workflowId} has no associated worktree`
            );
          }
        } catch (error) {
          result.errors.push(
            `Failed to read workflow state for ${workflowId}: ${getErrorMessage(error)}`
          );
        }
      } else {
        result.skipped.push(`Workflow state not found for ${workflowId}`);
      }

      return result;
    }

    // If no specific workflow, clean up all orphan worktrees
    return this.cleanupOrphanWorktrees({ force, dryRun });
  }

  /**
   * Clean up debug files
   */
  private async cleanupDebugFiles(options: {
    maxAgeDays: number;
    workflowId?: string;
    dryRun?: boolean;
  }): Promise<{ removed: number; errors: string[] }> {
    const { maxAgeDays, workflowId, dryRun = false } = options;
    const result = { removed: 0, errors: [] as string[] };

    try {
      if (workflowId) {
        // Clean up debug files for specific workflow
        if (!dryRun) {
          result.removed =
            await this.debugFileManager.deleteForWorkflow(workflowId);
        } else {
          const files = await this.debugFileManager.getForWorkflow(workflowId);
          result.removed = files.length;
        }
      } else {
        // Clean up old debug files - use centralized getOldFiles method
        if (!dryRun) {
          result.removed =
            await this.debugFileManager.cleanupOldFiles(maxAgeDays);
        } else {
          // For dry run, use the same logic via getOldFiles
          const oldFiles = await this.debugFileManager.getOldFiles(maxAgeDays);
          result.removed = oldFiles.length;
        }
      }
    } catch (error) {
      result.errors.push(
        `Failed to clean up debug files: ${getErrorMessage(error)}`
      );
    }

    return result;
  }

  /**
   * Clean up workflow state files
   */
  private async cleanupWorkflowState(options: {
    workflowId?: string;
    dryRun?: boolean;
  }): Promise<{ removed: number; errors: string[] }> {
    const { workflowId, dryRun = false } = options;
    const result = { removed: 0, errors: [] as string[] };

    const stateDir = path.join(this.basePath, DEFAULT_STATE_DIR);

    if (!existsSync(stateDir)) {
      return result;
    }

    try {
      if (workflowId) {
        // Clean up specific workflow state
        const statePath = path.join(stateDir, `${workflowId}.json`);
        if (existsSync(statePath)) {
          if (!dryRun) {
            await rm(statePath);
          }
          result.removed = 1;
        }
      } else {
        // Clean up all workflow states (be careful!)
        const files = await readdir(stateDir);
        for (const file of files) {
          if (file.endsWith('.json')) {
            if (!dryRun) {
              await rm(path.join(stateDir, file));
            }
            result.removed++;
          }
        }
      }
    } catch (error) {
      result.errors.push(
        `Failed to clean up workflow state: ${getErrorMessage(error)}`
      );
    }

    return result;
  }

  /**
   * Clean up todo files
   */
  private async cleanupTodos(options: {
    dryRun?: boolean;
  }): Promise<{ removed: number; errors: string[] }> {
    const { dryRun = false } = options;
    const result = { removed: 0, errors: [] as string[] };

    const todoDir = path.join(this.basePath, DEFAULT_TODO_DIR);

    if (!existsSync(todoDir)) {
      return result;
    }

    try {
      const files = await readdir(todoDir);
      for (const file of files) {
        if (!dryRun) {
          await rm(path.join(todoDir, file));
        }
        result.removed++;
      }
    } catch (error) {
      result.errors.push(`Failed to clean up todos: ${getErrorMessage(error)}`);
    }

    return result;
  }

  /**
   * Log cleanup result summary
   */
  private logResult(result: CleanupResult, dryRun: boolean): void {
    const prefix = dryRun ? 'Would clean up' : 'Cleaned up';

    const items: string[] = [];
    if (result.worktreesRemoved > 0) {
      items.push(`${result.worktreesRemoved} worktree(s)`);
    }
    if (result.debugFilesRemoved > 0) {
      items.push(`${result.debugFilesRemoved} debug file(s)`);
    }
    if (result.workflowStatesRemoved > 0) {
      items.push(`${result.workflowStatesRemoved} workflow state(s)`);
    }
    if (result.todosRemoved > 0) {
      items.push(`${result.todosRemoved} todo(s)`);
    }

    if (items.length === 0) {
      logger.info('Nothing to clean up');
    } else {
      logger.info(`${prefix}: ${items.join(', ')}`);
    }

    if (result.skipped.length > 0) {
      logger.warn(`Skipped: ${result.skipped.join(', ')}`);
    }

    if (result.errors.length > 0) {
      for (const error of result.errors) {
        logger.error(error);
      }
    }
  }

  /**
   * Get a summary of what would be cleaned up (dry run)
   */
  async getSummary(): Promise<{
    worktrees: number;
    debugFiles: number;
    workflowStates: number;
    todos: number;
  }> {
    const result = await this.cleanup({
      worktrees: true,
      debugFilesMaxAgeDays: 7,
      workflowState: true,
      todos: true,
      dryRun: true,
    });

    return {
      worktrees: result.worktreesRemoved,
      debugFiles: result.debugFilesRemoved,
      workflowStates: result.workflowStatesRemoved,
      todos: result.todosRemoved,
    };
  }
}
