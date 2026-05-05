/**
 * Report Progress Agent Tool
 * Allows agents to report intermediate progress on long-running tasks.
 */

import type { AgentContext } from '../task-queue/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('agent-tool:report-progress');

export const reportProgressTool = {
  name: 'report_progress',
  description:
    'Report intermediate progress on the current task. Use this for long-running work to keep the orchestrator informed.',
  parameters: {
    type: 'object' as const,
    properties: {
      message: { type: 'string', description: 'Progress update message' },
      percentComplete: {
        type: 'number',
        description: 'Estimated completion percentage (0-100)',
      },
      blockers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Any blockers encountered (optional)',
      },
    },
    required: ['message'],
  },

  execute: async (
    params: { message: string; percentComplete?: number; blockers?: string[] },
    _context: AgentContext
  ): Promise<{ acknowledged: boolean }> => {
    const pct =
      params.percentComplete != null ? ` (${params.percentComplete}%)` : '';
    logger.info(`Progress${pct}: ${params.message}`);
    if (params.blockers?.length) {
      logger.warn(`Blockers: ${params.blockers.join(', ')}`);
    }
    return { acknowledged: true };
  },
};

export function getReportProgressToolDefinition(): {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
} {
  return {
    name: reportProgressTool.name,
    description: reportProgressTool.description,
    parameters: reportProgressTool.parameters,
  };
}
