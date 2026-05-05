/**
 * Process Lock
 * Prevents multiple heartbeat instances from running simultaneously.
 * Uses a lockfile with PID to detect stale locks from crashed processes.
 */

/* eslint-disable no-undef */
import {
  existsSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  constants as fsConstants,
} from 'fs';
import { dirname, resolve } from 'path';
import { createLogger } from '../utils/logger.js';
import type { LockResult, FileSystem } from '../task-queue/types.js';

const logger = createLogger('process-lock');

// Named constants (no magic numbers)
const LOCK_REFRESH_INTERVAL_MS = 30_000;

// Timer reference type for Node.js
type TimerRef = ReturnType<typeof setTimeout>;

// Default filesystem implementation using Node.js fs
const defaultFs: FileSystem = {
  exists: existsSync,
  read: (path) => readFileSync(path, 'utf8'),
  write: (path, content) => writeFileSync(path, content),
  delete: unlinkSync,
};

export class ProcessLock {
  private lockPath: string;
  private fs: FileSystem;
  private refreshInterval: TimerRef | null = null;

  constructor(lockPath: string, fs: FileSystem = defaultFs) {
    this.lockPath = lockPath;
    this.fs = fs;
  }

  /**
   * Attempt to acquire the process lock.
   * Handles stale locks from crashed processes.
   *
   * @returns LockResult with success status and optional reason for failure
   */
  acquire(): LockResult {
    try {
      // Ensure directory exists
      const dir = dirname(this.lockPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Attempt atomic lock creation using O_CREAT | O_EXCL | O_WRONLY
      // This avoids the TOCTOU race between exists() and write()
      try {
        const fd = openSync(
          this.lockPath,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY
        );
        // Atomically created — write our PID and close.
        // try/finally ensures fd is closed even if writeFileSync fails.
        try {
          writeFileSync(fd, process.pid.toString());
        } finally {
          closeSync(fd);
        }
        this.startRefreshInterval();
        logger.info(`Acquired process lock (PID ${process.pid})`);
        return { success: true };
      } catch (openError: unknown) {
        // EEXIST means lock file already exists — check if stale
        if (
          openError instanceof Error &&
          'code' in openError &&
          (openError as NodeJS.ErrnoException).code === 'EEXIST'
        ) {
          return this.handleExistingLock();
        }
        throw openError;
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        reason: `Lock acquisition failed: ${err.message}`,
      };
    }
  }

  /**
   * Handle an existing lock file: check if it's stale, a symlink, or active.
   */
  private handleExistingLock(): LockResult {
    // Open fd first, then fstat on the fd to check for symlinks.
    // This avoids the TOCTOU between a path-based lstat and a separate read.
    let fd: number;
    let content: string;
    try {
      fd = openSync(this.lockPath, fsConstants.O_RDONLY);
    } catch {
      // File was removed between the EEXIST and here — retry
      return this.acquire();
    }

    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) {
        logger.warn('Lockfile is not a regular file — refusing to read');
        return {
          success: false,
          reason: 'Lockfile is not a regular file — refusing to use',
        };
      }
      // Read content from the verified fd
      content = readFileSync(fd, 'utf-8');
    } finally {
      closeSync(fd);
    }

    const existingPid = parseInt(content, 10);

    if (isNaN(existingPid)) {
      logger.warn('Corrupt lockfile found, overwriting');
      this.fs.write(this.lockPath, process.pid.toString());
      this.startRefreshInterval();
      logger.info(`Acquired process lock (PID ${process.pid})`);
      return { success: true };
    }

    // Check if process is still running
    try {
      process.kill(existingPid, 0); // Signal 0 = check existence
      return {
        success: false,
        reason: `Another heartbeat process is running (PID ${existingPid})`,
      };
    } catch {
      // Process is dead, take over the stale lock
      logger.info(`Taking over stale lock from dead process ${existingPid}`);
      this.fs.write(this.lockPath, process.pid.toString());
      this.startRefreshInterval();
      logger.info(`Acquired process lock (PID ${process.pid})`);
      return { success: true };
    }
  }

  /**
   * Release the process lock.
   * Should be called on graceful shutdown.
   */
  release(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }

    try {
      if (this.fs.exists(this.lockPath)) {
        // Only delete if we own the lock
        const content = this.fs.read(this.lockPath);
        const pid = parseInt(content, 10);
        if (pid === process.pid) {
          this.fs.delete(this.lockPath);
          logger.info('Released process lock');
        }
      }
    } catch {
      // Ignore cleanup errors - process is likely exiting anyway
    }
  }

  /**
   * Check if a heartbeat process is currently running.
   *
   * @returns Object with running status and optional PID
   */
  isRunning(): { running: boolean; pid?: number } {
    try {
      if (!this.fs.exists(this.lockPath)) {
        return { running: false };
      }

      const content = this.fs.read(this.lockPath);
      const pid = parseInt(content, 10);

      if (isNaN(pid)) {
        return { running: false };
      }

      // Check if process is alive
      try {
        process.kill(pid, 0);
        return { running: true, pid };
      } catch {
        return { running: false };
      }
    } catch {
      return { running: false };
    }
  }

  /**
   * Get the PID of the running heartbeat process (if any).
   */
  getPid(): number | null {
    const status = this.isRunning();
    return status.running ? (status.pid ?? null) : null;
  }

  /**
   * Force remove a stale lock (for manual recovery).
   */
  forceRemove(): void {
    try {
      if (this.fs.exists(this.lockPath)) {
        this.fs.delete(this.lockPath);
        logger.info('Force removed lockfile');
      }
    } catch (error) {
      logger.warn(
        `Failed to force remove lockfile: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  /**
   * Periodically refresh the lockfile to maintain ownership.
   * This helps detect stale locks more reliably.
   */
  private startRefreshInterval(): void {
    this.refreshInterval = setInterval(() => {
      try {
        this.fs.write(this.lockPath, process.pid.toString());
      } catch {
        // Ignore refresh errors - lock may have been taken over
      }
    }, LOCK_REFRESH_INTERVAL_MS);

    // Don't prevent Node from exiting
    if (this.refreshInterval.unref) {
      this.refreshInterval.unref();
    }
  }
}

/**
 * Default lockfile path for heartbeat process
 */
export function getDefaultLockPath(): string {
  // Resolve to absolute path to prevent CWD-dependent lock location
  return resolve('.airunx-state/heartbeat.lock');
}
