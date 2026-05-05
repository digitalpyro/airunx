#!/usr/bin/env node

// Capture shell-only env vars BEFORE dotenv loads .env files.
// Security: AIRUNX_ALLOW_YOLO must come from the shell, not from
// a project-controlled .env file that could silently bypass sandboxing.
const SHELL_AIRUNX_ALLOW_YOLO = process.env.AIRUNX_ALLOW_YOLO;

import { Command } from 'commander';
import { config } from 'dotenv';
import { existsSync, readFileSync, statSync } from 'fs';
import { join, resolve, isAbsolute, dirname } from 'path';
import { expandPath } from '../utils/settings.js';
import {
  getGlobalConfigDir,
  getProjectConfigDir,
  getPackageVersion,
} from '../utils/paths.js';
import { parseJsonc } from '../utils/json-utils.js';
import { runOrchestrator } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { initCommand } from './commands/init.js';
import { doctorCommand } from './commands/doctor.js';
import {
  cleanupCommand,
  listDebugFilesCommand,
  workspaceCleanupCommand,
} from './commands/cleanup.js';
import { validateCommand, showSchemaHelp } from './commands/validate.js';
import {
  agentsValidateCommand,
  showAgentsValidateHelp,
} from './commands/agents-validate.js';
import {
  circuitStatusCommand,
  circuitResetCommand,
} from './commands/circuit.js';
import { registerHeartbeatCommands } from './commands/heartbeat.js';
import { CONFIG_FILE_TYPES } from '../utils/file-validator.js';

/**
 * Load environment variables with priority:
 * 1. --env-file CLI flag (handled later in run command)
 * 2. env_file_location from settings.json
 * 3. ~/.airunx/.env (global fallback)
 * 4. .env in cwd (default dotenv behavior)
 * 5. Process environment variables (always available)
 *
 * Note: CLI flag override (--env-file) is handled in run.ts
 */
function loadEnvironment(): void {
  // Try to load settings to get env_file_location
  // TODO: Consider refactoring to use loadSettings() from settings.ts once
  // circular dependency issues are resolved. Current implementation duplicates
  // some path resolution logic but is necessary for early env loading.
  const settingsPath = join(getProjectConfigDir(), 'settings.json');
  const globalSettingsPath = join(getGlobalConfigDir(), 'settings.json');

  let envFileLocation: string | null = null;

  // Check project settings first, then global
  for (const settingsFile of [settingsPath, globalSettingsPath]) {
    if (existsSync(settingsFile)) {
      try {
        const content = readFileSync(settingsFile, 'utf-8');
        // Treat empty or whitespace-only files as non-existent
        if (!content.trim()) {
          continue;
        }
        const settings = parseJsonc(content) as Record<string, unknown>;
        if (settings.env_file_location) {
          if (typeof settings.env_file_location !== 'string') {
            console.error(
              `[error] env_file_location in settings must be a string, found: ${typeof settings.env_file_location}`
            );
            process.exit(1);
          }
          // Resolve path relative to settings file directory
          const expanded = expandPath(settings.env_file_location);
          envFileLocation = expanded
            ? isAbsolute(expanded)
              ? expanded
              : resolve(dirname(settingsFile), expanded)
            : null;
          if (!envFileLocation || !existsSync(envFileLocation)) {
            console.error(
              `[error] Environment file specified in settings.json not found: ${settings.env_file_location}`
            );
            process.exit(1);
          }
          break;
        }
      } catch (error) {
        // Log warning for parse errors, then continue to next source
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[warning] Failed to parse settings file at '${settingsFile}': ${message}`
        );
      }
    }
  }

  // Build candidate list in priority order
  const candidates: string[] = [];

  if (envFileLocation) {
    candidates.push(envFileLocation);
  }

  // Global fallback
  candidates.push(join(getGlobalConfigDir(), '.env'));

  // Current working directory (default dotenv behavior)
  candidates.push('.env');

  // Try each candidate in order
  for (const candidate of candidates) {
    const resolved = resolve(candidate);

    if (existsSync(resolved)) {
      // Warn if .env has overly permissive permissions (skip on Windows)
      if (process.platform !== 'win32') {
        try {
          const mode = statSync(resolved).mode & 0o777;
          if (mode & 0o077) {
            console.warn(
              `[warning] ${resolved} has permissive permissions (${mode.toString(8)}). Consider: chmod 600 ${resolved}`
            );
          }
        } catch {
          // Ignore stat errors — file exists but permission check failed
        }
      }
      config({ path: resolved });
      return;
    }
  }

  // If no env file found, still call config() for default behavior
  // (it will silently succeed even if .env doesn't exist)
  config();
}

loadEnvironment();

// Preserve the pre-dotenv YOLO value so the adapter can distinguish
// shell env from .env-injected values
process.env._AIRUNX_SHELL_ALLOW_YOLO = SHELL_AIRUNX_ALLOW_YOLO ?? '';

const program = new Command();

program
  .name('airunx')
  .description('Vendor-neutral Agent Orchestrator for developer workflows')
  .version(getPackageVersion())
  .option('--debug', 'Enable debug output (secrets are redacted)')
  .option('--quiet', 'Suppress non-essential output (errors always shown)')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.optsWithGlobals();
    if (opts.debug && opts.quiet) {
      console.error(
        'Error: --debug and --quiet are mutually exclusive. Choose one.'
      );
      process.exit(1);
    }
    if (opts.debug) {
      process.env.DEBUG = '1';
    }
    if (opts.quiet) {
      process.env.AIRUNX_QUIET = '1';
    }
  });

program
  .command('run')
  .description('Execute an orchestrated workflow from issue, PRD, or prompt')
  .argument('[input]', 'GitHub issue URL, file path, or inline prompt')
  .option('-m, --mode <mode>', 'Orchestration mode: pipeline, raw', 'pipeline')
  .option(
    '-w, --worktree <name>',
    'Git worktree name (auto-generated if not provided)'
  )
  .option(
    '-b, --base-branch <branch>',
    'Base branch for worktree (auto-detected if not provided)'
  )
  .option(
    '-f, --fidelity <level>',
    'Execution fidelity level: fast, standard, thorough, ultra'
  )
  .option(
    '-p, --pipeline <name>',
    'Pipeline to use from pipelines.yaml (default: standard)'
  )
  .option(
    '--project <path>',
    'Target project directory (overrides default_project_location)'
  )
  .option('--prd <path>', 'Path or URL to PRD file (local file or HTTP URL)')
  .option(
    '--context <path>',
    'Path to additional context file (merged with project context)'
  )
  .option('--no-dashboard', 'Disable dashboard output')
  .option(
    '--skip-version-check',
    'Skip checking if AIRunX is up-to-date with remote'
  )
  .option(
    '--keep-worktree',
    'Keep the worktree after execution (do not clean up)'
  )
  .option(
    '--backend <backend>',
    'Override configured backend (claude-code, cursor, codex)'
  )
  .option('--format <format>', 'Output format: human (default), json', 'human')
  .option(
    '--no-sync',
    'Skip syncing source branch with remote before worktree creation'
  )
  .option('--no-pr', 'Skip PR creation even on successful completion')
  .option(
    '--from-branch <branch>',
    'Specify the source branch for the worktree (takes priority over --base-branch)'
  )
  .option(
    '-v, --verbose',
    'Show detailed execution progress (stages, timing, spawn counts)'
  )
  .option(
    '--workspace <path>',
    'Directory for cloning repos (overrides workspace_location setting)'
  )
  .option(
    '--dotenv <path>',
    'Path to .env file (overrides env_file_location setting)'
  )
  .option(
    '--ci-verification-gate',
    'After PR creation, poll GitHub Actions and iterate on CI failures (up to 3 attempts). Overrides ci_verification_gate setting.'
  )
  .action(runOrchestrator);

program
  .command('status')
  .description('Show status of running workflows')
  .option('-a, --all', 'Show all workflows including completed')
  .action(statusCommand);

program
  .command('init')
  .description('Initialize project with AGENTS.md and pipeline configuration')
  .option('-f, --force', 'Overwrite existing files')
  .option('-r, --reset', 'Clear cache and state files before initialization')
  .option(
    '--from-workspace <path>',
    'Import folders from VSCode .code-workspace file'
  )
  .option(
    '--workspace <path>',
    'Set workspace location for cloning repos (server deployments)'
  )
  .option(
    '--dotenv <path>',
    'Path to .env file (loads before backend detection)'
  )
  .action(initCommand);

program
  .command('doctor')
  .description('Check backend availability and system configuration')
  .action(doctorCommand);

// Circuit breaker management
const circuitCmd = program
  .command('circuit')
  .description('Manage circuit breaker state for backends');

circuitCmd
  .command('status', { isDefault: true })
  .description('Show circuit breaker status for all backends')
  .action(circuitStatusCommand);

circuitCmd
  .command('reset')
  .description('Reset circuit breaker for a backend')
  .argument('<backend>', 'Backend to reset (claude-code, cursor, codex)')
  .action(circuitResetCommand);

// Cleanup command with subcommands
const cleanupCmd = program
  .command('cleanup')
  .description('Clean up AIRunX resources (worktrees, debug files, state)');

cleanupCmd
  .command('run', { isDefault: true })
  .description('Run cleanup of AIRunX resources')
  .option('--worktrees', 'Clean up orphan worktrees')
  .option(
    '--debug-files [days]',
    'Clean up debug files older than N days (default: 7)'
  )
  .option('--workflow-state', 'Clean up workflow state files')
  .option('--todos', 'Clean up todo files')
  .option('--all', 'Clean up all resource types')
  .option('-f, --force', 'Force cleanup even with uncommitted changes')
  .option('--workflow-id <id>', 'Clean up specific workflow by ID')
  .option('--project <path>', 'Target project directory for cleanup')
  .option('--dry-run', 'Preview what would be cleaned without making changes')
  .action(cleanupCommand);

cleanupCmd
  .command('list')
  .description('List debug files')
  .action(listDebugFilesCommand);

cleanupCmd
  .command('workspace')
  .description('Clean up cloned repos in workspace')
  .option('--older-than <days>', 'Remove repos not accessed in N days', '30')
  .option('--dry-run', 'Show what would be removed without deleting')
  .action(workspaceCleanupCommand);

program
  .command('validate [files...]')
  .description('Validate configuration files against their schemas')
  .option('-l, --lenient', 'Use lenient mode (warnings instead of errors)')
  .option('-j, --json', 'Output results in JSON format')
  .option('-a, --all', 'Validate all project configuration files')
  .option('-g, --global', 'Include global configuration files')
  .option(
    '-t, --type <type>',
    `Force file type (${CONFIG_FILE_TYPES.join('|')})`
  )
  .option('--schema', 'Show schema documentation for config files')
  .action((files: string[], options) => {
    if (options.schema) {
      showSchemaHelp(options.type);
    } else {
      validateCommand(files, options);
    }
  });

program
  .command('agents-validate [path]')
  .description('Interactive AGENTS.md validation with model checking')
  .option('--fix', 'Automatically apply suggested fixes')
  .option('--non-interactive', 'Run without prompts (for CI/CD)')
  .option('--no-cost-warnings', 'Disable cost warnings for expensive models')
  .option('-l, --lenient', 'Use lenient mode (warnings instead of errors)')
  .option('-j, --json', 'Output results in JSON format')
  .option('-h, --help', 'Show help for agents-validate command')
  .action((path: string | undefined, options) => {
    if (options.help) {
      showAgentsValidateHelp();
    } else {
      agentsValidateCommand(path, {
        fix: options.fix,
        nonInteractive: options.nonInteractive,
        costWarnings: options.costWarnings,
        lenient: options.lenient,
        json: options.json,
      });
    }
  });

// Heartbeat execution mode commands
registerHeartbeatCommands(program);

program.parse();
