/**
 * Cleanup CLI Command
 * Provides manual cleanup capabilities for AIRunX resources
 */

import chalk from 'chalk';
import ora from 'ora';
import { resolve, isAbsolute, relative } from 'path';
import { existsSync, rmSync } from 'fs';
import { ScriptCleanup, getErrorMessage } from '../../utils/script-cleanup.js';
import {
  DebugFileManager,
  DEFAULT_DEBUG_DIR,
} from '../../utils/debug-file-manager.js';
import { loadSettings } from '../../utils/settings.js';
import { createLogger } from '../../utils/logger.js';
import { findStaleRepos } from '../../utils/repo-resolver.js';
import { spawnSync } from 'child_process';

const logger = createLogger('cleanup');

/**
 * Resolve project directory from options and settings
 * Priority: CLI --project > settings.default_project_location > cwd
 */
function resolveProjectDirectory(
  cliProject: string | undefined,
  settings: { resolvedPaths: { project?: string } }
): string {
  // CLI flag takes highest priority
  if (cliProject) {
    return isAbsolute(cliProject)
      ? cliProject
      : resolve(process.cwd(), cliProject);
  }

  // Settings default_project_location
  if (settings.resolvedPaths.project) {
    return settings.resolvedPaths.project;
  }

  // Default to current working directory
  return process.cwd();
}

/**
 * Determine the debug files max age in days from options.
 * Handles the complexity of Commander.js parsing where --debug-files without a value
 * returns `true` (boolean), while --debug-files=N returns the number as a string.
 */
function getDebugFilesMaxAgeDays(options: CleanupOptions): number {
  // If --all is set or --debug-files was provided, enable debug file cleanup
  if (options.all || options.debugFiles !== undefined) {
    // Commander passes `true` if --debug-files is used without a value
    if (typeof options.debugFiles === 'boolean') {
      return 7; // Default to 7 days
    }
    // Otherwise use the provided value or default to 7
    return Number(options.debugFiles ?? 7);
  }
  // If neither --all nor --debug-files was set, return 0 to skip cleanup
  return 0;
}

interface CleanupOptions {
  /** Clean up all orphan worktrees */
  worktrees?: boolean;
  /** Clean up debug files older than N days (default: 7) */
  debugFiles?: boolean | string;
  /** Clean up workflow state files */
  workflowState?: boolean;
  /** Clean up todo files */
  todos?: boolean;
  /** Force cleanup even with uncommitted changes */
  force?: boolean;
  /** Specific workflow ID to clean up */
  workflowId?: string;
  /** Target project directory */
  project?: string;
  /** Dry run - only show what would be cleaned */
  dryRun?: boolean;
  /** Clean up everything */
  all?: boolean;
}

export async function cleanupCommand(options: CleanupOptions): Promise<void> {
  const spinner = ora('Analyzing cleanup targets...').start();

  try {
    // Load settings and resolve project directory
    const settings = loadSettings();
    const projectDir = resolveProjectDirectory(options.project, settings);

    // Validate project directory exists
    if (!existsSync(projectDir)) {
      spinner.fail(chalk.red('Project directory not found'));
      console.error(chalk.red(`\nDirectory does not exist: ${projectDir}`));
      process.exit(1);
    }

    const cleanup = new ScriptCleanup(projectDir);
    const debugFileManager = new DebugFileManager(
      resolve(projectDir, DEFAULT_DEBUG_DIR)
    );

    // If --all flag is set, enable all cleanup options
    const cleanupOptions = {
      worktrees: options.all || options.worktrees || false,
      debugFilesMaxAgeDays: getDebugFilesMaxAgeDays(options),
      workflowState: options.all || options.workflowState || false,
      todos: options.all || options.todos || false,
      force: options.force || false,
      workflowId: options.workflowId,
      dryRun: options.dryRun || false,
    };

    // If no specific options set, default to cleaning worktrees and old debug files
    const anyOptionSet =
      options.all ||
      options.worktrees ||
      options.debugFiles !== undefined ||
      options.workflowState ||
      options.todos ||
      options.workflowId;

    if (!anyOptionSet) {
      cleanupOptions.worktrees = true;
      cleanupOptions.debugFilesMaxAgeDays = 7;
    }

    // Get summary first for dry run or preview
    if (options.dryRun) {
      spinner.text = 'Analyzing what would be cleaned up...';
    } else {
      spinner.text = 'Running cleanup...';
    }

    const result = await cleanup.cleanup(cleanupOptions);

    spinner.stop();

    // Display results
    console.log(
      chalk.bold(
        options.dryRun
          ? '\n📋 Cleanup Preview (Dry Run):\n'
          : '\n✅ Cleanup Complete:\n'
      )
    );

    const cleanupItems = [
      { count: result.worktreesRemoved, label: 'worktree' },
      { count: result.debugFilesRemoved, label: 'debug file' },
      { count: result.workflowStatesRemoved, label: 'workflow state' },
      { count: result.todosRemoved, label: 'todo' },
    ];

    const items = cleanupItems
      .filter(({ count }) => count > 0)
      .map(
        ({ count, label }) =>
          `${count} ${label}${count === 1 ? '' : 's'} ${options.dryRun ? 'would be' : ''} removed`
      );

    if (items.length === 0) {
      console.log(chalk.dim('  Nothing to clean up'));
    } else {
      for (const item of items) {
        console.log(chalk.green(`  ✓ ${item}`));
      }
    }

    // Show skipped items
    if (result.skipped.length > 0) {
      console.log(chalk.yellow('\n⚠️  Skipped:'));
      for (const skipped of result.skipped) {
        console.log(chalk.dim(`  - ${skipped}`));
      }
    }

    // Show errors
    if (result.errors.length > 0) {
      console.log(chalk.red('\n❌ Errors:'));
      for (const error of result.errors) {
        console.log(chalk.red(`  - ${error}`));
      }
    }

    console.log();

    // Show debug file info
    if (!options.dryRun) {
      const debugFiles = await debugFileManager.list();
      if (debugFiles.length > 0) {
        console.log(chalk.dim(`Debug files remaining: ${debugFiles.length}`));
        console.log(
          chalk.dim(`Debug directory: ${debugFileManager.getDebugDir()}`)
        );
        console.log();
      }
    }

    // If dry run, suggest actual command
    if (options.dryRun) {
      console.log(
        chalk.yellow('To perform the actual cleanup, remove --dry-run')
      );
      console.log();
    }
  } catch (error) {
    spinner.fail(chalk.red('Cleanup failed'));
    const errorMsg = getErrorMessage(error);
    logger.error(`Cleanup error: ${errorMsg}`);
    console.error(chalk.red(`\nError: ${errorMsg}`));
    process.exit(1);
  }
}

export async function listDebugFilesCommand(): Promise<void> {
  const spinner = ora('Loading debug files...').start();

  try {
    const debugFileManager = new DebugFileManager();
    const files = await debugFileManager.list();

    spinner.stop();

    console.log(chalk.bold('\n📁 Debug Files:\n'));

    if (files.length === 0) {
      console.log(chalk.dim('  No debug files found'));
      console.log(chalk.dim(`  Directory: ${debugFileManager.getDebugDir()}`));
    } else {
      console.log(chalk.dim(`  Total: ${files.length} file(s)`));
      console.log(chalk.dim(`  Directory: ${debugFileManager.getDebugDir()}`));
      console.log();

      // Show recent files (up to 10)
      const recentFiles = files.slice(0, 10);
      for (const file of recentFiles) {
        const statusIcon =
          file.status === 'completed'
            ? chalk.green('✓')
            : file.status === 'failed'
              ? chalk.red('✗')
              : chalk.yellow('!');
        const age = getRelativeTime(file.createdAt);
        console.log(`  ${statusIcon} ${chalk.dim(file.workflowId)} - ${age}`);
      }

      if (files.length > 10) {
        console.log(chalk.dim(`\n  ... and ${files.length - 10} more`));
      }
    }
    console.log();
  } catch (error) {
    spinner.fail(chalk.red('Failed to list debug files'));
    console.error(chalk.red(`\nError: ${getErrorMessage(error)}`));
    process.exit(1);
  }
}

/**
 * Get relative time string (e.g., "2 hours ago")
 */
function getRelativeTime(date: Date): string {
  const diffMinutes = Math.floor((Date.now() - date.getTime()) / 60000);

  const format = (value: number, unit: string): string =>
    `${value} ${unit}${value > 1 ? 's' : ''} ago`;

  if (diffMinutes < 1) {
    return 'just now';
  }
  if (diffMinutes < 60) {
    return format(diffMinutes, 'minute');
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return format(diffHours, 'hour');
  }

  const diffDays = Math.floor(diffHours / 24);
  return format(diffDays, 'day');
}

interface WorkspaceCleanupOptions {
  /** Remove repos not accessed in N days (default: 30) */
  olderThan?: string;
  /** Show what would be removed without deleting */
  dryRun?: boolean;
}

/**
 * Clean up stale cloned repos in the workspace directory
 */
export async function workspaceCleanupCommand(
  options: WorkspaceCleanupOptions
): Promise<void> {
  const spinner = ora('Analyzing workspace...').start();

  try {
    const settings = loadSettings();
    // Use pre-resolved workspace path from settings
    const workspace = settings.resolvedPaths.workspace;

    if (!workspace || !existsSync(workspace)) {
      spinner.stop();
      console.log(
        chalk.yellow('\n⚠ No workspace directory configured or found')
      );
      console.log(chalk.dim(`  Expected: ${workspace || '~/.airunx/repos'}`));
      console.log();
      return;
    }

    // Calculate threshold with validation
    const days = parseInt(options.olderThan || '30', 10);
    if (isNaN(days) || days < 0) {
      spinner.fail(chalk.red('Invalid --older-than value'));
      console.error(
        chalk.red('\nError: --older-than must be a non-negative number')
      );
      process.exit(1);
    }
    const thresholdMs = days * 24 * 60 * 60 * 1000;

    spinner.text = `Finding repos not accessed in ${days} days...`;

    const staleRepos = findStaleRepos(workspace, thresholdMs);

    spinner.stop();

    console.log(
      chalk.bold(
        options.dryRun
          ? '\n📋 Workspace Cleanup Preview (Dry Run):\n'
          : '\n🧹 Workspace Cleanup:\n'
      )
    );

    console.log(chalk.dim(`  Workspace: ${workspace}`));
    console.log(chalk.dim(`  Threshold: ${days} days`));
    console.log();

    if (staleRepos.length === 0) {
      console.log(chalk.dim('  No stale repos found'));
      console.log();
      return;
    }

    console.log(
      chalk.yellow(
        `  Found ${staleRepos.length} stale repo(s)${options.dryRun ? ' (would be removed)' : ''}:`
      )
    );
    console.log();

    for (const repoPath of staleRepos) {
      // Extract owner/repo from path using robust path resolution
      const displayName = relative(workspace, repoPath) || repoPath;

      if (options.dryRun) {
        console.log(chalk.dim(`  - ${displayName}`));
      } else {
        try {
          // Check for uncommitted changes to prevent accidental data loss
          const status = spawnSync('git', ['status', '--porcelain'], {
            cwd: repoPath,
            encoding: 'utf-8',
          });

          // Skip if git command failed or there are uncommitted changes
          if (
            status.error ||
            status.status !== 0 ||
            status.stdout.trim() !== ''
          ) {
            const reason = status.error
              ? 'git command failed'
              : status.status !== 0
                ? 'git status check failed'
                : 'has uncommitted changes';
            console.log(
              chalk.yellow(`  ⚠ Skipped: ${displayName} (${reason})`)
            );
            continue;
          }

          rmSync(repoPath, { recursive: true, force: true });
          console.log(chalk.green(`  ✓ Removed: ${displayName}`));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.log(
            chalk.red(`  ✗ Failed to remove ${displayName}: ${message}`)
          );
        }
      }
    }

    console.log();

    if (options.dryRun) {
      console.log(
        chalk.yellow('To perform the actual cleanup, remove --dry-run')
      );
      console.log();
    }
  } catch (error) {
    spinner.fail(chalk.red('Workspace cleanup failed'));
    const errorMsg = getErrorMessage(error);
    logger.error(`Workspace cleanup error: ${errorMsg}`);
    console.error(chalk.red(`\nError: ${errorMsg}`));
    process.exit(1);
  }
}
