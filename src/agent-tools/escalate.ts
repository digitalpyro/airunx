/**
 * Escalate Agent Tool
 * Allows agents to escalate issues that require human attention or
 * decisions beyond the agent's authority.
 */

import type { AgentContext } from '../task-queue/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('agent-tool:escalate');

export const escalateTool = {
  name: 'escalate',
  description:
    'Escalate an issue that requires human attention or a decision beyond your authority. ' +
    'Use this when you encounter ambiguity, security concerns, or need approval.',
  parameters: {
    type: 'object' as const,
    properties: {
      reason: { type: 'string', description: 'Why this needs human attention' },
      severity: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
        description: 'Severity of the escalation',
      },
      suggestedAction: {
        type: 'string',
        description: 'What you recommend the human do (optional)',
      },
    },
    required: ['reason', 'severity'],
  },

  execute: async (
    params: { reason: string; severity: string; suggestedAction?: string },
    _context: AgentContext
  ): Promise<{ escalated: boolean }> => {
    logger.warn(
      `[${params.severity.toUpperCase()}] Escalation: ${params.reason}`
    );
    if (params.suggestedAction) {
      logger.info(`Suggested action: ${params.suggestedAction}`);
    }
    return { escalated: true };
  },
};

export function getEscalateToolDefinition(): {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
} {
  return {
    name: escalateTool.name,
    description: escalateTool.description,
    parameters: escalateTool.parameters,
  };
}
