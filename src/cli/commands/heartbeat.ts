/**
 * Heartbeat CLI Commands
 * Commands for managing heartbeat execution mode.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { HeartbeatRunner } from '../../heartbeat/heartbeat-runner.js';
import {
  ProcessLock,
  getDefaultLockPath,
} from '../../heartbeat/process-lock.js';
import { AuditLogger, getDefaultAuditDir } from '../../audit/audit-logger.js';
import { GitHubCLI } from '../../integrations/github-cli.js';
import { existsSync } from 'fs';
import { isExecutionFidelityLevel } from '../../core/types.js';
import { requiresCostWarning } from '../../utils/fidelity-resolver.js';
import { expandPath } from '../../utils/settings.js';
import type { ExecutionFidelityLevel } from '../../core/types.js';

export function registerHeartbeatCommands(program: Command): void {
  const heartbeat = program
    .command('heartbeat')
    .description(
      'Manage heartbeat execution mode for continuous agent operation'
    );

  // Start command
  heartbeat
    .command('start')
    .description(
      'Start heartbeat mode to continuously poll for and execute tasks'
    )
    .option(
      '-r, --repo <repo>',
      'GitHub repository (owner/repo format). Auto-detected if not specified.'
    )
    .option('--interval <ms>', 'Poll interval in milliseconds', '10000')
    .option('--idle-cycles <n>', 'Idle cycles before entering pause mode', '6')
    .option('--idle-pause <ms>', 'Pause duration when idle (ms)', '60000')
    .option('--pipeline <name>', 'Default pipeline to use', 'standard')
    .option(
      '--backend <backend>',
      'Backend to use (claude-code, cursor, codex)'
    )
    .option(
      '-f, --fidelity <level>',
      'Execution fidelity level: fast, standard, thorough, ultra'
    )
    .option(
      '--dotenv <path>',
      'Path to .env file (overrides env_file_location setting)'
    )
    .option(
      '--context <path>',
      'Path to context file or directory (forwarded to each airunx run)'
    )
    .option(
      '--ci-verification-gate',
      'After PR creation, poll GitHub Actions and iterate on CI failures (up to 3 attempts)'
    )
    .action(async (options) => {
      try {
        // Load dotenv FIRST (before any env-dependent operations like GH CLI checks)
        if (options.dotenv) {
          const envPath = expandPath(options.dotenv);
          if (!envPath || !existsSync(envPath)) {
            console.error(
              chalk.red(`Error: Env file not found: ${options.dotenv}`)
            );
            process.exit(1);
          }
          const { config } = await import('dotenv');
          config({ path: envPath, override: true });
          console.log(chalk.gray(`  Env file: ${envPath}`));
        }

        // Validate fidelity level if provided
        let fidelityLevel: ExecutionFidelityLevel | undefined;
        if (options.fidelity) {
          if (!isExecutionFidelityLevel(options.fidelity)) {
            console.error(
              chalk.red(`Invalid fidelity level: ${options.fidelity}`)
            );
            console.log(
              chalk.yellow(`Valid options: fast, standard, thorough, ultra`)
            );
            process.exit(1);
          }
          fidelityLevel = options.fidelity;

          if (requiresCostWarning(options.fidelity)) {
            console.log(
              chalk.yellow(
                `  Warning: ${fidelityLevel} fidelity applies to ALL tasks processed by this daemon`
              )
            );
          }
        }

        // Validate GitHub CLI is available (after dotenv, may need GH_TOKEN)
        const ghStatus = await GitHubCLI.isAvailable();
        if (!ghStatus.available) {
          console.error(chalk.red(`Error: ${ghStatus.error}`));
          process.exit(1);
        }

        // Determine repo
        const repo = options.repo || (await GitHubCLI.getCurrentRepo());
        if (!repo) {
          console.error(
            chalk.red(
              'Error: Could not detect repository. ' +
                'Run from a git repository or specify --repo owner/repo'
            )
          );
          process.exit(1);
        }

        // Build args to forward to each `airunx run` child process
        const runArgs: string[] = [];
        if (options.backend) runArgs.push('--backend', options.backend);
        if (options.dotenv) {
          const envPath = expandPath(options.dotenv);
          if (envPath) runArgs.push('--dotenv', envPath);
        }
        if (options.context) {
          const contextPath = expandPath(options.context);
          if (contextPath) runArgs.push('--context', contextPath);
        }
        if (options.ciVerificationGate) {
          runArgs.push('--ci-verification-gate');
        }

        // Create and start heartbeat runner
        const runner = new HeartbeatRunner({
          repo,
          runArgs,
        });

        console.log(chalk.cyan('Starting heartbeat mode...'));
        console.log(chalk.gray(`  Repository: ${repo}`));
        if (options.backend) {
          console.log(chalk.gray(`  Backend: ${options.backend}`));
        }
        console.log(chalk.gray(`  Poll interval: ${options.interval}ms`));
        console.log(chalk.gray(`  Default pipeline: ${options.pipeline}`));
        if (fidelityLevel) {
          console.log(chalk.gray(`  Fidelity: ${fidelityLevel}`));
        }
        if (options.context) {
          console.log(chalk.gray(`  Context: ${options.context}`));
        }
        console.log();
        console.log(chalk.gray('Press Ctrl+C to stop'));
        console.log();

        await runner.start({
          intervalMs: parseInt(options.interval, 10),
          maxIdleCycles: parseInt(options.idleCycles, 10),
          idlePauseMs: parseInt(options.idlePause, 10),
          defaultPipeline: options.pipeline,
          repo,
          fidelityLevel,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('Cannot start heartbeat')) {
          console.error(chalk.red(`Error: ${message}`));
          console.error(
            chalk.gray(
              'Use `airunx heartbeat status` to check, or `airunx heartbeat stop` to terminate.'
            )
          );
          process.exit(1);
        }

        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    });

  // Stop command
  heartbeat
    .command('stop')
    .description('Stop the running heartbeat process')
    .action(async () => {
      const lock = new ProcessLock(getDefaultLockPath());
      const status = lock.isRunning();

      if (!status.running) {
        console.log(chalk.yellow('No heartbeat process is running.'));
        return;
      }

      if (status.pid) {
        console.log(
          chalk.cyan(`Stopping heartbeat process (PID ${status.pid})...`)
        );

        try {
          process.kill(status.pid, 'SIGTERM');
          console.log(
            chalk.green('Stop signal sent. Process will terminate gracefully.')
          );
        } catch (error) {
          console.error(
            chalk.red(
              `Failed to stop process: ${error instanceof Error ? error.message : error}`
            )
          );

          // Offer force removal
          console.log(
            chalk.gray(
              'Try running `airunx heartbeat recover` to force cleanup.'
            )
          );
        }
      }
    });

  // Status command
  heartbeat
    .command('status')
    .description('Show heartbeat process status')
    .option('--audit', 'Show recent audit log entries')
    .option('--limit <n>', 'Number of audit entries to show', '10')
    .action(async (options) => {
      const lock = new ProcessLock(getDefaultLockPath());
      const status = lock.isRunning();

      console.log(chalk.cyan('Heartbeat Status'));
      console.log(chalk.gray('─'.repeat(40)));

      if (status.running && status.pid) {
        console.log(chalk.green(`  Running: Yes (PID ${status.pid})`));
      } else {
        console.log(chalk.yellow('  Running: No'));
      }

      // Show audit log if requested
      if (options.audit) {
        console.log();
        console.log(chalk.cyan('Recent Audit Events'));
        console.log(chalk.gray('─'.repeat(40)));

        const auditLogger = new AuditLogger(getDefaultAuditDir());
        const events = auditLogger.readRecentEvents(
          parseInt(options.limit, 10)
        );

        if (events.length === 0) {
          console.log(chalk.gray('  No audit events found.'));
        } else {
          for (const event of events) {
            const timestamp = event.timestamp.slice(11, 19); // HH:MM:SS
            const eventColor = getEventColor(event.event);
            console.log(
              `  ${chalk.gray(timestamp)} ${eventColor(event.event)}`
            );

            const details = Object.entries(event.details ?? {})
              .filter(([key]) => key !== 'stack')
              .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
              .join(' ');
            if (details) {
              console.log(chalk.gray(`    ${details}`));
            }
          }
        }
      }
    });

  // Recover command
  heartbeat
    .command('recover')
    .description('Reset stuck tasks from running to pending state')
    .option(
      '-r, --repo <repo>',
      'GitHub repository (owner/repo format). Auto-detected if not specified.'
    )
    .option('--force-unlock', 'Force remove stale lockfile')
    .action(async (options) => {
      try {
        // Force unlock if requested
        if (options.forceUnlock) {
          const lock = new ProcessLock(getDefaultLockPath());
          lock.forceRemove();
          console.log(chalk.green('Lockfile removed.'));
        }

        // Validate GitHub CLI is available
        const ghStatus = await GitHubCLI.isAvailable();
        if (!ghStatus.available) {
          console.error(chalk.red(`Error: ${ghStatus.error}`));
          process.exit(1);
        }

        // Determine repo
        const repo = options.repo || (await GitHubCLI.getCurrentRepo());
        if (!repo) {
          console.error(
            chalk.red(
              'Error: Could not detect repository. ' +
                'Run from a git repository or specify --repo owner/repo'
            )
          );
          process.exit(1);
        }

        console.log(chalk.cyan(`Checking for stuck tasks in ${repo}...`));

        // Find tasks with airunx:running label
        const runningIssues = await GitHubCLI.listIssues(repo, {
          labels: ['airunx:running'],
          state: 'open',
        });

        if (runningIssues.length === 0) {
          console.log(chalk.green('No stuck tasks found.'));
          return;
        }

        console.log(
          chalk.yellow(
            `Found ${runningIssues.length} stuck task(s). Recovering...`
          )
        );

        for (const issue of runningIssues) {
          try {
            // Reset labels
            await GitHubCLI.updateIssueLabels(repo, issue.number.toString(), {
              remove: ['airunx:running'],
              add: ['airunx:pending'],
            });

            console.log(
              chalk.green(`  Recovered: #${issue.number} - ${issue.title}`)
            );
          } catch (error) {
            console.error(
              chalk.red(
                `  Failed to recover #${issue.number}: ${
                  error instanceof Error ? error.message : error
                }`
              )
            );
          }
        }

        console.log(chalk.green('Recovery complete.'));
      } catch (error) {
        console.error(
          chalk.red(
            `Recovery failed: ${error instanceof Error ? error.message : error}`
          )
        );
        process.exit(1);
      }
    });
}

/**
 * Get color function for event type
 */
function getEventColor(event: string): (text: string) => string {
  if (event.includes('error') || event.includes('failed')) {
    return chalk.red;
  }
  if (event.includes('completed')) {
    return chalk.green;
  }
  if (event.includes('start') || event.includes('claimed')) {
    return chalk.cyan;
  }
  if (event.includes('stop') || event.includes('released')) {
    return chalk.yellow;
  }
  return chalk.white;
}
