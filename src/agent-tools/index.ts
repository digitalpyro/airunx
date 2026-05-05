/**
 * Agent Tools Index
 * Exports all agent-native tools for use in LangGraph pipelines.
 */

import {
  completeTaskTool,
  getCompleteTaskToolDefinition,
} from './complete-task.js';
import {
  listPipelinesTool,
  getListPipelinesToolDefinition,
} from './list-pipelines.js';
import { createTaskTool, getCreateTaskToolDefinition } from './create-task.js';
import { queryAuditTool, getQueryAuditToolDefinition } from './query-audit.js';
import {
  iterationHistoryTool,
  getIterationHistoryToolDefinition,
} from './iteration-history.js';
import { updateTaskTool, getUpdateTaskToolDefinition } from './update-task.js';
import { cancelTaskTool, getCancelTaskToolDefinition } from './cancel-task.js';
import { getTaskTool, getGetTaskToolDefinition } from './get-task.js';
import {
  reportProgressTool,
  getReportProgressToolDefinition,
} from './report-progress.js';
import { escalateTool, getEscalateToolDefinition } from './escalate.js';
import {
  writeContextTool,
  getWriteContextToolDefinition,
} from './write-context.js';

export {
  completeTaskTool,
  getCompleteTaskToolDefinition,
  listPipelinesTool,
  getListPipelinesToolDefinition,
  createTaskTool,
  getCreateTaskToolDefinition,
  queryAuditTool,
  getQueryAuditToolDefinition,
  iterationHistoryTool,
  getIterationHistoryToolDefinition,
  updateTaskTool,
  getUpdateTaskToolDefinition,
  cancelTaskTool,
  getCancelTaskToolDefinition,
  getTaskTool,
  getGetTaskToolDefinition,
  reportProgressTool,
  getReportProgressToolDefinition,
  escalateTool,
  getEscalateToolDefinition,
  writeContextTool,
  getWriteContextToolDefinition,
};

/**
 * All agent-native tools
 */
export const agentTools = [
  completeTaskTool,
  listPipelinesTool,
  createTaskTool,
  queryAuditTool,
  iterationHistoryTool,
  updateTaskTool,
  cancelTaskTool,
  getTaskTool,
  reportProgressTool,
  escalateTool,
  writeContextTool,
];

/**
 * Get all tool definitions for LLM registration
 */
export function getAllAgentToolDefinitions(): Array<{
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}> {
  return [
    getCompleteTaskToolDefinition(),
    getListPipelinesToolDefinition(),
    getCreateTaskToolDefinition(),
    getQueryAuditToolDefinition(),
    getIterationHistoryToolDefinition(),
    getUpdateTaskToolDefinition(),
    getCancelTaskToolDefinition(),
    getGetTaskToolDefinition(),
    getReportProgressToolDefinition(),
    getEscalateToolDefinition(),
    getWriteContextToolDefinition(),
  ];
}
