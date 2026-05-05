/**
 * PR Generator for automated pull request creation
 * Creates PRs with workflow metadata and labels
 */

import type { WorkflowContext } from '../core/types.js';
import {
  GitHubCLI,
  type GitHubPullRequest,
} from '../integrations/github-cli.js';
import { TemplateEngine } from './template-engine.js';
import { generateConventionalTitle } from './title-utils.js';
import { createLogger } from '../utils/logger.js';
import { toError } from '../utils/error-handlers.js';
import { loadSettings, type ResolvedSettings } from '../utils/settings.js';

const logger = createLogger('pr-generator');

/**
 * Options for PR generation
 */
export interface PRGeneratorOptions {
  /** Base branch for the PR (default: auto-detect) */
  baseBranch?: string;
  /** Skip label application */
  skipLabels?: boolean;
  /** Additional labels to apply */
  extraLabels?: string[];
  /** Draft PR */
  draft?: boolean;
}

/**
 * Result of PR generation
 */
export interface PRGeneratorResult {
  /** PR URL */
  url: string;
  /** PR number */
  number: number;
  /** Whether labels were applied */
  labelsApplied: boolean;
  /** Whether an existing PR was updated instead of creating a new one */
  updated: boolean;
}

/**
 * PRGenerator handles creating GitHub PRs from workflow context
 */
export class PRGenerator {
  private templateEngine: TemplateEngine;
  private settings: ResolvedSettings;

  constructor() {
    this.templateEngine = new TemplateEngine();
    // Load settings once at construction to avoid repeated filesystem access
    this.settings = loadSettings();
  }

  /**
   * Create a PR from workflow context
   * If a PR already exists for the branch, updates it instead
   */
  async create(
    context: WorkflowContext,
    options: PRGeneratorOptions = {}
  ): Promise<PRGeneratorResult> {
    logger.info('Generating pull request');
    logger.debug('PR generation context', {
      workflowId: context.id,
      branchName: context.branchName,
      worktreePath: context.worktreePath,
      repoPath: context.repoPath,
    });

    // Use worktree path for repo detection, fall back to repoPath
    // This ensures we detect the correct repository even without a worktree
    const repoDetectionPath = context.worktreePath || context.repoPath;

    // Get current repo (from worktree/repo path if available)
    const repo = await GitHubCLI.getCurrentRepo(repoDetectionPath);
    if (!repo) {
      throw new Error(
        'Could not determine repository. Ensure gh CLI is configured.'
      );
    }

    logger.info(`Repository: ${repo}`);

    // Check for existing PR
    const branch = context.branchName;
    if (branch) {
      logger.debug(`Checking for existing PR on branch: ${branch}`);
      const existingPR = await this.findExistingPR(repo, branch);
      if (existingPR) {
        logger.info(
          `[PR-UPDATE] Found existing PR #${existingPR.number} for branch ${branch}`
        );
        logger.debug('[PR-UPDATE] Existing PR details', {
          number: existingPR.number,
          url: existingPR.url,
          state: existingPR.state,
          title: existingPR.title,
        });
        return this.update(repo, existingPR, context, options);
      }
      logger.debug(`No existing PR found for branch: ${branch}`);
    }

    // Generate PR title and body
    const title = this.generateTitle(context);
    const body = await this.templateEngine.render(context);

    logger.info(`[PR-CREATE] Creating NEW pull request`);
    logger.info(`[PR-CREATE] Branch: ${context.branchName}`);
    logger.info(`[PR-CREATE] Title: ${title}`);
    logger.debug('[PR-CREATE] PR creation parameters', {
      repo,
      title,
      base: options.baseBranch || 'default',
      head: context.branchName,
      bodyLength: body.length,
    });

    // Create PR (run from worktree/repo path to ensure correct repo context)
    const pr = await GitHubCLI.createPullRequest({
      repo,
      title,
      body,
      base: options.baseBranch,
      head: context.branchName,
      cwd: repoDetectionPath,
    });

    logger.info(`[PR-CREATE] SUCCESS: Created PR #${pr.number}: ${pr.url}`);

    // Apply labels
    let labelsApplied = false;
    if (!options.skipLabels) {
      try {
        const labels = this.generateLabels(context, options.extraLabels);
        await this.applyLabels(repo, pr.number, labels);
        labelsApplied = true;
        logger.info(`Applied labels: ${labels.join(', ')}`);
      } catch (error) {
        logger.warn(`Failed to apply labels: ${toError(error).message}`);
      }
    }

    return {
      url: pr.url,
      number: pr.number,
      labelsApplied,
      updated: false,
    };
  }

  /**
   * Find an existing open PR for the given branch
   */
  private async findExistingPR(
    repo: string,
    branch: string
  ): Promise<GitHubPullRequest | null> {
    try {
      const prs = await GitHubCLI.listPullRequests(repo, {
        head: branch,
        state: 'open',
        limit: 1,
      });
      return prs[0] || null;
    } catch (error) {
      logger.warn(`Failed to check for existing PR: ${toError(error).message}`);
      return null;
    }
  }

  /**
   * Update an existing PR with new workflow metadata
   */
  private async update(
    repo: string,
    existingPR: GitHubPullRequest,
    context: WorkflowContext,
    options: PRGeneratorOptions = {}
  ): Promise<PRGeneratorResult> {
    // Generate new title and body with updated metadata
    const title = this.generateTitle(context);
    const body = await this.templateEngine.render(context);

    // Update PR title and body
    await GitHubCLI.updatePullRequest({
      repo,
      prNumber: existingPR.number,
      title,
      body,
    });

    logger.info(`Updated PR #${existingPR.number}: ${existingPR.url}`);

    // Apply labels if not skipped (labels may have changed)
    let labelsApplied = false;
    if (!options.skipLabels) {
      try {
        const labels = this.generateLabels(context, options.extraLabels);
        await this.applyLabels(repo, existingPR.number, labels);
        labelsApplied = true;
        logger.info(`Applied labels: ${labels.join(', ')}`);
      } catch (error) {
        logger.warn(`Failed to apply labels: ${toError(error).message}`);
      }
    }

    return {
      url: existingPR.url,
      number: existingPR.number,
      labelsApplied,
      updated: true,
    };
  }

  /**
   * Generate PR title from workflow context
   * Delegates to shared title-utils for consistency with auto-commit
   */
  private generateTitle(context: WorkflowContext): string {
    return generateConventionalTitle(context, undefined, this.settings);
  }

  /**
   * Generate labels for the PR
   * Uses optional chaining to handle both configured and unconfigured rules
   */
  private generateLabels(
    context: WorkflowContext,
    extraLabels?: string[]
  ): string[] {
    const rules = this.settings.gh_pr_label_rules;

    const labels: string[] = [...(rules?.always || ['ai-generated'])];

    if ((rules?.include_backend ?? true) && context.backend) {
      labels.push(`backend-${context.backend}`);
    }

    if ((rules?.include_fidelity ?? true) && context.fidelityLevel) {
      labels.push(`fidelity-${context.fidelityLevel}`);
    }

    if (rules?.custom?.length) {
      labels.push(...rules.custom);
    }

    if (extraLabels?.length) {
      labels.push(...extraLabels);
    }

    // Deduplicate labels to prevent issues when same label appears in multiple sources
    return this.filterInvalidLabels([...new Set(labels)]);
  }

  /**
   * Filter out invalid labels that could be misinterpreted as command flags
   */
  private filterInvalidLabels(labels: string[]): string[] {
    return labels.filter((label) => {
      if (label.startsWith('-')) {
        logger.warn(
          `Skipping invalid label '${label}' as it starts with a hyphen.`
        );
        return false;
      }
      return true;
    });
  }

  /**
   * Apply labels to a PR (delegates to GitHubCLI for centralized gh interactions)
   */
  private async applyLabels(
    repo: string,
    prNumber: number,
    labels: string[]
  ): Promise<void> {
    await GitHubCLI.applyLabels(repo, prNumber, labels);
  }
}
