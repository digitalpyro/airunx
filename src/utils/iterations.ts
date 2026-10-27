/**
 * Iteration count helpers
 *
 * `WorkflowContext.iterationCount` is 0-indexed: it counts the re-iterations
 * started after the judge rejected a pass (0 on the first pass, 1 after one
 * ITERATE verdict, ...). Internal control flow (judge gating, skip conditions,
 * max-iteration checks) depends on that. Everything user-facing — run
 * reports, `run --format json` metrics, PR/commit bodies, issue comments —
 * reports the 1-indexed number of iterations actually run, via these helpers.
 */

import type { WorkflowContext } from '../core/types.js';

/**
 * Number of pipeline iterations a workflow has run (1-indexed): 1 for a run
 * the judge accepted on the first pass, 2 after one re-iteration, and so on.
 * 0 only for a workflow that never got past initialization.
 */
export function iterationsRun(
  context: Pick<WorkflowContext, 'iterationCount' | 'status' | 'stageRecords'>
): number {
  const reIterations = context.iterationCount ?? 0;
  const neverStarted =
    context.status === 'initializing' &&
    reIterations === 0 &&
    (context.stageRecords?.length ?? 0) === 0;
  return neverStarted ? 0 : reIterations + 1;
}
