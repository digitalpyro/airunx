/**
 * Compound Engineering Adapter
 *
 * A specialized adapter that wraps Claude Code with sub-agent delegation capability.
 * Used by the developer role to spawn specialized research agents:
 * - architecture-strategist: System design review
 * - pattern-recognition-specialist: Codebase pattern analysis
 * - framework-docs-researcher: External documentation research
 *
 */

import { ClaudeCodeAdapter } from './claude-code-adapter.js';
import type {
  DelegationRecord,
  DelegationTriggerReason,
  ExecutionRequest,
  ExecutionResult,
  ProjectContext,
} from '../core/adapter-types.js';
import { SUB_AGENT_TYPES, type SubAgentType } from '../core/adapter-types.js';
import { createLogger } from '../utils/logger.js';
import type { CostSummary } from '../core/types.js';
import { mergeCostSummaries, usdToMicroUsd } from '../core/cost-accounting.js';

const logger = createLogger('compound-engineering-adapter');

/**
 * Threshold for task length to be considered complex
 * Tasks longer than this are more likely to benefit from sub-agent delegation
 */
const COMPLEX_TASK_LENGTH_THRESHOLD = 500;

// Re-export for backward compatibility
export { SUB_AGENT_TYPES, type SubAgentType } from '../core/adapter-types.js';

/**
 * Why delegation fired. Length takes precedence when both length and a
 * keyword match; the keyword is still reported.
 */
export interface DelegationTrigger {
  reason: DelegationTriggerReason;
  keyword?: string;
  keywordSource?: 'task' | 'analysis';
}

/** Analysis phrases that signal a complex task */
const ANALYSIS_COMPLEXITY_INDICATORS = [
  'complex architecture',
  'multiple components',
  'system design',
  'architectural decision',
  'refactoring needed',
  'dependency analysis',
  'cross-cutting concern',
];

/**
 * Sub-agent delegation request
 */
export interface SubAgentRequest {
  agent: SubAgentType;
  task: string;
  context?: Record<string, unknown>;
}

/**
 * Sub-agent delegation result
 */
export interface SubAgentResult {
  agent: SubAgentType;
  success: boolean;
  findings: string;
  error?: string;
  metrics?: {
    tokensUsed: number;
    duration: number;
    cost?: number;
    costSummary?: CostSummary;
  };
}

/**
 * System prompts for sub-agents
 */
const SUB_AGENT_PROMPTS: Record<SubAgentType, string> = {
  'architecture-strategist': `You are an architecture strategist agent. Your role is to:
- Review system design decisions and their implications
- Identify architectural patterns and anti-patterns
- Evaluate scalability, maintainability, and security considerations
- Provide recommendations for architectural improvements

Output your analysis in structured JSON format:
{
  "design_review": { "strengths": [], "concerns": [], "recommendations": [] },
  "patterns_identified": [],
  "scalability_assessment": "",
  "security_considerations": []
}`,

  'pattern-recognition-specialist': `You are a pattern recognition specialist agent. Your role is to:
- Analyze the codebase for existing patterns and conventions
- Identify code duplication and refactoring opportunities
- Map dependencies and relationships between components
- Document naming conventions and coding standards in use

Output your analysis in structured JSON format:
{
  "patterns_found": [{ "name": "", "locations": [], "description": "" }],
  "conventions": { "naming": [], "structure": [], "style": [] },
  "refactoring_opportunities": [],
  "dependency_map": {}
}`,

  'framework-docs-researcher': `You are a framework documentation researcher agent. Your role is to:
- Research official documentation for relevant frameworks and libraries
- Find best practices and recommended approaches
- Identify version-specific features and constraints
- Gather examples and implementation patterns from documentation

Output your analysis in structured JSON format:
{
  "documentation_refs": [{ "source": "", "url": "", "relevance": "" }],
  "best_practices": [],
  "version_constraints": [],
  "implementation_examples": []
}`,
};

/**
 * Compound Engineering Adapter
 *
 * Extends ClaudeCodeAdapter with sub-agent delegation capability.
 * Uses Claude Code CLI under the hood but adds the ability to spawn
 * specialized research agents in parallel before synthesizing results.
 */
export class CompoundEngineeringAdapter extends ClaudeCodeAdapter {
  // Inherits name, getCliConfig(), buildCliArgs(), and buildEnv() from ClaudeCodeAdapter

  private delegationEnabled = true;
  private subAgents: SubAgentType[] = [
    'architecture-strategist',
    'pattern-recognition-specialist',
    'framework-docs-researcher',
  ];

  /**
   * Enable or disable sub-agent delegation
   */
  setDelegationEnabled(enabled: boolean): void {
    this.delegationEnabled = enabled;
    logger.info(`Sub-agent delegation ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Configure which sub-agents are available
   */
  setAvailableSubAgents(agents: SubAgentType[]): void {
    this.subAgents = agents;
    logger.info(`Available sub-agents: ${agents.join(', ')}`);
  }

  /**
   * Execute with optional sub-agent delegation
   *
   * The execution flow:
   * 1. Check if CE is disabled for this agent via providerConfig
   * 2. Execute main task via Claude Code
   * 3. If delegation is enabled and task is complex, spawn sub-agents
   * 4. Synthesize sub-agent findings into final result
   */
  override async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const startTime = Date.now();

    // Check if CE is disabled for this specific agent
    const ceDisabledForAgent =
      request.agent.providerConfig?.disableCompoundEngineering === true;

    if (ceDisabledForAgent) {
      logger.info(
        `Compound Engineering disabled for agent '${request.agent.role}' via providerConfig`
      );
      // Skip CE features entirely, use base ClaudeCodeAdapter behavior
      return super.execute(request);
    }

    logger.info(`Compound Engineering execution starting`);

    // Check per-agent delegation config (defaults to true if not specified)
    const agentDelegationEnabled =
      request.agent.providerConfig?.delegation !== false;
    const effectiveDelegationEnabled =
      this.delegationEnabled && agentDelegationEnabled;

    logger.debug(
      `Delegation enabled: instance=${this.delegationEnabled}, agent=${agentDelegationEnabled}, effective=${effectiveDelegationEnabled}`
    );

    if (!agentDelegationEnabled) {
      logger.info(
        `Delegation disabled for agent '${request.agent.role}' via providerConfig`
      );
    }

    // First, execute the main task
    const mainResult = await super.execute(request);

    if (!mainResult.success) {
      return mainResult;
    }

    // Check if we should delegate to sub-agents
    const trigger = effectiveDelegationEnabled
      ? this.shouldDelegate(request, mainResult)
      : null;
    if (trigger) {
      logger.info('Delegating to sub-agents for comprehensive research');

      const agentsToRun = this.resolveSubAgents(request);
      const delegationBase = this.delegationBase(
        request,
        mainResult,
        trigger,
        agentsToRun
      );
      this.emitDelegation({ ...delegationBase, phase: 'decision' }, request);

      const subAgentResults = await this.executeSubAgents(
        request,
        mainResult.outputs.analysis || '',
        mainResult.spawnId,
        agentsToRun
      );

      // Marginal cost of delegation: exactly the sub-agent spawns' costs,
      // summed per spawn as the ledger records them
      const marginalCostMicroUsd = subAgentResults.reduce(
        (sum, r) => sum + usdToMicroUsd(r.metrics?.cost ?? 0),
        0
      );
      this.emitDelegation(
        {
          ...delegationBase,
          phase: 'completion',
          succeededCount: subAgentResults.filter((r) => r.success).length,
          marginalCostUsd: subAgentResults.reduce(
            (sum, r) => sum + (r.metrics?.cost ?? 0),
            0
          ),
          marginalCostMicroUsd,
          marginalCostSummary: mergeCostSummaries(
            ...subAgentResults.map((r) => r.metrics?.costSummary)
          ),
        },
        request
      );

      // Synthesize results
      const synthesizedResult = this.synthesizeResults(
        mainResult,
        subAgentResults
      );

      const totalDuration = Date.now() - startTime;
      synthesizedResult.metrics.duration = totalDuration;

      return synthesizedResult;
    }

    return mainResult;
  }

  /**
   * Determine if sub-agent delegation is needed based on complexity signals.
   * Returns the trigger (reason + matched keyword), or null to skip.
   */
  private shouldDelegate(
    request: ExecutionRequest,
    mainResult: ExecutionResult
  ): DelegationTrigger | null {
    const analysis = (mainResult.outputs.analysis || '').toLowerCase();

    // Complexity indicators in the main result must be specific enough to
    // avoid triggering on simple tasks
    const analysisKeyword = ANALYSIS_COMPLEXITY_INDICATORS.find((indicator) =>
      analysis.includes(indicator)
    );

    // Task keywords that suggest complexity (must be explicit)
    const taskLower = request.task.toLowerCase();
    let taskKeyword: string | undefined;
    if (taskLower.includes('architecture') && taskLower.includes('design')) {
      taskKeyword = 'architecture+design';
    } else if (taskLower.includes('system design')) {
      taskKeyword = 'system design';
    } else if (taskLower.includes('research and analyze')) {
      taskKeyword = 'research and analyze';
    }
    const overLength = request.task.length > COMPLEX_TASK_LENGTH_THRESHOLD;

    const keyword = analysisKeyword ?? taskKeyword;
    if (!overLength && keyword === undefined) {
      logger.debug(
        `Delegation decision: skipped (complexity: false, task: false)`
      );
      return null;
    }

    // Build human-readable reasons for why delegation was triggered
    const reasons: string[] = [];
    if (analysisKeyword) reasons.push('complexity indicators in analysis');
    if (overLength)
      reasons.push(
        `task length ${request.task.length} chars > ${COMPLEX_TASK_LENGTH_THRESHOLD}`
      );
    if (taskKeyword && !overLength)
      reasons.push('task keywords match (architecture/design/research)');
    logger.info(
      `Delegation triggered: spawning ${this.subAgents.length} sub-agents (${reasons.join(', ')})`
    );

    return {
      reason: overLength ? 'length' : 'keyword',
      ...(keyword !== undefined
        ? {
            keyword,
            keywordSource: analysisKeyword !== undefined ? 'analysis' : 'task',
          }
        : {}),
    };
  }

  /**
   * Fields shared by a delegation's decision and completion events
   */
  private delegationBase(
    request: ExecutionRequest,
    mainResult: ExecutionResult,
    trigger: DelegationTrigger,
    agentsToRun: SubAgentType[]
  ): Omit<DelegationRecord, 'phase'> {
    const ctx = request.spawnContext;
    return {
      workflowId: ctx?.workflowId,
      stage: ctx?.stage,
      iteration: ctx?.iteration,
      spawnId: mainResult.spawnId,
      parentSpawnId: ctx?.parentSpawnId,
      triggerReason: trigger.reason,
      keyword: trigger.keyword,
      keywordSource: trigger.keywordSource,
      taskLength: request.task.length,
      lengthThreshold: COMPLEX_TASK_LENGTH_THRESHOLD,
      subAgentCount: agentsToRun.length,
      subAgents: [...agentsToRun],
    };
  }

  /**
   * Hand a delegation record to the ledger observer. Never throws.
   */
  private emitDelegation(
    record: DelegationRecord,
    request: ExecutionRequest
  ): void {
    const observer = this.spawnObserver;
    if (!observer?.onDelegation) return;
    try {
      observer.onDelegation(record, request);
    } catch (error) {
      logger.warn(
        `Delegation observer failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Sub-agents to run for a request: the agent's configured list (invalid
   * types dropped) or all available
   */
  private resolveSubAgents(parentRequest: ExecutionRequest): SubAgentType[] {
    // Get configured sub-agents from request, or use all available
    const configuredSubAgentStrings =
      parentRequest.agent.providerConfig?.subAgents;

    if (configuredSubAgentStrings === undefined) {
      // No configuration - use all available (current default behavior)
      logger.debug(
        `Using default sub-agents for ${parentRequest.agent.role}: [${this.subAgents.join(', ')}]`
      );
      return this.subAgents;
    }

    // Explicit configuration - partition into valid/invalid in single pass
    // Validation should have caught invalid types, but this makes the adapter robust
    const [validAgents, invalidAgents] = configuredSubAgentStrings.reduce<
      [SubAgentType[], string[]]
    >(
      ([valid, invalid], sa) => {
        if ((SUB_AGENT_TYPES as readonly string[]).includes(sa)) {
          valid.push(sa as SubAgentType);
        } else {
          invalid.push(sa);
        }
        return [valid, invalid];
      },
      [[], []]
    );

    if (invalidAgents.length > 0) {
      logger.warn(
        `Ignoring invalid sub-agent types for agent '${parentRequest.agent.role}': ${invalidAgents.join(', ')}`
      );
    }

    logger.debug(
      `Using configured sub-agents for ${parentRequest.agent.role}: [${validAgents.join(', ')}]`
    );
    return validAgents;
  }

  /**
   * Execute sub-agents in parallel
   */
  private async executeSubAgents(
    parentRequest: ExecutionRequest,
    parentAnalysis: string,
    parentSpawnId?: string,
    agentsToRun: SubAgentType[] = this.resolveSubAgents(parentRequest)
  ): Promise<SubAgentResult[]> {
    const results: SubAgentResult[] = [];

    // Early return if no sub-agents configured
    if (agentsToRun.length === 0) {
      logger.info(
        `No sub-agents configured for ${parentRequest.agent.role}, skipping delegation`
      );
      return [];
    }

    // Execute sub-agents in parallel for efficiency
    const promises = agentsToRun.map((agentType) =>
      this.executeSubAgent(
        agentType,
        parentRequest,
        parentAnalysis,
        parentSpawnId
      )
    );

    const settled = await Promise.allSettled(promises);

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      const agentType = agentsToRun[i];

      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        logger.warn(`Sub-agent ${agentType} failed: ${result.reason}`);
        results.push({
          agent: agentType,
          success: false,
          findings: '',
          error: String(result.reason),
        });
      }
    }

    return results;
  }

  /**
   * Execute a single sub-agent
   */
  private async executeSubAgent(
    agentType: SubAgentType,
    parentRequest: ExecutionRequest,
    parentAnalysis: string,
    parentSpawnId?: string
  ): Promise<SubAgentResult> {
    const subAgentTask = this.buildSubAgentTask(
      agentType,
      parentRequest.task,
      parentAnalysis
    );
    logger.info(
      `Executing sub-agent: ${agentType} (task: ${subAgentTask.length}B, context: ${parentAnalysis.length}B)`
    );

    const subAgentRequest: ExecutionRequest = {
      agent: {
        role: 'developer', // Sub-agents operate under developer umbrella
        capabilities: this.getSubAgentCapabilities(agentType),
        contextRequired: ['codebase', 'task_context'],
        systemPrompt: SUB_AGENT_PROMPTS[agentType],
      },
      task: subAgentTask,
      context: parentRequest.context,
      fidelityParams: parentRequest.fidelityParams,
      // Inherit the parent's attribution; link back to the delegating spawn
      ...(parentRequest.spawnContext
        ? {
            spawnContext: {
              ...parentRequest.spawnContext,
              ...(parentSpawnId ? { parentSpawnId } : {}),
            },
          }
        : {}),
    };

    try {
      // Use parent adapter's execute to run sub-agent
      const result = await super.execute(subAgentRequest);

      return {
        agent: agentType,
        success: result.success,
        findings: result.outputs.analysis || '',
        error: result.errors.length > 0 ? result.errors[0].message : undefined,
        metrics: {
          tokensUsed: result.metrics.tokensUsed,
          duration: result.metrics.duration,
          cost: result.metrics.cost ?? 0,
          costSummary: result.metrics.costSummary,
        },
      };
    } catch (error) {
      return {
        agent: agentType,
        success: false,
        findings: '',
        error: error instanceof Error ? error.message : String(error),
        metrics: { tokensUsed: 0, duration: 0 },
      };
    }
  }

  /**
   * Get capabilities for a sub-agent type
   */
  private getSubAgentCapabilities(agentType: SubAgentType): string[] {
    switch (agentType) {
      case 'architecture-strategist':
        return ['system_design', 'architecture_review', 'scalability_analysis'];
      case 'pattern-recognition-specialist':
        return ['pattern_analysis', 'code_review', 'convention_detection'];
      case 'framework-docs-researcher':
        return ['documentation_search', 'best_practices', 'api_research'];
      default:
        return ['analysis'];
    }
  }

  /**
   * Build a task-specific prompt for a sub-agent
   */
  private buildSubAgentTask(
    agentType: SubAgentType,
    parentTask: string,
    parentAnalysis: string
  ): string {
    const taskPrefix = {
      'architecture-strategist':
        'Review the following task from an architectural perspective:',
      'pattern-recognition-specialist':
        'Analyze the codebase for patterns relevant to this task:',
      'framework-docs-researcher':
        'Research documentation and best practices for this task:',
    };

    return `${taskPrefix[agentType]}

Parent Task: ${parentTask}

Initial Analysis Context:
${parentAnalysis.substring(0, 1000)}${parentAnalysis.length > 1000 ? '...' : ''}

Provide your specialized analysis based on your role.`;
  }

  /**
   * Synthesize main result with sub-agent findings
   */
  private synthesizeResults(
    mainResult: ExecutionResult,
    subAgentResults: SubAgentResult[]
  ): ExecutionResult {
    const successfulResults = subAgentResults.filter((r) => r.success);
    const failedResults = subAgentResults.filter((r) => !r.success);

    // Build sub-agent research section
    const subAgentResearch = successfulResults.map((r) => ({
      agent: r.agent,
      findings: r.findings,
    }));

    // Combine analysis (fallback to empty string if undefined)
    const combinedAnalysis = `${mainResult.outputs.analysis || ''}

## Sub-Agent Research

${successfulResults.map((r) => `### ${r.agent}\n${r.findings}`).join('\n\n')}

${failedResults.length > 0 ? `\n## Sub-Agent Failures\n${failedResults.map((r) => `- ${r.agent}: ${r.error}`).join('\n')}` : ''}`;

    // Aggregate token usage from actual sub-agent metrics
    const subAgentTokens = subAgentResults.reduce(
      (sum, r) => sum + (r.metrics?.tokensUsed ?? 0),
      0
    );
    const totalTokens = mainResult.metrics.tokensUsed + subAgentTokens;

    // Aggregate spawn counts: main task (1) + each sub-agent (1 each)
    const mainSpawnCount = mainResult.metrics.spawnCount ?? 1;
    const subAgentSpawnCount = subAgentResults.length;
    const totalSpawnCount = mainSpawnCount + subAgentSpawnCount;

    // Aggregate cost from main result + all sub-agent results
    const totalCost = [
      mainResult.metrics,
      ...subAgentResults.map((r) => r.metrics),
    ].reduce((sum, m) => sum + (m?.cost ?? 0), 0);

    // Log per-sub-agent cost breakdown for observability
    logger.info(
      `Cost breakdown: main=$${(mainResult.metrics.cost ?? 0).toFixed(2)} (${mainResult.metrics.tokensUsed} tokens)` +
        subAgentResults
          .map(
            (r) =>
              ` + ${r.agent}=$${(r.metrics?.cost ?? 0).toFixed(2)} (${r.metrics?.tokensUsed ?? 0} tokens)`
          )
          .join('') +
        ` = total=$${totalCost.toFixed(2)} (${totalTokens} tokens, ${totalSpawnCount} spawns)`
    );

    // Destructure to avoid spread silently overwriting aggregated fields
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const {
      cost: _mainCost,
      tokensUsed: _mainTokens,
      spawnCount: _mainSpawns,
      costSummary: _mainCostSummary,
      ...restMetrics
    } = mainResult.metrics;
    /* eslint-enable @typescript-eslint/no-unused-vars */

    return {
      success: mainResult.success,
      outputs: {
        ...mainResult.outputs,
        analysis: combinedAnalysis,
        sub_agent_research: subAgentResearch,
      },
      metrics: {
        ...restMetrics,
        tokensUsed: totalTokens,
        spawnCount: totalSpawnCount,
        cost: totalCost,
        costSummary: mergeCostSummaries(
          mainResult.metrics.costSummary,
          ...subAgentResults.map((r) => r.metrics?.costSummary)
        ),
      },
      errors: [
        ...mainResult.errors,
        ...failedResults.map((r) => new Error(`${r.agent}: ${r.error}`)),
      ],
      spawnId: mainResult.spawnId,
    };
  }

  /**
   * Delegate to a specific sub-agent
   * Can be called directly for targeted research
   */
  async delegateToSubAgent(
    agentType: SubAgentType,
    task: string,
    context: ProjectContext
  ): Promise<SubAgentResult> {
    if (!this.subAgents.includes(agentType)) {
      return {
        agent: agentType,
        success: false,
        findings: '',
        error: `Sub-agent ${agentType} is not available`,
        metrics: { tokensUsed: 0, duration: 0 },
      };
    }

    const request: ExecutionRequest = {
      agent: {
        role: 'developer',
        capabilities: this.getSubAgentCapabilities(agentType),
        contextRequired: ['codebase', 'task_context'],
        systemPrompt: SUB_AGENT_PROMPTS[agentType],
      },
      task,
      context,
    };

    return this.executeSubAgent(agentType, request, '');
  }
}
