/**
 * List Pipelines Agent Tool
 * Returns available pipelines with their descriptions.
 * Allows agents to make informed decisions about which pipeline to use.
 */

import type { AgentContext, PipelineInfo } from '../task-queue/types.js';

export const listPipelinesTool = {
  name: 'list_pipelines',
  description:
    'List all available pipelines with their descriptions. ' +
    'Use this to understand your options before deciding which pipeline to execute.',
  parameters: {
    type: 'object' as const,
    properties: {},
    required: [] as string[],
  },

  /**
   * Execute the list_pipelines tool.
   * Returns all available pipelines from the loaded configuration.
   */
  execute: async (
    _params: Record<string, never>,
    context: AgentContext
  ): Promise<PipelineInfo[]> => {
    const pipelineConfig = context.pipelineConfig;

    if (!pipelineConfig || !pipelineConfig.pipelines) {
      return [];
    }

    return Object.values(pipelineConfig.pipelines).map((pipeline) => ({
      name: pipeline.name,
      description: pipeline.description || '',
      stages: pipeline.stages?.map((stage) => stage.name) || [],
      // whenToUse could be added to pipeline schema in the future
    }));
  },
};

/**
 * Get tool definition for LangGraph/LLM registration
 */
export function getListPipelinesToolDefinition(): {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
} {
  return {
    name: listPipelinesTool.name,
    description: listPipelinesTool.description,
    parameters: listPipelinesTool.parameters,
  };
}
