/**
 * Kill ladder — graceful termination of a spawned CLI process.
 *
 * SIGINT → interruptGraceMs → SIGTERM → terminateGraceMs → SIGKILL. Each
 * step runs only while the process has not actually exited (exitCode /
 * signalCode), never on `child.killed` (Node sets it on delivery, not exit).
 *
 * The caller settles on the child's 'close' event. Because 'close' waits for
 * stdio to close — which a grandchild inheriting the pipes can delay
 * indefinitely — the ladder calls `onGiveUp` postKillSettleMs after the
 * process exits (at any step) or after SIGKILL, whichever comes first.
 */

import type { ChildProcess } from 'child_process';

/** Signal ladder timings (see SIGINT_GRACE_PERIOD_MS in constants.ts) */
export interface SignalLadder {
  /** SIGINT → SIGTERM */
  interruptGraceMs: number;
  /** SIGTERM → SIGKILL */
  terminateGraceMs: number;
  /** Exit or SIGKILL → settle with collected output if stdio never closes */
  postKillSettleMs: number;
}

export type LadderSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

interface LadderLogger {
  debug(message: string): void;
  warn(message: string): void;
}

export interface KillLadderOptions {
  child: ChildProcess;
  timings: SignalLadder;
  /**
   * Called (at most once) when the ladder stops waiting for stdio to close.
   * The caller's settle must be idempotent: 'close' may still win the race.
   */
  onGiveUp: () => void;
  logger?: LadderLogger;
}

export interface KillLadder {
  /** True once start() has been called */
  readonly started: boolean;
  /**
   * Begin the ladder (idempotent). `alreadySignaled` skips the initial
   * SIGINT (the terminal already delivered it to the process group).
   */
  start(alreadySignaled?: boolean): void;
  /** Clear pending timers and listeners (call on settle) */
  dispose(): void;
}

/** True until the process has actually exited (not merely been signalled) */
export const processRunning = (child: ChildProcess): boolean =>
  child.exitCode === null && child.signalCode === null;

/** Signal `child` if it is still running; errors (already gone) are ignored */
export function sendSignal(
  child: ChildProcess,
  signal: LadderSignal,
  logger?: LadderLogger
): void {
  if (!processRunning(child)) return;
  logger?.debug(`Sending ${signal} to CLI (pid ${child.pid})`);
  try {
    child.kill(signal);
  } catch {
    // Process already gone
  }
}

export function createKillLadder(options: KillLadderOptions): KillLadder {
  const { child, timings, onGiveUp, logger } = options;
  const timers: ReturnType<typeof globalThis.setTimeout>[] = [];
  let started = false;
  let giveUpArmed = false;
  let disposed = false;

  const schedule = (fn: () => void, ms: number): void => {
    if (disposed) return;
    timers.push(globalThis.setTimeout(fn, ms));
  };

  /** Arm the settle fallback once; stdio may never close */
  const armGiveUp = (): void => {
    if (giveUpArmed || disposed) return;
    giveUpArmed = true;
    schedule(onGiveUp, timings.postKillSettleMs);
  };

  const onExit = (): void => armGiveUp();

  return {
    get started(): boolean {
      return started;
    },

    start(alreadySignaled = false): void {
      if (started || disposed) return;
      started = true;

      if (!processRunning(child)) {
        armGiveUp();
        return;
      }
      child.once('exit', onExit);

      if (!alreadySignaled) sendSignal(child, 'SIGINT', logger);
      schedule(() => {
        if (!processRunning(child)) {
          armGiveUp();
          return;
        }
        logger?.debug('CLI still running after SIGINT, sending SIGTERM');
        sendSignal(child, 'SIGTERM', logger);
        schedule(() => {
          if (processRunning(child)) {
            logger?.warn('CLI still running after SIGTERM, sending SIGKILL');
            sendSignal(child, 'SIGKILL', logger);
          }
          // Ladder complete: don't wait forever for stdio to close
          armGiveUp();
        }, timings.terminateGraceMs);
      }, timings.interruptGraceMs);
    },

    dispose(): void {
      disposed = true;
      for (const timer of timers) globalThis.clearTimeout(timer);
      timers.length = 0;
      child.removeListener('exit', onExit);
    },
  };
}
