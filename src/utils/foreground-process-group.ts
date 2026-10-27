/**
 * Foreground process group probe — did the terminal deliver SIGINT to us?
 *
 * Terminal Ctrl-C sends SIGINT to the terminal's foreground process group.
 * Spawned CLIs stay in `run`'s process group (see base-cli-adapter.ts), so
 * when `run` is in the foreground group the CLIs already got that SIGINT and
 * the shutdown ladder must not send a second one. A TTY alone does not prove
 * that: a background job (`airunx run &`) or a `kill -INT <pid>` aimed at
 * `run` alone leaves the CLIs unsignalled, and skipping SIGINT for them means
 * Claude never gets the chance to print its cost.
 *
 * Node has no tcgetpgrp(), so we ask `ps` for our pgid and the controlling
 * terminal's foreground pgid (tpgid). Both BSD/macOS and procps (Linux) `ps`
 * support `-o pgid=,tpgid=`; tpgid is 0 (macOS) or -1 (Linux) without a
 * controlling terminal, which never equals a real pgid.
 *
 * The probe runs at signal time, not at install: a job can be moved between
 * foreground and background (`fg`/`bg`, Ctrl-Z) after `run` starts, and only
 * the state when SIGINT arrives says who the terminal signalled. It is
 * synchronous with a short timeout so shutdown never waits on it for long.
 *
 * Residual limitation: when `run` IS the foreground group, a `kill -INT
 * <pid>` from another shell is indistinguishable from Ctrl-C at signal level,
 * so the CLIs then skip SIGINT and the ladder starts at SIGTERM.
 *
 * Any failure (no `ps`, timeout, unparseable output, Windows) answers false:
 * the safe default is to send SIGINT ourselves. A wrong "false" costs at
 * most a duplicate SIGINT: the kill ladder sends one SIGINT regardless of
 * what the child already received, then SIGTERM/SIGKILL only while the
 * process is still running. A wrong "true" costs a CLI that never gets
 * SIGINT and is SIGTERMed without reporting its spend.
 */

import { execFileSync } from 'child_process';

/** Upper bound for the `ps` probe (shutdown must not hang on it) */
export const FOREGROUND_PROBE_TIMEOUT_MS = 500;

/** Runs `ps` and returns its stdout; throws on failure or timeout */
export type PsExec = (args: string[], timeoutMs: number) => string;

const defaultPsExec: PsExec = (args, timeoutMs) =>
  execFileSync('ps', args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

export interface ForegroundProbeOptions {
  /** Process to check (default: this process) */
  pid?: number;
  timeoutMs?: number;
  /** Override the `ps` call (tests) */
  exec?: PsExec;
}

/**
 * Parse `ps -o pgid=,tpgid=` output. True only when both are positive and
 * equal (the process group is the terminal's foreground group).
 */
export function parseForegroundPs(output: string): boolean {
  const fields = output.trim().split(/\s+/);
  if (fields.length !== 2) return false;
  const [pgid, tpgid] = fields.map((f) =>
    /^-?\d+$/.test(f) ? Number(f) : NaN
  );
  return pgid > 0 && tpgid > 0 && pgid === tpgid;
}

/**
 * True when `pid`'s process group is its controlling terminal's foreground
 * process group. False when it is not, or when that cannot be determined.
 */
export function isForegroundProcessGroup(
  options: ForegroundProbeOptions = {}
): boolean {
  const pid = options.pid ?? process.pid;
  const exec = options.exec ?? defaultPsExec;
  try {
    return parseForegroundPs(
      exec(
        ['-o', 'pgid=,tpgid=', '-p', String(pid)],
        options.timeoutMs ?? FOREGROUND_PROBE_TIMEOUT_MS
      )
    );
  } catch {
    return false;
  }
}

export interface TerminalSigintOptions {
  /** stdin/stderr TTY check (default: process streams) */
  isTTY?: () => boolean;
  /** Foreground group check (default: isForegroundProcessGroup) */
  isForeground?: () => boolean;
}

/**
 * Did a terminal Ctrl-C (most likely) already deliver this SIGINT to the
 * whole process group, CLIs included? Requires a TTY on stdin/stderr (cheap
 * gate: a detached heartbeat `run` never spawns `ps`) and a foreground group.
 */
export function terminalDeliveredSigint(
  options: TerminalSigintOptions = {}
): boolean {
  const isTTY =
    options.isTTY ??
    ((): boolean => Boolean(process.stdin.isTTY || process.stderr.isTTY));
  try {
    if (!isTTY()) return false;
    return (options.isForeground ?? isForegroundProcessGroup)();
  } catch {
    return false;
  }
}
