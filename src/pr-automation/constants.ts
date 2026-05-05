/**
 * Constants for PR automation module
 * Centralized defaults to ensure consistency across the module
 */

/**
 * Default values for workflow context fields
 */
export const PR_AUTOMATION_DEFAULTS = {
  /** Default fidelity level when not specified */
  FIDELITY_LEVEL: 'standard',
  /** Default backend when not specified */
  BACKEND: 'claude-code',
  /** Default max iterations when not specified */
  MAX_ITERATIONS: 2,
  /** Default commit type when not inferred */
  COMMIT_TYPE: 'feat',
  /** Default task title when not provided */
  TASK_TITLE: 'AI-generated implementation',
} as const;
