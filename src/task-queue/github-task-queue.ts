/**
 * GitHub Task Queue
 * Uses GitHub Issues as a task queue for heartbeat execution mode.
 * Labels act as a state machine: airunx:pending -> airunx:running -> airunx:completed/failed
 */

import { GitHubCLI } from '../integrations/github-cli.js';
import { createLogger } from '../utils/logger.js';
import type { GitHubTask, TaskQueue, TaskResult } from './types.js';
import {
  type Priority,
  DEFAULT_PRIORITY,
  PRIORITY_LABEL_PREFIX,
} from './constants.js';

const logger = createLogger('github-task-queue');

export class GitHubTaskQueue implements TaskQueue {
  private repo: string;
  private currentUser: string;
  private heartbeatCommentIds: Map<string, number> = new Map();

  constructor(repo: string, currentUser: string) {
    this.repo = repo;
    this.currentUser = currentUser;
  }

  /**
   * Factory method to create GitHubTaskQueue with auto-detected user
   */
  static async create(repo: string): Promise<GitHubTaskQueue> {
    const currentUser = await GitHubCLI.getCurrentUser();
    return new GitHubTaskQueue(repo, currentUser);
  }

  /**
   * Poll for available tasks with airunx:pending label
   * Returns tasks sorted by priority (p1 > p2 > p3), then by creation date (FIFO)
   */
  async pollTasks(): Promise<GitHubTask[]> {
    logger.debug(`Polling for tasks in ${this.repo}`);

    const issues = await GitHubCLI.listIssues(this.repo, {
      labels: ['airunx:pending'],
      state: 'open',
    });

    const tasks = issues.map((issue) => this.mapIssueToTask(issue));

    // Sort by priority first, then by creation date within same priority (FIFO)
    const sortedTasks = this.sortByPriority(tasks);

    logger.debug(`Found ${sortedTasks.length} pending task(s)`);
    return sortedTasks;
  }

  /**
   * Sort tasks by priority (p1 > p2 > p3), then by creation date (FIFO)
   */
  private sortByPriority(tasks: GitHubTask[]): GitHubTask[] {
    const order: Record<Priority, number> = { p1: 0, p2: 1, p3: 2 };
    return tasks.sort((a, b) => {
      const diff = order[a.priority] - order[b.priority];
      return diff !== 0 ? diff : a.createdAt.getTime() - b.createdAt.getTime();
    });
  }

  /**
   * Extract priority from issue labels.
   * Checks explicitly in order of importance: p1 > p2 > p3.
   * Format: airunx:priority:p1, airunx:priority:p2, airunx:priority:p3
   */
  private extractPriority(labels: string[]): Priority {
    if (labels.includes(`${PRIORITY_LABEL_PREFIX}p1`)) return 'p1';
    if (labels.includes(`${PRIORITY_LABEL_PREFIX}p2`)) return 'p2';
    if (labels.includes(`${PRIORITY_LABEL_PREFIX}p3`)) return 'p3';
    return DEFAULT_PRIORITY;
  }

  /**
   * Extract depth from issue body comment marker
   * Format: <!-- airunx:depth:N -->
   */
  private extractDepthFromBody(body: string | null): number | undefined {
    const match = body?.match(/<!-- airunx:depth:(\d+) -->/);
    return match ? parseInt(match[1], 10) : undefined;
  }

  /**
   * Optimistic concurrency checkout: assign-then-verify to prevent TOCTOU race.
   * Includes rollback on failure.
   *
   * @returns true if checkout succeeded, false if another agent won the race
   */
  async checkoutTask(taskId: string): Promise<boolean> {
    logger.info(`Attempting to checkout task #${taskId}`);

    try {
      // Step 1: Optimistically assign to self
      await GitHubCLI.assignIssue(this.repo, taskId, this.currentUser);

      // Step 2: Verify we actually got it (another agent may have won)
      const assignees = await GitHubCLI.getIssueAssignees(
        this.repo,
        parseInt(taskId, 10)
      );
      const isOurs = assignees.includes(this.currentUser);

      if (!isOurs) {
        // Lost the race - clean up our failed assignment attempt
        logger.warn(`Lost checkout race for task #${taskId}`);
        await GitHubCLI.unassignIssue(
          this.repo,
          taskId,
          this.currentUser
        ).catch((err) => {
          logger.warn(
            `Failed to unassign self after losing checkout race for task #${taskId}`,
            err
          );
        });
        return false;
      }

      // Step 3: Update labels (with rollback on failure)
      try {
        await GitHubCLI.updateIssueLabels(this.repo, taskId, {
          remove: ['airunx:pending'],
          add: ['airunx:running'],
        });
      } catch (error) {
        // Rollback assignment on label update failure
        logger.error(`Label update failed for task #${taskId}, rolling back`);
        await GitHubCLI.unassignIssue(
          this.repo,
          taskId,
          this.currentUser
        ).catch((err) => {
          logger.warn(
            `Failed to unassign during rollback for task #${taskId}`,
            err
          );
        });
        throw error;
      }

      // Step 4: Create initial heartbeat comment (will be edited, not recreated)
      await this.updateHeartbeatTimestamp(taskId);

      logger.info(`Successfully checked out task #${taskId}`);
      return true;
    } catch (error) {
      logger.error(`Checkout failed for task #${taskId}:`, error);
      throw error;
    }
  }

  /**
   * Update heartbeat by EDITING existing comment, not creating new ones.
   * Prevents 360 comments/hour per task (if updating every 10s).
   */
  async updateHeartbeatTimestamp(taskId: string): Promise<void> {
    const timestamp = new Date().toISOString();
    const commentBody = `<!-- airunx:heartbeat:${timestamp} -->\n_AIRunX heartbeat: ${timestamp}_`;

    const existingCommentId = this.heartbeatCommentIds.get(taskId);
    if (existingCommentId) {
      // Edit existing comment
      await GitHubCLI.updateIssueComment(
        this.repo,
        existingCommentId,
        commentBody
      );
      logger.debug(`Updated heartbeat comment for task #${taskId}`);
    } else {
      // Create first heartbeat comment and store ID
      const comment = await GitHubCLI.createIssueComment(
        this.repo,
        parseInt(taskId, 10),
        commentBody
      );
      this.heartbeatCommentIds.set(taskId, comment.id);
      logger.debug(
        `Created heartbeat comment ${comment.id} for task #${taskId}`
      );
    }
  }

  /**
   * Mark task as completed: update labels, add completion comment.
   * Issue closure is handled by the PR's "Closes <issue>" keyword on merge.
   * Guards against false completions — refuses to complete if no PR exists.
   */
  async completeTask(taskId: string, result: TaskResult): Promise<void> {
    if (!result.prUrl) {
      logger.warn(
        `Task #${taskId} reported completed but has no PR — treating as failed`
      );
      await this.failTask(taskId, {
        ...result,
        status: 'failed',
        error: new Error('Completed without PR: no pull request was created'),
      });
      return;
    }

    logger.info(`Completing task #${taskId}`);

    await GitHubCLI.updateIssueLabels(this.repo, taskId, {
      remove: ['airunx:running'],
      add: ['airunx:completed'],
    });

    await GitHubCLI.addIssueComment({
      repo: this.repo,
      issueNumber: parseInt(taskId, 10),
      body: this.formatCompletionComment(result),
    });

    // Cleanup heartbeat comment tracking
    this.heartbeatCommentIds.delete(taskId);

    logger.info(`Task #${taskId} completed successfully`);
  }

  /**
   * Mark task as failed: update labels and add failure comment with metrics
   */
  async failTask(taskId: string, result: TaskResult): Promise<void> {
    logger.info(`Marking task #${taskId} as failed`);

    await GitHubCLI.updateIssueLabels(this.repo, taskId, {
      remove: ['airunx:running'],
      add: ['airunx:failed'],
    });

    const errorMessage = result.error?.message ?? 'Unknown error';
    let body = `**AIRunX Failed**\n\n\`\`\`\n${errorMessage}\n\`\`\``;
    if (result.runReport && result.runReport.stages.length > 0) {
      body += '\n\n' + formatRunReportTables(result.runReport);
    }
    body += formatMetricsLine(result.metrics);

    await GitHubCLI.addIssueComment({
      repo: this.repo,
      issueNumber: parseInt(taskId, 10),
      body,
    });

    // Cleanup heartbeat comment tracking
    this.heartbeatCommentIds.delete(taskId);

    logger.warn(`Task #${taskId} marked as failed`);
  }

  /**
   * Release task back to pending state (for graceful shutdown)
   */
  async releaseTask(taskId: string): Promise<void> {
    logger.info(`Releasing task #${taskId}`);

    await GitHubCLI.unassignIssue(this.repo, taskId, this.currentUser);

    await GitHubCLI.updateIssueLabels(this.repo, taskId, {
      remove: ['airunx:running'],
      add: ['airunx:pending'],
    });

    // Cleanup heartbeat comment tracking
    this.heartbeatCommentIds.delete(taskId);

    logger.info(`Task #${taskId} released back to pending`);
  }

  /**
   * Map GitHub issue to GitHubTask format
   */
  private mapIssueToTask(issue: {
    number: number;
    title: string;
    body: string;
    labels: string[];
    url: string;
    createdAt: string;
    author: string;
  }): GitHubTask {
    return {
      id: issue.number.toString(),
      issueUrl: issue.url,
      title: issue.title,
      body: issue.body || '',
      labels: issue.labels,
      suggestedPipeline: this.extractPipelineFromBody(issue.body),
      assignee: undefined, // Not assigned yet when polling pending tasks
      createdAt: new Date(issue.createdAt),
      priority: this.extractPriority(issue.labels),
      depth: this.extractDepthFromBody(issue.body),
    };
  }

  /**
   * Extract pipeline name from issue body comment marker
   * Format: <!-- airunx:pipeline:pipeline-name -->
   */
  private extractPipelineFromBody(body: string | null): string | undefined {
    // Use [\w-]+ to support hyphenated names like 'mission-critical'
    const match = body?.match(/<!-- airunx:pipeline:([\w-]+) -->/);
    return match?.[1];
  }

  /**
   * Format completion comment with results.
   * Renders rich Pipeline Execution table and Timeline when runReport is available,
   * falls back to simple one-liner metrics when not.
   */
  private formatCompletionComment(result: TaskResult): string {
    const parts = ['**AIRunX Completed**', ''];

    if (result.summary) {
      parts.push(`**Summary:** ${result.summary}`, '');
    }

    if (result.prUrl) {
      parts.push(`**PR:** ${result.prUrl}`, '');
    }

    if (result.deliverables && result.deliverables.length > 0) {
      parts.push('**Deliverables:**');
      for (const item of result.deliverables) {
        parts.push(`- \`${item}\``);
      }
      parts.push('');
    }

    if (result.runReport && result.runReport.stages.length > 0) {
      parts.push(formatRunReportTables(result.runReport));
    }

    // Always include the summary metrics line at the bottom
    parts.push(formatMetricsLine(result.metrics));

    return parts.join('\n').trim();
  }
}

/**
 * Format run report as Pipeline Execution table and Timeline.
 * Matches the format from jasonspalace/ai-cli-swarm#227.
 */
function formatRunReportTables(
  report: import('../core/types.js').RunReport
): string {
  const parts: string[] = [];

  // Pipeline Execution table
  parts.push('### Pipeline Execution', '');
  parts.push(
    '| # | Stage | Agent | Backend | Spawns | Duration | Tokens | Est. Cost |'
  );
  parts.push(
    '|---|-------|-------|---------|--------|----------|--------|-----------|'
  );

  let totalTokens = 0;
  let totalCost = 0;
  let totalSpawns = 0;

  report.stages.forEach((stage, index) => {
    const duration = formatDurationCompact(stage.durationMs);
    const tokens = stage.tokensUsed.toLocaleString('en-US');
    const cost = `$${stage.costUsd.toFixed(4)}`;
    totalTokens += stage.tokensUsed;
    totalCost += stage.costUsd;
    totalSpawns += stage.spawnCount;

    parts.push(
      `| ${index + 1} | ${stage.stage} | ${stage.agent} | ${stage.backend} | ${stage.spawnCount} | ${duration} | ${tokens} | ${cost} |`
    );
  });

  // Totals row
  parts.push(
    `| | **Totals** | | | **${totalSpawns}** | **${formatDurationCompact(report.totalDurationMs)}** | **${totalTokens.toLocaleString('en-US')}** | **$${totalCost.toFixed(4)}** |`
  );
  parts.push('');

  // Timeline
  if (report.timeline.length > 0) {
    parts.push('### Timeline', '', '```');
    for (const event of report.timeline) {
      const time = new Date(event.timestamp).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
      parts.push(`${time}  ${event.event}`);
    }
    parts.push('```', '');
  }

  return parts.join('\n');
}

/**
 * Format milliseconds as a compact human-readable duration (e.g., "5m 11s")
 */
function formatDurationCompact(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/**
 * Format a metrics line for GitHub issue comments.
 * Omits individual fields that are undefined (unknown != zero).
 * Returns empty string when no metrics are available.
 */
function formatMetricsLine(metrics?: TaskResult['metrics']): string {
  if (!metrics) return '';

  const parts: string[] = [];
  if (metrics.costUsd != null)
    parts.push(`Cost: $${metrics.costUsd.toFixed(4)}`);
  if (metrics.tokensUsed != null)
    parts.push(`Tokens: ${metrics.tokensUsed.toLocaleString('en-US')}`);
  if (metrics.durationMs != null)
    parts.push(`Duration: ${(metrics.durationMs / 1000).toFixed(1)}s`);
  if (metrics.iterations != null)
    parts.push(`Iterations: ${metrics.iterations}`);

  return parts.length > 0 ? `\n\n:bar_chart: ${parts.join(' | ')}` : '';
}
