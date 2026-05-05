/**
 * Heartbeat Runner
 * Scheduler that polls GitHub Issues for pending tasks and dispatches each
 * to `airunx run` as an isolated child process. The heartbeat is a scheduler,
 * not an executor — all pipeline logic (worktree creation, context loading,
 * multi-provider routing) lives in the `run` command.
 */

/* eslint-disable no-undef */
import crypto from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { GitHubTaskQueue } from '../task-queue/github-task-queue.js';
import { AuditLogger } from '../audit/audit-logger.js';
import { ProcessLock, getDefaultLockPath } from './process-lock.js';
import {
  CircuitBreaker,
  getDefaultStateFilePath,
} from '../utils/circuit-breaker.js';
import { createLogger } from '../utils/logger.js';
import { getPackageRoot } from '../utils/paths.js';
import type {
  HeartbeatConfig,
  GitHubTask,
  TaskResult,
  CycleResult,
} from '../task-queue/types.js';
import type {
  ExecutionFidelityLevel,
  RunReport,
  StageRecord,
  TimelineEvent,
} from '../core/types.js';

const logger = createLogger('heartbeat-runner');

// Named constants
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_IDLE_PAUSE_MS = 60_000;
const DEFAULT_MAX_IDLE_CYCLES = 6;
const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;
const HEARTBEAT_UPDATE_INTERVAL_MS = 30_000;

// Timer reference type for Node.js
type TimerRef = ReturnType<typeof setTimeout>;

export interface HeartbeatRunnerOptions {
  repo: string;
  config?: Partial<HeartbeatConfig>;
  lockPath?: string;
  auditDir?: string;
  /** Additional CLI args forwarded to each `airunx run` invocation (e.g. --backend, --dotenv) */
  runArgs?: string[];
}

export class HeartbeatRunner {
  private taskQueue: GitHubTaskQueue | null = null;
  private auditLogger: AuditLogger;
  private circuitBreaker: CircuitBreaker;
  private processLock: ProcessLock;
  private repo: string;
  private runArgs: string[];

  private isRunning = false;
  private idleCycles = 0;
  private currentTask: GitHubTask | null = null;
  private currentWorkflowId: string | null = null;
  private currentChild: ChildProcess | null = null;
  private backoffAttempt = 0;
  private heartbeatInterval: TimerRef | null = null;

  constructor(options: HeartbeatRunnerOptions) {
    this.repo = options.repo;
    this.runArgs = options.runArgs ?? [];
    this.auditLogger = new AuditLogger(options.auditDir);
    this.circuitBreaker = new CircuitBreaker(getDefaultStateFilePath());
    this.processLock = new ProcessLock(
      options.lockPath ?? getDefaultLockPath()
    );
  }

  /**
   * Start the heartbeat execution loop.
   * Runs in foreground, blocking until stopped.
   */
  async start(config?: Partial<HeartbeatConfig>): Promise<void> {
    const fullConfig = this.resolveConfig(config);

    // Acquire process lock
    const lockResult = this.processLock.acquire();
    if (!lockResult.success) {
      throw new Error(`Cannot start heartbeat: ${lockResult.reason}`);
    }

    // Initialize task queue
    this.taskQueue = await GitHubTaskQueue.create(this.repo);

    // Warn if no GitHub token is available for child processes (PR creation)
    const hasEnvToken = !!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
    if (!hasEnvToken) {
      logger.warn(
        'No GH_TOKEN or GITHUB_TOKEN in environment. ' +
          'Child processes may not be able to create PRs.'
      );
    }

    this.isRunning = true;
    this.auditLogger.logHeartbeatStart({ config: fullConfig });

    logger.info('Heartbeat started');
    logger.info(`  Repo: ${this.repo}`);
    logger.info(`  Poll interval: ${fullConfig.intervalMs}ms`);
    logger.info(`  Default pipeline: ${fullConfig.defaultPipeline}`);
    if (fullConfig.fidelityLevel) {
      logger.info(`  Fidelity: ${fullConfig.fidelityLevel}`);
    }

    // Setup signal handlers for graceful shutdown
    this.setupSignalHandlers();

    try {
      while (this.isRunning) {
        const cycleResult = await this.runOneCycle(fullConfig);
        await this.handleCycleResult(cycleResult, fullConfig);
      }
    } finally {
      this.cleanup();
    }
  }

  /**
   * Stop the heartbeat execution loop gracefully.
   */
  async stop(): Promise<void> {
    logger.info('Stopping heartbeat...');
    this.isRunning = false;

    // Kill running child process and wait for it to exit
    if (this.currentChild && !this.currentChild.killed) {
      logger.info('Terminating running child process...');
      this.currentChild.kill('SIGTERM');
      // Wait for child to exit (spawnAirunx clears this.currentChild on close)
      const deadline = Date.now() + 10_000;
      while (this.currentChild && Date.now() < deadline) {
        await this.sleep(100);
      }
      if (this.currentChild) {
        logger.warn('Child process did not exit within 10s, sending SIGKILL');
        this.currentChild.kill('SIGKILL');
        this.currentChild = null;
      }
    }

    // Release current task if any
    if (this.currentTask && this.taskQueue) {
      try {
        await this.taskQueue.releaseTask(this.currentTask.id);
        this.auditLogger.logTaskReleased(
          this.currentWorkflowId ?? 'shutdown',
          this.currentTask.id,
          'graceful_shutdown'
        );
        this.currentWorkflowId = null;
      } catch (error) {
        logger.warn('Failed to release task during shutdown:', error);
      }
    }

    this.auditLogger.logHeartbeatStop({ reason: 'graceful_shutdown' });
  }

  /**
   * Run a single heartbeat cycle.
   * Extracted for testability.
   */
  async runOneCycle(config: HeartbeatConfig): Promise<CycleResult> {
    if (!this.taskQueue) {
      throw new Error('Task queue not initialized');
    }

    try {
      // Check circuit breaker
      if (await this.circuitBreaker.isOpen('github')) {
        this.auditLogger.logCircuitOpen('github');
        return { action: 'backoff' };
      }

      // Poll for tasks
      const tasks = await this.taskQueue.pollTasks();
      this.backoffAttempt = 0; // Reset on successful poll

      if (tasks.length === 0) {
        this.idleCycles++;
        logger.debug(
          `No pending tasks (idle cycle ${this.idleCycles}/${config.maxIdleCycles})`
        );
        return {
          action:
            this.idleCycles >= config.maxIdleCycles ? 'idle_pause' : 'wait',
        };
      }

      this.idleCycles = 0;

      // Attempt checkout (FIFO - oldest first)
      const task = tasks[0];
      logger.info(`Attempting to checkout task #${task.id}: ${task.title}`);

      const claimed = await this.taskQueue.checkoutTask(task.id);

      if (!claimed) {
        logger.info(`Lost race for task #${task.id}, will retry next cycle`);
        return { action: 'wait' };
      }

      this.currentTask = task;
      this.currentWorkflowId = this.generateWorkflowId();
      this.auditLogger.logTaskClaimed(
        this.currentWorkflowId,
        task.id,
        task.title
      );

      // Start heartbeat timestamp updates
      this.startHeartbeatUpdates(task.id);

      // Execute pipeline
      const pipeline = task.suggestedPipeline || config.defaultPipeline;
      logger.info(`Executing pipeline '${pipeline}' for task #${task.id}`);

      const result = await this.executePipeline(
        task,
        pipeline,
        config.fidelityLevel
      );

      // Stop heartbeat updates
      this.stopHeartbeatUpdates();

      // Report result
      if (result.status === 'completed') {
        // completeTask() will call failTask() internally if no PR exists
        if (!result.prUrl) {
          this.auditLogger.logTaskCompletedNoPR(
            this.currentWorkflowId!,
            task.id
          );
        }

        await this.taskQueue.completeTask(task.id, result);

        if (result.prUrl) {
          this.auditLogger.logTaskCompleted(
            this.currentWorkflowId!,
            task.id,
            result.prUrl
          );
          logger.info(`Task #${task.id} completed successfully`);
        } else {
          logger.warn(`Task #${task.id} pipeline completed but produced no PR`);
        }
      } else {
        await this.taskQueue.failTask(task.id, result);
        this.auditLogger.logTaskFailed(
          this.currentWorkflowId!,
          task.id,
          result.error?.message || 'Unknown error'
        );
        logger.warn(`Task #${task.id} failed: ${result.error?.message}`);
      }

      this.currentTask = null;
      this.currentWorkflowId = null;
      return { action: 'wait' };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.auditLogger.logHeartbeatError(error);
      this.circuitBreaker.recordFailure('github', error);
      logger.error('Heartbeat cycle error:', error);

      // Stop heartbeat updates if running
      this.stopHeartbeatUpdates();

      // Release task so it can be retried (prevents orphaned airunx:running tasks)
      if (this.currentTask && this.taskQueue) {
        logger.warn(
          `Releasing task #${this.currentTask.id} due to runner error`
        );
        await this.taskQueue
          .releaseTask(this.currentTask.id)
          .catch((releaseError) => {
            logger.error(
              `Failed to release task #${this.currentTask?.id} during error handling:`,
              releaseError
            );
          });
      }

      this.currentTask = null;
      this.currentWorkflowId = null;
      return { action: 'backoff' };
    }
  }

  /**
   * Handle the result of a cycle.
   */
  private async handleCycleResult(
    result: CycleResult,
    config: HeartbeatConfig
  ): Promise<void> {
    switch (result.action) {
      case 'wait':
        await this.sleep(config.intervalMs);
        break;
      case 'idle_pause':
        logger.info(`Entering idle pause (${config.idlePauseMs}ms)`);
        await this.sleep(config.idlePauseMs);
        this.idleCycles = 0;
        break;
      case 'backoff':
        await this.sleepWithBackoff();
        break;
    }
  }

  /**
   * Execute a task by spawning `airunx run` as an isolated child process.
   * The `run` command handles all setup: worktree creation, context loading,
   * multi-provider routing, PR automation, and cleanup. The heartbeat just
   * parses the JSON result.
   */
  private async executePipeline(
    task: GitHubTask,
    pipelineName: string,
    fidelityLevel?: ExecutionFidelityLevel
  ): Promise<TaskResult> {
    const args = [
      'run',
      task.issueUrl,
      '--pipeline',
      pipelineName,
      '--format',
      'json',
      ...this.runArgs,
    ];
    if (fidelityLevel) {
      args.push('--fidelity', fidelityLevel);
    }

    logger.info(`Spawning: airunx ${args.join(' ')} (task #${task.id})`);

    try {
      const result = await this.spawnAirunx(args);

      if (result.exitCode !== 0) {
        return {
          status: 'failed',
          summary: `airunx run exited with code ${result.exitCode} for task #${task.id}`,
          error: new Error(
            result.stderr.trim() ||
              `airunx run failed with exit code ${result.exitCode}`
          ),
        };
      }

      // Parse JSON output from --format json
      const json = this.parseJsonFromStdout(result.stdout);

      const deliverables: string[] = [];
      if (json?.commitSha) deliverables.push(`commit:${json.commitSha}`);
      if (json?.prUrl) deliverables.push(`pr:${json.prUrl}`);
      if (json?.branchName) deliverables.push(`branch:${json.branchName}`);

      const prUrl = typeof json?.prUrl === 'string' ? json.prUrl : undefined;

      const pipelineStatus =
        typeof json?.status === 'string' ? json.status : undefined;
      const isSuccess = pipelineStatus === 'completed';

      // Extract failure reason from pipeline JSON (set by CI fallback, test gate, etc.)
      const failureReason =
        typeof json?.failureReason === 'string' ? json.failureReason : null;

      // Extract metrics from pipeline JSON output
      const jsonMetrics = json?.metrics as Record<string, unknown> | undefined;
      const metrics = jsonMetrics
        ? {
            costUsd:
              typeof jsonMetrics.cost === 'number'
                ? jsonMetrics.cost
                : undefined,
            tokensUsed:
              typeof jsonMetrics.tokensUsed === 'number'
                ? jsonMetrics.tokensUsed
                : undefined,
            durationMs:
              typeof jsonMetrics.durationMs === 'number'
                ? jsonMetrics.durationMs
                : undefined,
            iterations:
              typeof jsonMetrics.iterations === 'number'
                ? jsonMetrics.iterations
                : undefined,
          }
        : undefined;

      // Build RunReport from structured stage data when available
      const runReport = this.buildRunReport(json, metrics);

      return {
        status: isSuccess ? 'completed' : 'failed',
        prUrl,
        summary: `Processed task #${task.id}`,
        deliverables,
        error: isSuccess
          ? undefined
          : new Error(
              failureReason || `Pipeline status: ${pipelineStatus ?? 'unknown'}`
            ),
        metrics,
        runReport,
      };
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      return {
        status: 'failed',
        summary: `Failed to spawn airunx run for task #${task.id}`,
        error: wrapped,
      };
    }
  }

  /**
   * Spawn `airunx` CLI as a child process and capture output.
   * Resolves the CLI entry point relative to this package using
   * cross-platform-safe path resolution (no URL.pathname).
   * Includes a configurable timeout (AIRUNX_CHILD_TIMEOUT_MS, default 150 min)
   * with SIGTERM → SIGKILL escalation to prevent hung children from blocking the daemon.
   */
  private spawnAirunx(
    args: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const CHILD_TIMEOUT_MS =
      parseInt(process.env.AIRUNX_CHILD_TIMEOUT_MS || '') || 300 * 60 * 1000;

    return new Promise((resolve, reject) => {
      const cliPath = join(getPackageRoot(), 'dist', 'cli', 'index.js');
      // NOTE: Full process.env is intentional here — this spawns airunx itself
      // (not an AI agent), so credential filtering is handled downstream by
      // the adapter's getFilteredEnv() when the actual agent CLI is spawned.
      const child = spawn(process.execPath, [cliPath, ...args], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Track child so stop() can terminate it on shutdown
      this.currentChild = child;

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // Kill child after timeout to prevent indefinite blocking
      const timer = setTimeout(() => {
        timedOut = true;
        logger.error(
          `Child process timed out after ${CHILD_TIMEOUT_MS / 60000}min, sending SIGTERM`
        );
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => {
          logger.error('Child did not exit after SIGTERM, sending SIGKILL');
          child.kill('SIGKILL');
        }, 10_000);
        child.once('close', () => clearTimeout(killTimer));
      }, CHILD_TIMEOUT_MS);

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
        // Stream stderr to the heartbeat log for real-time visibility
        const lines = data.toString().trim().split('\n');
        for (const line of lines) {
          if (line) logger.debug(`[run] ${line}`);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        this.currentChild = null;
        resolve(
          timedOut
            ? {
                exitCode: 124,
                stdout,
                stderr: stderr + '\n[PROCESS TIMED OUT]',
              }
            : { exitCode: code ?? 1, stdout, stderr }
        );
      });
    });
  }

  /**
   * Parse JSON result from `airunx run --format json` stdout.
   * With clean JSON output mode (console.log redirected to stderr),
   * stdout should contain only the JSON blob.
   */
  private parseJsonFromStdout(stdout: string): Record<string, unknown> | null {
    const trimmed = stdout.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fallback: find the last '{' to handle potential preamble pollution
      const lastBraceIndex = trimmed.lastIndexOf('{');
      if (lastBraceIndex !== -1) {
        try {
          return JSON.parse(trimmed.substring(lastBraceIndex));
        } catch {
          // Fall through to warning
        }
      }
      logger.warn(
        `Could not parse JSON from airunx run output ` +
          `(stdout=${stdout.length}B). ` +
          `First 200 chars: ${stdout.substring(0, 200).replace(/[\n\r]/g, '\\n')}`
      );
      return null;
    }
  }

  /**
   * Build a RunReport from parsed JSON output of `airunx run --format json`.
   * Returns undefined if stage records are not available.
   */
  private buildRunReport(
    json: Record<string, unknown> | null,
    metrics?: TaskResult['metrics']
  ): RunReport | undefined {
    if (!json) return undefined;

    const stageRecords = json.stageRecords as StageRecord[] | undefined;
    if (
      !stageRecords ||
      !Array.isArray(stageRecords) ||
      stageRecords.length === 0
    ) {
      return undefined;
    }

    // Build timeline from stage records
    const timeline: TimelineEvent[] = stageRecords.map((sr) => ({
      timestamp: sr.timestamp,
      event: `${sr.stage} complete (${(sr.durationMs / 1000).toFixed(1)}s)`,
      durationMs: sr.durationMs,
      details: sr.agent !== sr.stage ? sr.agent : undefined,
    }));

    return {
      workflowId: typeof json.workflowId === 'string' ? json.workflowId : '',
      taskTitle:
        typeof json.taskTitle === 'string' ? json.taskTitle : undefined,
      pipelineName:
        typeof json.pipelineName === 'string' ? json.pipelineName : undefined,
      status: typeof json.status === 'string' ? json.status : 'unknown',
      startedAt:
        typeof json.startedAt === 'string'
          ? json.startedAt
          : (stageRecords[0]?.timestamp ?? new Date().toISOString()),
      completedAt: new Date().toISOString(),
      totalDurationMs: metrics?.durationMs ?? 0,
      totalTokens: metrics?.tokensUsed ?? 0,
      totalCostUsd: metrics?.costUsd ?? 0,
      iterationCount: metrics?.iterations ?? 1,
      maxIterations:
        typeof json.maxIterations === 'number' ? json.maxIterations : 1,
      iterations: Array.isArray(json.iterationHistory)
        ? json.iterationHistory
        : [],
      stages: stageRecords,
      timeline,
    };
  }

  /**
   * Start periodic heartbeat timestamp updates.
   */
  private startHeartbeatUpdates(taskId: string): void {
    if (!this.taskQueue) return;

    this.heartbeatInterval = setInterval(async () => {
      if (this.taskQueue && this.currentTask?.id === taskId) {
        try {
          await this.taskQueue.updateHeartbeatTimestamp(taskId);
        } catch {
          // Ignore heartbeat update errors
        }
      }
    }, HEARTBEAT_UPDATE_INTERVAL_MS);
  }

  /**
   * Stop periodic heartbeat timestamp updates.
   */
  private stopHeartbeatUpdates(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Sleep with exponential backoff.
   */
  private async sleepWithBackoff(): Promise<void> {
    const jitter = Math.random() * 1000;
    const delay = Math.min(
      BASE_BACKOFF_MS * Math.pow(2, this.backoffAttempt) + jitter,
      MAX_BACKOFF_MS
    );
    this.backoffAttempt++;
    logger.debug(
      `Backing off for ${Math.round(delay)}ms (attempt ${this.backoffAttempt})`
    );
    await this.sleep(delay);
  }

  /**
   * Sleep for a duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Generate a unique workflow ID.
   */
  private generateWorkflowId(): string {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `heartbeat-${timestamp}-${random}`;
  }

  /**
   * Resolve partial config with defaults.
   */
  private resolveConfig(partial?: Partial<HeartbeatConfig>): HeartbeatConfig {
    return {
      intervalMs: partial?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      maxIdleCycles: partial?.maxIdleCycles ?? DEFAULT_MAX_IDLE_CYCLES,
      idlePauseMs: partial?.idlePauseMs ?? DEFAULT_IDLE_PAUSE_MS,
      defaultPipeline: partial?.defaultPipeline ?? 'standard',
      repo: this.repo,
      fidelityLevel: partial?.fidelityLevel,
    };
  }

  /**
   * Setup signal handlers for graceful shutdown.
   */
  private setupSignalHandlers(): void {
    const shutdown = async (): Promise<void> => {
      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  /**
   * Cleanup resources.
   */
  private cleanup(): void {
    this.stopHeartbeatUpdates();
    this.processLock.release();
    logger.info('Heartbeat cleanup complete');
  }
}
