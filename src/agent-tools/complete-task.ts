/**
 * Complete Task Agent Tool
 * Allows agents to signal task completion with summary and deliverables.
 * This shifts completion judgment from orchestrator to agent (agent-native principle).
 */

import type {
  AgentContext,
  CompleteTaskParams,
  CompleteTaskResult,
} from '../task-queue/types.js';

export const completeTaskTool = {
  name: 'complete_task',
  description:
    'Signal that you have completed the current task. ' +
    'Call this when all work is done and you are ready to report results.',
  parameters: {
    type: 'object' as const,
    properties: {
      summary: {
        type: 'string',
        description: 'Brief summary of what was accomplished',
      },
      deliverables: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of files created or modified',
      },
      testsPassing: {
        type: 'boolean',
        description: 'Whether tests pass (optional)',
      },
    },
    required: ['summary', 'deliverables'],
  },

  /**
   * Execute the complete_task tool.
   * Logs the completion signal and updates workflow state.
   */
  execute: async (
    params: CompleteTaskParams,
    context: AgentContext
  ): Promise<CompleteTaskResult> => {
    // Log completion signal to audit (no confidence gating - per DHH feedback)
    context.auditLogger.logAgentCompletionSignal(
      context.workflowId,
      params.summary,
      params.deliverables
    );

    // Update state to signal completion
    await context.stateManager.update(context.workflowId, (state) => ({
      ...state,
      // Store the agent's completion signal for the heartbeat runner to process
      agentCompletionSignal: {
        summary: params.summary,
        deliverables: params.deliverables,
        testsPassing: params.testsPassing,
      },
      // Signal that the agent believes work is complete
      shouldIterate: false,
    }));

    return { status: 'accepted' };
  },
};

/**
 * Get tool definition for LangGraph/LLM registration
 */
export function getCompleteTaskToolDefinition(): {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
} {
  return {
    name: completeTaskTool.name,
    description: completeTaskTool.description,
    parameters: completeTaskTool.parameters,
  };
}
