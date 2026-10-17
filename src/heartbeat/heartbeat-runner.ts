/**
 * Heartbeat Runner
 * Scheduler that polls GitHub Issues for pending tasks and dispatches each
 * to `airunx run` as an isolated child process. The heartbeat is a scheduler,
 * not an executor — all pipeline logic (worktree creation, context loading,
 * multi-provider routing) lives in the `run` command.
 */

/* eslint-disable no-undef */
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
import { generateWorkflowId } from '../utils/workflow-id.js';
import { loadRunReport } from '../utils/run-report-io.js';
import { formatCostSummaryLine } from '../core/cost-accounting.js';
import type {
  HeartbeatConfig,
  GitHubTask,
  TaskResult,
  CycleResult,
} from '../task-queue/types.js';
import type {
  CostSummary,
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

/**
 * Outer grace between SIGTERM to `run` (pid only) and SIGKILL to its whole
 * process group. `run` needs ≤ ~7s: its CLI signal ladder (5s) plus writing
 * spawn events and the final run report.
 */
export const HEARTBEAT_CHILD_GRACE_MS = 15_000;

// Timer reference type for Node.js
type TimerRef = ReturnType<typeof setTimeout>;

export interface HeartbeatRunnerOptions {
  repo: string;
  config?: Partial<HeartbeatConfig>;
  lockPath?: string;
  auditDir?: string;
  /** Additional CLI args forwarded to each `airunx run` invocation (e.g. --backend, --dotenv) */
  runArgs?: string[];
  /** Override HEARTBEAT_CHILD_GRACE_MS (tests) */
  childGraceMs?: number;
}

export class HeartbeatRunner {
  private taskQueue: GitHubTaskQueue | null = null;
  private auditLogger: AuditLogger;
  private circuitBreaker: CircuitBreaker;
  private processLock: ProcessLock;
  private repo: string;
  private runArgs: string[];
  private childGraceMs: number;

  private isRunning = false;
  private idleCycles = 0;
  private currentTask: GitHubTask | null = null;
  private currentWorkflowId: string | null = null;
  private currentChild: ChildProcess | null = null;
  private backoffAttempt = 0;
  private heartbeatInterval: TimerRef | null = null;
  /** In-flight stop(); repeat stop signals share it */
  private stopPromise: Promise<void> | null = null;
  /**
   * One termination sequence per child, shared by the child timeout and
   * stop(): a second SIGTERM would make `run` abandon its graceful shutdown
   */
  private terminations = new WeakMap<ChildProcess, Promise<void>>();

  constructor(options: HeartbeatRunnerOptions) {
    this.repo = options.repo;
    this.runArgs = options.runArgs ?? [];
    this.childGraceMs = options.childGraceMs ?? HEARTBEAT_CHILD_GRACE_MS;
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
    this.stopPromise = null;
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
  stop(): Promise<void> {
    // A second SIGINT/SIGTERM must not restart (and re-signal) the stop
    if (!this.stopPromise) this.stopPromise = this.runStop();
    return this.stopPromise;
  }

  private async runStop(): Promise<void> {
    logger.info('Stopping heartbeat...');
    this.isRunning = false;

    // Terminate the running child (SIGTERM → grace → group SIGKILL) and
    // wait for it, so its final run report is on disk before we release
    if (this.currentChild) {
      logger.info('Terminating running child process...');
      await this.terminateChild(this.currentChild);
      this.currentChild = null;
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
      // Pre-generated and passed to `run --workflow-id`, so the heartbeat's
      // events share the pipeline's ID and the run report's path is known
      this.currentWorkflowId = generateWorkflowId();
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
        config.fidelityLevel,
        this.currentWorkflowId
      );
      const costDetails = taskCostDetails(result);

      // Stop heartbeat updates
      this.stopHeartbeatUpdates();

      // Report result
      if (result.status === 'completed') {
        // completeTask() will call failTask() internally if no PR exists
        if (!result.prUrl) {
          this.auditLogger.logTaskCompletedNoPR(
            this.currentWorkflowId!,
            task.id,
            costDetails
          );
        }

        await this.taskQueue.completeTask(task.id, result);

        if (result.prUrl) {
          this.auditLogger.logTaskCompleted(
            this.currentWorkflowId!,
            task.id,
            result.prUrl,
            costDetails
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
          result.error?.message || 'Unknown error',
          costDetails
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
    fidelityLevel: ExecutionFidelityLevel | undefined,
    workflowId: string
  ): Promise<TaskResult> {
    const args = [
      'run',
      task.issueUrl,
      '--pipeline',
      pipelineName,
      '--format',
      'json',
      '--workflow-id',
      workflowId,
      ...this.runArgs,
    ];
    if (fidelityLevel) {
      args.push('--fidelity', fidelityLevel);
    }

    logger.info(`Spawning: airunx ${args.join(' ')} (task #${task.id})`);

    try {
      const result = await this.spawnAirunx(args);

      // Final stdout JSON is preferred, but a killed/timed-out child leaves
      // none — fall back to the incrementally-written run report, taking
      // whichever has more stage records.
      const json = result.stdout.trim()
        ? this.parseJsonFromStdout(result.stdout)
        : null;
      const jsonMetrics = this.metricsFromJson(json);
      const jsonReport = this.buildRunReport(json, jsonMetrics);
      const fileReport = this.readRunReportFile(workflowId);
      const useFile =
        fileReport !== undefined &&
        fileReport.stages.length > (jsonReport?.stages.length ?? 0);
      const runReport = useFile ? fileReport : jsonReport;
      const metrics =
        useFile && fileReport
          ? this.metricsFromReport(fileReport)
          : (jsonMetrics ??
            (fileReport ? this.metricsFromReport(fileReport) : undefined));

      if (result.exitCode !== 0) {
        return {
          status: 'failed',
          summary: `airunx run exited with code ${result.exitCode} for task #${task.id}`,
          error: new Error(
            result.stderr.trim() ||
              `airunx run failed with exit code ${result.exitCode}`
          ),
          metrics,
          runReport,
        };
      }

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
   * Stop a `run` child: SIGTERM to its pid only (run interrupts its own CLIs
   * once), wait up to the outer grace for it to exit, then SIGKILL its whole
   * process group — always, so a CLI that outlived run is reaped too.
   * Resolves once the group kill has been sent. Never rejects. Repeat calls
   * for the same child (timeout, then stop) share the first sequence.
   */
  private terminateChild(child: ChildProcess): Promise<void> {
    let termination = this.terminations.get(child);
    if (!termination) {
      termination = this.runTermination(child);
      this.terminations.set(child, termination);
    }
    return termination;
  }

  private async runTermination(child: ChildProcess): Promise<void> {
    const exited = (): boolean =>
      child.exitCode !== null || child.signalCode !== null;
    const closed = new Promise<void>((resolve) => {
      if (exited()) resolve();
      child.once('exit', () => resolve());
      child.once('close', () => resolve());
    });

    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone
    }

    let timer: TimerRef | undefined;
    const timedOut = await Promise.race([
      closed.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), this.childGraceMs);
      }),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      logger.warn(
        `Child did not exit within ${this.childGraceMs / 1000}s of SIGTERM, sending SIGKILL to its process group`
      );
    }
    this.killChildGroup(child);
  }

  /**
   * SIGKILL the child's process group (it is a group leader: spawned
   * detached). Falls back to the pid when group signalling is unavailable.
   */
  private killChildGroup(child: ChildProcess): void {
    if (child.pid === undefined) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone
      }
      return;
    }
    try {
      if (process.platform === 'win32') {
        child.kill('SIGKILL');
      } else {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch {
      // ESRCH: the group is already empty
    }
  }

  /**
   * Spawn `airunx` CLI as a child process and capture output.
   * Resolves the CLI entry point relative to this package using
   * cross-platform-safe path resolution (no URL.pathname).
   * Includes a configurable timeout (AIRUNX_CHILD_TIMEOUT_MS, default 150 min)
   * with SIGTERM → group SIGKILL escalation to prevent hung children from
   * blocking the daemon. The child is spawned detached so it leads its own
   * process group (its CLI children join it); it is still awaited and its
   * stdio captured (never unref'd).
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
        detached: process.platform !== 'win32',
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
        void this.terminateChild(child);
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
        // `run` exited (on its own or signalled): reap anything it left in
        // its process group (CLI dev servers, orphaned CLIs). ESRCH = empty.
        if (process.platform !== 'win32' && child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // Group already empty
          }
        }
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
   * Extract summary metrics from `airunx run --format json` output
   */
  private metricsFromJson(
    json: Record<string, unknown> | null
  ): TaskResult['metrics'] {
    const jsonMetrics = json?.metrics as Record<string, unknown> | undefined;
    if (!jsonMetrics) return undefined;
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' ? v : undefined;
    return {
      costUsd: num(jsonMetrics.cost),
      tokensUsed: num(jsonMetrics.tokensUsed),
      durationMs: num(jsonMetrics.durationMs),
      iterations: num(jsonMetrics.iterations),
      costSummaryLine:
        typeof jsonMetrics.costSummaryLine === 'string'
          ? jsonMetrics.costSummaryLine
          : undefined,
    };
  }

  /**
   * Summary metrics from a run report read off disk
   */
  private metricsFromReport(report: RunReport): TaskResult['metrics'] {
    return {
      costUsd: report.totalCostUsd,
      tokensUsed: report.totalTokens,
      durationMs: report.totalDurationMs,
      iterations: report.iterationCount,
      costSummaryLine:
        report.costSummaryLine ??
        (report.costSummary
          ? formatCostSummaryLine(report.costSummary)
          : undefined),
    };
  }

  /**
   * Read `.airunx-state/reports/<workflowId>.json` (the report `run` writes
   * after every stage). Undefined when absent or unreadable.
   */
  private readRunReportFile(workflowId: string): RunReport | undefined {
    try {
      return loadRunReport(workflowId) ?? undefined;
    } catch (error) {
      logger.warn(`Could not read run report for ${workflowId}:`, error);
      return undefined;
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

    const jsonMetrics = json.metrics as Record<string, unknown> | undefined;
    const costSummary = jsonMetrics?.costSummary as CostSummary | undefined;

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
      ...(costSummary && typeof costSummary === 'object'
        ? {
            costSummary,
            costSummaryLine:
              typeof jsonMetrics?.costSummaryLine === 'string'
                ? jsonMetrics.costSummaryLine
                : formatCostSummaryLine(costSummary),
          }
        : {}),
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

/**
 * Cost fields for heartbeat task_* audit events (undefined when the run
 * produced no cost figures)
 */
function taskCostDetails(
  result: TaskResult
): { costUsd?: number; costSummaryLine?: string } | undefined {
  const costUsd = result.metrics?.costUsd ?? result.runReport?.totalCostUsd;
  const costSummaryLine =
    result.metrics?.costSummaryLine ?? result.runReport?.costSummaryLine;
  if (costUsd === undefined && costSummaryLine === undefined) return undefined;
  return { costUsd, costSummaryLine };
}
