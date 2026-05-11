/**
 * Async spawn utility — replaces spawnSync to avoid blocking the event loop.
 *
 * Provides the same interface as spawnSync but returns a Promise.
 * Used by test gates, dependency installers, and adapter auth checks.
 */

import { spawn } from 'child_process';

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface SpawnOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string | undefined>;
}

/**
 * Spawn a child process asynchronously and capture its output.
 * Drop-in replacement for spawnSync with the same result shape.
 */
export function spawnAsync(
  cmd: string,
  args: string[],
  options: SpawnOptions = {}
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeout) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, options.timeout);
    }

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        status: code,
        stdout,
        stderr,
        ...(timedOut
          ? { error: new Error(`Process timed out after ${options.timeout}ms`) }
          : {}),
      });
    });

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({
        status: null,
        stdout,
        stderr,
        error,
      });
    });
  });
}
