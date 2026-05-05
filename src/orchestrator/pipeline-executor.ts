/**
 * Pipeline Executor - Main orchestration engine
 * Reads pipeline configuration and executes end-to-end workflows
 */

import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type {
  Pipeline,
  PipelineConfig,
  WorkflowContext,
  WorkflowStatus,
  ExecutionFidelityLevel,
  InputType,
  OrchestrationMode,
} from '../core/types.js';
import type { ExecutionAdapter, SystemConfig } from '../core/adapter-types.js';
import type { AdapterFactory } from '../adapters/adapter-factory.js';
import type { ProviderRouter } from './provider-router.js';
import { StateManager } from './state-manager.js';
import { LangGraphRunner } from './langgraph-runner.js';
import { TodoManager } from '../utils/todo-manager.js';
import { DEFAULT_TODO_DIR } from './constants.js';
import { FidelityExecutor } from './fidelity-executor.js';
import { createLogger } from '../utils/logger.js';
import { toError } from '../utils/error-handlers.js';
import {
  loadPipelineConfig as loadPipelineConfigUtil,
  loadPipelineConfigWithSource,
} from '../utils/config.js';
import { AutoCommit } from '../pr-automation/auto-commit.js';
import { GitHubCLI, type WorkflowRun } from '../integrations/github-cli.js';
import { PRGenerator } from '../pr-automation/pr-generator.js';
import type { AutoCommitResult } from '../pr-automation/auto-commit.js';
import type { PRGeneratorResult } from '../pr-automation/pr-generator.js';
import type { ContextResolver } from '../utils/context-resolver.js';
import { loadSettings } from '../utils/settings.js';

const logger = createLogger('pipeline-executor');

/**
 * Workflow statuses that indicate failure (used to guard PR creation)
 */
const NON_SUCCESS_WORKFLOW_STATUSES: WorkflowStatus[] = [
  'failed',
  'completed_with_errors',
];

/**
 * Patterns indicating local infrastructure is missing, not a real test failure.
 * Note: overlaps with `retryablePatterns` in src/utils/errors.ts but serves a
 * different purpose. That classifies transient backend failures for the circuit
 * breaker; this classifies local environment gaps for the test gate.
 */
const INFRA_MISSING_PATTERNS = [
  /command not found/i,
  /SQLSTATE\[HY000\].*Connection refused/i,
  /Can't connect to local MySQL server/i,
  /ERROR 200[23]/i,
  /running with the --read-only option/i,
  /mysqli_real_connect\(\).*Connection refused/i,
  /SQLSTATE\[HY000\].*No such file or directory/i,
  /Cannot assign null to property .+::\$.+of type .+Mysqli/i,
];

/**
 * Classify whether a test failure is due to missing local infrastructure
 * (e.g., no MySQL server, no PHPCS binary) rather than a real code failure.
 */
function isInfrastructureFailure(
  exitCode: number | null,
  output: string
): boolean {
  if (exitCode === 127) return true;
  return INFRA_MISSING_PATTERNS.some((p) => p.test(output));
}

/**
 * Callback invoked when workflow execution starts
 * Provides workflow ID and state manager for external progress monitoring
 */
export type WorkflowStartCallback = (
  workflowId: string,
  stateManager: StateManager
) => void;

/**
 * Resolve the retry target stage from the pipeline's judge evaluates_stage config.
 * Falls back to 'implement' for backward compatibility.
 */
function getRetryTargetStage(pipeline: Pipeline): string {
  const judgeStage = pipeline.stages.find(
    (s) => s.decision === 'iterate_or_proceed'
  );
  return judgeStage?.evaluates_stage || 'implement';
}

/**
 * Workflow execution options
 */
export interface WorkflowExecutionOptions {
  input: string;
  inputType: InputType;
  mode?: OrchestrationMode;
  fidelityLevel?: ExecutionFidelityLevel;
  pipelineName?: string;
  worktreePath?: string;
  repoPath?: string;
  branchName?: string;
  taskTitle?: string;
  taskDescription?: string;
  backend?: string;
  /** Issue number to reference in commit/PR */
  issueNumber?: number;
  /** Full GitHub issue URL for PR linking (enables cross-repo issue closing) */
  issueUrl?: string;
  /** Skip automatic PR creation */
  skipPR?: boolean;
  /** Skip automatic commit */
  skipCommit?: boolean;
  /** Shared ContextResolver for cache efficiency across workflow */
  contextResolver?: ContextResolver;
  /** Callback invoked when workflow starts (for progress monitoring) */
  onWorkflowStart?: WorkflowStartCallback;
  /** Show detailed execution progress (stages, timing, spawn counts) */
  verbose?: boolean;
  /** Pre-loaded static context from settings and --context flag */
  staticContext?: string;
  /**
   * When true, poll GitHub Actions after PR creation and iterate on CI failures
   * (up to 3 attempts). Requires workflows in the repo; no-ops otherwise.
   */
  ciVerificationGate?: boolean;
  /** Mark completed checkboxes on source GitHub issues (default: true) */
  markIssueCheckboxes?: boolean;
}

/**
 * Result of PR automation
 */
export interface PRAutomationResult {
  commit?: AutoCommitResult;
  pr?: PRGeneratorResult;
}

/**
 * Options for creating a PipelineExecutor
 */
export interface PipelineExecutorOptions {
  /** Single adapter for backward compatibility (used when adapterFactory not provided) */
  adapter?: ExecutionAdapter;
  /** Adapter factory for multi-provider support */
  adapterFactory?: AdapterFactory;
  /** Provider router for per-agent backend selection */
  providerRouter?: ProviderRouter;
  /** System configuration (required when using adapterFactory) */
  systemConfig?: SystemConfig;
}

/**
 * Pipeline Executor class
 */
export class PipelineExecutor {
  private adapter: ExecutionAdapter | null;
  private adapterFactory: AdapterFactory | null;
  private providerRouter: ProviderRouter | null;
  private systemConfig: SystemConfig | null;
  private stateManager: StateManager;
  private todoManager: TodoManager;
  private pipelineConfig: PipelineConfig | null = null;
  private autoCommit: AutoCommit;
  private prGenerator: PRGenerator;

  constructor(adapter: ExecutionAdapter);
  constructor(options: PipelineExecutorOptions);
  constructor(adapterOrOptions: ExecutionAdapter | PipelineExecutorOptions) {
    // Handle both constructor signatures for backward compatibility
    // Use 'execute' in check to detect legacy ExecutionAdapter (consistent with LangGraphRunner/AgentInvoker)
    if ('execute' in adapterOrOptions) {
      // Legacy: single adapter passed directly
      this.adapter = adapterOrOptions;
      this.adapterFactory = null;
      this.providerRouter = null;
      this.systemConfig = null;
    } else {
      // New: options object with multi-provider support
      const options = adapterOrOptions;
      this.adapter = options.adapter ?? null;
      this.adapterFactory = options.adapterFactory ?? null;
      this.providerRouter = options.providerRouter ?? null;
      this.systemConfig = options.systemConfig ?? null;
    }

    // Validate configuration: must have either single adapter or complete multi-provider setup
    if (
      !this.adapter &&
      !(this.adapterFactory && this.providerRouter && this.systemConfig)
    ) {
      throw new Error(
        'PipelineExecutor must be initialized with either a single adapter or ' +
          'an options object containing adapterFactory, providerRouter, and systemConfig.'
      );
    }

    this.stateManager = new StateManager();
    this.todoManager = new TodoManager();
    this.autoCommit = new AutoCommit();
    this.prGenerator = new PRGenerator();
  }

  /**
   * Load pipeline configuration using hierarchical resolution
   * Priority: explicit path → project .airunx → user config → package default
   *
   * @param configPath - Optional explicit path to load from (for testing)
   */
  loadPipelineConfig(configPath?: string): PipelineConfig | null {
    // If explicit path provided, use config utility which handles path loading
    if (configPath) {
      try {
        this.pipelineConfig = loadPipelineConfigUtil(configPath);
        logger.info(`Loaded pipeline config from ${configPath}`);
        return this.pipelineConfig;
      } catch (error) {
        logger.warn(
          `Failed to load pipeline config from ${configPath}: ${toError(error).message}`
        );
        return null;
      }
    }

    // Use centralized loading with source tracking
    const result = loadPipelineConfigWithSource();
    if (result) {
      this.pipelineConfig = result.config;
      logger.info(
        `Loaded pipeline config from ${result.sourcePath} with ${result.pipelineCount} pipeline(s)`
      );
      return result.config;
    }
    return null;
  }

  /**
   * Get pipeline by name
   */
  getPipeline(name: string): Pipeline | null {
    if (!this.pipelineConfig) {
      return null;
    }

    return this.pipelineConfig.pipelines[name] || null;
  }

  /**
   * Execute workflow end-to-end
   */
  async execute(options: WorkflowExecutionOptions): Promise<WorkflowContext> {
    logger.info(`Starting workflow execution`);
    logger.info(`Input: ${options.input}`);
    logger.info(`Input Type: ${options.inputType}`);
    logger.info(`Mode: ${options.mode || 'pipeline'}`);

    // Initialize TodoManager with namespace for execution isolation
    const todoNamespace = this.deriveTodoNamespace(options);
    this.todoManager = new TodoManager(DEFAULT_TODO_DIR, todoNamespace);
    logger.debug(`Todo namespace: ${todoNamespace}`);

    // Load pipeline configuration if not already loaded
    if (!this.pipelineConfig) {
      this.loadPipelineConfig();
    }

    // Select pipeline based on fidelity if not explicitly specified
    // Fidelity-to-pipeline mapping:
    //   fast → thin, standard → standard, thorough → feature, ultra → mission-critical
    let pipelineName = options.pipelineName;
    if (!pipelineName && options.fidelityLevel) {
      const fidelityToPipeline: Record<string, string> = {
        fast: 'thin',
        standard: 'standard',
        thorough: 'feature',
        ultra: 'mission-critical',
      };
      const suggestedPipeline =
        fidelityToPipeline[options.fidelityLevel] || 'standard';
      // Only use suggested pipeline if it exists, otherwise fall back to 'standard'
      if (this.getPipeline(suggestedPipeline)) {
        pipelineName = suggestedPipeline;
        logger.info(
          `Auto-selected '${pipelineName}' pipeline based on fidelity: ${options.fidelityLevel}`
        );
      } else {
        logger.debug(
          `Pipeline '${suggestedPipeline}' not found for fidelity '${options.fidelityLevel}', using 'standard'`
        );
      }
    }
    pipelineName = pipelineName || 'standard';

    let pipeline = this.getPipeline(pipelineName);

    // Fail fast if pipeline not found - YAML config is single source of truth
    if (!pipeline) {
      throw new Error(
        `Pipeline '${pipelineName}' not found. ` +
          `Ensure a valid pipelines.yaml exists and defines this pipeline. ` +
          `Run 'airunx doctor' to check configuration.`
      );
    }

    logger.info(`Using pipeline: ${pipeline.name}`);

    // Resolve fidelity
    const fidelityResolution = FidelityExecutor.resolveStageFidelity({
      cliFlag: options.fidelityLevel,
      pipeline,
    });

    logger.info(FidelityExecutor.summarizeFidelity(fidelityResolution));

    // Determine max iterations: pipeline-specific > fidelity-based default
    const maxIterations =
      pipeline.max_iterations ??
      FidelityExecutor.getMaxIterations(fidelityResolution.params);

    logger.info(`Max iterations: ${maxIterations}`);

    // Create workflow context with pipeline name for resumability
    const workflowId = this.generateWorkflowId();
    const workflowContext = this.stateManager.createWorkflowContext({
      id: workflowId,
      input: options.input,
      inputType: options.inputType,
      mode: options.mode || 'pipeline',
      fidelityLevel: fidelityResolution.level,
      worktreePath: options.worktreePath,
      repoPath: options.repoPath,
      branchName: options.branchName,
      taskTitle: options.taskTitle,
      taskDescription: options.taskDescription,
      issueUrl: options.issueUrl,
      backend: options.backend,
      pipelineName,
      maxIterations,
    });

    // Save initial state
    await this.stateManager.save(workflowContext);
    logger.info(`Created workflow: ${workflowId}`);

    // Notify external listeners that workflow has started (for progress monitoring)
    if (options.onWorkflowStart) {
      options.onWorkflowStart(workflowId, this.stateManager);
    }

    // Create todos from task description (if available)
    if (options.taskDescription) {
      await this.createTodosFromDescription(
        workflowId,
        options.taskDescription
      );
    }

    // Execute pipeline with LangGraph
    // Resolve tool configs once and pass to runner (dependency injection)
    const settings = loadSettings(options.worktreePath || process.cwd());
    const toolConfigs: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      settings.resolvedToolConfigs || {}
    )) {
      if (value) toolConfigs[key] = value;
    }

    // Make agent tools available via tool configs so agents know what they can call
    // Import lazily to avoid circular deps
    const { getAllAgentToolDefinitions } = await import(
      '../agent-tools/index.js'
    );
    const agentToolDefs = getAllAgentToolDefinitions();
    if (agentToolDefs.length > 0) {
      toolConfigs['agent_tools'] = JSON.stringify(
        agentToolDefs.map((t) => ({ name: t.name, description: t.description }))
      );
    }

    // Use options-based constructor if we have factory + router (multi-provider mode)
    const runner =
      this.adapterFactory && this.providerRouter
        ? new LangGraphRunner({
            adapterFactory: this.adapterFactory,
            providerRouter: this.providerRouter,
            fallbackBackend: this.systemConfig?.fallback_backend,
            stateManager: this.stateManager,
            pipeline,
            workflowContext,
            contextResolver: options.contextResolver,
            verbose: options.verbose,
            staticContext: options.staticContext,
            toolConfigs,
          })
        : new LangGraphRunner(
            this.adapter!,
            this.stateManager,
            pipeline,
            workflowContext,
            options.contextResolver,
            options.staticContext
          );

    try {
      let result = await runner.execute();
      logger.info(`Workflow completed: ${workflowId}`);

      // Guard: If pipeline "completed" but produced no worktree (no code changes),
      // downgrade to completed_with_errors so the heartbeat runner treats it as a failure
      // instead of closing the issue with no deliverables.
      if (result.status === 'completed' && !result.worktreePath) {
        logger.warn(
          `Workflow ${workflowId} completed but produced no code changes (no worktree) — downgrading to completed_with_errors`
        );
        await this.stateManager.updateStatus(
          workflowId,
          'completed_with_errors'
        );
        result = { ...result, status: 'completed_with_errors' };
      }

      // Post-pipeline test verification gate: run project tests before PR creation.
      // If tests fail due to infrastructure (missing MySQL, PHPCS, etc.), fall back
      // to CI verification via GitHub Actions. If tests fail for real, re-run from
      // develop stage once.
      // Note: Static analysis is handled by the static-analyzer LLM agent in the
      // pipeline (analyze stage), not as a deterministic gate here.
      if (result.worktreePath && result.status === 'completed') {
        const testResult = this.runTestsInWorktree(result.worktreePath);
        if (!testResult.passed) {
          if (
            isInfrastructureFailure(
              testResult.exitCode,
              testResult.output ?? ''
            )
          ) {
            // Infrastructure failure — skip retry loop, fall back to CI
            result = await this.handleInfrastructureTestFailure(
              result,
              workflowId,
              options,
              runner,
              pipeline
            );
          } else {
            // Real test failure — retry from develop stage
            const devIdx = pipeline.stages.findIndex(
              (s) => s.name === getRetryTargetStage(pipeline)
            );
            if (devIdx !== -1) {
              logger.warn(
                'Tests failed after pipeline completion — iterating back to retry target stage'
              );
              // Inject test failure output into the workflow input so the
              // developer agent can see what broke during the retry.
              if (testResult.output) {
                result.input =
                  result.input +
                  '\n\n--- TEST FAILURE OUTPUT (fix these before proceeding) ---\n' +
                  testResult.output +
                  '\n--- END TEST FAILURE OUTPUT ---';
                await this.stateManager.save(result);
              }
              const savedOutputs = { ...(result.stageResults || {}) };
              for (let i = devIdx; i < pipeline.stages.length; i++) {
                delete savedOutputs[pipeline.stages[i].name];
              }
              result = await runner.execute(
                savedOutputs as Record<string, never>
              );
              // Verify tests after retry; downgrade if still failing
              if (result.worktreePath && result.status === 'completed') {
                const retry = this.runTestsInWorktree(result.worktreePath);
                if (!retry.passed) {
                  logger.warn(
                    'Tests still failing after retry — downgrading to completed_with_errors'
                  );
                  await this.stateManager.updateStatus(
                    workflowId,
                    'completed_with_errors'
                  );
                  result = { ...result, status: 'completed_with_errors' };
                }
              }
            } else {
              logger.warn(
                'Tests failed (no develop stage to retry) - downgrading to completed_with_errors'
              );
              await this.stateManager.updateStatus(
                workflowId,
                'completed_with_errors'
              );
              result = { ...result, status: 'completed_with_errors' };
            }
          }
        }
      }

      // Attempt PR automation if worktree is available, not skipped, and not already created
      // (infra fallback creates the PR early for CI tracking)
      if (result.worktreePath && !options.skipCommit && !result.prUrl) {
        if (!NON_SUCCESS_WORKFLOW_STATUSES.includes(result.status)) {
          try {
            const prResult = await this.createPullRequest(result, {
              skipPR: options.skipPR,
              issueNumber: options.issueNumber,
            });

            // Persist PR automation results atomically to avoid race conditions
            // Define updates once and apply to both state manager and local result
            if (prResult.commit || prResult.pr) {
              const updates: Partial<WorkflowContext> = {};
              if (prResult.commit) {
                updates.commitSha = prResult.commit.commitSha;
              }
              if (prResult.pr) {
                updates.prUrl = prResult.pr.url;
                updates.prNumber = prResult.pr.number;
              }

              await this.stateManager.update(result.id, (context) => ({
                ...context,
                ...updates,
              }));

              // Create new result object with updates to avoid mutation
              result = { ...result, ...updates };
            }
          } catch (prError) {
            // PR automation failure is non-fatal
            logger.warn(
              `PR automation failed: ${toError(prError).message}. Workflow completed but PR not created.`
            );
          }
        } else {
          logger.warn(
            `Skipping PR creation: workflow status is '${result.status}'`
          );
        }

        // CI verification gate: if enabled, poll GitHub Actions and iterate on
        // failures so PRs aren't marked complete with failing CI (e.g., PHPCS).
        // Only runs when the system is configured to use the GH Actions fallback.
        if (
          options.ciVerificationGate &&
          result.status === 'completed' &&
          result.commitSha &&
          result.branchName &&
          result.issueUrl
        ) {
          const parsed = GitHubCLI.parseGitHubUrl(result.issueUrl);
          if (parsed?.repo) {
            logger.info(
              'CI verification gate enabled — polling GitHub Actions'
            );
            result = await this.waitForCIWithRetry(
              parsed.repo,
              result.branchName!,
              result.commitSha!,
              result,
              workflowId,
              runner,
              pipeline,
              { issueNumber: options.issueNumber }
            );
          }
        }
      }

      // Final step: mark completed checkboxes on source issue.
      // Runs on ALL code paths (normal, infra failure, CI retry, completed_with_errors).
      // Skipped when: setting is off, skipCommit (dry-run), or markIssueCheckboxes guards fail.
      if (options.markIssueCheckboxes !== false && !options.skipCommit) {
        result = await this.markIssueCheckboxes(result, options);
      }

      return result;
    } catch (error) {
      logger.error(`Workflow failed: ${workflowId}`, toError(error));
      await this.stateManager.updateStatus(workflowId, 'failed');
      throw error;
    }
  }

  /**
   * Generate unique workflow ID
   */
  private generateWorkflowId(): string {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `workflow-${timestamp}-${random}`;
  }

  /**
   * Create todos from task description
   * This is a simplified version - in production, this would parse
   * acceptance criteria or requirements to create specific todos
   */
  private async createTodosFromDescription(
    workflowId: string,
    description: string
  ): Promise<void> {
    logger.info('Creating todos from task description');

    // Parse description for bullet points or numbered lists
    const lines = description.split('\n');
    const todoLines = lines.filter(
      (line) =>
        line.trim().match(/^[-*•]\s+/) || // Bullet points
        line.trim().match(/^\d+\.\s+/) // Numbered lists
    );

    if (todoLines.length === 0) {
      // Create a single todo for the whole task
      await this.todoManager.create({
        title: 'Complete implementation',
        description,
        status: 'pending',
        priority: 'p1',
      });
    } else {
      // Create todos from parsed lines
      for (const line of todoLines) {
        const cleaned = line
          .trim()
          .replace(/^[-*•]\s+/, '')
          .replace(/^\d+\.\s+/, '');

        if (cleaned.length > 0) {
          await this.todoManager.create({
            title: cleaned,
            status: 'pending',
            priority: 'p2',
          });
        }
      }
    }

    // Update workflow context with todos
    const todos = await this.todoManager.getAll();
    await this.stateManager.updateTodos(workflowId, todos);

    logger.info(`Created ${todos.length} todo(s)`);
  }

  /**
   * Resume workflow from saved state
   *
   * This method implements true resumability by:
   * 1. Loading the saved workflow context with completed stage outputs
   * 2. Passing completed stages to the runner so it can skip them
   * 3. Continuing execution from the last incomplete stage
   */
  async resume(workflowId: string): Promise<WorkflowContext> {
    logger.info(`Resuming workflow: ${workflowId}`);

    const context = await this.stateManager.load(workflowId);
    if (!context) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    if (context.status === 'completed') {
      logger.warn('Workflow already completed');
      return context;
    }

    if (context.status === 'failed') {
      logger.warn(
        'Workflow previously failed, attempting to resume from last checkpoint'
      );
    }

    // Load pipeline using stored name from context (with fallback to 'standard')
    this.loadPipelineConfig();
    const pipelineName = context.pipelineName || 'standard';
    const pipeline = this.getPipeline(pipelineName);
    if (!pipeline) {
      throw new Error(
        `Pipeline '${pipelineName}' not found. ` +
          `Ensure a valid pipelines.yaml exists and defines this pipeline. ` +
          `Run 'airunx doctor' to check configuration.`
      );
    }
    logger.info(`Resuming with pipeline: ${pipelineName}`);

    // Resume execution with saved state
    // The runner will skip stages that are already complete based on savedStageOutputs
    // Use options-based constructor if we have factory + router (multi-provider mode)
    const runner =
      this.adapterFactory && this.providerRouter
        ? new LangGraphRunner({
            adapterFactory: this.adapterFactory,
            providerRouter: this.providerRouter,
            fallbackBackend: this.systemConfig?.fallback_backend,
            stateManager: this.stateManager,
            pipeline,
            workflowContext: context,
          })
        : new LangGraphRunner(
            this.adapter!,
            this.stateManager,
            pipeline,
            context
          );

    try {
      // Pass saved stage outputs from the context to enable true resumability.
      // Type assertion needed: workflow state uses Record<string, unknown> (Zod schema)
      // while runner.execute() expects its internal StageOutput union type.
      // The data is structurally compatible at runtime.
      const result = await runner.execute(
        context.stageResults as Parameters<typeof runner.execute>[0]
      );
      logger.info(`Workflow resumed and completed: ${workflowId}`);
      return result;
    } catch (error) {
      logger.error(`Workflow resume failed: ${workflowId}`, toError(error));
      await this.stateManager.updateStatus(workflowId, 'failed');
      throw error;
    }
  }

  /**
   * Get workflow status
   */
  async getStatus(workflowId: string): Promise<WorkflowContext | null> {
    return await this.stateManager.load(workflowId);
  }

  /**
   * Create commit and pull request from completed workflow
   */
  async createPullRequest(
    context: WorkflowContext,
    options: { skipPR?: boolean; issueNumber?: number } = {}
  ): Promise<PRAutomationResult> {
    const result: PRAutomationResult = {};

    if (!context.worktreePath) {
      throw new Error('No worktree path available for PR automation');
    }

    // Step 1: Create commit (skip if already committed by CI fallback)
    if (!context.commitSha) {
      logger.info('Creating commit with workflow metadata...');
      try {
        result.commit = await this.autoCommit.commit(context, {
          issueNumber: options.issueNumber,
        });
        logger.info(`Commit created: ${result.commit.commitSha.slice(0, 7)}`);
      } catch (error) {
        // Log and re-throw original error to preserve stack trace
        logger.error(`Failed to create commit: ${toError(error).message}`);
        throw error;
      }
    } else {
      // CI fallback already committed and pushed
      result.commit = {
        commitSha: context.commitSha,
        branch: context.branchName!,
        pushed: true,
      };
    }

    // Step 2: Create PR (unless skipped or push failed)
    if (!options.skipPR && result.commit?.pushed) {
      logger.info('Creating pull request...');
      try {
        result.pr = await this.prGenerator.create(context);
        logger.info(`PR created: ${result.pr.url}`);
      } catch (error) {
        // PR creation failure is logged but not fatal
        logger.warn(`Failed to create PR: ${toError(error).message}`);
      }
    } else if (!options.skipPR && result.commit && !result.commit.pushed) {
      logger.warn(
        'Skipping PR creation: push to remote failed. Push manually and create PR.'
      );
    }

    return result;
  }

  /**
   * Clean up completed workflows
   */
  async cleanup(workflowId: string): Promise<void> {
    logger.info(`Cleaning up workflow: ${workflowId}`);
    await this.stateManager.cleanup(workflowId);
  }

  /**
   * Run project tests in the worktree and return whether they passed.
   * Skips silently if no test framework is detected.
   * Returns exitCode so callers can distinguish infrastructure failures
   * (exit 127, connection errors) from real test failures.
   */
  private runTestsInWorktree(worktreePath: string): {
    passed: boolean;
    skipped: boolean;
    exitCode: number | null;
    output?: string;
  } {
    const testCmd = this.detectTestCommand(worktreePath);
    if (!testCmd) {
      logger.debug('No test framework detected in worktree, skipping');
      return { passed: true, skipped: true, exitCode: null };
    }

    // Auto-install dependencies if binaries are missing (worktrees don't inherit vendor/)
    this.installDepsIfNeeded(worktreePath);

    logger.info(
      `Running test verification: ${testCmd.cmd} ${testCmd.args.join(' ')}`
    );
    const result = spawnSync(testCmd.cmd, testCmd.args, {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: 'pipe',
    });

    if (result.status === 0) {
      logger.info('Test verification passed');
      return { passed: true, skipped: false, exitCode: 0 };
    }

    const output = (result.stderr || result.stdout || '').slice(0, 5000);
    logger.warn(`Test verification failed (exit ${result.status})`);
    return { passed: false, skipped: false, exitCode: result.status, output };
  }

  /**
   * Detect the project's test command from config files in the worktree.
   * Returns null if no recognised test framework is found.
   */
  private detectTestCommand(
    worktreePath: string
  ): { cmd: string; args: string[] } | null {
    // PHP: composer.json
    const composerPath = join(worktreePath, 'composer.json');
    if (existsSync(composerPath)) {
      try {
        const composer = JSON.parse(readFileSync(composerPath, 'utf-8'));
        if (composer.scripts?.test) return { cmd: 'composer', args: ['test'] };
        if (composer['require-dev']?.['phpunit/phpunit'])
          return { cmd: join(worktreePath, 'vendor/bin/phpunit'), args: [] };
      } catch {
        /* skip unparseable config */
      }
    }

    // Node: package.json
    const packagePath = join(worktreePath, 'package.json');
    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'));
        // Skip the default npm init placeholder
        if (pkg.scripts?.test && !pkg.scripts.test.startsWith('echo "Error:')) {
          return { cmd: 'npm', args: ['test'] };
        }
      } catch {
        /* skip unparseable config */
      }
    }

    return null;
  }

  /**
   * Auto-install project dependencies if the vendor/node_modules directory
   * is missing. Worktrees don't inherit installed dependencies from the
   * main workspace, so this is needed on first test run.
   * Only runs when binaries are absent — skips if already installed.
   */
  private installDepsIfNeeded(worktreePath: string): void {
    // PHP: composer install if vendor/ is missing
    if (
      existsSync(join(worktreePath, 'composer.json')) &&
      !existsSync(join(worktreePath, 'vendor'))
    ) {
      logger.info('Installing PHP dependencies (vendor/ missing in worktree)');
      const result = spawnSync(
        'composer',
        [
          'install',
          '--no-interaction',
          '--no-scripts',
          '--no-plugins',
          '--prefer-dist',
          '--quiet',
        ],
        {
          cwd: worktreePath,
          encoding: 'utf-8',
          timeout: 300_000,
          stdio: 'pipe',
        }
      );
      if (result.status !== 0) {
        logger.warn(
          `composer install failed (exit ${result.status}): ${(result.stderr || '').slice(0, 500)}`
        );
      }
    }

    // Node: npm install if node_modules/ is missing
    if (
      existsSync(join(worktreePath, 'package.json')) &&
      !existsSync(join(worktreePath, 'node_modules'))
    ) {
      logger.info(
        'Installing Node dependencies (node_modules/ missing in worktree)'
      );
      const result = spawnSync('npm', ['install', '--ignore-scripts'], {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 300_000,
        stdio: 'pipe',
      });
      if (result.status !== 0) {
        logger.warn(
          `npm install failed (exit ${result.status}): ${(result.stderr || '').slice(0, 500)}`
        );
      }
    }
  }

  /**
   * Handle test failures classified as infrastructure-missing.
   * Commits+pushes the branch, creates PR early, then polls CI with retry loop.
   */
  private async handleInfrastructureTestFailure(
    result: WorkflowContext,
    workflowId: string,
    options: { issueNumber?: number; skipPR?: boolean },
    runner: LangGraphRunner,
    pipeline: Pipeline
  ): Promise<WorkflowContext> {
    logger.info(
      'Local tests failed due to missing infrastructure — falling back to CI verification'
    );

    // Commit and push
    const commitResult = await this.autoCommit.commit(result, {
      issueNumber: options.issueNumber,
    });

    if (!commitResult.pushed) {
      logger.warn('Push failed — cannot fall back to CI. Downgrading.');
      await this.stateManager.updateStatus(workflowId, 'completed_with_errors');
      return { ...result, status: 'completed_with_errors' };
    }

    // Derive repo from issue URL. parseGitHubUrl returns { repo: "owner/repo", ... }
    const parsed = GitHubCLI.parseGitHubUrl(result.issueUrl ?? '');
    if (!parsed?.repo) {
      logger.warn('Cannot determine repo for CI polling. Downgrading.');
      await this.stateManager.updateStatus(workflowId, 'completed_with_errors');
      return { ...result, status: 'completed_with_errors' };
    }

    // Create PR early so CI is visible and the branch is trackable
    result = {
      ...result,
      commitSha: commitResult.commitSha,
      branchName: commitResult.branch,
    };
    try {
      const prResult = await this.createPullRequest(result, {
        skipPR: options.skipPR,
        issueNumber: options.issueNumber,
      });
      if (prResult.pr) {
        result = {
          ...result,
          prUrl: prResult.pr.url,
          prNumber: prResult.pr.number,
        };
        await this.stateManager.update(workflowId, (ctx) => ({
          ...ctx,
          commitSha: commitResult.commitSha,
          prUrl: prResult.pr!.url,
          prNumber: prResult.pr!.number,
        }));
        logger.info(`PR created early for CI tracking: ${prResult.pr.url}`);
      }
    } catch (err) {
      logger.warn(
        `Early PR creation failed (non-fatal): ${toError(err).message}`
      );
    }

    // Poll CI with retry loop — iterate on failures
    return this.waitForCIWithRetry(
      parsed.repo,
      commitResult.branch,
      commitResult.commitSha,
      result,
      workflowId,
      runner,
      pipeline,
      options
    );
  }

  /**
   * Mark completed checkboxes on the source GitHub issue.
   * Runs automatically when judge output contains github_issue_updates.
   * Non-fatal: logs warning on failure, does not fail the run.
   */
  private async markIssueCheckboxes(
    result: WorkflowContext,
    options: WorkflowExecutionOptions
  ): Promise<WorkflowContext> {
    // Extract checkboxes from judge stage output
    // The judge stores parsedOutput in outputs (see langgraph-runner.ts judgeStageOutput)
    const judgeStageResult = result.stageResults?.['judge'] as
      | {
          outputs?: {
            parsedOutput?: { checkboxesToComplete?: string[] };
          };
        }
      | undefined;
    const checkboxes =
      judgeStageResult?.outputs?.parsedOutput?.checkboxesToComplete;

    logger.debug(
      `Checkbox extraction: judgeStageResult=${!!judgeStageResult}, ` +
        `parsedOutput=${!!judgeStageResult?.outputs?.parsedOutput}, ` +
        `checkboxes=${checkboxes?.length ?? 0}, ` +
        `status=${result.status}, issueUrl=${!!options.issueUrl}`
    );

    // Mark checkboxes on completed or completed_with_errors (PR was created, work was done)
    if (
      (result.status !== 'completed' &&
        result.status !== 'completed_with_errors') ||
      !options.issueUrl ||
      !checkboxes?.length
    ) {
      return result;
    }

    try {
      const parsed = GitHubCLI.parseGitHubUrl(options.issueUrl);
      if (!parsed || parsed.type === 'repo') return result;

      const issue = await GitHubCLI.getIssue(parsed.repo, parsed.number);
      let body = issue.body;
      let marked = 0;

      // Structured regex replacement — ONLY toggle checkbox state
      for (const checkboxText of checkboxes) {
        const escaped = checkboxText
          .trim()
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(
          `^(\\s*[-*+]\\s*)\\[ \\](\\s*${escaped}\\s*)$`,
          'm'
        );
        if (regex.test(body)) {
          body = body.replace(regex, '$1[x]$2');
          marked++;
        }
      }

      if (marked > 0) {
        await GitHubCLI.updateIssueBody({
          repo: parsed.repo,
          issueNumber: parsed.number,
          body,
        });

        const prRef = result.prNumber ? ` based on PR #${result.prNumber}` : '';
        await GitHubCLI.addIssueComment({
          repo: parsed.repo,
          issueNumber: parsed.number,
          body: `AIRunX checked off ${marked} item${marked > 1 ? 's' : ''}${prRef}.`,
        });
      }

      logger.info(
        `Marked ${marked}/${checkboxes.length} checkboxes on issue #${parsed.number}`
      );
      return result;
    } catch (err) {
      logger.warn(`Checkbox marking failed: ${toError(err).message}`);
      return result;
    }
  }

  /**
   * Poll CI with a retry loop: on failure, fetch logs, inject into workflow,
   * re-run from implement stage, commit+push, and poll again (up to MAX_CI_ITERATIONS).
   */
  private async waitForCIWithRetry(
    repo: string,
    branch: string,
    commitSha: string,
    result: WorkflowContext,
    workflowId: string,
    runner: LangGraphRunner,
    pipeline: Pipeline,
    options: { issueNumber?: number }
  ): Promise<WorkflowContext> {
    const MAX_CI_ITERATIONS = 3;
    let currentSha = commitSha;
    let currentResult = result;
    let lastCiReason: string | undefined;
    let attemptCount = 0;
    const originalInput = result.input;

    for (let attempt = 0; attempt < MAX_CI_ITERATIONS; attempt++) {
      const ciResult = await this.waitForCI(repo, branch, currentSha);

      if (ciResult.passed) {
        logger.info(
          `CI passed${attempt > 0 ? ` after ${attempt + 1} attempt(s)` : ''}`
        );
        return { ...currentResult, commitSha: currentSha, branchName: branch };
      }

      lastCiReason = ciResult.reason;
      attemptCount = attempt + 1;

      // Last attempt — don't retry, just fail
      if (attempt === MAX_CI_ITERATIONS - 1) {
        break;
      }

      // Fetch CI failure logs for agent consumption
      const runs = await GitHubCLI.listWorkflowRuns(repo, branch, currentSha);
      const failedRuns = runs.filter(
        (r) =>
          r.status === 'completed' &&
          !['success', 'skipped', 'neutral'].includes(r.conclusion ?? '')
      );
      let failedLogs = '';
      for (const run of failedRuns) {
        const logs = await GitHubCLI.getRunFailedLogs(repo, run.databaseId);
        if (logs) {
          failedLogs += `\n--- ${run.workflowName} (run ${run.databaseId}) ---\n${logs}\n`;
        }
      }

      if (!failedLogs) {
        logger.warn(
          'CI failed but could not fetch failure logs — stopping retries'
        );
        break;
      }

      logger.warn(
        `CI failed (attempt ${attempt + 1}/${MAX_CI_ITERATIONS}): ${ciResult.reason ?? 'unknown'} — iterating from retry target stage`
      );

      // Inject CI failure output — rebuild from original input each time to avoid stacking
      const updatedInput =
        originalInput +
        '\n\n--- CI FAILURE OUTPUT (fix these before proceeding) ---\n' +
        failedLogs +
        '\n--- END CI FAILURE OUTPUT ---' +
        '\n\nHINT: If failures are snapshot assertion mismatches (e.g. assertMatchesJsonSnapshot), ' +
        'update the snapshot files in the __snapshots__/ directory to match the new expected output. ' +
        'Do NOT just add new test methods — fix the existing failing tests.';
      currentResult.input = updatedInput;
      runner.updateInput(updatedInput);

      // Re-run from develop stage with maxIterations=1 to force single pass
      // (prevents re-entering the full judge iteration loop)
      const devIdx = pipeline.stages.findIndex(
        (s) => s.name === getRetryTargetStage(pipeline)
      );
      if (devIdx === -1) {
        logger.warn(
          'No retry target stage found — cannot iterate on CI failure'
        );
        break;
      }

      const savedOutputs = { ...(currentResult.stageResults || {}) };
      for (let i = devIdx; i < pipeline.stages.length; i++) {
        delete savedOutputs[pipeline.stages[i].name];
      }
      await this.stateManager.save(currentResult);
      runner.setMaxIterations(1);
      currentResult = await runner.execute(
        savedOutputs as Parameters<typeof runner.execute>[0]
      );

      // Commit and push the fix (updates existing PR)
      const fixCommit = await this.autoCommit.commit(currentResult, {
        issueNumber: options.issueNumber,
      });
      if (!fixCommit.pushed) {
        logger.warn('Push failed during CI retry — stopping retries');
        break;
      }
      currentSha = fixCommit.commitSha;
    }

    // All retries exhausted or unrecoverable — include last known CI reason
    const reason = lastCiReason
      ? `CI verification failed after ${attemptCount} attempt(s): ${lastCiReason}`
      : `CI verification failed after ${attemptCount} attempt(s)`;
    await this.stateManager.update(workflowId, (ctx) => ({
      ...ctx,
      status: 'completed_with_errors' as const,
      failureReason: reason,
    }));
    return {
      ...currentResult,
      status: 'completed_with_errors',
      failureReason: reason,
    };
  }

  /**
   * Poll GitHub Actions CI results until all runs complete or timeout.
   * Returns { passed, reason? } so callers can propagate failure details.
   */
  private async waitForCI(
    repo: string,
    branch: string,
    commitSha: string
  ): Promise<{ passed: boolean; reason?: string }> {
    const APPEAR_TIMEOUT = 300_000; // 5 minutes
    const POLL_TIMEOUT = 1_800_000; // 30 minutes
    const POLL_INTERVAL = 15_000; // 15 seconds
    const startTime = Date.now();

    // Phase 1: Wait for runs to appear
    let runs: WorkflowRun[] = [];
    while (Date.now() - startTime < APPEAR_TIMEOUT) {
      try {
        runs = await GitHubCLI.listWorkflowRuns(repo, branch, commitSha);
      } catch (err) {
        logger.debug(
          `gh run list failed (will retry): ${toError(err).message}`
        );
      }
      if (runs.length > 0) break;
      await this.sleep(POLL_INTERVAL);
    }

    if (runs.length === 0) {
      const hasCI = await GitHubCLI.hasWorkflows(repo);
      if (!hasCI) {
        logger.warn(
          'No CI workflows configured for this repo — treating as passed'
        );
        return { passed: true };
      }
      logger.warn('CI workflows exist but no runs appeared within 5m');
      return {
        passed: false,
        reason: 'CI workflows exist but no runs appeared within 5m',
      };
    }

    // Phase 2: Poll until all complete
    const deadline = startTime + POLL_TIMEOUT;
    while (Date.now() < deadline) {
      try {
        runs = await GitHubCLI.listWorkflowRuns(repo, branch, commitSha);
      } catch (err) {
        logger.debug(
          `gh run list failed (will retry): ${toError(err).message}`
        );
        await this.sleep(POLL_INTERVAL);
        continue;
      }

      const allComplete = runs.every((r) => r.status === 'completed');
      if (allComplete) {
        const acceptable = new Set(['success', 'skipped', 'neutral']);
        const allPassed = runs.every((r) => acceptable.has(r.conclusion ?? ''));

        if (!allPassed) {
          const failed = runs
            .filter((r) => !acceptable.has(r.conclusion ?? ''))
            .map((r) => `${r.workflowName}: ${r.conclusion}`)
            .join(', ');
          logger.warn(`CI verification failed: ${failed}`);
          return { passed: false, reason: `CI failed: ${failed}` };
        }

        logger.info(`CI verification passed (${runs.length} workflow(s))`);
        return { passed: true };
      }

      await this.sleep(POLL_INTERVAL);
    }

    logger.warn('CI polling timed out after 30m');
    return { passed: false, reason: 'CI polling timed out after 30m' };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Derive a namespace for todo isolation based on execution context
   * This ensures parallel executions don't mix their todos
   */
  private deriveTodoNamespace(options: WorkflowExecutionOptions): string {
    // Extract from issueUrl if available (e.g., 'issue-123' or 'pr-456')
    if (options.issueUrl) {
      const parsedUrl = GitHubCLI.parseGitHubUrl(options.issueUrl);
      if (parsedUrl && parsedUrl.number !== undefined) {
        return `${parsedUrl.type}-${parsedUrl.number}`;
      }
    }

    // Use branch name as fallback (already unique per worktree)
    // Sanitize: replace invalid chars, collapse multiple hyphens, trim leading/trailing hyphens
    if (options.branchName) {
      return options.branchName
        .replace(/[^a-z0-9-]/gi, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 50);
    }

    // Final fallback: timestamp-based ID
    return `exec-${Date.now().toString(36)}`;
  }
}
