/**
 * Get Run Cost Agent Tool
 * Lets agents read a run's spend summary mid-run (the same data as
 * `airunx costs --workflow-id <id> --json`). Ledger events are hidden from
 * query_audit by default, so this is the agent-facing view of cost.
 * Security: the workflow ID is validated before any file access and the
 * output is aggregate numbers only — no prompt content, no raw ledger lines.
 */

import { z } from 'zod';
import type { AgentContext } from '../task-queue/types.js';
import {
  summarizeRunCosts,
  type RunCostSummary,
} from '../core/run-cost-summary.js';
import {
  RUN_REPORTS_DIR,
  assertValidWorkflowId,
} from '../utils/workflow-id.js';
import { loadRunReport } from '../utils/run-report-io.js';

const GetRunCostParamsSchema = z.object({
  workflowId: z.string().optional(),
});

export type GetRunCostResult =
  | { success: true; found: true; summary: RunCostSummary }
  | { success: false; found: false; workflowId: string; error: string };

export interface GetRunCostOptions {
  /** Override for tests; defaults to `.airunx-state/reports` */
  reportsDir?: string;
}

export const getRunCostTool = {
  name: 'get_run_cost',
  description:
    'Get the cost summary for a run: billed and API-equivalent totals, ' +
    'provenance mix, per-stage spend and top cost drivers (all money in ' +
    'integer micro-USD). Defaults to the current workflow. Use this to ' +
    'reason about spend mid-run. Returns aggregate numbers only.',
  parameters: {
    type: 'object' as const,
    properties: {
      workflowId: {
        type: 'string',
        description:
          'Run to summarize (default: the current workflow). ' +
          "1-64 characters of A-Z, a-z, 0-9, '_' or '-'.",
      },
    },
    required: [] as string[],
  },

  /**
   * Execute the get_run_cost tool.
   * Throws on an invalid workflow ID; reports `found: false` for an unknown
   * run. The current workflow always yields a summary (possibly empty).
   */
  execute: async (
    rawParams: unknown,
    context: AgentContext,
    options: GetRunCostOptions = {}
  ): Promise<GetRunCostResult> => {
    const params = GetRunCostParamsSchema.parse(rawParams ?? {});
    const workflowId = params.workflowId ?? context.workflowId;
    // Validate before any file access: rejects traversal such as `../etc`
    assertValidWorkflowId(workflowId);

    const report = loadRunReport(
      workflowId,
      options.reportsDir ?? RUN_REPORTS_DIR
    );
    const auditAvailable = context.auditLogger.listLogFiles().length > 0;
    const { events, skipped } = auditAvailable
      ? await context.auditLogger.queryWithStats({ workflowId })
      : { events: [], skipped: 0 };

    if (!report && events.length === 0 && workflowId !== context.workflowId) {
      return {
        success: false,
        found: false,
        workflowId,
        error: `No run report or ledger events for ${workflowId}`,
      };
    }

    return {
      success: true,
      found: true,
      summary: summarizeRunCosts({
        workflowId,
        report,
        events,
        skippedLines: skipped,
        auditAvailable,
      }),
    };
  },
};

/**
 * Get tool definition for LangGraph/LLM registration
 */
export function getGetRunCostToolDefinition(): {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
} {
  return {
    name: getRunCostTool.name,
    description: getRunCostTool.description,
    parameters: getRunCostTool.parameters,
  };
}
