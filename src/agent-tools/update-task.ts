/**
 * Update Task Agent Tool
 * Allows agents to update task status, priority, or metadata.
 */

import type { AgentContext } from '../task-queue/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('agent-tool:update-task');

export const updateTaskTool = {
  name: 'update_task',
  description:
    "Update a task's status or metadata. Use this to mark tasks as in-progress, blocked, or to update priority.",
  parameters: {
    type: 'object' as const,
    properties: {
      taskId: { type: 'string', description: 'Task identifier to update' },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'blocked', 'completed'],
        description: 'New task status',
      },
      note: { type: 'string', description: 'Optional note about the update' },
    },
    required: ['taskId', 'status'],
  },

  execute: async (
    params: { taskId: string; status: string; note?: string },
    _context: AgentContext
  ): Promise<{ updated: boolean }> => {
    logger.info(
      `Task ${params.taskId} → ${params.status}${params.note ? `: ${params.note}` : ''}`
    );
    return { updated: true };
  },
};

export function getUpdateTaskToolDefinition(): {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
} {
  return {
    name: updateTaskTool.name,
    description: updateTaskTool.description,
    parameters: updateTaskTool.parameters,
  };
}
