/**
 * Create Task Agent Tool
 * Allows agents to decompose complex work by creating subtasks.
 * Max depth of 3 prevents infinite recursion.
 */

import { z } from 'zod';
import type { AgentContext } from '../task-queue/types.js';
import {
  type Priority,
  PRIORITY_LABEL_PREFIX,
  PRIORITIES,
} from '../task-queue/constants.js';

const MAX_TASK_DEPTH = 3;

const CreateTaskParamsSchema = z.object({
  title: z.string().min(1).max(256),
  body: z.string().min(1).max(65536),
  priority: z.enum(PRIORITIES).optional(),
  suggestedPipeline: z.string().optional(),
});

export interface CreateTaskResult {
  taskId: string;
  url: string;
}

export const createTaskTool = {
  name: 'create_task',
  description:
    'Create a subtask for decomposing complex work. ' +
    'Use this when a task is too large to complete in one go. ' +
    'Maximum task depth is 3 levels.',
  parameters: {
    type: 'object' as const,
    properties: {
      title: {
        type: 'string',
        description: 'Task title (max 256 characters)',
      },
      body: {
        type: 'string',
        description: 'Task description and acceptance criteria',
      },
      priority: {
        type: 'string',
        enum: ['p1', 'p2', 'p3'],
        description:
          'Priority level: p1 (critical), p2 (normal), p3 (low). Defaults to parent priority or p2.',
      },
      suggestedPipeline: {
        type: 'string',
        description: 'Recommended pipeline for this task',
      },
    },
    required: ['title', 'body'],
  },

  /**
   * Execute the create_task tool.
   * Creates a new GitHub issue as a subtask.
   */
  execute: async (
    rawParams: unknown,
    context: AgentContext
  ): Promise<CreateTaskResult> => {
    const params = CreateTaskParamsSchema.parse(rawParams);

    // Check depth limit to prevent infinite recursion
    const parentDepth = context.currentTask?.depth ?? 0;
    if (parentDepth >= MAX_TASK_DEPTH) {
      throw new Error(
        `Maximum task depth (${MAX_TASK_DEPTH}) reached. Cannot create subtask.`
      );
    }

    // Inherit priority from parent if not specified
    const priority: Priority =
      params.priority ?? context.currentTask?.priority ?? 'p2';

    const labels = ['airunx:pending', `${PRIORITY_LABEL_PREFIX}${priority}`];

    // Build issue body with metadata markers
    const bodyParts = [
      params.body,
      '',
      `<!-- airunx:parent:${context.currentTask?.id ?? 'none'} -->`,
      `<!-- airunx:depth:${parentDepth + 1} -->`,
    ];

    if (params.suggestedPipeline) {
      bodyParts.push(`<!-- airunx:pipeline:${params.suggestedPipeline} -->`);
    }

    const body = bodyParts.join('\n');

    // Create the issue
    const issue = await context.github.createIssue({
      title: params.title,
      body,
      labels,
    });

    // Log to audit
    context.auditLogger.log({
      event: 'task_created',
      workflowId: context.workflowId,
      details: {
        taskId: issue.number.toString(),
        parentTaskId: context.currentTask?.id,
        depth: parentDepth + 1,
        priority,
        title: params.title,
      },
    });

    return {
      taskId: issue.number.toString(),
      url: issue.html_url,
    };
  },
};

/**
 * Get tool definition for LangGraph/LLM registration
 */
export function getCreateTaskToolDefinition(): {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
} {
  return {
    name: createTaskTool.name,
    description: createTaskTool.description,
    parameters: createTaskTool.parameters,
  };
}
