import chalk from 'chalk';
import ora from 'ora';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type {
  OrchestrationMode,
  ExecutionFidelityLevel,
  WorkflowContext,
} from '../../core/types.js';
import {
  EXECUTION_FIDELITY_LEVELS,
  isExecutionFidelityLevel,
} from '../../core/types.js';
import { parseInput } from '../../parsers/index.js';
import { resolvePRD, PRDResolverError } from '../../parsers/prd-resolver.js';
import { GitWorktreeManager } from '../../tools/git-worktree.js';
import { loadSystemConfig } from '../../utils/system-config.js';
import { loadPipelineConfig } from '../../utils/config.js';
import {
  loadSettings,
  expandPath,
  type ResolvedSettings,
} from '../../utils/settings.js';
import { createLogger } from '../../utils/logger.js';
import { handleCommandError } from '../../utils/error-handlers.js';
import {
  resolveFidelity,
  requiresCostWarning,
} from '../../utils/fidelity-resolver.js';
import {
  mergeContexts,
  ContextLoaderError,
} from '../../utils/context-loader.js';
import { ContextResolver } from '../../utils/context-resolver.js';
import { resolvePathRelativeToDir } from '../../utils/path-utils.js';
import {
  checkVersion,
  formatVersionMessage,
} from '../../utils/version-checker.js';
import {
  DebugFileManager,
  DEFAULT_DEBUG_DIR,
} from '../../utils/debug-file-manager.js';
import { ScriptCleanup, getErrorMessage } from '../../utils/script-cleanup.js';
import {
  displayCompletion,
  formatCompletionJson,
} from '../formatters/completion-formatter.js';
import { printStageTimings } from '../formatters/timing-formatter.js';
import {
  resolveProject,
  type ResolvedProject,
} from '../../utils/project-resolver.js';
import { VerboseReporter } from '../../orchestrator/verbose-reporter.js';
import type { StateManager } from '../../orchestrator/state-manager.js';
import { resolveRepoLocation } from '../../utils/repo-resolver.js';
import { GitHubCLI } from '../../integrations/github-cli.js';

/**
 * Format elapsed time in human-readable format (e.g., "1h 2m 3s")
 */
function formatElapsedTime(startTime: number): string {
  const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  const timeParts: string[] = [];
  if (hours > 0) timeParts.push(`${hours}h`);
  if (minutes > 0) timeParts.push(`${minutes}m`);
  if (seconds > 0 || timeParts.length === 0) timeParts.push(`${seconds}s`);
  return timeParts.join(' ');
}

/**
 * Return type for createVerboseReporterCallback
 */
interface VerboseReporterHelper {
  callback: (workflowId: string, stateManager: StateManager) => void;
  getReporter: () => VerboseReporter | undefined;
}

/**
 * Create the onWorkflowStart callback for verbose progress reporting
 * Returns the callback and a getter for the reporter instance (for cleanup)
 */
function createVerboseReporterCallback(
  spinner: ReturnType<typeof ora>,
  getSpinnerText: () => string
): VerboseReporterHelper {
  let verboseReporter: VerboseReporter | undefined;

  return {
    callback: (workflowId, stateManager): void => {
      verboseReporter = new VerboseReporter({
        stateManager,
        workflowId,
        output: (msg): void => {
          spinner.info(msg);
          spinner.start(getSpinnerText());
        },
      });
      verboseReporter.start();
    },
    getReporter: () => verboseReporter,
  };
}

/**
 * Display a formatted error message for resource loading failures
 * Handles both PRDResolverError and ContextLoaderError with their specific properties
 */
function displayResourceError(error: unknown): void {
  const isPRDError = error instanceof PRDResolverError;
  const isContextError = error instanceof ContextLoaderError;

  if (isPRDError || isContextError) {
    console.error(chalk.red(`\nError: ${(error as Error).message}`));
    const pathInfo = isPRDError
      ? (error as PRDResolverError).source
      : (error as ContextLoaderError).path;
    const label = isPRDError ? 'Source' : 'Path';
    console.error(chalk.dim(`  ${label}: ${pathInfo}`));
  } else {
    console.error(chalk.red(`\nError: ${(error as Error).message}`));
  }
}

interface RunOptions {
  mode?: OrchestrationMode;
  worktree?: string;
  baseBranch?: string;
  dashboard?: boolean;
  fidelity?: string;
  pipeline?: string;
  /** Target project directory (overrides default_project_location) */
  project?: string;
  /** Path or URL to PRD file */
  prd?: string;
  /** Path to additional context file */
  context?: string;
  /** Skip checking if AIRunX is up-to-date with remote */
  skipVersionCheck?: boolean;
  /** Keep worktree after execution (do not clean up) */
  keepWorktree?: boolean;
  /** Override the configured backend (claude-code, cursor, codex) */
  backend?: string;
  /** Output format: human (default), json */
  format?: 'human' | 'json';
  /** Skip syncing the source branch with remote before worktree creation */
  noSync?: boolean;
  /** Determines if a pull request should be created. Defaults to true, disabled with --no-pr. */
  pr?: boolean;
  /** Specify a different branch to work from (overrides base-branch for worktree source) */
  fromBranch?: string;
  /** Show detailed execution progress (stages, timing, spawn counts) */
  verbose?: boolean;
  /** Directory for cloning repos (overrides workspace_location setting) */
  workspace?: string;
  /** Path to .env file (overrides env_file_location setting) */
  dotenv?: string;
  /** Poll GitHub Actions after PR creation and iterate on CI failures (overrides setting) */
  ciVerificationGate?: boolean;
}

export async function runOrchestrator(
  input: string | undefined,
  options: RunOptions
): Promise<void> {
  const logger = createLogger('run');

  // When --format json is active, redirect all human-readable output to stderr
  // so stdout contains ONLY the JSON result blob (Unix convention: stdout for data, stderr for diagnostics).
  // This is safe because runOrchestrator() owns the process lifecycle and calls process.exit().
  // Stored for restoration in case of future library usage outside CLI context.
  const originalConsoleLog = console.log;
  if (options.format === 'json') console.log = console.error;

  // Handle --dotenv override (highest priority for env loading)
  // Note: We use --dotenv instead of --env-file to avoid collision with Node.js 20+ built-in --env-file
  if (options.dotenv) {
    const { config } = await import('dotenv');
    const envPath = expandPath(options.dotenv)!;

    if (!existsSync(envPath)) {
      logger.error(`Error: Env file not found: ${envPath}`);
      process.exit(1);
    }

    config({ path: envPath, override: true });
    logger.debug(`[env] Loaded from --dotenv: ${envPath}`);
  }

  // Input is optional when --prd flag is provided
  if (!input && !options.prd) {
    logger.error('Error: Input or --prd required');
    console.log(
      chalk.dim(
        'Usage: airunx run <github-url|file|prompt> [options]\n       airunx run --prd <path-or-url> [options]'
      )
    );
    process.exit(1);
  }

  console.log(chalk.bold.blue('🚀 Starting AIRunX...\n'));

  // Load settings for runtime configuration
  const settings = loadSettings();

  // Handle repo resolution for GitHub URLs (auto-clone if not found)
  // This must happen before project resolution since it may provide the project path
  let resolvedRepoPath: string | undefined;
  if (input) {
    const parsedGitHubUrl = GitHubCLI.parseGitHubUrl(input);
    if (parsedGitHubUrl) {
      const [owner, repo] = parsedGitHubUrl.repo.split('/');
      if (owner && repo) {
        const spinner = ora('Resolving repository location...').start();
        try {
          resolvedRepoPath = await resolveRepoLocation({
            owner,
            repo,
            workspaceOverride: options.workspace,
            settings,
          });
          spinner.succeed(chalk.green(`Repository: ${resolvedRepoPath}`));

          // Reload settings from the resolved repo path for project-specific config
          // This ensures project-local agents, pipelines, and settings are respected
          // Priority: project-specific (reloaded) > initial settings
          const reloadedSettings = loadSettings(resolvedRepoPath);
          // Deep merge nested objects to preserve structure
          const { resolvedPaths, resolvedToolConfigs, ...rest } =
            reloadedSettings;
          Object.assign(settings, rest);
          Object.assign(settings.resolvedPaths, resolvedPaths);
          Object.assign(settings.resolvedToolConfigs, resolvedToolConfigs);
        } catch (error) {
          spinner.fail(chalk.red('Failed to resolve repository'));
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(chalk.red(`\nError: ${message}`));
          const hasToken = !!(
            process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim()
          );
          if (!hasToken) {
            console.log(
              chalk.dim(
                '\nSet GITHUB_TOKEN environment variable for private repos.'
              )
            );
          } else {
            console.log(
              chalk.dim(
                '\nGITHUB_TOKEN is set but clone still failed. Check that the token has repo access.'
              )
            );
          }
          process.exit(1);
        }
      }
    }
  }

  // Check if AIRunX is up-to-date (unless skipped via CLI flag or settings)
  const shouldSkipVersionCheck =
    options.skipVersionCheck || settings.skip_version_check;

  if (!shouldSkipVersionCheck) {
    const versionResult = await checkVersion();
    const versionMessage = formatVersionMessage(versionResult);
    if (versionMessage) {
      console.log(chalk.yellow('⚠️  Version Warning:\n'));
      console.log(chalk.yellow(versionMessage.replace(/^/gm, '   ')));
      console.log();
    }
  }

  // Resolve project directory using intelligent detection chain
  // Priority: resolved repo path (from GitHub URL) > CLI --project > prompt analysis > cwd detection > default > fallback
  // Note: We pass input here for prompt analysis (before full parsing)
  const resolvedProject = resolveProjectDirectory(
    resolvedRepoPath || options.project,
    input,
    settings
  );
  const projectDir = resolvedProject.project.path;

  // Validate project directory
  if (!existsSync(projectDir)) {
    logger.error(`Project directory not found: ${projectDir}`);
    process.exit(1);
  }

  // Show project resolution info
  const sourceLabels: Record<ResolvedProject['source'], string> = {
    'cli-flag': 'from --project flag',
    prompt: 'detected from prompt',
    cwd: 'from current directory (in configured project)',
    default: 'from default_project_location',
    fallback: 'using current directory (fallback)',
  };
  console.log(
    chalk.dim(
      `  Project: ${resolvedProject.project.name} (${sourceLabels[resolvedProject.source]})`
    )
  );
  console.log(chalk.dim(`  Path: ${projectDir}`));

  // Resolve relative paths for --prd and --context relative to projectDir
  // This makes CLI behavior more intuitive when using --project flag
  const resolvedPrdPath = resolvePathRelativeToDir(options.prd, projectDir);
  const resolvedContextPath = resolvePathRelativeToDir(
    options.context,
    projectDir
  );

  // Validate fidelity level if provided
  let fidelityLevel: ExecutionFidelityLevel | undefined;
  if (options.fidelity) {
    if (!isExecutionFidelityLevel(options.fidelity)) {
      logger.error(`Invalid fidelity level: ${options.fidelity}`);
      console.log(
        chalk.yellow(`Valid options: ${EXECUTION_FIDELITY_LEVELS.join(', ')}`)
      );
      process.exit(1);
    }
    fidelityLevel = options.fidelity;

    // Warn about high-cost fidelity levels
    if (requiresCostWarning(fidelityLevel)) {
      console.log(
        chalk.yellow(
          `⚠️  ${fidelityLevel.toUpperCase()} fidelity may increase costs significantly\n`
        )
      );
    }
  }

  const spinner = ora('Parsing input...').start();

  try {
    // Resolve PRD if provided via --prd flag
    let prdContent: string | undefined;
    if (resolvedPrdPath) {
      spinner.text = 'Resolving PRD...';
      try {
        const prdSource = await resolvePRD(resolvedPrdPath);
        prdContent = prdSource.content;
        spinner.succeed(
          chalk.green(`Loaded PRD from ${prdSource.type}: ${prdSource.path}`)
        );
        spinner.start('Parsing input...');
      } catch (error) {
        spinner.fail(chalk.red('Failed to load PRD'));
        displayResourceError(error);
        process.exit(1);
      }
    }

    // Determine the effective input
    // Priority: PRD content > input argument
    const effectiveInput = prdContent || input || '';

    // 1. Parse input first (before loading context)
    const parsed = await parseInput(effectiveInput);
    spinner.succeed(
      chalk.green(`Parsed ${parsed.type} input: ${parsed.title}`)
    );

    console.log(chalk.dim(`  Type: ${parsed.type}`));
    if (parsed.metadata.author) {
      console.log(chalk.dim(`  Author: ${parsed.metadata.author}`));
    }
    if (parsed.metadata.labels && parsed.metadata.labels.length > 0) {
      console.log(chalk.dim(`  Labels: ${parsed.metadata.labels.join(', ')}`));
    }

    // 2. Load and merge context files (after input parsing)
    // This also resolves @mentions in loaded context files
    // Create shared resolver for cache efficiency across context loading and agent execution
    const sharedContextResolver = new ContextResolver(projectDir);

    spinner.start('Loading context...');
    let mergedContext;
    try {
      mergedContext = await mergeContexts(
        settings.resolvedPaths.context,
        resolvedContextPath,
        { workingDirectory: projectDir, contextResolver: sharedContextResolver }
      );
      const totalSources =
        mergedContext.sources.length + mergedContext.resolvedReferences.length;
      if (totalSources > 0) {
        const sourceCount = mergedContext.sources.length;
        const refCount = mergedContext.resolvedReferences.length;
        let successMessage: string;

        if (sourceCount > 0 && refCount > 0) {
          successMessage = `Loaded context from ${sourceCount} source(s), resolved ${refCount} @mention(s)`;
        } else if (sourceCount > 0) {
          successMessage = `Loaded context from ${sourceCount} source(s)`;
        } else {
          // refCount > 0 is implied by totalSources > 0
          successMessage = `Resolved ${refCount} @mention(s) as context`;
        }

        spinner.succeed(chalk.green(successMessage));

        for (const source of mergedContext.sources) {
          console.log(chalk.dim(`    - ${source}`));
        }
        for (const ref of mergedContext.resolvedReferences) {
          console.log(chalk.dim(`    - @${ref} (resolved)`));
        }
      } else if (mergedContext.failedReferences.length === 0) {
        spinner.stop();
      }

      // Always report failed @mention resolutions (even if no other sources loaded)
      if (mergedContext.failedReferences.length > 0) {
        if (totalSources === 0) {
          spinner.warn(
            chalk.yellow(
              `Failed to resolve ${mergedContext.failedReferences.length} @mention(s)`
            )
          );
        }
        console.log(chalk.yellow(`    Failed to resolve:`));
        for (const failed of mergedContext.failedReferences) {
          console.log(chalk.yellow(`      - @${failed.path}: ${failed.error}`));
        }
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to load context'));
      displayResourceError(error);
      process.exit(1);
    }
    console.log();

    // 2. Check system config
    spinner.start('Loading configuration...');
    const config = loadSystemConfig();

    if (!config) {
      spinner.fail(chalk.red('No configuration found'));
      console.log(chalk.yellow('\nRun: airunx init\n'));
      process.exit(1);
    }

    spinner.succeed(chalk.green('Configuration loaded'));

    // Set cache TTL if configured (must import BaseAdapter)
    if (config.cache_ttl_minutes) {
      const { BaseAdapter } = await import('../../adapters/base-adapter.js');
      BaseAdapter.setCacheTTL(config.cache_ttl_minutes);
    }

    // Load pipeline configuration
    const pipelineConfig = loadPipelineConfig();
    let selectedPipeline = null;

    if (pipelineConfig) {
      // Determine which pipeline to use (from options or default to 'standard')
      const pipelineName = options.pipeline || 'standard';
      selectedPipeline = pipelineConfig.pipelines[pipelineName];

      if (!selectedPipeline) {
        console.log(
          chalk.yellow(
            `⚠️  Pipeline '${pipelineName}' not found, using system defaults`
          )
        );
      }
    }

    // Resolve fidelity parameters with priority hierarchy
    // Priority: CLI flag > Pipeline default > System config > Hardcoded default
    // Note: Stage-level resolution will be implemented in Phase 3 orchestrator
    // when individual pipeline stages are executed
    const fidelityResolution = resolveFidelity({
      cliFlag: fidelityLevel,
      pipeline: selectedPipeline || undefined,
      systemConfig: config,
    });

    if (fidelityResolution.source !== 'default') {
      console.log(
        chalk.dim(
          `  Fidelity: ${fidelityResolution.level} (from ${fidelityResolution.source})`
        )
      );
    }
    console.log();

    // 3. Create git worktree (if in a git repo)
    // Pass projectDir so worktrees are created in the target project, not the package
    // Also pass configured base branch from settings for branch detection priority
    const worktreeManager = new GitWorktreeManager(
      projectDir,
      settings.default_base_branch
    );
    const isGitRepo = await worktreeManager.isGitRepo();

    let worktreeInfo = null;
    let executionError: Error | null = null;

    if (isGitRepo) {
      // Determine source branch for worktree
      // Priority: --from-branch > --base-branch > auto-detected
      const sourceBranch =
        options.fromBranch ||
        options.baseBranch ||
        (await worktreeManager.getMainBranch());

      // Determine if we should skip sync
      // Priority: CLI --no-sync flag > settings.skip_sync
      const shouldSkipSync = options.noSync || settings.skip_sync;

      // Sync source branch with remote (unless --no-sync is specified)
      if (!shouldSkipSync) {
        spinner.start(`Syncing ${sourceBranch} with remote...`);

        try {
          const syncResult = await worktreeManager.syncBranch({
            branch: sourceBranch,
          });

          if (syncResult.synced) {
            spinner.succeed(chalk.green(`Synced: ${syncResult.message}`));
          } else {
            // Sync failed but is non-fatal (e.g., diverged branch) - warn and continue
            spinner.warn(chalk.yellow(`Sync warning: ${syncResult.message}`));
            console.log(chalk.dim('  Continuing with local branch state...'));
          }
        } catch (syncError) {
          // Fatal sync errors (e.g., branch not found) - set error for graceful shutdown
          spinner.fail(chalk.red('Branch sync failed'));
          executionError =
            syncError instanceof Error
              ? syncError
              : new Error(String(syncError));
          console.error(chalk.red(`\nError: ${executionError.message}`));
          console.log(
            chalk.dim(
              '\nEnsure the branch exists locally or on the remote, or use --no-sync to skip syncing.'
            )
          );
        }
      } else {
        console.log(chalk.dim('  Skipping branch sync (--no-sync)'));
      }

      // Only create worktree if sync succeeded (or was skipped)
      if (!executionError) {
        spinner.start('Creating git worktree...');

        // Extract issue number if available (with type guard)
        const issueNumber =
          typeof parsed.context.number === 'number'
            ? parsed.context.number
            : undefined;

        // Worktree creation is critical - if it fails, we must exit to prevent
        // accidental commits on the current branch. Errors will be caught by the
        // outer try-catch which handles logging and exit.
        worktreeInfo = await worktreeManager.createWorktree({
          branchName: options.worktree,
          baseBranch: sourceBranch,
          issueNumber,
        });

        spinner.succeed(
          chalk.green(`Created worktree: ${worktreeInfo.branch}`)
        );
        console.log(chalk.dim(`  Path: ${worktreeInfo.path}`));
        console.log();
      }
    }

    // 4. Display workflow info
    console.log(chalk.bold('📋 Workflow Configuration:\n'));
    console.log(chalk.dim(`  Project: ${projectDir}`));
    console.log(chalk.dim(`  Mode: ${options.mode || 'pipeline'}`));
    console.log(chalk.dim(`  Fidelity: ${fidelityResolution.level}`));
    console.log(chalk.dim(`  Default backend: ${config.fallback_backend}`));
    if (resolvedPrdPath) {
      console.log(chalk.dim(`  PRD: ${resolvedPrdPath}`));
    }
    if (mergedContext && mergedContext.sources.length > 0) {
      console.log(
        chalk.dim(`  Context: ${mergedContext.sources.length} source(s)`)
      );
    }
    if (worktreeInfo) {
      console.log(chalk.dim(`  Worktree: ${worktreeInfo.path}`));
    }
    console.log();

    // Initialize debug file manager and cleanup utility
    const debugFileManager = new DebugFileManager(
      resolve(projectDir, DEFAULT_DEBUG_DIR)
    );
    const scriptCleanup = new ScriptCleanup(projectDir);

    // Track workflow result for cleanup
    let workflowResult: WorkflowContext | null = null;

    // Skip workflow display and execution if there was a fatal error (e.g., sync failure)
    if (executionError) {
      // Debug file creation and cleanup will still run below
      console.log(
        chalk.yellow('\n⚠ Skipping workflow execution due to earlier error\n')
      );
    } else {
      // 5. Execute orchestration pipeline
      spinner.start('Initializing orchestrator...');

      try {
        // Validate backend if specified via CLI flag
        const { BACKEND_TYPES } = await import('../../core/adapter-types.js');
        type BackendType = (typeof BACKEND_TYPES)[number];

        if (options.backend) {
          const validBackends = BACKEND_TYPES as readonly string[];
          if (!validBackends.includes(options.backend)) {
            throw new Error(
              `Invalid backend: ${options.backend}. ` +
                `Available backends: ${validBackends.join(', ')}`
            );
          }
          console.log(
            chalk.dim(`  Using backend override: ${options.backend}`)
          );
        }

        // Create AdapterFactory for lazy adapter initialization
        const { createAdapterFactory } = await import(
          '../../adapters/adapter-factory.js'
        );
        const adapterFactory = createAdapterFactory(config);

        // Load agent definitions from AGENTS.md for provider routing
        const { loadAgentsDefs } = await import('../../utils/agents-schema.js');
        const agentsPath = settings.resolvedPaths?.agents_md;
        const agentsResult = agentsPath ? loadAgentsDefs(agentsPath) : null;

        // Verbose: Log which AGENTS.md file is being used
        if (options.verbose && agentsResult) {
          console.log(
            chalk.cyan(
              `[INFO] Using AGENTS.md: ${agentsPath} (${agentsResult.agents.size} agents)`
            )
          );
        }

        // Build agent provider configs from parsed AGENTS.md
        const agentProviderConfigs = agentsResult?.agents
          ? Array.from(agentsResult.agents, ([role, def]) => ({
              role,
              provider: def.provider,
              fallbackProvider: def.fallbackProvider,
            }))
          : [];

        // Create ProviderRouter for per-agent backend selection
        const { createProviderRouter } = await import(
          '../../orchestrator/provider-router.js'
        );
        const providerRouter = createProviderRouter(
          agentProviderConfigs,
          config
        );

        // Log provider routing summary if agents have custom providers
        const agentsWithProviders = agentProviderConfigs.filter(
          (a) => a.provider
        );
        if (agentsWithProviders.length > 0) {
          console.log(
            chalk.dim(
              `  Provider routing: ${agentsWithProviders.length} agent(s) with custom providers`
            )
          );
        }

        spinner.succeed(
          chalk.green('Initialized multi-provider adapter factory')
        );

        // Create pipeline executor with multi-provider support
        const { PipelineExecutor } = await import(
          '../../orchestrator/pipeline-executor.js'
        );
        const executor = new PipelineExecutor({
          adapterFactory,
          providerRouter,
          systemConfig: config,
        });

        spinner.start('Executing workflow...');

        // Add elapsed time display to spinner (updates every 10 seconds)
        const startTime = Date.now();
        const getSpinnerText = (): string =>
          `Executing workflow... (${formatElapsedTime(startTime)} elapsed)`;
        const updateInterval = globalThis.setInterval(() => {
          spinner.text = getSpinnerText();
        }, 10000);

        // Initialize verbose reporter callback (escalating interval progress reporting)
        // Only enabled when verbose_progress setting is true and not using JSON output
        const verboseReporterHelper =
          settings.verbose_progress !== false && options.format !== 'json'
            ? createVerboseReporterCallback(spinner, getSpinnerText)
            : undefined;

        // Execute workflow with shared context resolver for cache efficiency
        // Backend is now determined per-agent by ProviderRouter, fallback for logging
        // Extract issue URL for cross-repo issue closing (full URL from GitHub input)
        const issueUrl =
          parsed.type === 'github' ? parsed.metadata.url : undefined;

        try {
          workflowResult = await executor.execute({
            input: parsed.title,
            inputType: parsed.type,
            mode: options.mode,
            fidelityLevel: fidelityResolution.level,
            pipelineName: options.pipeline,
            worktreePath: worktreeInfo?.path,
            repoPath: projectDir,
            branchName: worktreeInfo?.branch,
            taskTitle: parsed.title,
            taskDescription: parsed.description,
            issueUrl,
            skipPR: options.pr === false, // --no-pr flag
            backend:
              (options.backend as BackendType) || config.fallback_backend,
            contextResolver: sharedContextResolver,
            onWorkflowStart: verboseReporterHelper?.callback,
            verbose: options.verbose,
            staticContext: mergedContext?.combined,
            // CLI flags take precedence over settings
            ciVerificationGate:
              options.ciVerificationGate ?? settings.ci_verification_gate,
            markIssueCheckboxes: settings.mark_issue_checkboxes,
          });
        } finally {
          globalThis.clearInterval(updateInterval);
          await verboseReporterHelper?.getReporter()?.stop();
        }

        // Update spinner based on actual status
        if (
          workflowResult.status === 'completed' ||
          workflowResult.status === 'completed_with_errors'
        ) {
          spinner.succeed(
            workflowResult.status === 'completed'
              ? chalk.green('Workflow completed successfully')
              : chalk.yellow('Workflow completed with errors')
          );
        } else {
          spinner.fail(chalk.red('Workflow failed'));
        }

        // Print stage timing breakdown for performance visibility (skip for JSON output)
        if (options.format !== 'json' && workflowResult.stageTiming?.length) {
          printStageTimings(workflowResult.stageTiming);
        }

        // Display results using the completion formatter
        // Use JSON format if requested via --format flag
        if (options.format === 'json') {
          process.stdout.write(
            JSON.stringify(formatCompletionJson(workflowResult), null, 2) + '\n'
          );
        } else {
          displayCompletion(workflowResult, {
            tty: process.stdout.isTTY ?? true,
          });

          // Show todos summary (additional to completion formatter)
          if (workflowResult.todos && workflowResult.todos.length > 0) {
            const completed = workflowResult.todos.filter(
              (t) => t.status === 'completed'
            );
            const total = workflowResult.todos.length;
            const percentage = Math.round((completed.length / total) * 100);

            console.log(chalk.bold('📋 Todo Summary:\n'));
            console.log(
              chalk.dim(
                `  Progress: ${percentage}% (${completed.length}/${total} completed)`
              )
            );
            console.log();
          }
        }
      } catch (orchestrationError) {
        spinner.fail(chalk.red('Workflow execution failed'));
        executionError =
          orchestrationError instanceof Error
            ? orchestrationError
            : new Error(String(orchestrationError));
        console.error(chalk.red('\nError:'), executionError.message);
      }
    } // end of else block for !executionError

    // Always create debug file (success or failure)
    console.log(chalk.bold('📁 Debug Files:\n'));

    if (workflowResult) {
      try {
        const { compressed: debugFilePath, readable: readableDebugFilePath } =
          await debugFileManager.create({
            workflowContext: workflowResult,
            error: executionError || undefined,
          });
        console.log(chalk.dim(`  Debug file: ${debugFilePath}`));
        console.log(chalk.dim(`  Readable version: ${readableDebugFilePath}`));
      } catch (debugError) {
        console.log(
          chalk.yellow(
            `  Warning: Failed to create debug file: ${getErrorMessage(debugError)}`
          )
        );
      }
    } else if (executionError) {
      // If workflow didn't even start, still record the error
      console.log(
        chalk.dim(`  Debug directory: ${debugFileManager.getDebugDir()}`)
      );
      console.log(
        chalk.yellow('  Note: No workflow context available for debug file')
      );
    }
    console.log();

    // Handle cleanup
    if (options.keepWorktree) {
      // Show manual cleanup info
      if (worktreeInfo) {
        console.log(chalk.dim('  Worktree preserved (--keep-worktree flag)'));
        console.log(chalk.dim(`  Path: ${worktreeInfo.path}`));
        console.log(chalk.dim(`  Branch: ${worktreeInfo.branch}`));
        console.log();
      }
    } else {
      console.log(chalk.bold('🧹 Cleanup:\n'));

      if (worktreeInfo) {
        // Check if worktree has changes before cleanup
        const hasChanges = await worktreeManager.hasChanges(worktreeInfo.path);

        if (hasChanges) {
          console.log(
            chalk.yellow(
              '  Worktree has uncommitted changes. Skipping automatic cleanup.'
            )
          );
          console.log(chalk.dim('  To manually remove:'));
          console.log(
            chalk.dim(`    git worktree remove --force ${worktreeInfo.path}`)
          );
          console.log(chalk.dim(`    git branch -D ${worktreeInfo.branch}`));
        } else {
          // Clean up the worktree
          try {
            await scriptCleanup.cleanupWorkflow(workflowResult?.id, {
              worktreePath: worktreeInfo.path,
              branchName: worktreeInfo.branch,
              force: false,
            });
            console.log(
              chalk.green('  Worktree and branch cleaned up successfully')
            );
          } catch (cleanupError) {
            console.log(
              chalk.yellow(
                `  Warning: Cleanup failed: ${getErrorMessage(cleanupError)}`
              )
            );
            console.log(chalk.dim('  To manually remove:'));
            console.log(
              chalk.dim(`    git worktree remove --force ${worktreeInfo.path}`)
            );
            console.log(chalk.dim(`    git branch -D ${worktreeInfo.branch}`));
          }
        }
      } else {
        console.log(chalk.dim('  No worktree to clean up'));
      }

      // Clean up old debug files (uses default retention period)
      try {
        const oldFilesRemoved = await debugFileManager.cleanupOldFiles();
        if (oldFilesRemoved > 0) {
          console.log(
            chalk.dim(`  Cleaned up ${oldFilesRemoved} old debug file(s)`)
          );
        }
      } catch (cleanupError) {
        logger.warn(
          `Periodic debug file cleanup failed: ${getErrorMessage(cleanupError)}`
        );
      }

      console.log();
    }

    // If there was an error, display it prominently and exit
    if (executionError) {
      console.log(chalk.red.bold('\n❌ Execution completed with errors\n'));
      console.log(chalk.red(`Error: ${executionError.message}`));
      if (workflowResult) {
        console.log(
          chalk.dim(
            `\nDebug files available at: ${debugFileManager.getDebugDir()}`
          )
        );
        console.log(
          chalk.dim('Run "airunx cleanup --help" for cleanup options')
        );
      }
      process.exit(1);
    }

    // Restore console.log before exit (safety for library/test usage)
    console.log = originalConsoleLog;

    // Force exit: LangGraph's compiled StateGraph and the codex CLI adapter
    // leave internal handles (timers, pipes) that cannot be closed externally.
    // Without this, Node.js waits indefinitely for those handles to release.
    // Tracked as a known dependency limitation — not a leak in our code.
    process.exit(0);
  } catch (error) {
    console.log = originalConsoleLog;
    spinner.fail(chalk.red('Execution failed'));
    handleCommandError(error, logger, 'Execution');
    process.exit(1);
  }
}

/**
 * Resolve project directory using intelligent detection chain
 *
 * Priority:
 * 1. CLI --project flag: Explicit selection
 * 2. Prompt analysis: Extract project name from work prompt
 * 3. Current directory: Check if cwd is within a configured project
 * 4. Default project: Fall back to default_project_location
 * 5. Package directory: Last resort fallback to process.cwd()
 */
function resolveProjectDirectory(
  cliProject: string | undefined,
  prompt: string | undefined,
  settings: ResolvedSettings
): ResolvedProject {
  return resolveProject({
    cliFlag: cliProject,
    prompt,
    cwd: process.cwd(),
    settings,
  });
}
