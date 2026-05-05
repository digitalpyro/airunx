/**
 * Task Queue Constants
 * Priority levels and defaults for the heartbeat execution model.
 */

export const PRIORITIES = ['p1', 'p2', 'p3'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const DEFAULT_PRIORITY: Priority = 'p2';

/**
 * Priority label prefix for GitHub Issues
 */
export const PRIORITY_LABEL_PREFIX = 'airunx:priority:';
