/**
 * Orchestrator constants - Centralized configuration values
 */

/**
 * Default state directory for workflow persistence
 * Uses .airunx-state/ to separate runtime artifacts from configuration
 */
export const DEFAULT_STATE_DIR = '.airunx-state/workflows';

/**
 * Default todo directory for task tracking
 */
export const DEFAULT_TODO_DIR = '.airunx-state/todos';

/**
 * Lock file retry configuration
 */
export const LOCK_RETRY_CONFIG = {
  retries: 5,
  minTimeout: 100,
  maxTimeout: 1000,
} as const;

/**
 * Timeout configurations (in milliseconds)
 */
export const TIMEOUTS = {
  testCoverage: 60000, // 1 minute
  acceptanceCriteria: 30000, // 30 seconds
  lint: 60000, // 1 minute
  typeCheck: 120000, // 2 minutes
} as const;
