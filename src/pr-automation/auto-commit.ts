/**
 * Auto-commit module for PR automation
 * Handles staging, committing, and pushing changes with workflow metadata
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import Handlebars from 'handlebars';
import type { WorkflowContext } from '../core/types.js';
import { createLogger } from '../utils/logger.js';
import { toError } from '../utils/error-handlers.js';
import { formatDuration } from '../utils/formatting.js';
import { PR_AUTOMATION_DEFAULTS } from './constants.js';
import { generateConventionalTitle } from './title-utils.js';
import { GIT_OPERATION_TIMEOUT } from '../tools/git-worktree.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('auto-commit');

/**
 * Options for auto-commit
 */
export interface AutoCommitOptions {
  /** Skip pushing to remote (useful for testing) */
  skipPush?: boolean;
  /** Custom commit type prefix (default: 'feat') */
  commitType?: string;
  /** Issue number to reference in commit */
  issueNumber?: number;
}

/**
 * Result of auto-commit operation
 */
export interface AutoCommitResult {
  /** The commit SHA */
  commitSha: string;
  /** The branch name */
  branch: string;
  /** Whether push was successful */
  pushed: boolean;
}

/**
 * Default commit message template path
 */
const COMMIT_TEMPLATE_PATH = '.github/commit_template.txt';

/**
 * AutoCommit class handles git operations for workflow completion
 */
export class AutoCommit {
  /**
   * Load custom commit template if present (stateless - returns template content)
   */
  private loadTemplate(repoPath?: string): string | null {
    if (!repoPath) return null;

    const templatePath = join(repoPath, COMMIT_TEMPLATE_PATH);
    if (existsSync(templatePath)) {
      try {
        const customTemplate = readFileSync(templatePath, 'utf-8');
        logger.info(`Loaded custom commit template from: ${templatePath}`);
        return customTemplate;
      } catch (error) {
        logger.warn(
          `Failed to load custom commit template: ${toError(error).message}`
        );
      }
    }
    return null;
  }

  /**
   * Commit and push changes from a workflow
   */
  async commit(
    context: WorkflowContext,
    options: AutoCommitOptions = {}
  ): Promise<AutoCommitResult> {
    const worktree = context.worktreePath;
    if (!worktree) {
      throw new Error('No worktree path in workflow context');
    }

    logger.info(`Starting auto-commit in worktree: ${worktree}`);

    // Load custom commit template if present (stateless)
    const customTemplate = this.loadTemplate(context.repoPath);

    // Check if there are changes to commit
    const hasChanges = await this.hasChanges(worktree);
    if (!hasChanges) {
      throw new Error('No changes to commit');
    }

    // Stage all changes
    await this.stageChanges(worktree);

    // Generate commit message
    const message = this.generateMessage(context, options, customTemplate);

    // Create commit
    await this.createCommit(worktree, message);

    // Get commit SHA
    const commitSha = await this.getCommitSha(worktree);
    logger.info(`Created commit: ${commitSha.slice(0, 7)}`);

    // Push to remote - use context branch or detect from git
    const branch =
      context.branchName || (await this.getCurrentBranch(worktree));
    let pushed = false;

    if (!options.skipPush) {
      try {
        await this.pushToRemote(worktree, branch);
        pushed = true;
        logger.info(`Pushed to origin/${branch}`);
      } catch (error) {
        logger.warn(`Failed to push: ${toError(error).message}`);
      }
    }

    return {
      commitSha,
      branch,
      pushed,
    };
  }

  /**
   * Check if worktree has uncommitted changes
   */
  private async hasChanges(worktree: string): Promise<boolean> {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: worktree,
    });
    return stdout.trim().length > 0;
  }

  /**
   * Get current branch name from git
   */
  private async getCurrentBranch(worktree: string): Promise<string> {
    const { stdout } = await execFileAsync(
      'git',
      ['branch', '--show-current'],
      { cwd: worktree }
    );
    return stdout.trim();
  }

  /**
   * Stage all changes
   */
  private async stageChanges(worktree: string): Promise<void> {
    await execFileAsync('git', ['add', '.'], { cwd: worktree });
    logger.info('Staged all changes');
  }

  /**
   * Create commit with message
   */
  private async createCommit(worktree: string, message: string): Promise<void> {
    await execFileAsync('git', ['commit', '-m', message], { cwd: worktree });
  }

  /**
   * Get the SHA of the current HEAD commit
   */
  private async getCommitSha(worktree: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: worktree,
    });
    return stdout.trim();
  }

  /**
   * Push to remote with upstream tracking
   */
  private async pushToRemote(worktree: string, branch: string): Promise<void> {
    await execFileAsync('git', ['push', '-u', 'origin', branch], {
      cwd: worktree,
      timeout: GIT_OPERATION_TIMEOUT * 2, // remote ops get 2x the local timeout
      env: { ...process.env, AIRUNX_ALLOW_PUSH: '1' },
    });
  }

  /**
   * Generate commit message with workflow metadata
   * Uses custom template from .github/commit_template.txt if present,
   * otherwise falls back to default format.
   *
   * Template variables:
   * - {{commitSubject}} - Full conventional commit subject (e.g., "feat: Add feature")
   * - {{issueRef}} - Issue reference (e.g., " (#123)")
   * - {{fidelity}} - Fidelity level
   * - {{backend}} - Backend name
   * - {{iterations}} - Current/max iterations
   * - {{tokens}} - Total tokens used
   * - {{cost}} - Total cost
   * - {{runtime}} - Total runtime
   * - {{todos}} - Completed todos list
   */
  generateMessage(
    context: WorkflowContext,
    options: AutoCommitOptions = {},
    customTemplate: string | null = null
  ): string {
    // Use shared title generation for consistency with PR titles
    const commitSubject = generateConventionalTitle(
      context,
      options.commitType
    );
    const issueRef = options.issueNumber ? ` (#${options.issueNumber})` : '';

    const completedTodos =
      context.todos?.filter((t) => t.status === 'completed') || [];
    const todoList =
      completedTodos.length > 0
        ? completedTodos.map((t) => `✓ ${t.title}`).join('\n')
        : 'No specific todos tracked';

    const runtime = formatDuration(context.metrics?.totalRuntimeMs || 0);
    const tokens = (context.metrics?.totalTokens || 0).toLocaleString();
    const cost = (context.metrics?.totalCost || 0).toFixed(2);

    const fidelity =
      context.fidelityLevel || PR_AUTOMATION_DEFAULTS.FIDELITY_LEVEL;
    const backend = context.backend || PR_AUTOMATION_DEFAULTS.BACKEND;
    const maxIterations =
      context.maxIterations || PR_AUTOMATION_DEFAULTS.MAX_ITERATIONS;
    const iterations = `${context.iterationCount || 0}/${maxIterations}`;

    // Use custom template if provided, otherwise use default format
    if (customTemplate) {
      try {
        const template = Handlebars.compile(customTemplate, {
          noEscape: true,
        });
        return template({
          commitSubject,
          issueRef,
          fidelity,
          backend,
          iterations,
          tokens,
          cost,
          runtime,
          todos: todoList,
        });
      } catch (error) {
        logger.warn(
          `Failed to compile custom commit template, falling back to default format: ${toError(error).message}`
        );
      }
    }

    return `${commitSubject}${issueRef}

Implemented via AIRunX workflow

Execution Details:
- Fidelity: ${fidelity}
- Backend: ${backend}
- Iterations: ${iterations}
- Tokens: ${tokens}
- Cost: $${cost}
- Runtime: ${runtime}

Todos Completed:
${todoList}

Co-authored-by: AIRunX <254062095+airunx@users.noreply.github.com>`;
  }
}
