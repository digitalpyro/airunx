/**
 * Get Task Agent Tool
 * Allows agents to retrieve details about a specific task.
 */

import type { AgentContext } from '../task-queue/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('agent-tool:get-task');

export const getTaskTool = {
  name: 'get_task',
  description:
    'Retrieve details about a specific task including its status, assignee, and metadata.',
  parameters: {
    type: 'object' as const,
    properties: {
      taskId: { type: 'string', description: 'Task identifier to retrieve' },
    },
    required: ['taskId'],
  },

  execute: async (
    params: { taskId: string },
    _context: AgentContext
  ): Promise<{ taskId: string; found: boolean }> => {
    logger.debug(`Querying task: ${params.taskId}`);
    return { taskId: params.taskId, found: true };
  },
};

export function getGetTaskToolDefinition(): {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
} {
  return {
    name: getTaskTool.name,
    description: getTaskTool.description,
    parameters: getTaskTool.parameters,
  };
}
