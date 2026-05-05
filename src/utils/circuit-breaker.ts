/**
 * Circuit Breaker - Prevents repeated calls to failing backends
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Backend failing, requests fast-fail
 * - HALF_OPEN: Testing if backend recovered, one request allowed
 *
 * State transitions:
 * - CLOSED -> OPEN: After failureThreshold consecutive failures
 * - OPEN -> HALF_OPEN: After resetTimeout passes
 * - HALF_OPEN -> CLOSED: On success
 * - HALF_OPEN -> OPEN: On failure (with backoff)
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import lockfile from 'proper-lockfile';
import { existsSync } from 'fs';
import { createLogger } from './logger.js';
import { isRetryableError } from './errors.js';
import { LOCK_RETRY_CONFIG } from '../orchestrator/constants.js';

const logger = createLogger('circuit-breaker');

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerConfig {
  /** Failures before OPEN (default: 5) */
  failureThreshold: number;
  /** Time in ms before HALF_OPEN (default: 60000) */
  resetTimeoutMs: number;
  /** Max timeout with backoff (default: 300000) */
  maxResetTimeoutMs: number;
  /** Successes needed to close (default: 1) */
  halfOpenSuccessThreshold: number;
}

export interface CircuitBreakerState {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime: string | null;
  openedAt: string | null;
  resetAttempts: number;
}

interface CircuitBreakerFile {
  version: string;
  backends: Record<string, CircuitBreakerState>;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 60_000, // 1 minute
  maxResetTimeoutMs: 300_000, // 5 minutes
  halfOpenSuccessThreshold: 1,
};

export const DEFAULT_STATE: CircuitBreakerState = {
  state: CircuitState.CLOSED,
  failureCount: 0,
  successCount: 0,
  lastFailureTime: null,
  openedAt: null,
  resetAttempts: 0,
};

export class CircuitBreaker {
  private stateFilePath: string;
  private config: CircuitBreakerConfig;

  constructor(
    stateFilePath: string,
    config: Partial<CircuitBreakerConfig> = {}
  ) {
    this.stateFilePath = stateFilePath;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if the circuit is open for a backend
   * Returns true if requests should be blocked
   */
  async isOpen(backend: string): Promise<boolean> {
    const state = await this.getState(backend);

    if (state.state === CircuitState.CLOSED) {
      return false;
    }

    if (state.state === CircuitState.OPEN) {
      // Check if we should transition to HALF_OPEN
      if (this.shouldTransitionToHalfOpen(state)) {
        await this.updateState(backend, { state: CircuitState.HALF_OPEN });
        logger.info(`Circuit for ${backend} transitioning to HALF_OPEN`);
        return false; // Allow one request through
      }
      return true;
    }

    // HALF_OPEN - allow requests through
    return false;
  }

  /**
   * Record a successful execution
   */
  async recordSuccess(backend: string): Promise<void> {
    const state = await this.getState(backend);

    if (state.state === CircuitState.HALF_OPEN) {
      const newSuccessCount = state.successCount + 1;

      if (newSuccessCount >= this.config.halfOpenSuccessThreshold) {
        // Transition to CLOSED
        await this.updateState(backend, {
          state: CircuitState.CLOSED,
          failureCount: 0,
          successCount: 0,
          openedAt: null,
          resetAttempts: 0,
        });
        logger.info(`Circuit for ${backend} CLOSED (recovered)`);
      } else {
        await this.updateState(backend, { successCount: newSuccessCount });
      }
    } else if (state.state === CircuitState.CLOSED) {
      // Reset failure count on success
      if (state.failureCount > 0) {
        await this.updateState(backend, { failureCount: 0 });
      }
    }
  }

  /**
   * Record a failed execution
   * Only retryable errors count toward the circuit breaker
   */
  async recordFailure(backend: string, error: Error): Promise<void> {
    // Only count retryable errors (backend issues)
    // Don't count config errors (user's fault)
    if (!isRetryableError(error)) {
      logger.debug(`Not counting ${error.name} toward circuit (non-retryable)`);
      return;
    }

    const state = await this.getState(backend);
    const now = new Date().toISOString();

    if (state.state === CircuitState.HALF_OPEN) {
      // Failure during test - back to OPEN with increased backoff
      const newResetAttempts = state.resetAttempts + 1;
      await this.updateState(backend, {
        state: CircuitState.OPEN,
        openedAt: now,
        lastFailureTime: now,
        resetAttempts: newResetAttempts,
        successCount: 0,
      });
      logger.warn(
        `Circuit for ${backend} back to OPEN (attempt ${newResetAttempts})`
      );
    } else if (state.state === CircuitState.CLOSED) {
      const newFailureCount = state.failureCount + 1;

      if (newFailureCount >= this.config.failureThreshold) {
        // Transition to OPEN
        await this.updateState(backend, {
          state: CircuitState.OPEN,
          failureCount: newFailureCount,
          lastFailureTime: now,
          openedAt: now,
          resetAttempts: 0,
        });
        logger.warn(
          `Circuit for ${backend} OPEN (${newFailureCount} failures)`
        );
      } else {
        await this.updateState(backend, {
          failureCount: newFailureCount,
          lastFailureTime: now,
        });
        logger.debug(
          `Circuit failure recorded for ${backend} (${newFailureCount}/${this.config.failureThreshold})`
        );
      }
    }
  }

  /**
   * Get the current state for a backend
   */
  async getState(backend: string): Promise<CircuitBreakerState> {
    const file = await this.loadFile();
    return file.backends[backend] || { ...DEFAULT_STATE };
  }

  /**
   * Get states for all backends
   */
  async getAllStates(): Promise<Record<string, CircuitBreakerState>> {
    const file = await this.loadFile();
    return file.backends;
  }

  /**
   * Reset circuit for a backend (manual intervention)
   */
  async reset(backend: string): Promise<void> {
    await this.updateState(backend, { ...DEFAULT_STATE });
    logger.info(`Circuit for ${backend} manually reset`);
  }

  /**
   * Calculate when the circuit will attempt to recover
   */
  getRetryTime(state: CircuitBreakerState): Date | null {
    if (state.state !== CircuitState.OPEN || !state.openedAt) {
      return null;
    }

    const backoffMs = this.calculateBackoff(state.resetAttempts);
    return new Date(new Date(state.openedAt).getTime() + backoffMs);
  }

  /**
   * Check if circuit should transition from OPEN to HALF_OPEN
   */
  private shouldTransitionToHalfOpen(state: CircuitBreakerState): boolean {
    if (!state.openedAt) {
      return true; // No timestamp, allow transition
    }

    const backoffMs = this.calculateBackoff(state.resetAttempts);
    const elapsed = Date.now() - new Date(state.openedAt).getTime();

    return elapsed >= backoffMs;
  }

  /**
   * Calculate backoff with exponential increase
   */
  private calculateBackoff(resetAttempts: number): number {
    const baseTimeout = this.config.resetTimeoutMs;
    const backoff = baseTimeout * Math.pow(2, resetAttempts);
    return Math.min(backoff, this.config.maxResetTimeoutMs);
  }

  /**
   * Load the state file with proper error handling
   */
  private async loadFile(): Promise<CircuitBreakerFile> {
    try {
      if (!existsSync(this.stateFilePath)) {
        return { version: '1.0.0', backends: {} };
      }

      const content = await readFile(this.stateFilePath, 'utf-8');
      const data = JSON.parse(content) as CircuitBreakerFile;

      // Validate structure
      if (!data.version || typeof data.backends !== 'object') {
        logger.warn('Invalid circuit breaker state file, resetting');
        return { version: '1.0.0', backends: {} };
      }

      return data;
    } catch (error) {
      // If file is corrupted, start fresh
      logger.warn(
        `Failed to load circuit breaker state: ${error instanceof Error ? error.message : error}`
      );
      return { version: '1.0.0', backends: {} };
    }
  }

  /**
   * Update state for a backend with file locking
   */
  private async updateState(
    backend: string,
    update: Partial<CircuitBreakerState>
  ): Promise<void> {
    // Ensure directory exists
    const dir = dirname(this.stateFilePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    // Create file if it doesn't exist
    if (!existsSync(this.stateFilePath)) {
      await writeFile(
        this.stateFilePath,
        JSON.stringify({ version: '1.0.0', backends: {} }, null, 2)
      );
    }

    let release: (() => Promise<void>) | null = null;

    try {
      // Acquire lock with retries
      release = await lockfile.lock(this.stateFilePath, {
        retries: LOCK_RETRY_CONFIG,
        stale: 5000, // Consider lock stale after 5s
      });

      // Read current state
      const file = await this.loadFile();

      // Update backend state
      const currentState = file.backends[backend] || { ...DEFAULT_STATE };
      file.backends[backend] = { ...currentState, ...update };

      // Write back
      await writeFile(this.stateFilePath, JSON.stringify(file, null, 2));
    } catch (error) {
      // If locking fails, log but don't crash - circuit breaker is best-effort
      logger.warn(
        `Failed to update circuit state: ${error instanceof Error ? error.message : error}`
      );
    } finally {
      if (release) {
        await release();
      }
    }
  }
}

/**
 * Default circuit breaker state file path
 */
export function getDefaultStateFilePath(): string {
  return '.airunx-state/circuit-breaker.json';
}
