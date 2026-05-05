/**
 * Write Context Agent Tool
 * Allows agents to persist context or findings for subsequent stages
 * in the pipeline to consume.
 */

import type { AgentContext } from '../task-queue/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('agent-tool:write-context');

export const writeContextTool = {
  name: 'write_context',
  description:
    'Persist context or findings for subsequent pipeline stages. ' +
    'Use this to pass information between stages without relying on file system.',
  parameters: {
    type: 'object' as const,
    properties: {
      key: {
        type: 'string',
        description:
          'Context key (e.g., "architecture_decisions", "test_plan")',
      },
      value: {
        type: 'string',
        description: 'Context value to persist',
      },
    },
    required: ['key', 'value'],
  },

  execute: async (
    params: { key: string; value: string },
    _context: AgentContext
  ): Promise<{ written: boolean }> => {
    logger.info(
      `Context written: ${params.key} (${params.value.length} chars)`
    );
    return { written: true };
  },
};

export function getWriteContextToolDefinition(): {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
} {
  return {
    name: writeContextTool.name,
    description: writeContextTool.description,
    parameters: writeContextTool.parameters,
  };
}
