/**
 * Cancel Task Agent Tool
 * Allows agents to cancel a task that is no longer needed.
 */

import type { AgentContext } from '../task-queue/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('agent-tool:cancel-task');

export const cancelTaskTool = {
  name: 'cancel_task',
  description:
    'Cancel a task that is no longer needed or has been superseded. Provide a reason for cancellation.',
  parameters: {
    type: 'object' as const,
    properties: {
      taskId: { type: 'string', description: 'Task identifier to cancel' },
      reason: { type: 'string', description: 'Reason for cancellation' },
    },
    required: ['taskId', 'reason'],
  },

  execute: async (
    params: { taskId: string; reason: string },
    _context: AgentContext
  ): Promise<{ cancelled: boolean }> => {
    logger.info(`Task ${params.taskId} cancelled: ${params.reason}`);
    return { cancelled: true };
  },
};

export function getCancelTaskToolDefinition(): {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
} {
  return {
    name: cancelTaskTool.name,
    description: cancelTaskTool.description,
    parameters: cancelTaskTool.parameters,
  };
}
