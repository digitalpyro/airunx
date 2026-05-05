/**
 * Query Audit Agent Tool
 * Allows agents to query past execution events for learning from history.
 * Security: Restricted to current workflow only, sanitizes error details.
 */

import { z } from 'zod';
import type { AgentContext } from '../task-queue/types.js';
import type { AuditEvent } from '../audit/audit-logger.js';
import { isSensitiveKey } from '../utils/redaction.js';

const MAX_RESULTS = 50;
// Augment shared sensitive keys with audit-specific keys (stack, error)
const AUDIT_SENSITIVE_KEYS = ['stack', 'error'];

const QueryAuditParamsSchema = z.object({
  eventTypes: z.array(z.string()).optional(),
  since: z.string().datetime().optional(),
  limit: z.number().min(1).max(MAX_RESULTS).default(20),
});

export const queryAuditTool = {
  name: 'query_audit',
  description:
    'Query audit log for past execution events in the current workflow. ' +
    'Use this to learn from history and understand what has happened. ' +
    'Results are limited to the current workflow for security.',
  parameters: {
    type: 'object' as const,
    properties: {
      eventTypes: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Filter by event types (e.g., "task_completed", "stage_error")',
      },
      since: {
        type: 'string',
        description: 'ISO timestamp - return events after this time',
      },
      limit: {
        type: 'number',
        description: `Maximum events to return (1-${MAX_RESULTS}, default: 20)`,
      },
    },
    required: [] as string[],
  },

  /**
   * Execute the query_audit tool.
   * Returns sanitized audit events from the current workflow.
   */
  execute: async (
    rawParams: unknown,
    context: AgentContext
  ): Promise<AuditEvent[]> => {
    const params = QueryAuditParamsSchema.parse(rawParams);

    // Security: Force current workflow only - agents cannot query other workflows
    const events = await context.auditLogger.query({
      workflowId: context.workflowId,
      eventTypes: params.eventTypes,
      since: params.since ? new Date(params.since) : undefined,
      limit: params.limit,
    });

    // Sanitize: Remove sensitive details before returning to agent
    return events.map((event) => ({
      ...event,
      details: sanitizeDetails(event.details),
    }));
  },
};

/**
 * Sanitize event details by redacting sensitive fields.
 * Prevents leaking stack traces, error details, or secrets to agents.
 */
function sanitizeDetails(
  details?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!details) return undefined;

  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => {
      const lowerKey = key.toLowerCase();
      if (
        isSensitiveKey(key) ||
        AUDIT_SENSITIVE_KEYS.some((sensitive) => lowerKey.includes(sensitive))
      ) {
        return [key, '[redacted]'];
      }
      return [key, value];
    })
  );
}

/**
 * Get tool definition for LangGraph/LLM registration
 */
export function getQueryAuditToolDefinition(): {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
} {
  return {
    name: queryAuditTool.name,
    description: queryAuditTool.description,
    parameters: queryAuditTool.parameters,
  };
}
