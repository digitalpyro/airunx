/**
 * Workflow ID helpers
 *
 * One strict pattern for every workflow ID that reaches a file path (run
 * reports, the `run --workflow-id` flag, the `costs` reader). IDs are
 * validated before any file access so a crafted ID such as `../../x` can
 * never escape the reports directory.
 */

import crypto from 'crypto';
import { join } from 'path';

/** Alphanumerics, `_` and `-`, 1–64 characters */
export const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Directory (relative to the process cwd) holding per-run reports */
export const RUN_REPORTS_DIR = join('.airunx-state', 'reports');

/** True when `id` is a string matching WORKFLOW_ID_PATTERN */
export function isValidWorkflowId(id: unknown): id is string {
  return typeof id === 'string' && WORKFLOW_ID_PATTERN.test(id);
}

/** Throws when `id` does not match WORKFLOW_ID_PATTERN */
export function assertValidWorkflowId(id: unknown): asserts id is string {
  if (!isValidWorkflowId(id)) {
    const shown = typeof id === 'string' ? JSON.stringify(id) : typeof id;
    throw new Error(
      `Invalid workflow ID ${shown}: expected 1-64 characters of A-Z, a-z, 0-9, '_' or '-'`
    );
  }
}

/**
 * Mint a workflow ID: `workflow-<epoch ms>-<8 hex>` (always matches
 * WORKFLOW_ID_PATTERN). Shared by PipelineExecutor and the heartbeat, which
 * pre-generates the ID so it knows where the run report will land.
 */
export function generateWorkflowId(): string {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  return `workflow-${timestamp}-${random}`;
}

/**
 * Path of a workflow's run report (`<baseDir>/<workflowId>.json`).
 * Validates the ID first; throws on an invalid one.
 */
export function getRunReportPath(
  workflowId: string,
  baseDir: string = RUN_REPORTS_DIR
): string {
  assertValidWorkflowId(workflowId);
  return join(baseDir, `${workflowId}.json`);
}
