/**
 * Git worktree management
 * Create and manage isolated git worktrees for parallel execution
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, basename } from 'path';
import { randomBytes } from 'crypto';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { createLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

/**
 * Timeout for git operations in milliseconds (30 seconds)
 * Prevents indefinite hangs on network issues or disk/lock contention
 */
export const GIT_OPERATION_TIMEOUT = 30000;

/**
 * Max buffer size for git command output (10MB)
 */
export const GIT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Branch/directory name prefix for worktree branches
 */
const BRANCH_PREFIX = 'airunx-';

/**
 * Directory name for worktree storage
 */
const WORKTREE_DIR = '.worktrees';

/**
 * Custom error class for main branch determination failures
 * Allows for more robust error handling than string matching
 */
export class MainBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MainBranchError';
  }
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  id: string;
}

/**
 * Options for syncing a branch with its remote tracking branch
 */
export interface SyncOptions {
  /** Branch to sync */
  branch: string;
}

/**
 * Result of a branch sync operation
 */
export interface SyncResult {
  /** Whether the branch was successfully synced */
  synced: boolean;
  /** Number of commits the branch was behind (if synced) */
  commitsBehind?: number;
  /** Human-readable message about the sync result */
  message: string;
}

export class GitWorktreeManager {
  private basePath: string;
  private logger: Logger;
  private configuredBaseBranch: string | null = null;

  constructor(basePath?: string, configuredBaseBranch?: string | null) {
    this.basePath = basePath || process.cwd();
    this.logger = createLogger('git-worktree');
    this.configuredBaseBranch = configuredBaseBranch || null;
  }

  /**
   * Extract error message from unknown error type
   * Handles both Error instances and other thrown values
   */
  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Set the configured base branch (from settings)
   */
  setConfiguredBaseBranch(branch: string | null): void {
    this.configuredBaseBranch = branch;
  }

  /**
   * Check if current directory is a git repository
   */
  async isGitRepo(): Promise<boolean> {
    try {
      await execFileAsync('git', ['rev-parse', '--git-dir'], {
        cwd: this.basePath,
        timeout: GIT_OPERATION_TIMEOUT,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get main/master branch name
   *
   * Priority:
   * 1. Configured base branch from settings (if set and valid)
   * 2. Remote HEAD reference (git symbolic-ref refs/remotes/origin/HEAD)
   * 3. Common branch names: main, master, develop
   */
  async getMainBranch(): Promise<string> {
    try {
      // Priority 1: Use configured base branch if set
      if (this.configuredBaseBranch) {
        // Verify the configured branch exists
        try {
          await execFileAsync(
            'git',
            ['rev-parse', '--verify', this.configuredBaseBranch],
            { cwd: this.basePath, timeout: GIT_OPERATION_TIMEOUT }
          );
          this.logger.debug(
            `Using configured base branch: ${this.configuredBaseBranch}`
          );
          return this.configuredBaseBranch;
        } catch {
          this.logger.warn(
            `Configured base branch '${this.configuredBaseBranch}' does not exist, falling back to auto-detection`
          );
        }
      }

      // Priority 2: Try to get default branch from remote
      let stdout = '';
      try {
        const result = await execFileAsync(
          'git',
          ['symbolic-ref', 'refs/remotes/origin/HEAD'],
          { cwd: this.basePath, timeout: GIT_OPERATION_TIMEOUT }
        );
        stdout = result.stdout;
      } catch (error: unknown) {
        // Any failure in getting the remote HEAD is non-critical.
        // Log a warning and proceed to the fallback of checking local branches.
        this.logger.warn(
          `Could not determine default branch from remote HEAD, falling back to local branches. Reason: ${this.getErrorMessage(error)}`
        );
      }

      if (stdout.trim()) {
        const remoteBranch = stdout.trim().replace('refs/remotes/origin/', '');
        // Verify the branch exists locally or as a remote tracking ref
        // before returning — the remote HEAD may point to a branch that
        // was never checked out locally (e.g., origin/HEAD → main but
        // only master exists locally)
        if (await this.branchExistsLocallyOrRemote(remoteBranch)) {
          return remoteBranch;
        }
        this.logger.warn(
          `Remote HEAD points to '${remoteBranch}' but it does not exist locally or on remote, falling back to local branches`
        );
      }

      // Priority 3: Fallback to common branch names
      for (const branch of ['main', 'master', 'develop']) {
        if (await this.branchExistsLocallyOrRemote(branch)) {
          return branch;
        }
      }

      // Last resort: fail if no standard branch is found
      // Using the current branch as a fallback is dangerous because developers
      // might be on feature branches, leading to incorrect or nested feature development
      throw new MainBranchError(
        'Could not determine main branch (checked main, master, develop). ' +
          'Please ensure one of these branches exists, or specify a base branch explicitly with --base-branch or default_base_branch in settings.'
      );
    } catch (error) {
      // If this is our specific error, re-throw it to give the user the detailed message.
      if (error instanceof MainBranchError) {
        throw error;
      }
      // For other unexpected errors, wrap them for context.
      throw new Error('Failed to determine main branch', {
        cause: error as Error,
      });
    }
  }

  /**
   * Generate unique worktree identifier
   */
  private generateId(): string {
    return randomBytes(8).toString('hex');
  }

  /**
   * Create a new worktree
   */
  async createWorktree(
    options: {
      branchName?: string;
      baseBranch?: string;
      issueNumber?: number;
    } = {}
  ): Promise<WorktreeInfo> {
    const isRepo = await this.isGitRepo();
    if (!isRepo) {
      throw new Error(`Not a git repository: ${this.basePath}`);
    }

    const id = this.generateId();
    const mainBranch = options.baseBranch || (await this.getMainBranch());

    // Generate the worktree name (used for both branch and directory)
    const suffix = options.issueNumber
      ? `issue-${options.issueNumber}`
      : 'feature';
    const worktreeName = `${BRANCH_PREFIX}${suffix}-${id}`;

    // Use custom branch name if provided, otherwise use the generated worktree name
    const branchName = options.branchName || worktreeName;

    // Generate worktree path using the generated worktree name for consistency
    const worktreePath = join(this.basePath, WORKTREE_DIR, worktreeName);

    // Resolve the start point: use the local branch if it exists,
    // otherwise fall back to origin/<branch> (common when the local
    // branch hasn't been checked out yet)
    const startPoint = (await this.branchExists(mainBranch))
      ? mainBranch
      : `origin/${mainBranch}`;

    // Create worktree (using execFile to prevent command injection)
    // Note: Fetching is handled by syncBranch() before createWorktree() is called
    try {
      await execFileAsync(
        'git',
        ['worktree', 'add', '-b', branchName, worktreePath, startPoint],
        {
          cwd: this.basePath,
          timeout: GIT_OPERATION_TIMEOUT,
          maxBuffer: GIT_MAX_BUFFER,
        }
      );
    } catch (error) {
      throw new Error(
        `Failed to create worktree '${branchName}' at ${worktreePath}: ${this.getErrorMessage(error)}\n` +
          `Ensure git is not locked by another process and the repository is not corrupted.`
      );
    }

    // Install pre-push hook to prevent agents from pushing directly.
    // Only the pipeline executor's AutoCommit should push (via AIRUNX_ALLOW_PUSH env).
    this.installPrePushHook(worktreePath);

    return {
      path: worktreePath,
      branch: branchName,
      id: worktreeName,
    };
  }

  /**
   * Install a pre-push hook in a worktree to block agent-initiated pushes.
   * Worktrees store hooks in the main repo's .git/worktrees/<name>/hooks/
   * (the worktree's .git is a file pointing there, not a directory).
   */
  private installPrePushHook(worktreePath: string): void {
    try {
      // Worktree .git is a file containing "gitdir: /path/to/.git/worktrees/<name>"
      const dotGit = join(worktreePath, '.git');
      let hooksDir: string;

      if (existsSync(dotGit)) {
        const content = readFileSync(dotGit, 'utf-8').trim();
        const gitdirMatch = content.match(/^gitdir:\s*(.+)$/);
        if (gitdirMatch) {
          hooksDir = join(gitdirMatch[1], 'hooks');
        } else {
          hooksDir = join(dotGit, 'hooks');
        }
      } else {
        hooksDir = join(dotGit, 'hooks');
      }

      mkdirSync(hooksDir, { recursive: true });

      const hookPath = join(hooksDir, 'pre-push');
      const hookContent = [
        '#!/bin/sh',
        '# Installed by AIRunX — prevents agents from pushing directly.',
        '# The pipeline executor sets AIRUNX_ALLOW_PUSH=1 to bypass.',
        'if [ -z "$AIRUNX_ALLOW_PUSH" ]; then',
        '  echo "ERROR: git push blocked by AIRunX pre-push hook." >&2',
        '  echo "Pushes are managed by the pipeline executor after workflow completion." >&2',
        '  exit 1',
        'fi',
        'exit 0',
        '',
      ].join('\n');

      writeFileSync(hookPath, hookContent, { mode: 0o755 });
      this.logger.info(`Installed pre-push hook in worktree: ${worktreePath}`);
    } catch (error) {
      // Non-fatal — log and continue, the worktree is still usable
      this.logger.warn(
        `Failed to install pre-push hook: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  /**
   * List all worktrees
   */
  async listWorktrees(): Promise<
    Array<{ path: string; branch: string; hash: string }>
  > {
    const { stdout } = await execFileAsync(
      'git',
      ['worktree', 'list', '--porcelain'],
      {
        cwd: this.basePath,
        timeout: GIT_OPERATION_TIMEOUT,
        maxBuffer: GIT_MAX_BUFFER,
      }
    );

    const worktrees: Array<{ path: string; branch: string; hash: string }> = [];
    const lines = stdout.split('\n');

    let current: Partial<{ path: string; branch: string; hash: string }> = {};
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        current.path = line.replace('worktree ', '');
      } else if (line.startsWith('HEAD ')) {
        current.hash = line.replace('HEAD ', '');
      } else if (line.startsWith('branch ')) {
        current.branch = line.replace('branch ', '').replace('refs/heads/', '');
      } else if (line === '') {
        if (current.path && current.branch && current.hash) {
          worktrees.push(
            current as { path: string; branch: string; hash: string }
          );
        }
        current = {};
      }
    }

    // Handle case where output doesn't end with blank line
    if (current.path && current.branch && current.hash) {
      worktrees.push(current as { path: string; branch: string; hash: string });
    }

    return worktrees;
  }

  /**
   * Remove a worktree (idempotent - succeeds if worktree doesn't exist)
   */
  async removeWorktree(worktreePath: string, force = false): Promise<void> {
    // Check if worktree exists in git's list
    const worktrees = await this.listWorktrees();
    const worktreeEntry = worktrees.find((wt) => wt.path === worktreePath);

    if (!worktreeEntry) {
      // Worktree not registered with git - check if directory exists
      if (existsSync(worktreePath)) {
        this.logger.warn(
          `Directory exists but not registered as worktree: ${worktreePath}`
        );
        // Prune orphaned entries
        await this.pruneWorktrees();
      }
      // Already removed or never existed - success (idempotent)
      this.logger.debug(
        `Worktree not found, skipping removal: ${worktreePath}`
      );
      return;
    }

    // Check if directory exists
    if (!existsSync(worktreePath)) {
      // Git thinks it exists but directory is gone - prune
      this.logger.warn(`Worktree directory missing, pruning: ${worktreePath}`);
      await this.pruneWorktrees();
      return;
    }

    // Normal removal
    const args = ['worktree', 'remove'];
    if (force) {
      args.push('--force');
    }
    args.push(worktreePath);

    try {
      await execFileAsync('git', args, {
        cwd: this.basePath,
        timeout: GIT_OPERATION_TIMEOUT,
        maxBuffer: GIT_MAX_BUFFER,
      });
    } catch (error) {
      const errorMessage = this.getErrorMessage(error);
      if (errorMessage.includes('uncommitted changes')) {
        throw new Error(
          `Worktree has uncommitted changes. Use --force to remove anyway, ` +
            `or commit/stash changes first.`
        );
      }
      throw new Error(`Failed to remove worktree: ${errorMessage}`);
    }
  }

  /**
   * Clean up stale worktrees
   */
  async pruneWorktrees(): Promise<void> {
    await execFileAsync('git', ['worktree', 'prune'], {
      cwd: this.basePath,
      timeout: GIT_OPERATION_TIMEOUT,
      maxBuffer: GIT_MAX_BUFFER,
    });
  }

  /**
   * Get current worktree info (if in a worktree)
   */
  async getCurrentWorktree(): Promise<WorktreeInfo | null> {
    try {
      const { stdout: worktreePath } = await execFileAsync(
        'git',
        ['rev-parse', '--show-toplevel'],
        {
          cwd: this.basePath,
          timeout: GIT_OPERATION_TIMEOUT,
        }
      );

      const { stdout: branch } = await execFileAsync(
        'git',
        ['branch', '--show-current'],
        {
          cwd: this.basePath,
          timeout: GIT_OPERATION_TIMEOUT,
        }
      );

      const currentBranch = branch.trim();
      const currentPath = worktreePath.trim();

      // A directory is one of our worktrees if its path includes the worktree dir name
      // and its branch name matches our prefix.
      if (
        currentPath.includes(WORKTREE_DIR) &&
        currentBranch.startsWith(BRANCH_PREFIX)
      ) {
        return {
          path: currentPath,
          branch: currentBranch,
          id: basename(currentPath),
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Check if worktree has uncommitted changes
   */
  async hasChanges(worktreePath: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: worktreePath,
        timeout: GIT_OPERATION_TIMEOUT,
        maxBuffer: GIT_MAX_BUFFER,
      });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get the configured remote for a branch
   * Falls back to 'origin' if not configured
   *
   * @param branch - Branch name to look up
   * @returns Remote name (defaults to 'origin')
   */
  private async getRemoteForBranch(branch: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['config', '--get', `branch.${branch}.remote`],
        {
          cwd: this.basePath,
          timeout: GIT_OPERATION_TIMEOUT,
        }
      );
      if (stdout.trim()) {
        return stdout.trim();
      }
    } catch (error) {
      // Command fails if config is not set, fall through to default
      this.logger.debug(
        `Could not get remote for branch '${branch}', falling back to 'origin'. Error: ${this.getErrorMessage(error)}`
      );
    }
    return 'origin';
  }

  /**
   * Fetch from a remote
   * Fetches all refs to ensure we have the latest remote state
   *
   * @param remoteName - Remote to fetch from (defaults to 'origin')
   */
  async fetch(remoteName = 'origin'): Promise<void> {
    this.logger.debug(`Fetching from ${remoteName}...`);
    await execFileAsync('git', ['fetch', remoteName], {
      cwd: this.basePath,
      timeout: GIT_OPERATION_TIMEOUT,
      maxBuffer: GIT_MAX_BUFFER,
    });
    this.logger.debug('Fetch completed');
  }

  /**
   * Check if a branch (local or remote) exists
   *
   * @param branch - Branch reference to check (e.g., 'main' or 'origin/main')
   * @returns True if the branch exists
   */
  private async branchExists(branch: string): Promise<boolean> {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', branch], {
        cwd: this.basePath,
        timeout: GIT_OPERATION_TIMEOUT,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a branch exists locally or as a remote tracking ref.
   * Returns true if the branch can be resolved as a local ref or
   * as origin/<branch> (sufficient for worktree creation and sync).
   */
  private async branchExistsLocallyOrRemote(branch: string): Promise<boolean> {
    if (await this.branchExists(branch)) {
      return true;
    }
    return this.branchExists(`origin/${branch}`);
  }

  /**
   * Get branch divergence information (how many commits ahead/behind remote)
   *
   * @param branch - Branch name to check
   * @param remoteName - Remote name (defaults to 'origin')
   * @returns Object with ahead and behind counts
   * @throws Error if local branch doesn't exist or divergence check fails
   */
  async getBranchDivergence(
    branch: string,
    remoteName = 'origin'
  ): Promise<{ ahead: number; behind: number }> {
    // Check if local branch exists
    if (!(await this.branchExists(branch))) {
      throw new Error(
        `Cannot get divergence for non-existent local branch: ${branch}`
      );
    }

    // Check if remote tracking branch exists
    const remoteBranch = `${remoteName}/${branch}`;
    if (!(await this.branchExists(remoteBranch))) {
      this.logger.debug(
        `Remote branch ${remoteBranch} does not exist, skipping divergence check`
      );
      return { ahead: 0, behind: 0 };
    }

    try {
      // Get ahead/behind counts using rev-list
      const { stdout } = await execFileAsync(
        'git',
        ['rev-list', '--left-right', '--count', `${branch}...${remoteBranch}`],
        {
          cwd: this.basePath,
          timeout: GIT_OPERATION_TIMEOUT,
        }
      );

      // Output format: "ahead\tbehind"
      const parts = stdout.trim().split(/\s+/);
      const ahead = parseInt(parts[0], 10);
      const behind = parseInt(parts[1], 10);
      if (isNaN(ahead) || isNaN(behind)) {
        throw new Error(
          `Failed to parse branch divergence from git output: "${stdout.trim()}". Expected numeric values.`
        );
      }
      return { ahead, behind };
    } catch (error) {
      throw new Error(
        `Failed to get branch divergence for ${branch}: ${this.getErrorMessage(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Fast-forward a local branch to match its remote tracking branch
   * Only works if the branch can be fast-forwarded (no local commits)
   *
   * @param branch - Branch name to fast-forward
   * @param remoteName - Remote name (defaults to 'origin')
   */
  async fastForwardBranch(
    branch: string,
    remoteName = 'origin'
  ): Promise<void> {
    const remoteBranch = `${remoteName}/${branch}`;
    this.logger.debug(`Fast-forwarding ${branch} to ${remoteBranch}`);

    // Get current local and remote refs in a single command for efficiency
    const { stdout: refs } = await execFileAsync(
      'git',
      ['rev-parse', branch, remoteBranch],
      {
        cwd: this.basePath,
        timeout: GIT_OPERATION_TIMEOUT,
      }
    );
    const [localRef, remoteRef] = refs.trim().split('\n');

    if (!localRef || !remoteRef) {
      throw new Error(`Could not parse refs for ${branch} and ${remoteBranch}`);
    }

    // Use atomic update-ref with oldvalue to prevent race conditions
    // This ensures the branch hasn't changed since we read its value
    await execFileAsync(
      'git',
      ['update-ref', `refs/heads/${branch}`, remoteRef, localRef],
      {
        cwd: this.basePath,
        timeout: GIT_OPERATION_TIMEOUT,
        maxBuffer: GIT_MAX_BUFFER,
      }
    );

    this.logger.debug(`Fast-forwarded ${branch} to ${remoteRef}`);
  }

  /**
   * Sync a local branch with its remote tracking branch
   *
   * This method:
   * 1. Determines the configured remote for the branch
   * 2. Fetches from the remote
   * 3. Creates local tracking branch if only remote exists
   * 4. Checks if the branch has diverged
   * 5. Fast-forwards if possible
   *
   * @param options - Sync options including branch name
   * @returns Sync result with status and message
   */
  async syncBranch(options: SyncOptions): Promise<SyncResult> {
    const { branch } = options;

    // 1. Determine the remote for this branch
    const remoteName = await this.getRemoteForBranch(branch);

    // 2. Fetch from the remote
    try {
      await this.fetch(remoteName);
    } catch (error) {
      // Network errors are non-fatal - warn and continue with local state
      return {
        synced: false,
        message: `Failed to fetch from remote '${remoteName}': ${this.getErrorMessage(error)}`,
      };
    }

    const remoteBranch = `${remoteName}/${branch}`;
    const localBranchExists = await this.branchExists(branch);
    const remoteBranchExists = await this.branchExists(remoteBranch);

    // 3. Handle case where branch exists on remote but not locally
    if (!localBranchExists && remoteBranchExists) {
      try {
        await execFileAsync(
          'git',
          ['branch', '--track', branch, remoteBranch],
          {
            cwd: this.basePath,
            timeout: GIT_OPERATION_TIMEOUT,
          }
        );
        this.logger.debug(
          `Created local branch '${branch}' to track '${remoteBranch}'`
        );
        return {
          synced: true,
          commitsBehind: 0,
          message: `Created local branch '${branch}' from remote`,
        };
      } catch (error) {
        throw new Error(
          `Failed to create local branch '${branch}' from remote: ${this.getErrorMessage(error)}`
        );
      }
    }

    // 4. Handle edge cases
    if (!remoteBranchExists) {
      if (localBranchExists) {
        return {
          synced: true,
          message: `Local-only branch '${branch}', nothing to sync`,
        };
      }
      throw new Error(
        `Branch '${branch}' not found locally or on remote '${remoteName}'`
      );
    }

    // 5. Both branches exist - check if fast-forward is possible
    // getBranchDivergence throws on failure, so no null check needed
    const { behind, ahead } = await this.getBranchDivergence(
      branch,
      remoteName
    );

    if (ahead > 0 && behind > 0) {
      // Branch has diverged - cannot auto-sync
      return {
        synced: false,
        message: `Branch '${branch}' has diverged (${ahead} ahead, ${behind} behind). Continuing with local state.`,
      };
    }

    if (behind === 0) {
      return { synced: true, commitsBehind: 0, message: 'Already up to date' };
    }

    // 6. Fast-forward the local branch
    try {
      await this.fastForwardBranch(branch, remoteName);
      return {
        synced: true,
        commitsBehind: behind,
        message: `Synced ${behind} commit(s) from ${remoteName}`,
      };
    } catch (error) {
      return {
        synced: false,
        message: `Failed to fast-forward branch: ${this.getErrorMessage(error)}`,
      };
    }
  }
}
