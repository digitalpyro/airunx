/**
 * Status command - Display workflow progress and todo tracking
 */

import chalk from 'chalk';
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { StateManager } from '../../orchestrator/state-manager.js';
import type { WorkflowContext } from '../../core/types.js';

interface StatusOptions {
  all?: boolean;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  console.log(chalk.blue.bold('\n📊 AIRunX Status\n'));

  const stateManager = new StateManager();

  try {
    // Find active workflows
    const workflows = await findWorkflows(stateManager);

    if (workflows.length === 0) {
      console.log(chalk.dim('No active workflows'));

      if (options.all) {
        console.log(chalk.dim('\nNo completed workflows'));
      }

      return;
    }

    // Display each workflow
    for (const workflow of workflows) {
      if (!options.all && workflow.status === 'completed') {
        continue; // Skip completed workflows unless --all is specified
      }

      await displayWorkflowStatus(workflow);
      console.log(); // Blank line between workflows
    }

    // Summary
    const activeCount = workflows.filter((w) => w.status === 'running').length;
    const completedCount = workflows.filter(
      (w) => w.status === 'completed'
    ).length;
    const failedCount = workflows.filter((w) => w.status === 'failed').length;

    console.log(chalk.bold('Summary:'));
    console.log(
      chalk.dim(
        `  Active: ${activeCount} | Completed: ${completedCount} | Failed: ${failedCount}`
      )
    );
  } catch (error) {
    console.error(chalk.red('Error reading workflow status:'), error);
  }
}

/**
 * Find all workflows from state directory
 */
async function findWorkflows(
  stateManager: StateManager
): Promise<WorkflowContext[]> {
  const stateDir = '.agentos/state';

  if (!existsSync(stateDir)) {
    return [];
  }

  const files = await readdir(stateDir);
  const stateFiles = files.filter((f) => f.endsWith('.json'));

  const workflowPromises = stateFiles.map(async (file) => {
    const workflowId = file.replace('.json', '');
    return await stateManager.load(workflowId);
  });

  const loadedWorkflows = await Promise.all(workflowPromises);
  const workflows: WorkflowContext[] = loadedWorkflows.filter(
    (workflow): workflow is WorkflowContext => workflow !== null
  );

  // Sort by creation date (newest first)
  return workflows.sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );
}

/**
 * Display status for a single workflow
 */
async function displayWorkflowStatus(workflow: WorkflowContext): Promise<void> {
  // Header
  const statusIcon = getStatusIcon(workflow.status);
  const statusColor = getStatusColor(workflow.status);

  console.log(
    chalk.bold(
      `${statusIcon} Workflow: ${workflow.taskTitle || workflow.input}`
    )
  );

  // Status line
  const statusParts = [
    `Status: ${chalk[statusColor](workflow.status)}`,
    workflow.currentStage ? `Phase: ${workflow.currentStage}` : null,
    workflow.iterationCount !== undefined
      ? `Iteration: ${workflow.iterationCount}/${workflow.maxIterations || 3}`
      : null,
  ].filter(Boolean);

  console.log(chalk.dim(`  ${statusParts.join(' | ')}`));

  // Metrics line
  const metricsParts = [
    `Fidelity: ${workflow.fidelityLevel || 'standard'}`,
    workflow.metrics.totalRuntimeMs
      ? `Runtime: ${formatDuration(workflow.metrics.totalRuntimeMs)}`
      : null,
    workflow.metrics.totalTokens
      ? `Tokens: ${formatNumber(workflow.metrics.totalTokens)}`
      : null,
    workflow.metrics.totalCost
      ? `Cost: $${workflow.metrics.totalCost.toFixed(2)}`
      : null,
  ].filter(Boolean);

  console.log(chalk.dim(`  ${metricsParts.join(' | ')}`));

  // Todos
  const todos = workflow.todos || [];

  if (todos.length > 0) {
    console.log();
    console.log(chalk.bold('  📋 Todos:'));

    const completed = todos.filter((t) => t.status === 'completed');
    const inProgress = todos.filter((t) => t.status === 'in_progress');
    const pending = todos.filter((t) => t.status === 'pending');
    const blocked = todos.filter((t) => t.status === 'blocked');

    // Show up to 5 todos
    const displayTodos = [
      ...completed.slice(0, 2),
      ...inProgress,
      ...pending.slice(0, 2),
      ...blocked,
    ].slice(0, 5);

    for (const todo of displayTodos) {
      const todoIcon = getTodoIcon(todo.status);
      console.log(
        chalk.dim(`  ${todoIcon} ${todo.id} - ${todo.title} (${todo.status})`)
      );
    }

    // Progress
    const percentage = Math.round((completed.length / todos.length) * 100);
    console.log();
    console.log(
      chalk.dim(
        `  Progress: ${percentage}% (${completed.length}/${todos.length} completed)`
      )
    );
  }

  // Additional info
  if (workflow.branchName) {
    console.log(chalk.dim(`  Branch: ${workflow.branchName}`));
  }

  if (workflow.prUrl) {
    console.log(chalk.dim(`  PR: ${workflow.prUrl}`));
  }
}

/**
 * Get status icon
 */
function getStatusIcon(status: string): string {
  switch (status) {
    case 'completed':
      return '✅';
    case 'running':
      return '🔄';
    case 'failed':
      return '❌';
    case 'paused':
      return '⏸️';
    case 'initializing':
      return '🚀';
    default:
      return '○';
  }
}

/**
 * Get status color
 */
function getStatusColor(
  status: string
): 'green' | 'blue' | 'red' | 'yellow' | 'dim' {
  switch (status) {
    case 'completed':
      return 'green';
    case 'running':
      return 'blue';
    case 'failed':
      return 'red';
    case 'paused':
      return 'yellow';
    default:
      return 'dim';
  }
}

/**
 * Get todo icon
 */
function getTodoIcon(status: string): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'in_progress':
      return '⠼';
    case 'pending':
      return '○';
    case 'blocked':
      return '✗';
    default:
      return '○';
  }
}

/**
 * Format duration in milliseconds
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  } else if (minutes > 0) {
    return `${minutes.toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Format large numbers with K/M suffixes
 */
function formatNumber(num: number): string {
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)}M`;
  } else if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}K`;
  } else {
    return num.toString();
  }
}
