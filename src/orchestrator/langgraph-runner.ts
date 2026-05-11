/**
 * LangGraph Runner - StateGraph integration for orchestration
 * Creates and executes LangGraph StateGraph from pipeline configuration
 */

import { performance } from 'perf_hooks';
import { spawnAsync } from '../utils/async-spawn.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { StateGraph, END, START } from '@langchain/langgraph';
import type {
  Pipeline,
  RunReport,
  StageRecord,
  TimelineEvent,
  WorkflowContext,
} from '../core/types.js';
import {
  DEFAULT_FALLBACK_BACKEND,
  type BackendType,
  type ExecutionAdapter,
  type ExecutionResult,
  type ProjectContext,
} from '../core/adapter-types.js';
import {
  selectAdapterForRole,
  formatProviderSelectionLog,
  type AdapterFactory,
} from '../adapters/adapter-factory.js';
import type { ProviderRouter } from './provider-router.js';
import { StateManager } from './state-manager.js';
import { AgentInvoker } from './agent-invoker.js';
import { AuditLogger, getDefaultAuditDir } from '../audit/audit-logger.js';
import { FidelityChecker } from './fidelity-checker.js';
import { JudgeAgent } from './judge-agent.js';
import { IterationManager } from './iteration-manager.js';
import {
  appendIterationEntry,
  type IterationEntry,
} from './iteration-history.js';
import { FidelityExecutor } from './fidelity-executor.js';
import { createLogger } from '../utils/logger.js';
import { toError } from '../utils/error-handlers.js';
import { ContextResolver } from '../utils/context-resolver.js';
import { DEFAULT_MAX_ITERATIONS } from './iteration-manager.js';
import { formatHandoffContext } from './handoff-context.js';

/**
 * Safety ceiling for LangGraph super-steps. Generous to avoid false trips;
 * the application's own IterationManager enforces the real iteration limit.
 */
const LANGGRAPH_RECURSION_CEILING = 1000;

const logger = createLogger('langgraph-runner');

/**
 * Stage output type - discriminated union for type safety
 */
type StageOutput =
  | ExecutionResult
  | {
      success: boolean;
      outputs: Record<string, unknown>;
      metrics: { tokensUsed: number; duration: number; cost?: number };
      errors?: Error[];
    };

/**
 * Graph state for LangGraph
 */
interface GraphState {
  workflowId: string;
  currentStage: string;
  stageOutputs: Record<string, StageOutput>;
  shouldIterate: boolean;
  iterationTarget?: string;
}

/**
 * Options for creating a LangGraphRunner
 */
export interface LangGraphRunnerOptions {
  /** Single adapter for backward compatibility */
  adapter?: ExecutionAdapter;
  /** Adapter factory for multi-provider support */
  adapterFactory?: AdapterFactory;
  /** Provider router for per-agent backend selection */
  providerRouter?: ProviderRouter;
  /** Fallback backend when provider routing unavailable */
  fallbackBackend?: BackendType;
  /** State manager for workflow state */
  stateManager: StateManager;
  /** Pipeline configuration */
  pipeline: Pipeline;
  /** Workflow context */
  workflowContext: WorkflowContext;
  /** Context resolver for @mentions */
  contextResolver?: ContextResolver;
  /** Show detailed execution progress (stages, timing, spawn counts) */
  verbose?: boolean;
  /** Pre-loaded static context for all agents */
  staticContext?: string;
  /** Resolved tool configs (e.g., docs_location) to inject into agent prompts */
  toolConfigs?: Record<string, string>;
  /** Optional audit logger for structured stage events */
  auditLogger?: AuditLogger;
}

/**
 * LangGraph Runner class
 */
export class LangGraphRunner {
  private adapter: ExecutionAdapter | null;
  private adapterFactory: AdapterFactory | null;
  private providerRouter: ProviderRouter | null;
  private fallbackBackend: BackendType;
  private stateManager: StateManager;
  private iterationManager: IterationManager;
  private pipeline: Pipeline;
  private workflowContext: WorkflowContext;
  /** Saved stage outputs from previous execution for resumability */
  private savedStageOutputs: Record<string, StageOutput> = {};
  private contextResolver?: ContextResolver;
  private verbose: boolean;
  private spawnCount = 0;
  private staticContext?: string;
  /** Resolved tool configs (e.g., docs_location) loaded once for all stages */
  private toolConfigs: Record<string, string>;
  private auditLogger?: AuditLogger;
  /** Workflow start time for incremental report writing */
  private workflowStartTime = 0;

  constructor(
    adapter: ExecutionAdapter,
    stateManager: StateManager,
    pipeline: Pipeline,
    workflowContext: WorkflowContext,
    contextResolver?: ContextResolver,
    staticContext?: string
  );
  constructor(options: LangGraphRunnerOptions);
  constructor(
    adapterOrOptions: ExecutionAdapter | LangGraphRunnerOptions,
    stateManager?: StateManager,
    pipeline?: Pipeline,
    workflowContext?: WorkflowContext,
    contextResolver?: ContextResolver,
    staticContext?: string
  ) {
    // Handle both constructor signatures for backward compatibility
    // Use 'execute' in check to detect legacy ExecutionAdapter (consistent with PipelineExecutor/AgentInvoker)
    if ('execute' in adapterOrOptions) {
      // Legacy: adapter passed directly
      this.adapter = adapterOrOptions;
      this.adapterFactory = null;
      this.providerRouter = null;
      this.fallbackBackend = DEFAULT_FALLBACK_BACKEND;
      this.stateManager = stateManager!;
      this.pipeline = pipeline!;
      this.workflowContext = workflowContext!;
      this.contextResolver = contextResolver;
      this.verbose = false; // Legacy constructor doesn't support verbose
      this.staticContext = staticContext;
      this.toolConfigs = {};
      this.auditLogger = new AuditLogger(getDefaultAuditDir());
    } else {
      // New: options object with multi-provider support
      const options = adapterOrOptions;
      this.adapter = options.adapter ?? null;
      this.adapterFactory = options.adapterFactory ?? null;
      this.providerRouter = options.providerRouter ?? null;
      this.fallbackBackend =
        options.fallbackBackend ?? DEFAULT_FALLBACK_BACKEND;
      this.stateManager = options.stateManager;
      this.pipeline = options.pipeline;
      this.workflowContext = options.workflowContext;
      this.contextResolver = options.contextResolver;
      this.verbose = options.verbose ?? false;
      this.staticContext = options.staticContext;
      this.toolConfigs = options.toolConfigs ?? {};
      this.auditLogger =
        options.auditLogger ?? new AuditLogger(getDefaultAuditDir());
    }

    // Validate configuration: must have either single adapter or multi-provider setup
    if (!this.adapter && !this.adapterFactory) {
      throw new Error(
        'LangGraphRunner must be initialized with either a single adapter or adapterFactory.'
      );
    }

    this.iterationManager = new IterationManager(this.stateManager);
  }

  /**
   * Update the workflow input text that agents see (e.g., to inject CI failure output).
   * Must be called before execute() for the new input to take effect.
   */
  updateInput(input: string): void {
    this.workflowContext = { ...this.workflowContext, input };
  }

  /**
   * Override max iterations for the next execute() call (e.g., to force single-pass
   * during CI gate retry). Must be called before execute().
   */
  setMaxIterations(n: number): void {
    this.workflowContext = { ...this.workflowContext, maxIterations: n };
  }

  /**
   * Create and execute StateGraph from pipeline
   * @param savedStageOutputs - Optional saved outputs from previous execution for resumability
   */
  async execute(
    savedStageOutputs?: Record<string, StageOutput>
  ): Promise<WorkflowContext> {
    // Track workflow start time for total runtime calculation
    this.workflowStartTime = performance.now();
    const workflowStartTime = this.workflowStartTime;

    logger.info(`Creating StateGraph for pipeline: ${this.pipeline.name}`);

    // Store saved outputs for use in node execution
    this.savedStageOutputs = savedStageOutputs || {};

    // Create StateGraph
    const graph = new StateGraph<GraphState>({
      channels: {
        workflowId: null,
        currentStage: null,
        stageOutputs: null,
        shouldIterate: null,
        iterationTarget: null,
      },
    });

    // Add nodes for each stage
    for (const stage of this.pipeline.stages) {
      if (stage.name === 'judge') {
        // Judge node has special handling
        graph.addNode(stage.name, async (state: GraphState) => {
          return await this.executeJudgeNode(state, stage.name);
        });
      } else {
        // Regular agent node
        graph.addNode(stage.name, async (state: GraphState) => {
          return await this.executeAgentNode(state, stage.name);
        });
      }
    }

    // Add edges
    this.addEdges(graph);

    // Set entry point
    // Note: Type assertion is required here because LangGraph's START symbol has a special
    // type that doesn't match the generic node name type in addEdge. This is a known
    // limitation of LangGraph's TypeScript typings when mixing START/END symbols with
    // dynamic node names.
    const firstStage = this.pipeline.stages[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graph.addEdge(START, firstStage.name as any);

    // Compile graph
    const compiledGraph = graph.compile();

    // Initialize state with any saved outputs from previous execution
    // This enables true resumability - stages with saved outputs will be skipped
    const initialState: GraphState = {
      workflowId: this.workflowContext.id,
      currentStage: firstStage.name,
      stageOutputs: { ...this.savedStageOutputs },
      shouldIterate: false,
    };

    if (Object.keys(this.savedStageOutputs).length > 0) {
      logger.info(
        `Resuming with ${Object.keys(this.savedStageOutputs).length} completed stage(s)`
      );
    }

    // Update workflow status
    await this.stateManager.updateStatus(this.workflowContext.id, 'running');

    // Execute graph
    logger.info('Executing StateGraph');
    try {
      await compiledGraph.invoke(initialState, {
        recursionLimit: LANGGRAPH_RECURSION_CEILING,
      });
      logger.info('StateGraph execution completed');

      // Load final context to determine proper status
      const finalContext = await this.stateManager.load(
        this.workflowContext.id
      );

      // If finalContext is null, throw error to trigger catch block
      // This ensures workflow doesn't remain stuck in 'running' status
      if (!finalContext) {
        throw new Error(
          `StateGraph execution completed, but failed to load final context for workflow ${this.workflowContext.id}.`
        );
      }

      // Analyze stage results to set appropriate final status
      const stageOutputs = finalContext.stageResults || {};
      // Use type guard to safely filter valid StageOutput objects
      const stageResults = Object.values(stageOutputs).filter(
        (output): output is StageOutput =>
          output !== null && typeof output === 'object' && 'success' in output
      );
      const failedStages = stageResults.filter((output) => !output.success);
      const totalStages = stageResults.length;

      // Determine final status based on stage outcomes
      let finalStatus: 'completed' | 'completed_with_errors' | 'failed';

      if (totalStages === 0) {
        // No stages ran (edge case)
        finalStatus = 'failed';
        logger.error('Workflow completed with no stages executed');
      } else if (failedStages.length === totalStages) {
        // All stages failed
        finalStatus = 'failed';
        logger.error(`Workflow failed: all ${totalStages} stage(s) failed`);
      } else if (failedStages.length > 0) {
        // Some stages failed
        finalStatus = 'completed_with_errors';
        logger.warn(
          `Workflow completed with errors: ${failedStages.length}/${totalStages} stage(s) failed`
        );
      } else {
        // All stages succeeded
        finalStatus = 'completed';
        logger.info('Workflow completed successfully');
      }

      // Calculate and store total runtime
      const totalRuntimeMs = Math.round(performance.now() - workflowStartTime);

      // Verbose: Log pipeline completion summary
      if (this.verbose) {
        const totalSec = (totalRuntimeMs / 1000).toFixed(1);
        const spawnLabel = this.spawnCount === 1 ? 'spawn' : 'spawns';
        logger.info(
          `Pipeline complete: ${totalStages} stages, ${this.spawnCount} ${spawnLabel}, ${totalSec}s total`
        );
      }

      // Update final status and runtime atomically
      const updatedContext = await this.stateManager.update(
        this.workflowContext.id,
        (context) => ({
          ...context,
          status: finalStatus,
          metrics: {
            ...context.metrics,
            totalRuntimeMs,
          },
        })
      );

      // Write structured run report for post-run consumers
      this.writeRunReport(updatedContext, totalRuntimeMs);

      return updatedContext;
    } catch (error) {
      logger.error('StateGraph execution failed:', toError(error));
      await this.stateManager.updateStatus(this.workflowContext.id, 'failed');
      throw error;
    }
  }

  /**
   * Add edges to graph based on pipeline configuration
   * Handles optional stages by using conditional edges that can bypass them
   */
  private addEdges(graph: StateGraph<GraphState>): void {
    const stages = this.pipeline.stages;

    for (let i = 0; i < stages.length; i++) {
      const currentStage = stages[i];
      const nextStage = stages[i + 1];

      // Note: Type assertions throughout this method are required due to LangGraph's
      // TypeScript type limitations when working with dynamic node names and START/END symbols.
      // The types expect literal string types but we use dynamic pipeline stage names.
      if (currentStage.name === 'judge') {
        // Judge node has conditional edges
        graph.addConditionalEdges(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          currentStage.name as any,
          (state: GraphState): string => {
            if (state.shouldIterate && state.iterationTarget) {
              return state.iterationTarget;
            }
            // Route to next stage (e.g., document) instead of ending.
            // Post-judge stages like create_pr are handled post-graph
            // by pipeline-executor.ts, not as graph nodes.
            // Check skipCondition on the next stage — if it should be
            // skipped, bypass to the stage after it (or END).
            const nextStageAfterJudge = stages[i + 1];
            if (!nextStageAfterJudge) return 'END';
            if (
              (nextStageAfterJudge.skipCondition ||
                nextStageAfterJudge.optional) &&
              this.shouldSkipStage(nextStageAfterJudge, state)
            ) {
              const bypassStage = stages[i + 2];
              return bypassStage ? bypassStage.name : 'END';
            }
            return nextStageAfterJudge.name;
          },
          // Map of possible targets
          stages.reduce(
            (acc, stage) => {
              acc[stage.name] = stage.name;
              return acc;
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LangGraph requires literal types
            { END: END } as Record<string, any>
          )
        );
      } else if (nextStage) {
        // Check if the next stage has skipCondition or is optional
        // If so, use conditional edge that can bypass it
        if (nextStage.skipCondition || nextStage.optional) {
          // Find the stage after the skippable one (to bypass to)
          const stageAfterSkippable = stages[i + 2];
          const bypassTarget = stageAfterSkippable
            ? stageAfterSkippable.name
            : 'END';

          graph.addConditionalEdges(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            currentStage.name as any,
            (state: GraphState): string => {
              // Check if the stage should be skipped based on skipCondition
              if (this.shouldSkipStage(nextStage, state)) {
                logger.info(
                  `Skipping stage: ${nextStage.name} (skipCondition: ${nextStage.skipCondition})`
                );
                return bypassTarget;
              }
              return nextStage.name;
            },
            {
              [nextStage.name]: nextStage.name,
              [bypassTarget]: bypassTarget === 'END' ? END : bypassTarget,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LangGraph requires literal types
            } as Record<string, any>
          );
        } else {
          // Regular edge to next stage
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          graph.addEdge(currentStage.name as any, nextStage.name as any);
        }
      } else {
        // Last stage (if not judge) goes to END
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        graph.addEdge(currentStage.name as any, END);
      }
    }
  }

  /**
   * Determine if a stage should be skipped based on skipCondition
   * Supports iteration context (iteration.first, iteration.last, iteration.interim)
   * and stage success patterns (stage_name.success)
   */
  private shouldSkipStage(
    stage: Pipeline['stages'][0],
    state: GraphState
  ): boolean {
    if (!stage.skipCondition) {
      return false;
    }

    const condition = stage.skipCondition;

    // Build iteration context from workflowContext
    const current = (this.workflowContext.iterationCount ?? 0) + 1; // Convert 0-indexed to 1-indexed
    const max = this.workflowContext.maxIterations ?? 1;

    // Check iteration patterns using switch for maintainability
    switch (condition) {
      case 'iteration.interim':
        return current > 1 && current < max;
      case 'iteration.first':
        return current === 1;
      case 'iteration.last':
        return current === max;
      case '!iteration.last':
        return current !== max;
      case '!iteration.first':
        return current !== 1;
      case '!iteration.interim':
        return !(current > 1 && current < max);
    }

    // Check for stage.success pattern (existing functionality)
    // Use [\w-]+ to support hyphenated stage names like code-reviewer
    const stageSuccessMatch = condition.match(/^!?([\w-]+)\.success$/);
    if (stageSuccessMatch) {
      const targetStage = stageSuccessMatch[1];
      const negate = condition.startsWith('!');
      const stageOutput = state.stageOutputs[targetStage] as
        | StageOutput
        | undefined;
      const isSuccess = stageOutput?.success ?? true;
      return negate ? !isSuccess : isSuccess;
    }

    // Check for checkbox.* pattern — matches "- [ ] <label>" in taskDescription
    // Example: skipCondition: "!checkbox.generate_documentation" skips unless checkbox present
    const checkboxMatch = condition.match(/^!?checkbox\.([\w_]+)$/);
    if (checkboxMatch) {
      const negate = condition.startsWith('!');
      const label = checkboxMatch[1].replace(/_/g, ' ');
      const description = this.workflowContext.taskDescription || '';
      const hasCheckbox = new RegExp(
        `^\\s*[-*+]\\s\\[[ xX]\\]\\s+${label}`,
        'im'
      ).test(description);
      return negate ? !hasCheckbox : hasCheckbox;
    }

    // Unknown condition pattern - don't skip
    logger.warn(`Unknown skipCondition pattern: ${condition}`);
    return false;
  }

  /**
   * Execute agent node
   */
  private async executeAgentNode(
    state: GraphState,
    stageName: string
  ): Promise<Partial<GraphState>> {
    // Pre-stage cost cap check — prevent starting a stage that would exceed the budget
    await this.checkCostCap(stageName);

    logger.info(`Executing agent node: ${stageName}`);

    // Find stage configuration
    const stage = this.pipeline.stages.find((s) => s.name === stageName);
    if (!stage) {
      throw new Error(`Stage not found: ${stageName}`);
    }

    // Check if this stage was already completed (for resumability)
    // If we have saved output for this stage, skip re-execution
    if (state.stageOutputs[stageName]) {
      logger.info(`Skipping already-completed stage: ${stageName}`);
      return {
        currentStage: stageName,
        stageOutputs: state.stageOutputs,
      };
    }

    // Check if this is an optional stage that should be skipped based on configuration
    if (stage.optional && stage.skipCondition) {
      // In a full implementation, skipCondition would be evaluated
      // For now, we check if the stage was explicitly marked to skip
      logger.info(`Checking optional stage: ${stageName}`);
    }

    // Update workflow state
    await this.stateManager.updateCurrentStage(
      state.workflowId,
      stageName,
      stage
    );

    // Resolve fidelity for this stage
    const fidelityResolution = FidelityExecutor.resolveStageFidelity({
      cliFlag: this.workflowContext.fidelityLevel,
      stage,
      pipeline: this.pipeline,
    });

    // Create agent invoker with shared context resolver for cache efficiency
    // Use options-based constructor if we have factory + router (multi-provider mode)
    const invoker =
      this.adapterFactory && this.providerRouter
        ? new AgentInvoker({
            adapterFactory: this.adapterFactory,
            providerRouter: this.providerRouter,
            fallbackBackend: this.fallbackBackend,
            fidelityParams: fidelityResolution.params,
            fidelityLevel: fidelityResolution.level,
            contextResolver: this.contextResolver,
          })
        : new AgentInvoker({
            adapter: this.adapter!,
            fidelityParams: fidelityResolution.params,
            fidelityLevel: fidelityResolution.level,
            contextResolver: this.contextResolver,
          });

    // Validate agent is defined (should always be true after inheritance resolution)
    if (!stage.agent) {
      throw new Error(
        `Stage '${stageName}' has no agent defined. This indicates a pipeline configuration error.`
      );
    }

    // Build task with user's original request + stage context
    // CRITICAL: Use taskDescription (full PRD/issue body/prompt) not input (short title).
    // input is just the parsed first line — for PRDs it can be "---" (YAML frontmatter).
    const userRequest =
      this.workflowContext.taskDescription || this.workflowContext.input;
    const stageDescription = stage.description || `Execute stage: ${stageName}`;
    const stageInput = stage.input || '';

    // Combine user request with stage-specific context
    const task = stageInput
      ? `${stageInput}\n\nUser Request: ${userRequest}`
      : `${stageDescription}\n\nUser Request: ${userRequest}`;

    // Capture timing for performance visibility
    const stageStart = performance.now();
    const stageStartIso = new Date().toISOString();

    // Verbose: Log stage start
    if (this.verbose) {
      logger.info(`Stage '${stageName}' started`);
    }

    // Execute agent
    // Include static context unless stage has ignoreContext: true
    const shouldIncludeContext = this.staticContext && !stage.ignoreContext;

    // Format previous stage outputs as handoff context for the agent prompt
    // StageOutput shape is compatible with formatHandoffContext's expected type
    const handoffContext = formatHandoffContext(
      state.stageOutputs as Parameters<typeof formatHandoffContext>[0],
      { fidelityLevel: fidelityResolution.level }
    );

    const projectContext: ProjectContext = {
      workingDirectory: this.workflowContext.worktreePath || process.cwd(),
      gitBranch: this.workflowContext.branchName,
      additionalContext: {
        ...(shouldIncludeContext ? { staticContext: this.staticContext } : {}),
        pipelineMode: this.workflowContext.mode !== 'raw',
        ...(Object.keys(this.toolConfigs).length > 0
          ? { toolConfigs: this.toolConfigs }
          : {}),
        ...(handoffContext ? { handoffContext } : {}),
      },
    };
    const result = await invoker.execute({
      role: stage.agent,
      task,
      projectContext,
      previousOutputs: state.stageOutputs,
    });

    const stageDuration = performance.now() - stageStart;
    const stageSpawnCount = result.metrics.spawnCount ?? 1;
    this.spawnCount += stageSpawnCount;

    // Verbose: Log stage completion with timing
    if (this.verbose) {
      const durationSec = (stageDuration / 1000).toFixed(1);
      const spawnLabel = stageSpawnCount === 1 ? 'spawn' : 'spawns';
      logger.info(
        `Stage '${stageName}' completed (${durationSec}s, ${stageSpawnCount} ${spawnLabel})`
      );
    }

    // Update stage outputs
    const newStageOutputs = {
      ...state.stageOutputs,
      [stageName]: result,
    };

    // Build rich stage record for run reporting
    const stageRecord: StageRecord = {
      stage: stageName,
      agent: stage.agent,
      backend:
        result.metrics.provider ?? this.workflowContext.backend ?? 'unknown',
      spawnCount: stageSpawnCount,
      durationMs: stageDuration,
      tokensUsed: result.metrics.tokensUsed,
      costUsd: result.metrics.cost ?? 0,
      promptSummary:
        task.length > 200
          ? task.slice(0, 200).replace(/\n/g, ' ') + '…'
          : task.replace(/\n/g, ' '),
      timestamp: stageStartIso,
      status: result.success ? 'completed' : 'error',
    };

    // Update and save workflow context atomically using file locking
    // This ensures metrics, current stage, and stage results are all persisted together
    // avoiding race conditions where a stale context could overwrite updated values
    // Capture the return value to avoid a redundant load() call for observability below
    const updatedCtx = await this.stateManager.update(
      state.workflowId,
      (context) => {
        // Update metrics
        context.metrics.tokensUsed =
          (context.metrics.tokensUsed || 0) + result.metrics.tokensUsed;
        context.metrics.totalTokens =
          (context.metrics.totalTokens || 0) + result.metrics.tokensUsed;
        context.metrics.totalCost =
          (context.metrics.totalCost || 0) + (result.metrics.cost || 0);
        context.metrics.stagesCompleted =
          (context.metrics.stagesCompleted || 0) + 1;

        // Update stage info and results for resumability
        context.currentStage = stageName;
        context.stageResults = newStageOutputs;

        // Record stage timing for performance visibility
        this.recordStageTiming(context, stageName, stageDuration);

        // Record rich stage record for run reporting
        context.stageRecords = context.stageRecords || [];
        context.stageRecords.push(stageRecord);

        return context;
      }
    );

    // Emit enriched audit event for stage completion
    this.auditLogger?.logStageComplete(
      state.workflowId,
      stageName,
      stageDuration,
      {
        tokensUsed: result.metrics.tokensUsed,
        costUsd: result.metrics.cost ?? 0,
        agent: stage.agent,
        spawnCount: stageSpawnCount,
      }
    );

    // --- Handoff observability ---
    // Use updatedCtx from the atomic update above (avoids redundant stateManager.load I/O)
    const cumulativeCost = updatedCtx.metrics.totalCost ?? 0;
    const cumulativeTokens = updatedCtx.metrics.totalTokens ?? 0;
    const maxCostStr = process.env.AIRUNX_MAX_COST_PER_RUN;
    const maxCost =
      maxCostStr && !isNaN(parseFloat(maxCostStr))
        ? parseFloat(maxCostStr)
        : 50;
    const budgetPct =
      maxCost > 0 ? ((cumulativeCost / maxCost) * 100).toFixed(1) : '∞';
    // Serialize once; reuse for size calculation and debug log
    const outputJson = JSON.stringify(result.outputs);
    const outputSizeBytes = Buffer.byteLength(outputJson);
    const handoffSizeBytes = handoffContext
      ? Buffer.byteLength(handoffContext)
      : 0;

    // INFO: handoff summary with cost tracking
    const tokenStr =
      cumulativeTokens >= 1000
        ? `${(cumulativeTokens / 1000).toFixed(0)}K`
        : `${cumulativeTokens}`;
    logger.info(
      `Stage '${stageName}' handoff: output=${(outputSizeBytes / 1024).toFixed(1)}KB, ` +
        `cumulative_cost=$${cumulativeCost.toFixed(2)}/$${maxCost.toFixed(2)} (${budgetPct}%), ` +
        `tokens=${tokenStr}`
    );

    // Cost projection
    const completedStages = updatedCtx.metrics.stagesCompleted ?? 1;
    const totalStages = this.pipeline.stages.length;
    const remainingStages = totalStages - completedStages;
    if (remainingStages > 0 && completedStages > 0) {
      const avgCostPerStage = cumulativeCost / completedStages;
      const projectedRemaining = avgCostPerStage * remainingStages;
      logger.info(
        `Cost: $${cumulativeCost.toFixed(2)}/$${maxCost.toFixed(2)} (${budgetPct}%), ` +
          `~$${avgCostPerStage.toFixed(2)}/stage avg, ` +
          `~$${projectedRemaining.toFixed(2)} projected remaining (${remainingStages} stage${remainingStages === 1 ? '' : 's'} left)`
      );
    }

    // DEBUG: full handoff payload (reuse outputJson to avoid redundant stringify)
    logger.debug(
      `Stage '${stageName}' handoff payload: ${outputJson.slice(0, 4000)}`
    );

    // Emit stage_handoff audit event
    const stageIndex = this.pipeline.stages.findIndex(
      (s) => s.name === stageName
    );
    const nextStage =
      stageIndex >= 0 && stageIndex < this.pipeline.stages.length - 1
        ? this.pipeline.stages[stageIndex + 1].name
        : 'end';
    this.auditLogger?.logStageHandoff(state.workflowId, {
      fromStage: stageName,
      toStage: nextStage,
      outputSizeBytes,
      handoffContextSizeBytes: handoffSizeBytes,
      cumulativeCost,
      cumulativeTokens,
      budgetRemainingPercent:
        maxCost > 0 ? Math.max(0, 100 - (cumulativeCost / maxCost) * 100) : 100,
    });

    // Incremental run report — write after each stage for mid-run visibility
    this.writeRunReport(
      updatedCtx,
      Math.round(performance.now() - this.workflowStartTime)
    );

    logger.info(`Agent node completed: ${stageName}`);

    return {
      currentStage: stageName,
      stageOutputs: newStageOutputs,
    };
  }

  /**
   * Execute judge node
   */
  private async executeJudgeNode(
    state: GraphState,
    stageName: string
  ): Promise<Partial<GraphState>> {
    // Pre-stage cost cap check — prevent starting a stage that would exceed the budget
    await this.checkCostCap(stageName);

    logger.info(`Executing judge node: ${stageName}`);

    // Capture timing for performance visibility
    const stageStart = performance.now();
    const stageStartIso = new Date().toISOString();

    // Find stage configuration
    const stage = this.pipeline.stages.find((s) => s.name === stageName);
    if (!stage) {
      throw new Error(`Stage not found: ${stageName}`);
    }

    // Validate evaluatesStage exists (required for all judge stages)
    const evaluatesStage = stage.evaluatesStage;
    if (!evaluatesStage) {
      throw new Error(
        `Judge stage '${stageName}' is missing required 'evaluatesStage' property in pipeline config.`
      );
    }

    // Update workflow state
    await this.stateManager.updateCurrentStage(
      state.workflowId,
      stageName,
      stage
    );

    // Resolve fidelity
    const fidelityResolution = FidelityExecutor.resolveStageFidelity({
      cliFlag: this.workflowContext.fidelityLevel,
      stage,
      pipeline: this.pipeline,
    });

    // Run fidelity check if enabled
    let fidelityCheckResult;
    if (FidelityExecutor.shouldRunVerification(fidelityResolution.params)) {
      const fidelityChecker = new FidelityChecker();

      // Check if the stage to evaluate exists in outputs
      const stageExists = evaluatesStage in state.stageOutputs;

      // Check if the evaluated stage is optional (might have been skipped)
      const evaluatedStageConfig = this.pipeline.stages.find(
        (s) => s.name === evaluatesStage
      );
      const isOptionalStage = evaluatedStageConfig?.optional === true;

      // If the stage doesn't exist and it's not optional, throw an error
      if (!stageExists && !isOptionalStage) {
        throw new Error(
          `Judge stage '${stageName}' references an unknown or incomplete stage '${evaluatesStage}' in 'evaluatesStage'. Make sure it's a valid, preceding stage in the pipeline.`
        );
      }

      // If the optional stage was skipped, consider the evaluation passed
      if (!stageExists && isOptionalStage) {
        logger.info(
          `Optional stage '${evaluatesStage}' was skipped, considering evaluation passed`
        );
        fidelityCheckResult = {
          passed: true,
          qualityMetrics: {},
          unmetCriteria: [],
          findings: [`Optional stage '${evaluatesStage}' was skipped`],
        };
      } else {
        const stageResult = state.stageOutputs[evaluatesStage] as
          | ExecutionResult
          | undefined;

        // Use the actual result if available, otherwise create a fallback
        const executionResult = stageResult || {
          success: false,
          outputs: {},
          metrics: { tokensUsed: 0, duration: 0 },
          errors: [new Error(`${evaluatesStage} stage output not found`)],
        };

        fidelityCheckResult = await fidelityChecker.check(executionResult, {
          enableVerification: true,
          workingDirectory: this.workflowContext.worktreePath,
        });
      }
    } else {
      // Skip verification
      fidelityCheckResult = {
        passed: true,
        qualityMetrics: {},
        unmetCriteria: [],
        findings: [],
      };
    }

    // Execute judge agent using shared adapter selection logic
    const judgeAdapterResult = await selectAdapterForRole({
      role: 'code-judge',
      adapterFactory: this.adapterFactory,
      providerRouter: this.providerRouter,
      singleAdapter: this.adapter,
      fallbackBackend: this.fallbackBackend,
    });

    if (judgeAdapterResult.selection) {
      logger.info(
        formatProviderSelectionLog('code-judge', judgeAdapterResult.selection)
      );
    }

    const judgeAgent = new JudgeAgent(
      judgeAdapterResult.adapter,
      fidelityResolution.params
    );

    const context = await this.stateManager.load(state.workflowId);
    if (!context) {
      throw new Error(
        `Workflow context not found during judge execution: ${state.workflowId}`
      );
    }
    const currentIteration = context.iterationCount ?? 0;
    const maxIterations = context.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    // Extract checkbox items from the task description (issue body) for the judge to evaluate
    // context.input is the short parsed title; context.taskDescription has the full issue body
    const descriptionText = context.taskDescription || context.input || '';
    const issueCheckboxes = descriptionText
      ? (descriptionText.match(/^[\s]*[-*+]\s\[ \]\s+(.+)$/gm) || []).map(
          (line) => line.replace(/^[\s]*[-*+]\s\[ \]\s+/, '').trim()
        )
      : undefined;

    // Pre-judge test gate: run project tests in the worktree to give the judge
    // concrete test failure signal. Without this, the judge at standard fidelity
    // PROCEEDs without knowing snapshot/unit tests will fail post-commit.
    //
    // Skip on final iteration: if we're at max_iterations, the judge MUST proceed
    // regardless of test results. Running tests here would only inject failures that
    // cause another ITERATE verdict, creating an infinite loop when tests fail due
    // to environment issues (e.g., read-only MySQL, missing services).
    const isLastIteration = currentIteration >= maxIterations - 1;
    const worktreePath = this.workflowContext.worktreePath;
    let preJudgeTestOutput: string | undefined;
    if (worktreePath && !isLastIteration) {
      const testResult = await this.runTestsInWorktree(worktreePath);
      if (!testResult.passed && !testResult.skipped) {
        // Check if failure is infrastructure (missing MySQL, etc.) vs real test failure
        const infraPatterns = [
          /command not found/i,
          /Can't connect to local MySQL server/i,
          /Connection refused/i,
          /ERROR 200[23]/i,
          /No such file or directory.*\.sql/i,
          /mysqli.*Connection refused/i,
          /read.only option/i, // RDS replica or read-only MySQL
          /ERROR 1290/i, // MySQL running with --read-only
        ];
        const isInfra = infraPatterns.some((p) => p.test(testResult.output));
        if (isInfra) {
          logger.info(
            'Pre-judge test gate: tests failed due to missing infrastructure (MySQL, etc.) — skipping'
          );
        } else {
          logger.warn(
            `Pre-judge test gate: tests FAILED — injecting output for judge evaluation`
          );
          preJudgeTestOutput = testResult.output;
        }
      } else if (!testResult.skipped) {
        logger.info('Pre-judge test gate: tests PASSED');
      }
    }

    const judgeResult = await judgeAgent.judgeExtended({
      acceptanceCriteria: [], // Would be loaded from workflow context
      fidelityCheckResult,
      currentIteration,
      maxIterations,
      workingDirectory: this.workflowContext.worktreePath || process.cwd(),
      fidelityLevel: fidelityResolution.level,
      preJudgeTestOutput,
      issueCheckboxes:
        issueCheckboxes && issueCheckboxes.length > 0
          ? issueCheckboxes
          : undefined,
    });

    // Build iteration history entry (will be enriched with cost data in state update)
    const stageOutput = state.stageOutputs[evaluatesStage];
    const summary = stageOutput?.outputs?.summary;
    const iterationEntry: IterationEntry = {
      iteration: currentIteration + 1,
      timestamp: new Date(),
      approach:
        typeof summary === 'string' && summary
          ? summary
          : `Iteration ${currentIteration + 1} attempt`,
      verdict: judgeResult.decision,
      gaps: [...judgeResult.gaps],
      // costUsd, tokensUsed, durationMs populated in state update callback below
    };

    // Check if should iterate
    const iterationDecision = await this.iterationManager.shouldIterate(
      state.workflowId,
      judgeResult
    );

    let shouldIterate = false;
    let iterationTarget: string | undefined;

    // Prepare updated stage outputs (may be modified for iteration)
    let updatedStageOutputs = { ...state.stageOutputs };

    if (iterationDecision.shouldIterate) {
      // Log projected cost for the next iteration based on most recent iteration cost
      // Load latest state to avoid stale in-memory metrics
      const latestCtx = await this.stateManager.load(state.workflowId);
      const currentTotalCost = latestCtx?.metrics.totalCost ?? 0;
      const lastIterationEntries = latestCtx?.iterationHistory?.entries ?? [];
      const lastEntry =
        lastIterationEntries.length > 0
          ? lastIterationEntries[lastIterationEntries.length - 1]
          : null;
      const projectedCost = lastEntry?.costUsd ?? currentTotalCost;
      const remainingIterations =
        (this.workflowContext.maxIterations ?? 1) - currentIteration - 1;
      logger.info(
        `Iterating: cost so far $${currentTotalCost.toFixed(2)}, ` +
          `projected next iteration ~$${projectedCost.toFixed(2)}, ` +
          `${remainingIterations} iteration(s) remaining`
      );

      // Clear stage outputs from the target stage onwards to force re-execution.
      // This ensures that all subsequent stages are re-run with fresh context.
      updatedStageOutputs = this.clearStageOutputsForIteration(
        state.stageOutputs,
        evaluatesStage
      );

      // Inject pre-judge test failures into workflow input so the developer
      // sees the actual test output on the next iteration (not just the judge reason).
      if (preJudgeTestOutput) {
        const testFailureContext =
          '\n\n--- TEST FAILURES (fix these on this iteration) ---\n' +
          preJudgeTestOutput +
          '\n--- END TEST FAILURES ---\n' +
          '\nHINT: If failures are snapshot assertion mismatches (assertMatchesJsonSnapshot), ' +
          'update the JSON files in the testing/src/__snapshots__/ directory to match the new expected output.';
        await this.stateManager.update(state.workflowId, (ctx) => {
          ctx.input = (ctx.input || '') + '\n' + testFailureContext;
          return ctx;
        });
        // Also update the in-memory context for the current graph execution
        this.workflowContext.input += testFailureContext;
      }

      // Start iteration - use evaluatesStage validated at function start
      await this.iterationManager.startIteration(
        state.workflowId,
        evaluatesStage
      );
      shouldIterate = true;
      iterationTarget = evaluatesStage;
    } else {
      // Complete workflow — only mark success on PROCEED, not FAIL
      const success = judgeResult.decision === 'PROCEED';
      await this.iterationManager.completeIteration(state.workflowId, success);
    }

    logger.info(`Judge decision: ${judgeResult.decision}`);

    // Create stage output for judge node - success only when decision is PROCEED
    const judgeStageOutput: StageOutput = {
      success: judgeResult.decision === 'PROCEED',
      outputs: {
        decision: judgeResult.decision,
        reason: judgeResult.reason,
        gaps: judgeResult.gaps,
        parsedOutput: judgeResult.parsedOutput,
      },
      metrics: {
        tokensUsed: judgeResult.metrics?.tokensUsed ?? 0,
        duration: judgeResult.metrics?.duration ?? 0,
        cost: judgeResult.metrics?.cost ?? 0,
      },
      errors:
        judgeResult.decision === 'FAIL'
          ? [new Error(judgeResult.reason)]
          : undefined,
    };

    // Update stage outputs to include judge result
    // Use updatedStageOutputs which may have failed stages cleared for iteration
    const newStageOutputs = {
      ...updatedStageOutputs,
      [stageName]: judgeStageOutput,
    };

    const stageDuration = performance.now() - stageStart;

    // Build rich stage record for judge run reporting
    const judgeStageRecord: StageRecord = {
      stage: stageName,
      agent: 'code-judge',
      backend: this.workflowContext.backend ?? 'unknown',
      spawnCount: judgeResult.metrics ? 1 : 0, // 0 for early-exit paths (no LLM call)
      durationMs: stageDuration,
      tokensUsed: judgeResult.metrics?.tokensUsed ?? 0,
      costUsd: judgeResult.metrics?.cost ?? 0,
      timestamp: stageStartIso,
      status: judgeResult.decision === 'FAIL' ? 'error' : 'completed',
    };

    // Persist judge stage result and iteration history in single atomic update
    await this.stateManager.update(state.workflowId, (context) => {
      context.currentStage = stageName;
      context.stageResults = newStageOutputs;

      // Update metrics with judge cost (like agent node does at lines 681-688)
      context.metrics.tokensUsed =
        (context.metrics.tokensUsed || 0) +
        (judgeResult.metrics?.tokensUsed ?? 0);
      context.metrics.totalTokens =
        (context.metrics.totalTokens || 0) +
        (judgeResult.metrics?.tokensUsed ?? 0);
      context.metrics.totalCost =
        (context.metrics.totalCost || 0) + (judgeResult.metrics?.cost ?? 0);

      // Record rich stage record for run reporting
      context.stageRecords = context.stageRecords || [];

      // Compute iteration metrics from stage records added since the last iteration.
      // This iteration's metrics = total accumulated so far (including judge) minus previous iterations.
      const prevHistory = context.iterationHistory?.entries ?? [];
      const prevIterationsCost = prevHistory.reduce(
        (sum, e) => sum + (e.costUsd ?? 0),
        0
      );
      const prevIterationsTokens = prevHistory.reduce(
        (sum, e) => sum + (e.tokensUsed ?? 0),
        0
      );
      const prevIterationsDuration = prevHistory.reduce(
        (sum, e) => sum + (e.durationMs ?? 0),
        0
      );

      const totalRecordsCost =
        context.stageRecords.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) +
        judgeStageRecord.costUsd;
      const totalRecordsTokens =
        context.stageRecords.reduce((sum, r) => sum + (r.tokensUsed ?? 0), 0) +
        judgeStageRecord.tokensUsed;
      const totalRecordsDuration =
        context.stageRecords.reduce((sum, r) => sum + (r.durationMs ?? 0), 0) +
        stageDuration;

      iterationEntry.costUsd = totalRecordsCost - prevIterationsCost;
      iterationEntry.tokensUsed = totalRecordsTokens - prevIterationsTokens;
      iterationEntry.durationMs = totalRecordsDuration - prevIterationsDuration;

      context.stageRecords.push(judgeStageRecord);

      // Record iteration history entry using centralized helper
      context.iterationHistory = appendIterationEntry(context, iterationEntry);

      // Record stage timing for performance visibility
      this.recordStageTiming(context, stageName, stageDuration);

      return context;
    });

    return {
      currentStage: stageName,
      stageOutputs: newStageOutputs,
      shouldIterate,
      iterationTarget,
    };
  }

  /**
   * Check if the per-run cost cap has been exceeded.
   * Reads AIRUNX_MAX_COST_PER_RUN env var (default: $50).
   * Throws Error to hard-stop the pipeline before the next stage starts.
   */
  private async checkCostCap(stageName: string): Promise<void> {
    const maxCostStr = process.env.AIRUNX_MAX_COST_PER_RUN;
    const maxCost = maxCostStr ? parseFloat(maxCostStr) : 50;

    // Skip if env var is explicitly set to 0 or invalid
    if (isNaN(maxCost) || maxCost <= 0) return;

    // Load latest state to avoid stale in-memory metrics
    const latestContext = await this.stateManager.load(this.workflowContext.id);
    const currentCost = latestContext?.metrics.totalCost ?? 0;
    if (currentCost >= maxCost) {
      const message =
        `Cost cap exceeded: $${currentCost.toFixed(2)} >= $${maxCost.toFixed(2)} cap. ` +
        `Pipeline stopped before stage "${stageName}". ` +
        `Increase the limit with AIRUNX_MAX_COST_PER_RUN=<amount> or set to 0 to disable.`;
      logger.error(message);

      // Store failure reason for issue comment surfacing
      this.workflowContext.failureReason = message;

      throw new Error(message);
    }
  }

  /**
   * Record stage timing for performance visibility.
   * Helper method to avoid duplication between agent and judge node execution.
   */
  private recordStageTiming(
    context: WorkflowContext,
    stageName: string,
    duration: number
  ): void {
    context.stageTiming = context.stageTiming || [];
    context.stageTiming.push({
      stage: stageName,
      duration,
    });
  }

  /**
   * Build and write a structured RunReport JSON to disk.
   * Consumers (issue comments, dashboards) read this file to render rich tables.
   */
  private writeRunReport(
    context: WorkflowContext,
    totalRuntimeMs: number
  ): void {
    try {
      const stageRecords = context.stageRecords || [];

      // Build timeline from stage records
      const timeline: TimelineEvent[] = stageRecords.map((sr) => ({
        timestamp: sr.timestamp,
        event: `${sr.stage} complete (${(sr.durationMs / 1000).toFixed(1)}s)`,
        durationMs: sr.durationMs,
        details: sr.agent !== sr.stage ? sr.agent : undefined,
      }));

      const report: RunReport = {
        workflowId: context.id,
        taskTitle: context.taskTitle,
        pipelineName: context.pipelineName,
        status: context.status,
        startedAt: context.createdAt.toISOString(),
        completedAt: new Date().toISOString(),
        totalDurationMs: totalRuntimeMs,
        totalTokens: context.metrics.totalTokens ?? context.metrics.tokensUsed,
        totalCostUsd: context.metrics.totalCost ?? 0,
        iterationCount: context.iterationCount ?? 1,
        maxIterations: context.maxIterations ?? 1,
        iterations: context.iterationHistory?.entries ?? [],
        stages: stageRecords,
        timeline,
      };

      const reportsDir = join('.airunx-state', 'reports');
      if (!existsSync(reportsDir)) {
        mkdirSync(reportsDir, { recursive: true });
      }
      const reportPath = join(reportsDir, `${context.id}.json`);
      // Atomic write: write to tmp file then rename to avoid partial reads
      const tmpPath = reportPath + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(report, null, 2));
      renameSync(tmpPath, reportPath);
      logger.info(`Run report written to ${reportPath}`);
    } catch (err) {
      // Non-fatal: don't crash the pipeline if report writing fails
      logger.warn('Failed to write run report:', err);
    }
  }

  /**
   * Clear outputs from the target stage onwards to force re-execution.
   * This is necessary on an ITERATE decision to ensure subsequent stages
   * run with fresh context, even if they previously succeeded.
   */
  private clearStageOutputsForIteration(
    outputs: Record<string, StageOutput>,
    targetStage: string
  ): Record<string, StageOutput> {
    const clearedOutputs = { ...outputs };
    const stages = this.pipeline.stages;

    // Find target stage index
    const targetIndex = stages.findIndex((s) => s.name === targetStage);
    if (targetIndex === -1) {
      logger.warn(
        `Target stage '${targetStage}' not found in pipeline, cannot clear failed outputs`
      );
      return clearedOutputs;
    }

    // When iterating, clear ALL stages from target onwards to force re-execution.
    // This is necessary because the judge may request iteration even on stages
    // that technically "succeeded" - we need to re-run them with fresh context.
    for (let i = targetIndex; i < stages.length; i++) {
      const stageName = stages[i].name;
      const output = clearedOutputs[stageName];

      if (output) {
        delete clearedOutputs[stageName];
        logger.info(`Cleared stage output for re-execution: ${stageName}`);
      }
    }

    return clearedOutputs;
  }

  /**
   * Run project tests in the worktree before the judge evaluates.
   * Lightweight test gate — gives the judge concrete test failure signal
   * so it can ITERATE instead of PROCEEDing with broken tests.
   */
  private async runTestsInWorktree(worktreePath: string): Promise<{
    passed: boolean;
    skipped: boolean;
    output: string;
  }> {
    const timeoutMs =
      parseInt(process.env.AIRUNX_TEST_TIMEOUT_MS || '') || 300_000; // 5 min default

    // Detect and run test command
    const cmd = this.detectTestCommand(worktreePath);
    if (!cmd) {
      return { passed: true, skipped: true, output: '' };
    }

    const result = await spawnAsync(cmd.cmd, cmd.args, {
      cwd: worktreePath,
      timeout: timeoutMs,
    });

    if (result.status === 0) {
      return { passed: true, skipped: false, output: '' };
    }

    const output = (
      (result.stdout || '') +
      (result.stderr || '') +
      (result.error ? '\nExecution Error: ' + result.error.message : '')
    ).slice(-3000);
    return { passed: false, skipped: false, output };
  }

  private detectTestCommand(
    worktreePath: string
  ): { cmd: string; args: string[] } | null {
    const composerPath = join(worktreePath, 'composer.json');
    if (existsSync(composerPath)) {
      try {
        const composer = JSON.parse(readFileSync(composerPath, 'utf-8'));
        if (composer.scripts?.test) return { cmd: 'composer', args: ['test'] };
      } catch {
        /* skip */
      }
    }

    const packagePath = join(worktreePath, 'package.json');
    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'));
        if (pkg.scripts?.test && !pkg.scripts.test.startsWith('echo "Error:')) {
          return { cmd: 'npm', args: ['test'] };
        }
      } catch {
        /* skip */
      }
    }

    return null;
  }
}
