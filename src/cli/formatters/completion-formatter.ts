/**
 * Completion Formatter - Status-aware workflow completion output
 *
 * Provides different output formatting based on workflow status:
 * - completed: Success message with next steps
 * - completed_with_errors: Warning with failed stages and recovery steps
 * - failed: Error message with diagnostic guidance
 *
 * Supports both TTY (colorful) and non-TTY (plain text) output modes.
 */

import chalk from 'chalk';
import type { WorkflowContext, WorkflowStatus } from '../../core/types.js';

/**
 * Status configuration for all WorkflowStatus values
 */
const STATUS_CONFIG: Record<
  WorkflowStatus,
  { symbol: string; color: typeof chalk.green; message: string }
> = {
  completed: {
    symbol: '✅',
    color: chalk.green,
    message: 'Workflow completed successfully',
  },
  completed_with_errors: {
    symbol: '⚠️',
    color: chalk.yellow,
    message: 'Workflow completed with errors',
  },
  failed: {
    symbol: '❌',
    color: chalk.red,
    message: 'Workflow failed',
  },
  running: {
    symbol: '🔄',
    color: chalk.blue,
    message: 'Workflow running',
  },
  initializing: {
    symbol: '🔧',
    color: chalk.cyan,
    message: 'Workflow initializing',
  },
  paused: {
    symbol: '⏸️',
    color: chalk.yellow,
    message: 'Workflow paused',
  },
};

/**
 * Formatted completion output structure
 */
export interface FormattedCompletion {
  header: string;
  summary: string[];
  failedStages: string[];
  metrics: string[];
  nextSteps: string[];
}

/**
 * Format completion options
 */
export interface FormatOptions {
  /** Whether output is for a TTY (enables colors and symbols) */
  tty: boolean;
}

/**
 * Format workflow completion for display
 */
export function formatCompletion(
  context: WorkflowContext,
  options: FormatOptions
): FormattedCompletion {
  const status = context.status as WorkflowStatus;
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.failed;

  // Build header based on TTY mode
  const header = options.tty
    ? `${config.symbol} ${config.color(config.message)}`
    : `[${status.toUpperCase()}] ${config.message}`;

  // Extract failed stages
  const failedStages = extractFailedStages(context);

  // Build metrics
  const metrics = buildMetrics(context);

  // Generate context-aware next steps
  const nextSteps = generateNextSteps(status, failedStages, context);

  return {
    header,
    summary: buildSummary(context),
    failedStages,
    metrics,
    nextSteps,
  };
}

/**
 * Format completion as JSON for CI/CD integration
 */
export function formatCompletionJson(context: WorkflowContext): object {
  const failedStages = extractFailedStageNames(context);

  return {
    status: context.status,
    workflowId: context.id,
    totalStages: context.metrics.totalStages || 0,
    completedStages: context.metrics.stagesCompleted || 0,
    failedStages,
    errors: extractErrors(context),
    metrics: {
      tokensUsed: context.metrics.totalTokens || 0,
      cost: context.metrics.totalCost || 0,
      durationMs: context.metrics.totalRuntimeMs || 0,
      iterations: context.iterationCount || 0,
    },
    startedAt: context.createdAt?.toISOString?.() ?? new Date().toISOString(),
    maxIterations: context.maxIterations ?? 1,
    stageRecords: context.stageRecords ?? [],
    iterationHistory: context.iterationHistory?.entries ?? [],
    taskTitle: context.taskTitle,
    pipelineName: context.pipelineName,
    todos: context.todos ?? [],
    nextSteps: generateNextSteps(context.status, failedStages, context),
    worktreePath: context.worktreePath,
    branchName: context.branchName,
    prUrl: context.prUrl,
    prNumber: context.prNumber,
    commitSha: context.commitSha,
    failureReason: context.failureReason,
  };
}

/**
 * Display formatted completion to console
 */
export function displayCompletion(
  context: WorkflowContext,
  options?: FormatOptions
): void {
  const opts = options || { tty: process.stdout.isTTY ?? true };
  const formatted = formatCompletion(context, opts);

  // Display header
  console.log();
  console.log(formatted.header);
  console.log();

  // Display workflow ID and basic info
  console.log(chalk.dim(`  Workflow ID: ${context.id}`));
  console.log(chalk.dim(`  Status: ${context.status}`));
  if (context.iterationCount) {
    console.log(chalk.dim(`  Iterations: ${context.iterationCount}`));
  }

  // Display failed stages if any
  if (formatted.failedStages.length > 0) {
    console.log();
    console.log(chalk.yellow('Failed Stages:'));
    formatted.failedStages.forEach((stage) => {
      console.log(chalk.yellow(`  - ${stage}`));
    });
  }

  // Display metrics
  if (formatted.metrics.length > 0) {
    console.log();
    formatted.metrics.forEach((metric) => {
      console.log(chalk.dim(`  ${metric}`));
    });
  }

  // Display next steps
  if (formatted.nextSteps.length > 0) {
    console.log();
    console.log(chalk.bold('Next Steps:'));
    formatted.nextSteps.forEach((step, i) => {
      console.log(`  ${i + 1}. ${step}`);
    });
  }

  console.log();
}

/**
 * Extract failed stages with error summaries
 */
function extractFailedStages(context: WorkflowContext): string[] {
  const failed: string[] = [];

  if (context.stageResults) {
    for (const [name, result] of Object.entries(context.stageResults)) {
      if (
        result &&
        typeof result === 'object' &&
        'success' in result &&
        !result.success
      ) {
        const resultObj = result as {
          success: boolean;
          errors?: Array<{ message?: string }>;
        };
        const errorMsg = resultObj.errors?.[0]?.message || 'Unknown error';
        failed.push(`${name}: ${truncate(errorMsg, 80)}`);
      }
    }
  }

  return failed;
}

/**
 * Extract just the names of failed stages
 */
function extractFailedStageNames(context: WorkflowContext): string[] {
  const failed: string[] = [];

  if (context.stageResults) {
    for (const [name, result] of Object.entries(context.stageResults)) {
      if (
        result &&
        typeof result === 'object' &&
        'success' in result &&
        !result.success
      ) {
        failed.push(name);
      }
    }
  }

  return failed;
}

/**
 * Extract all errors from stage results
 */
function extractErrors(context: WorkflowContext): string[] {
  const errors: string[] = [];

  if (context.stageResults) {
    for (const [, result] of Object.entries(context.stageResults)) {
      if (
        result &&
        typeof result === 'object' &&
        'errors' in result &&
        Array.isArray(result.errors)
      ) {
        for (const err of result.errors) {
          if (err && typeof err === 'object' && 'message' in err) {
            errors.push(String(err.message));
          }
        }
      }
    }
  }

  return errors;
}

/**
 * Build summary information
 */
function buildSummary(context: WorkflowContext): string[] {
  const summary: string[] = [];

  if (context.taskTitle) {
    summary.push(`Task: ${context.taskTitle}`);
  }

  if (context.pipelineName) {
    summary.push(`Pipeline: ${context.pipelineName}`);
  }

  if (context.backend) {
    summary.push(`Backend: ${context.backend}`);
  }

  return summary;
}

/**
 * Build metrics display
 */
function buildMetrics(context: WorkflowContext): string[] {
  const metrics: string[] = [];

  if (context.metrics.totalTokens) {
    metrics.push(
      `Tokens Used: ${context.metrics.totalTokens.toLocaleString()}`
    );
  }

  if (context.metrics.totalCost != null && context.metrics.totalCost > 0) {
    metrics.push(`Cost: $${context.metrics.totalCost.toFixed(4)}`);
  } else if (context.metrics.totalTokens && context.metrics.totalCost == null) {
    metrics.push('Cost: N/A');
  }

  if (context.metrics.totalRuntimeMs) {
    const seconds = (context.metrics.totalRuntimeMs / 1000).toFixed(1);
    metrics.push(`Duration: ${seconds}s`);
  }

  const completed = context.metrics.stagesCompleted || 0;
  const total = context.metrics.totalStages || 0;
  if (total > 0) {
    metrics.push(`Stages: ${completed}/${total} completed`);
  }

  return metrics;
}

/**
 * Generate context-aware next steps based on workflow status
 */
function generateNextSteps(
  status: WorkflowStatus,
  failedStages: string[],
  context: WorkflowContext
): string[] {
  const steps: string[] = [];

  switch (status) {
    case 'completed':
      if (context.worktreePath) {
        steps.push('Review changes in the worktree');
      }
      steps.push('Run tests to verify implementation');
      steps.push('Create a pull request');
      break;

    case 'completed_with_errors':
      if (failedStages.length > 0) {
        const stageNames = failedStages.map((s) => s.split(':')[0]).join(', ');
        steps.push(`Review failed stages: ${stageNames}`);
      }
      steps.push('Run airunx doctor to check backend status');
      if (context.worktreePath) {
        steps.push(`Review changes in worktree: ${context.worktreePath}`);
      }
      steps.push('Enable DEBUG=1 for detailed logs');
      break;

    case 'failed': {
      // Detect failure pattern for targeted advice
      const errorPattern = detectErrorPattern(context);
      if (errorPattern === 'auth') {
        steps.push('Backend authentication required');
        steps.push('Run: airunx doctor to check backend status');
        if (context.backend === 'cursor') {
          steps.push('Run: cursor-agent login');
        }
      } else if (errorPattern === 'timeout') {
        steps.push('Execution timed out');
        steps.push('Try again with --fidelity fast for shorter timeout');
        steps.push('Check if backend service is available');
      } else if (errorPattern === 'circuit') {
        steps.push('Backend circuit breaker is OPEN');
        steps.push('Run: airunx circuit status');
        steps.push('Run: airunx circuit reset <backend> to force retry');
      } else {
        steps.push('Check backend configuration: airunx doctor');
      }
      steps.push('Enable DEBUG=1 for detailed logs');
      break;
    }

    default:
      steps.push('Check workflow status: airunx status');
  }

  return steps;
}

/**
 * Detect error pattern from workflow context
 */
function detectErrorPattern(
  context: WorkflowContext
): 'auth' | 'timeout' | 'circuit' | 'unknown' {
  const errors = extractErrors(context);
  const combined = errors.join(' ').toLowerCase();

  if (
    combined.includes('circuit') ||
    combined.includes('CircuitOpenError'.toLowerCase())
  ) {
    return 'circuit';
  }

  if (
    combined.includes('not logged in') ||
    combined.includes('authentication') ||
    combined.includes('sign in') ||
    combined.includes('unauthorized')
  ) {
    return 'auth';
  }

  if (combined.includes('timeout') || combined.includes('timed out')) {
    return 'timeout';
  }

  return 'unknown';
}

/**
 * Truncate string to max length with ellipsis
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength - 3) + '...';
}
