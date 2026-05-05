/**
 * State Manager - Workflow state persistence
 * Handles saving, loading, and managing workflow state to filesystem
 */

import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import * as lockfile from 'proper-lockfile';
import type {
  WorkflowContext,
  WorkflowStatus,
  ExecutionFidelityLevel,
  PipelineStage,
  Todo,
  QualityMetrics,
  WorkflowMetrics,
} from '../core/types.js';
import type { InputType, OrchestrationMode } from '../core/types.js';
import { WorkflowContextSchema } from '../core/types.js';
import { createLogger } from '../utils/logger.js';
import { toError } from '../utils/error-handlers.js';
import { DEFAULT_STATE_DIR, LOCK_RETRY_CONFIG } from './constants.js';

const logger = createLogger('state-manager');

/**
 * State Manager class for workflow state persistence
 */
export class StateManager {
  private stateDir: string;

  constructor(stateDir: string = DEFAULT_STATE_DIR) {
    this.stateDir = stateDir;
  }

  /**
   * Initialize state directory
   */
  async initialize(): Promise<void> {
    if (!existsSync(this.stateDir)) {
      await mkdir(this.stateDir, { recursive: true });
      logger.info(`Created state directory: ${this.stateDir}`);
    }
  }

  /**
   * Save workflow state to filesystem
   */
  async save(context: WorkflowContext): Promise<void> {
    await this.initialize();

    const statePath = this.getStatePath(context.id);
    const stateData = this.serializeContext(context);

    await writeFile(statePath, JSON.stringify(stateData, null, 2), 'utf-8');
    logger.info(`Saved workflow state: ${context.id}`);
  }

  /**
   * Load workflow state from filesystem
   */
  async load(workflowId: string): Promise<WorkflowContext | null> {
    const statePath = this.getStatePath(workflowId);

    if (!existsSync(statePath)) {
      logger.warn(`State file not found: ${workflowId}`);
      return null;
    }

    try {
      const stateData = await readFile(statePath, 'utf-8');
      const parsed = JSON.parse(stateData);
      return this.deserializeContext(parsed);
    } catch (error) {
      logger.error(`Failed to load state: ${workflowId}`, toError(error));
      return null;
    }
  }

  /**
   * Clean up completed workflow state
   */
  async cleanup(workflowId: string): Promise<void> {
    const statePath = this.getStatePath(workflowId);

    if (existsSync(statePath)) {
      await rm(statePath);
      logger.info(`Cleaned up workflow state: ${workflowId}`);
    }
  }

  /**
   * Update workflow status with atomic locking
   */
  async updateStatus(
    workflowId: string,
    status: WorkflowStatus
  ): Promise<void> {
    await this.update(workflowId, (context) => ({
      ...context,
      status,
    }));
    logger.info(`Updated workflow status: ${workflowId} -> ${status}`);
  }

  /**
   * Update current stage with atomic locking
   */
  async updateCurrentStage(
    workflowId: string,
    stage: string,
    stageObj?: PipelineStage
  ): Promise<void> {
    await this.update(workflowId, (context) => ({
      ...context,
      currentStage: stage,
      currentStageObj: stageObj,
    }));
    logger.info(`Updated current stage: ${workflowId} -> ${stage}`);
  }

  /**
   * Increment iteration count with atomic locking
   */
  async incrementIteration(workflowId: string): Promise<number> {
    const updatedContext = await this.update(workflowId, (context) => ({
      ...context,
      iterationCount: (context.iterationCount || 0) + 1,
    }));
    logger.info(
      `Incremented iteration count: ${workflowId} -> ${updatedContext.iterationCount}`
    );
    return updatedContext.iterationCount ?? 0;
  }

  /**
   * Generic atomic update with file locking
   * Accepts an updater function to modify the context safely
   * Returns the updated context for methods that need access to the new state
   */
  async update(
    workflowId: string,
    updater: (context: WorkflowContext) => WorkflowContext
  ): Promise<WorkflowContext> {
    const statePath = this.getStatePath(workflowId);

    // Check if file exists before attempting to lock
    if (!existsSync(statePath)) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    let release: (() => Promise<void>) | undefined;

    try {
      // Acquire lock
      release = await lockfile.lock(statePath, {
        retries: LOCK_RETRY_CONFIG,
      });

      const context = await this.load(workflowId);
      if (!context) {
        throw new Error(
          `Failed to load workflow context for update: ${workflowId}`
        );
      }

      const newContext = updater(context);
      await this.save(newContext);
      logger.debug(`Updated workflow context for: ${workflowId}`);
      return newContext;
    } finally {
      // Release lock
      if (release) {
        await release();
      }
    }
  }

  /**
   * Update metrics with atomic locking
   */
  async updateMetrics(
    workflowId: string,
    metrics: Partial<WorkflowMetrics>
  ): Promise<void> {
    await this.update(workflowId, (context) => ({
      ...context,
      metrics: {
        ...context.metrics,
        ...metrics,
      },
    }));
    logger.debug(`Updated metrics for workflow: ${workflowId}`);
  }

  /**
   * Update todos with atomic locking
   */
  async updateTodos(workflowId: string, todos: Todo[]): Promise<void> {
    await this.update(workflowId, (context) => ({
      ...context,
      todos,
    }));
    logger.debug(`Updated todos for workflow: ${workflowId}`);
  }

  /**
   * Update quality metrics with atomic locking
   */
  async updateQualityMetrics(
    workflowId: string,
    qualityMetrics: QualityMetrics
  ): Promise<void> {
    await this.update(workflowId, (context) => ({
      ...context,
      qualityMetrics,
    }));
    logger.debug(`Updated quality metrics for workflow: ${workflowId}`);
  }

  /**
   * Get state file path
   */
  private getStatePath(workflowId: string): string {
    return path.join(this.stateDir, `${workflowId}.json`);
  }

  /**
   * Serialize workflow context for storage
   */
  private serializeContext(context: WorkflowContext): Record<string, unknown> {
    return {
      ...context,
      createdAt: context.createdAt.toISOString(),
      todos: context.todos?.map((todo) => ({
        ...todo,
        createdAt: todo.createdAt.toISOString(),
        updatedAt: todo.updatedAt.toISOString(),
      })),
    };
  }

  /**
   * Deserialize workflow context from storage using Zod schema validation.
   * The schema handles Date transformation for createdAt and todo timestamps.
   */
  private deserializeContext(data: Record<string, unknown>): WorkflowContext {
    return WorkflowContextSchema.parse(data);
  }

  /**
   * Create a new workflow context
   */
  createWorkflowContext(options: {
    id: string;
    input: string;
    inputType: InputType;
    mode: OrchestrationMode;
    fidelityLevel: ExecutionFidelityLevel;
    worktreePath?: string;
    repoPath?: string;
    branchName?: string;
    taskTitle?: string;
    taskDescription?: string;
    backend?: string;
    pipelineName?: string;
    maxIterations?: number;
    issueUrl?: string;
  }): WorkflowContext {
    return {
      id: options.id,
      input: options.input,
      inputType: options.inputType,
      mode: options.mode,
      worktreePath: options.worktreePath,
      repoPath: options.repoPath,
      branchName: options.branchName,
      createdAt: new Date(),
      status: 'initializing',
      taskTitle: options.taskTitle,
      taskDescription: options.taskDescription,
      issueUrl: options.issueUrl,
      backend: options.backend,
      pipelineName: options.pipelineName,
      fidelityLevel: options.fidelityLevel,
      iterationCount: 0,
      maxIterations: options.maxIterations,
      todos: [],
      metrics: {
        tokensUsed: 0,
        totalTokens: 0,
        runtime: 0,
        totalRuntimeMs: 0,
        stagesCompleted: 0,
        totalStages: 0,
        errors: 0,
        totalCost: 0,
      },
    };
  }
}
