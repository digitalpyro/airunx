/**
 * Verbose Reporter - Escalating interval progress reporting
 *
 * Provides meaningful status updates during workflow execution at escalating intervals:
 * - 1 minute: Initial status report
 * - 5 minutes: Extended status report
 * - 10+ minutes: Status every 5 minutes
 *
 * Uses AbortController for clean timer cleanup on workflow completion or interruption.
 */

import { setTimeout as delay } from 'node:timers/promises';
import type { StateManager } from './state-manager.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('VerboseReporter');

/** Type for the delay function (compatible with node:timers/promises setTimeout) */
export type DelayFn = (
  ms: number,
  value?: undefined,
  options?: { signal?: AbortSignal }
) => Promise<void>;

/**
 * Configuration options for VerboseReporter
 */
export interface VerboseReporterOptions {
  /** StateManager instance for loading workflow state */
  stateManager: StateManager;
  /** Workflow ID to report on */
  workflowId: string;
  /** Custom output function (defaults to console.log) */
  output?: (message: string) => void;
  /** Optional AbortSignal for external cancellation */
  signal?: AbortSignal;
  /** Optional delay function for testability (defaults to node:timers/promises setTimeout) */
  delayFn?: DelayFn;
}

/**
 * VerboseReporter provides escalating interval progress reporting
 * for long-running workflow executions.
 */
export class VerboseReporter {
  /** One minute in milliseconds */
  private static readonly ONE_MINUTE_MS = 60_000;
  /** Four minutes in milliseconds */
  private static readonly FOUR_MINUTES_MS = 4 * VerboseReporter.ONE_MINUTE_MS;
  /** Five minutes in milliseconds */
  private static readonly FIVE_MINUTES_MS = 5 * VerboseReporter.ONE_MINUTE_MS;
  /** Escalating intervals: 1min, 5min total, 10min total */
  private static readonly REPORT_INTERVALS_MS = [
    VerboseReporter.ONE_MINUTE_MS, // Wait 1 min for first report
    VerboseReporter.FOUR_MINUTES_MS, // Wait 4 more mins for 5 min report
    VerboseReporter.FIVE_MINUTES_MS, // Wait 5 more mins for 10 min report
  ];
  /** Recurring interval after initial reports */
  private static readonly RECURRING_INTERVAL_MS =
    VerboseReporter.FIVE_MINUTES_MS;

  private abortController: AbortController | null = null;
  private startTime: number = 0;
  private isRunning: boolean = false;
  private isStopping: boolean = false;
  private reportTask: Promise<void> | null = null;

  private readonly stateManager: StateManager;
  private readonly workflowId: string;
  private readonly output: (message: string) => void;
  private readonly externalSignal?: AbortSignal;
  private readonly externalAbortHandler: () => void;
  private readonly delayFn: DelayFn;

  constructor(options: VerboseReporterOptions) {
    this.stateManager = options.stateManager;
    this.workflowId = options.workflowId;
    this.output = options.output ?? console.log;
    this.externalSignal = options.signal;
    this.delayFn = options.delayFn ?? delay;
    // Handle promise rejection to prevent unhandled rejection crashes
    this.externalAbortHandler = (): void => {
      this.stop().catch((err) => {
        logger.warn('Error stopping VerboseReporter from external signal', err);
      });
    };
  }

  /**
   * Start the verbose reporter
   * Begins the escalating interval report loop
   */
  start(): void {
    if (this.isRunning || this.isStopping) return;

    this.isRunning = true;
    this.startTime = Date.now();
    this.abortController = new AbortController();

    // Listen for external abort signal (symmetric with removeEventListener in stop())
    if (this.externalSignal) {
      this.externalSignal.addEventListener('abort', this.externalAbortHandler);
    }

    this.reportTask = this.runReportLoop();
  }

  /**
   * Stop the verbose reporter
   * Cancels any pending reports and cleans up
   *
   * Uses isStopping flag to prevent race conditions where start() could
   * be called while stop() is awaiting the task to complete.
   */
  async stop(): Promise<void> {
    if (!this.isRunning || this.isStopping) return;

    this.isStopping = true;

    // Capture references for cleanup
    const controllerToAbort = this.abortController;
    const taskToAwait = this.reportTask;

    // Abort first to signal the loop to stop
    controllerToAbort?.abort();

    // Wait for the task to complete
    if (taskToAwait) {
      await taskToAwait;
    }

    // Clear state after the task is confirmed stopped
    this.isRunning = false;
    this.abortController = null;
    this.reportTask = null;

    // Clean up external signal listener to prevent memory leaks
    if (this.externalSignal) {
      this.externalSignal.removeEventListener(
        'abort',
        this.externalAbortHandler
      );
    }

    this.isStopping = false;
  }

  /**
   * Main report loop with escalating intervals
   * - First report at 1 minute
   * - Second report at 5 minutes (4 minute wait)
   * - Third report at 10 minutes (5 minute wait)
   * - Then every 5 minutes thereafter
   */
  private async runReportLoop(): Promise<void> {
    if (!this.abortController) {
      logger.warn('runReportLoop called without an active abort controller');
      return;
    }
    const { signal } = this.abortController;
    const intervals = [...VerboseReporter.REPORT_INTERVALS_MS];

    while (!signal.aborted) {
      const waitTime =
        intervals.shift() ?? VerboseReporter.RECURRING_INTERVAL_MS;

      try {
        await this.delayFn(waitTime, undefined, { signal });
        if (signal.aborted) break;
        await this.reportStatus();
      } catch (err) {
        if ((err as Error).name === 'AbortError') break;
        logger.warn('Error in verbose reporter', err);
      }
    }
  }

  /**
   * Report current workflow status
   * Loads state from StateManager and outputs formatted message
   */
  private async reportStatus(): Promise<void> {
    try {
      const state = await this.stateManager.load(this.workflowId);
      if (!state) {
        logger.debug('Could not load workflow state for verbose report');
        return;
      }

      const elapsed = Date.now() - this.startTime;
      const minutes = Math.floor(elapsed / 60_000);
      const stage = state.currentStage ?? 'unknown';
      const iteration = state.iterationCount ?? 0;

      const message = `[${minutes}m elapsed] Stage: ${stage} (iteration ${iteration})`;
      this.output(message);
    } catch (err) {
      logger.warn('Failed to report verbose status', err);
    }
  }
}
