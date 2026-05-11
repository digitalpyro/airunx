/**
 * Repository resolver for server-side workspace management
 *
 * Resolves GitHub repo locations by:
 * 1. Checking existing folders[] configuration
 * 2. Checking default_project_location
 * 3. Checking workspace_location
 * 4. Auto-cloning to workspace if not found
 */

import {
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  rmSync,
  utimesSync,
} from 'fs';
import { spawnAsync } from './async-spawn.js';
import { join, dirname } from 'path';
import { createLogger } from './logger.js';
import { expandPath } from './settings.js';
import type { ResolvedSettings } from './settings.js';
import { normalizeGitRemoteUrl } from '../integrations/github-cli.js';

const logger = createLogger('repo-resolver');

interface ResolveOptions {
  owner: string;
  repo: string;
  workspaceOverride?: string;
  settings: ResolvedSettings;
}

/**
 * Resolve the local path for a GitHub repo.
 * Checks existing locations first, clones if not found.
 */
export async function resolveRepoLocation(
  options: ResolveOptions
): Promise<string> {
  const { owner, repo, workspaceOverride, settings } = options;
  const targetRemote = `${owner}/${repo}`;

  // 1. Check folders[]
  const folders = settings.folders || [];
  for (const folder of folders) {
    const folderPath = typeof folder === 'string' ? folder : folder.path;
    const resolved = expandPath(folderPath);

    if (
      resolved &&
      existsSync(resolved) &&
      (await matchesRemote(resolved, targetRemote))
    ) {
      logger.info(`Found repo in folders[]: ${resolved}`);
      return resolved;
    }
  }

  // 2. Check default_project_location
  const defaultProject = settings.resolvedPaths?.project;
  if (
    defaultProject &&
    existsSync(defaultProject) &&
    (await matchesRemote(defaultProject, targetRemote))
  ) {
    logger.info(`Found repo at default_project_location: ${defaultProject}`);
    return defaultProject;
  }

  // 3. Check workspace_location
  // Use CLI override with expandPath, or fall back to pre-resolved settings path
  const workspace = workspaceOverride
    ? expandPath(workspaceOverride)
    : settings.resolvedPaths?.workspace;
  if (!workspace) {
    throw new Error('No workspace location configured');
  }

  const workspaceRepoPath = join(workspace, owner, repo);

  if (existsSync(workspaceRepoPath)) {
    logger.info(`Found repo in workspace: ${workspaceRepoPath}`);
    // Update mtime to mark as recently used for cleanup purposes
    try {
      const now = new Date();
      utimesSync(workspaceRepoPath, now, now);
    } catch (error) {
      logger.debug(
        `Failed to update timestamp for ${workspaceRepoPath}: ${error}`
      );
    }
    // Fetch latest before returning
    await fetchLatest(workspaceRepoPath);
    return workspaceRepoPath;
  }

  // 4. Clone to workspace
  logger.info(`Cloning ${targetRemote} to ${workspaceRepoPath}`);
  await cloneRepo(owner, repo, workspaceRepoPath);
  return workspaceRepoPath;
}

/**
 * Check if a directory's git remote matches the target owner/repo
 */
async function matchesRemote(
  repoPath: string,
  targetRemote: string
): Promise<boolean> {
  try {
    const result = await spawnAsync(
      'git',
      ['config', '--get', 'remote.origin.url'],
      {
        cwd: repoPath,
        timeout: 5000,
      }
    );

    if (result.status !== 0 || !result.stdout) {
      return false;
    }

    const remote = result.stdout.trim();
    const normalized = normalizeGitRemoteUrl(remote);

    return normalized.toLowerCase() === targetRemote.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Fetch latest changes from remote (non-fatal on failure)
 */
async function fetchLatest(repoPath: string): Promise<void> {
  try {
    const result = await spawnAsync('git', ['fetch', '--quiet'], {
      cwd: repoPath,
      timeout: 30000,
    });
    if (result.status === 0) {
      logger.debug(`Fetched latest for ${repoPath}`);
    } else {
      const errorOutput = result.stderr || result.stdout || 'unknown error';
      logger.warn(`Failed to fetch latest: ${errorOutput}`);
    }
  } catch (error) {
    logger.warn(`Failed to fetch latest: ${error}`);
    // Non-fatal, continue with existing state
  }
}

/**
 * Clone a repository to the target path
 */
async function cloneRepo(
  owner: string,
  repo: string,
  targetPath: string
): Promise<void> {
  const token =
    process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();

  // Create parent directories
  const parentDir = dirname(targetPath);
  mkdirSync(parentDir, { recursive: true });

  // Prefer gh CLI for secure token handling (avoids embedding token in .git/config),
  // but only if gh is actually installed
  const ghAvailable =
    !!token &&
    (await spawnAsync('which', ['gh'], { timeout: 5000 })).status === 0;

  let cmd: string;
  let args: string[];

  if (ghAvailable) {
    cmd = 'gh';
    args = ['repo', 'clone', `${owner}/${repo}`, targetPath];
  } else {
    cmd = 'git';
    // When token is available but gh isn't, use token-authenticated URL
    const cloneUrl = token
      ? `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
      : `https://github.com/${owner}/${repo}.git`;
    args = ['clone', '--progress', cloneUrl, targetPath];
  }

  // Log progress for potentially long-running operation
  logger.info(
    `Cloning ${owner}/${repo}... (this may take a few minutes for large repos)`
  );

  try {
    const result = await spawnAsync(cmd, args, {
      timeout: 300000, // 5 minute timeout for large repos
      // Prevent git from hanging on credential prompts in headless environments
      // gh CLI reads GH_TOKEN / GITHUB_TOKEN from env automatically
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      const stderr = result.stderr?.trim();
      const stdout = result.stdout?.trim();
      const detail = stderr || stdout || `exit code ${result.status}`;
      throw new Error(`${cmd} clone failed: ${detail}`);
    }

    logger.info(`Cloned ${owner}/${repo} to ${targetPath}`);
  } catch (error) {
    // Clean up partial clone
    if (existsSync(targetPath)) {
      try {
        rmSync(targetPath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }

    // Sanitize error message (remove token)
    const message = error instanceof Error ? error.message : String(error);
    const sanitized = message.replace(
      /x-access-token:[^@]+@/,
      'x-access-token:***@'
    );

    throw new Error(`Failed to clone ${owner}/${repo}: ${sanitized}`);
  }
}

/**
 * Find stale repos in workspace (not accessed within threshold)
 */
export function findStaleRepos(
  workspacePath: string,
  thresholdMs: number
): string[] {
  const staleRepos: string[] = [];

  if (!existsSync(workspacePath)) {
    return staleRepos;
  }

  try {
    // List all owner directories using Node.js fs
    const owners = readdirSync(workspacePath).filter((f) => {
      try {
        return statSync(join(workspacePath, f)).isDirectory();
      } catch {
        return false;
      }
    });

    const now = Date.now();

    for (const owner of owners) {
      const ownerPath = join(workspacePath, owner);

      // List all repo directories under this owner
      try {
        const repos = readdirSync(ownerPath).filter((f) => {
          try {
            return statSync(join(ownerPath, f)).isDirectory();
          } catch {
            return false;
          }
        });

        for (const repo of repos) {
          const repoPath = join(ownerPath, repo);

          // Check if it's a git repo
          if (!existsSync(join(repoPath, '.git'))) {
            continue;
          }

          // Get last used time using Node.js fs.statSync
          // Use max of atime and mtime for robustness (noatime mount options)
          try {
            const stats = statSync(repoPath);
            const lastUsed = Math.max(stats.atimeMs, stats.mtimeMs);

            if (now - lastUsed > thresholdMs) {
              staleRepos.push(repoPath);
            }
          } catch {
            // Skip repos where we can't get stat info
          }
        }
      } catch {
        // Skip owners we can't list
      }
    }
  } catch {
    // Return empty if we can't list the workspace
  }

  return staleRepos;
}
