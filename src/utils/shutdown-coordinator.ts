/**
 * Shutdown coordinator — graceful shutdown of a running `airunx run`
 *
 * Process topology (U9): the heartbeat spawns `run` as a process-group leader
 * and CLI children stay in that group. When `run` is asked to stop, it — and
 * only it — interrupts each in-flight CLI once (SIGINT), lets the signal
 * ladder in BaseCliAdapter run (SIGINT → SIGTERM → SIGKILL), waits until every
 * interrupted spawn has written its llm_spawn event (reported if the CLI
 * answered with result JSON, estimated otherwise), then runs flush hooks (the
 * runner's final run report) and exits.
 *
 * The coordinator is a process-level singleton because spawns are made deep
 * inside adapters (CE sub-agents, codex retries) that the CLI command never
 * sees directly.
 */

import type { EventEmitter } from 'events';
import type { CostSummary } from '../core/types.js';
import { createLogger } from './logger.js';

const logger = createLogger('shutdown');

/** Upper bound for waiting on interrupted spawns (ladder 5s + margin) */
export const SHUTDOWN_TIMEOUT_MS = 7_000;

/** Upper bound for flush hooks once spawns have settled */
export const SHUTDOWN_FLUSH_TIMEOUT_MS = 2_000;

/** A live CLI spawn that shutdown can interrupt */
export interface InterruptibleSpawn {
  /**
   * Start the signal ladder. `alreadySignaled` means the CLI has already
   * received SIGINT (e.g. terminal Ctrl-C reaches the whole foreground
   * process group), so the ladder must not send a second one.
   */
  interrupt(options: { alreadySignaled: boolean }): void;
}

/** Spend of one spawn that was cut off by shutdown, for the final report */
export interface InterruptedSpawnSummary {
  workflowId?: string;
  stage?: string;
  iteration?: number;
  backend: string;
  agentRole: string;
  startedAt: string;
  durationMs: number;
  tokensUsed: number;
  /** Headline cost (reported when the CLI answered SIGINT, else estimated) */
  costUsd?: number;
  costSummary?: CostSummary;
}

/** Runs after interrupted spawns settled, before the process exits */
export type ShutdownFlushHook = (
  interrupted: readonly InterruptedSpawnSummary[]
) => void | Promise<void>;

export interface ShutdownOptions {
  /** CLIs already received SIGINT from the terminal (see InterruptibleSpawn) */
  alreadySignaled?: boolean;
  /** Override SHUTDOWN_TIMEOUT_MS (tests) */
  timeoutMs?: number;
  /** Override SHUTDOWN_FLUSH_TIMEOUT_MS (tests) */
  flushTimeoutMs?: number;
}

/** Thrown for spawns attempted after shutdown began */
export class ShutdownInProgressError extends Error {
  constructor() {
    super('Shutdown in progress: no new CLI spawns');
    this.name = 'ShutdownInProgressError';
  }
}

const withTimeout = async (
  promise: Promise<unknown>,
  ms: number
): Promise<boolean> => {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = globalThis.setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    globalThis.clearTimeout(timer);
  }
};

export class ShutdownCoordinator {
  private spawns = new Set<InterruptibleSpawn>();
  private pending = new Set<Promise<unknown>>();
  private interrupted: InterruptedSpawnSummary[] = [];
  private flushHooks = new Set<ShutdownFlushHook>();
  private shutdownPromise: Promise<void> | null = null;

  get isShuttingDown(): boolean {
    return this.shutdownPromise !== null;
  }

  /** Number of live CLI processes (tests, diagnostics) */
  get activeSpawnCount(): number {
    return this.spawns.size;
  }

  /**
   * Register a live CLI process. Returns the unregister function. A spawn
   * registered after shutdown began is interrupted immediately.
   */
  registerSpawn(spawn: InterruptibleSpawn): () => void {
    this.spawns.add(spawn);
    if (this.isShuttingDown) spawn.interrupt({ alreadySignaled: false });
    return () => {
      this.spawns.delete(spawn);
    };
  }

  /**
   * Track a whole spawn lifecycle (process + ledger write). Shutdown waits
   * for tracked work so events are written before the final report flush.
   */
  trackSpawn<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    const done = (): void => {
      this.pending.delete(work);
    };
    work.then(done, done);
    return work;
  }

  /** Record the spend of a spawn cut off by shutdown */
  recordInterruptedSpawn(summary: InterruptedSpawnSummary): void {
    this.interrupted.push(summary);
  }

  /** Register a final flush (e.g. the runner's run report). Returns unregister. */
  onFlush(hook: ShutdownFlushHook): () => void {
    this.flushHooks.add(hook);
    return () => {
      this.flushHooks.delete(hook);
    };
  }

  /**
   * Interrupt every live spawn once, wait for their events, run flush hooks.
   * Idempotent: later calls return the first call's promise and never
   * re-signal CLIs. Never rejects.
   */
  shutdown(options: ShutdownOptions = {}): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.runShutdown(options);
    }
    return this.shutdownPromise;
  }

  private async runShutdown(options: ShutdownOptions): Promise<void> {
    const alreadySignaled = options.alreadySignaled ?? false;
    const live = [...this.spawns];
    logger.warn(
      `Shutting down: interrupting ${live.length} active CLI spawn(s)` +
        (alreadySignaled ? ' (SIGINT already delivered by terminal)' : '')
    );
    for (const spawn of live) {
      try {
        spawn.interrupt({ alreadySignaled });
      } catch (error) {
        logger.warn(
          `Failed to interrupt spawn: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const settled = await withTimeout(
      Promise.allSettled([...this.pending]),
      options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS
    );
    if (!settled) {
      logger.warn('Shutdown: spawns did not settle in time; flushing anyway');
    }

    const interrupted = [...this.interrupted];
    for (const hook of [...this.flushHooks]) {
      try {
        const ok = await withTimeout(
          Promise.resolve().then(() => hook(interrupted)),
          options.flushTimeoutMs ?? SHUTDOWN_FLUSH_TIMEOUT_MS
        );
        if (!ok) logger.warn('Shutdown flush hook timed out');
      } catch (error) {
        logger.warn(
          `Shutdown flush hook failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  /** Reset all state (tests only) */
  reset(): void {
    this.spawns.clear();
    this.pending.clear();
    this.interrupted = [];
    this.flushHooks.clear();
    this.shutdownPromise = null;
  }
}

/** Process-level coordinator shared by adapters, runners and `run` */
export const shutdownCoordinator = new ShutdownCoordinator();

/** Exit code for a signal-driven exit (128 + signal number) */
const SIGNAL_EXIT_CODES: Record<'SIGINT' | 'SIGTERM', number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

/**
 * Terminal Ctrl-C signals the whole foreground process group; a detached
 * `run` (heartbeat) has no terminal and only ever gets signals addressed to it
 */
const attachedToTerminal = (): boolean =>
  Boolean(process.stdin.isTTY || process.stderr.isTTY);

export interface ShutdownSignalHandlerOptions {
  /** Called once shutdown finished (or on a second signal) */
  exit: (code: number) => void;
  coordinator?: ShutdownCoordinator;
  shutdownOptions?: Omit<ShutdownOptions, 'alreadySignaled'>;
  /** Signal source (default: process; tests pass an EventEmitter) */
  target?: Pick<EventEmitter, 'on' | 'off'>;
  /** Override the terminal check (tests) */
  attachedToTerminal?: () => boolean;
}

/**
 * Install SIGINT/SIGTERM handlers that drive a graceful shutdown.
 *
 * - SIGTERM (heartbeat stop/timeout, `kill`): CLIs get SIGINT from us.
 * - SIGINT with a terminal attached (Ctrl-C): the terminal already
 *   delivered SIGINT to the whole foreground group, CLIs included, so we do
 *   not send another; the ladder continues with SIGTERM/SIGKILL. Without a
 *   terminal, SIGINT is treated like SIGTERM.
 * - A second signal while shutting down exits immediately.
 *
 * Returns an uninstall function.
 */
export function installShutdownSignalHandlers(
  options: ShutdownSignalHandlerOptions
): () => void {
  const coordinator = options.coordinator ?? shutdownCoordinator;
  const target = options.target ?? process;
  const isTerminal = options.attachedToTerminal ?? attachedToTerminal;
  let handling = false;

  const handler = (signal: 'SIGINT' | 'SIGTERM'): void => {
    const code = SIGNAL_EXIT_CODES[signal];
    if (handling) {
      logger.warn(`Received ${signal} during shutdown; exiting now`);
      options.exit(code);
      return;
    }
    handling = true;
    logger.warn(`Received ${signal}; stopping in-flight CLI spawns`);
    void coordinator
      .shutdown({
        ...options.shutdownOptions,
        alreadySignaled: signal === 'SIGINT' && isTerminal(),
      })
      .finally(() => options.exit(code));
  };

  const onSigint = (): void => handler('SIGINT');
  const onSigterm = (): void => handler('SIGTERM');
  target.on('SIGINT', onSigint);
  target.on('SIGTERM', onSigterm);
  return () => {
    target.off('SIGINT', onSigint);
    target.off('SIGTERM', onSigterm);
  };
}
