/**
 * Iteration History Agent Tool
 * Allows agents to query previous iteration attempts to avoid repeating failed approaches.
 */

import type { AgentContext } from '../task-queue/types.js';
import { IterationHistory } from '../orchestrator/iteration-history.js';

export const iterationHistoryTool = {
  name: 'iteration_history',
  description:
    'Get history of previous iterations to avoid repeating failed approaches. ' +
    'Returns a list of what was tried, what verdict the judge gave, and what gaps remain. ' +
    'Recurring gaps (appearing 2+ times) are highlighted - address these first.',
  parameters: {
    type: 'object' as const,
    properties: {},
    required: [] as string[],
  },

  /**
   * Execute the iteration_history tool.
   * Returns formatted history from the current workflow.
   */
  execute: async (
    _params: unknown,
    context: AgentContext
  ): Promise<{ success: boolean; history: string }> => {
    const history = new IterationHistory(
      context.stateManager,
      context.workflowId
    );
    const formatted = await history.formatForAgent();
    return { success: true, history: formatted };
  },
};

/**
 * Get tool definition for LangGraph/LLM registration
 */
export function getIterationHistoryToolDefinition(): {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
} {
  return {
    name: iterationHistoryTool.name,
    description: iterationHistoryTool.description,
    parameters: iterationHistoryTool.parameters,
  };
}
