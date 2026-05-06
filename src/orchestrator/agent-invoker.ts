/**
 * Agent Invoker - Execute agents with fidelity parameters
 * Handles calling backend adapters with proper context and retry logic
 *
 * Supports loading agent definitions from AGENTS.md or falling back to defaults
 */

import {
  DEFAULT_FALLBACK_BACKEND,
  type ExecutionAdapter,
  type ExecutionRequest,
  type ExecutionResult,
  type AgentDef,
  type ProjectContext,
  type BackendType,
} from '../core/adapter-types.js';
import type {
  AgentRole,
  ExecutionFidelityLevel,
  FidelityParameters,
} from '../core/types.js';
import { createLogger } from '../utils/logger.js';
import { toError } from '../utils/error-handlers.js';
import { loadAgentsDefs, type ParsedAgentDef } from '../utils/agents-schema.js';
import { FIDELITY_CLI_TIMEOUT } from '../adapters/constants.js';
import { loadSettings } from '../utils/settings.js';
import { existsSync } from 'fs';
import { DEFAULT_AGENT_CONFIGS } from './agent-defaults.js';
import { ContextResolver } from '../utils/context-resolver.js';
import { CircuitBreaker } from '../utils/circuit-breaker.js';
import {
  CircuitOpenError,
  isRetryableError,
  ConfigurationError,
  TimeoutError,
} from '../utils/errors.js';
import {
  selectAdapterForRole,
  formatProviderSelectionLog,
  type AdapterFactory,
} from '../adapters/adapter-factory.js';
import type { ProviderRouter } from './provider-router.js';

const logger = createLogger('agent-invoker');

/**
 * Agent execution context
 */
export interface AgentExecutionContext {
  role: AgentRole;
  task: string;
  projectContext: ProjectContext;
  previousOutputs?: Record<string, unknown>;
  systemPrompt?: string;
}

/**
 * Configuration options for AgentInvoker
 */
export interface AgentInvokerOptions {
  /** Single adapter for backward compatibility (used when adapterFactory not provided) */
  adapter?: ExecutionAdapter;
  /** Adapter factory for multi-provider support */
  adapterFactory?: AdapterFactory;
  /** Provider router for per-agent backend selection */
  providerRouter?: ProviderRouter;
  /** Fidelity parameters for execution */
  fidelityParams: FidelityParameters;
  /** Fidelity level name (used to scale per-agent timeout) */
  fidelityLevel?: ExecutionFidelityLevel;
  /** Pre-loaded agent definitions from AGENTS.md */
  loadedAgents?: Map<AgentRole, ParsedAgentDef>;
  /** Working directory for context resolution */
  workingDirectory?: string;
  /** Shared context resolver for cache efficiency */
  contextResolver?: ContextResolver;
  /** Circuit breaker for failure handling */
  circuitBreaker?: CircuitBreaker;
  /** Fallback backend when provider routing unavailable */
  fallbackBackend?: BackendType;
}

/**
 * Agent Invoker class
 */
export class AgentInvoker {
  private adapter: ExecutionAdapter | null;
  private adapterFactory: AdapterFactory | null;
  private providerRouter: ProviderRouter | null;
  private fallbackBackend: BackendType;
  private fidelityParams: FidelityParameters;
  private fidelityLevel: ExecutionFidelityLevel | null;
  private loadedAgents: Map<AgentRole, ParsedAgentDef> | null = null;
  private loadedAgentsSource?: string;
  private contextResolver: ContextResolver;
  private circuitBreaker: CircuitBreaker | null;

  constructor(
    adapter: ExecutionAdapter,
    fidelityParams: FidelityParameters,
    loadedAgents?: Map<AgentRole, ParsedAgentDef>,
    workingDirectory?: string,
    contextResolver?: ContextResolver,
    circuitBreaker?: CircuitBreaker
  );
  constructor(options: AgentInvokerOptions);
  constructor(
    adapterOrOptions: ExecutionAdapter | AgentInvokerOptions,
    fidelityParams?: FidelityParameters,
    loadedAgents?: Map<AgentRole, ParsedAgentDef>,
    workingDirectory?: string,
    contextResolver?: ContextResolver,
    circuitBreaker?: CircuitBreaker
  ) {
    // Handle both constructor signatures
    // Use 'execute' in check for consistency with LangGraphRunner and PipelineExecutor
    if ('execute' in adapterOrOptions) {
      // Legacy constructor for backward compatibility
      this.adapter = adapterOrOptions;
      this.adapterFactory = null;
      this.providerRouter = null;
      this.fallbackBackend = DEFAULT_FALLBACK_BACKEND;
      this.fidelityParams = fidelityParams!;
      this.fidelityLevel = null;
      this.loadedAgents = loadedAgents ?? null;
      this.contextResolver =
        contextResolver ?? new ContextResolver(workingDirectory);
      this.circuitBreaker = circuitBreaker ?? null;
    } else {
      // New options-based constructor
      const options = adapterOrOptions;
      this.adapter = options.adapter ?? null;
      this.adapterFactory = options.adapterFactory ?? null;
      this.providerRouter = options.providerRouter ?? null;
      this.fallbackBackend =
        options.fallbackBackend ?? DEFAULT_FALLBACK_BACKEND;
      this.fidelityParams = options.fidelityParams;
      this.fidelityLevel = options.fidelityLevel ?? null;
      this.loadedAgents = options.loadedAgents ?? null;
      this.contextResolver =
        options.contextResolver ??
        new ContextResolver(options.workingDirectory);
      this.circuitBreaker = options.circuitBreaker ?? null;
    }

    // Validate configuration: must have either single adapter or multi-provider setup
    if (!this.adapter && !this.adapterFactory) {
      throw new Error(
        'AgentInvoker must be initialized with either a single adapter or adapterFactory.'
      );
    }

    // Initialize agents from AGENTS.md if not explicitly provided
    if (!this.loadedAgents) {
      this._initializeAgents();
    }
  }

  /**
   * Initialize agent definitions from AGENTS.md
   * Handles loading, validation, and fail-fast for explicit paths
   */
  private _initializeAgents(): void {
    const settings = loadSettings();
    const agentsPath = settings.resolvedPaths?.agents_md;

    if (!agentsPath) {
      return;
    }

    const isExplicitPath = !!settings.agents_md_location;
    const result = loadAgentsDefs(agentsPath);

    // Consolidated validation for explicit paths (fail fast)
    if (isExplicitPath) {
      if (!result) {
        const reason = existsSync(agentsPath)
          ? 'is invalid or cannot be read'
          : 'was not found';
        throw new Error(
          `AGENTS.md at explicit path ${agentsPath} ${reason}. ` +
            `Please ensure the file is valid and accessible.`
        );
      } else if (result.missingRoles.length > 0) {
        throw new Error(
          `AGENTS.md at ${agentsPath} is missing required role definitions: ` +
            `${result.missingRoles.join(', ')}. ` +
            `Please add definitions for all required roles.`
        );
      }
    }

    if (result?.agents.size) {
      this.loadedAgents = result.agents;
      this.loadedAgentsSource = agentsPath;
      logger.info(
        `Loaded ${result.agents.size} agent definitions from ${agentsPath}`
      );
    }
  }

  /**
   * Set dynamically loaded agent definitions from AGENTS.md
   * When set, these take priority over default definitions
   * @param agents - Map of agent role to parsed definition
   * @param source - Optional source path for better logging
   */
  setLoadedAgents(
    agents: Map<AgentRole, ParsedAgentDef>,
    source?: string
  ): void {
    this.loadedAgents = agents;
    this.loadedAgentsSource = source;
    logger.debug(
      `Loaded ${agents.size} agent definitions from ${source || 'AGENTS.md'}`
    );
  }

  /**
   * Get the appropriate adapter for an agent role
   *
   * Uses shared selectAdapterForRole utility for consistent behavior across
   * AgentInvoker and LangGraphRunner.
   *
   * Priority:
   * 1. ProviderRouter + AdapterFactory (if both available)
   * 2. Single adapter (legacy mode)
   * 3. AdapterFactory with fallback backend
   */
  private async getAdapterForRole(role: AgentRole): Promise<ExecutionAdapter> {
    const result = await selectAdapterForRole({
      role,
      adapterFactory: this.adapterFactory,
      providerRouter: this.providerRouter,
      singleAdapter: this.adapter,
      fallbackBackend: this.fallbackBackend,
    });

    // Log provider selection if available
    if (result.selection) {
      logger.info(formatProviderSelectionLog(role, result.selection));
    }

    return result.adapter;
  }

  /**
   * Execute an agent with fidelity parameters
   *
   * Supports dynamic context resolution via @mentions in the task:
   * - @file:path/to/file.ts - Load specific file
   * - @folder:path/to/dir - Load all files in directory
   * - @path/to/file.ts - Shorthand (infers type from extension)
   *
   * Also supports fallback to another provider when the primary provider
   * fails with configuration/authentication errors.
   */
  async execute(context: AgentExecutionContext): Promise<ExecutionResult> {
    logger.info(`Executing agent: ${context.role}`);
    logger.debug(`Fidelity params:`, this.fidelityParams);

    // Get adapter for this specific role (may vary per agent with provider routing)
    let adapter = await this.getAdapterForRole(context.role);
    let backend = adapter.name;
    let triedFallback = false;

    // Check circuit breaker BEFORE retry loop (fast-fail)
    if (this.circuitBreaker) {
      const isOpen = await this.circuitBreaker.isOpen(backend);
      if (isOpen) {
        const state = await this.circuitBreaker.getState(backend);
        const retryAt = this.circuitBreaker.getRetryTime(state);
        throw new CircuitOpenError(backend, retryAt ?? undefined);
      }
    }

    // Resolve dynamic context references (@mentions) in the task
    const enrichedContext = await this.resolveContextReferences(context);

    // Load agent role description (would be from AGENTS.md in real implementation)
    const agentDef = this.loadAgentDefinition(
      context.role,
      context.systemPrompt
    );

    // Build execution request
    const request: ExecutionRequest = {
      agent: agentDef,
      task: enrichedContext.task,
      context: enrichedContext.projectContext,
      previousOutputs: context.previousOutputs,
      fidelityParams: {
        temperature: this.fidelityParams.temperature,
        maxTokens: this.fidelityParams.maxTokens,
        retryCount: this.fidelityParams.retryCount,
        useCaching: this.fidelityParams.useCaching,
        enableVerification: this.fidelityParams.enableVerification,
        timeoutMs: this.fidelityLevel
          ? FIDELITY_CLI_TIMEOUT[this.fidelityLevel]
          : undefined,
      },
    };

    // Execute with retry logic
    let lastError: Error | null = null;
    let result: ExecutionResult | null = null;

    // Helper to attempt fallback on configuration/auth errors
    // Returns true if fallback was successful and caller should continue loop
    const tryFallbackOnConfigError = async (error: Error): Promise<boolean> => {
      if (triedFallback || !this.providerRouter) {
        return false;
      }

      logger.warn(
        `Provider '${backend}' has configuration/auth error, attempting fallback`
      );
      this.providerRouter.setProviderAvailability(
        backend,
        false,
        error.message
      );

      try {
        const fallbackAdapter = await this.getAdapterForRole(context.role);
        if (fallbackAdapter.name !== backend) {
          logger.info(
            `Falling back from '${backend}' to '${fallbackAdapter.name}' for ${context.role}`
          );
          adapter = fallbackAdapter;
          backend = adapter.name;
          triedFallback = true;
          return true;
        }
      } catch (fallbackError) {
        logger.warn(
          `Failed to get fallback adapter: ${fallbackError instanceof Error ? fallbackError.message : fallbackError}`
        );
      }

      return false;
    };

    for (
      let attempt = 1;
      attempt <= this.fidelityParams.retryCount;
      attempt++
    ) {
      try {
        logger.info(`Attempt ${attempt}/${this.fidelityParams.retryCount}`);
        result = await adapter.execute(request);

        if (result.success) {
          logger.info(`Agent execution successful on attempt ${attempt}`);
          // Record success with circuit breaker
          if (this.circuitBreaker) {
            await this.circuitBreaker.recordSuccess(backend);
          }
          // Add provider info to metrics before returning
          return this.addProviderToResult(result, backend);
        }

        // Log each error explicitly so users can see what went wrong
        // Pass error object to logger.warn for stack traces in DEBUG mode
        if (result.errors && result.errors.length > 0) {
          const errors = result.errors;
          errors.forEach((err, index) => {
            logger.warn(`Execution error ${index + 1}/${errors.length}`, err);
          });
          lastError = errors[0];

          // Check if this is a configuration/auth error that warrants fallback
          const hasConfigError = errors.some(
            (err) => err instanceof ConfigurationError
          );
          if (hasConfigError && (await tryFallbackOnConfigError(lastError))) {
            attempt = 0; // Reset attempt counter for new provider
            continue;
          }
        }
      } catch (error) {
        lastError = toError(error);
        logger.warn(`Attempt ${attempt} failed:`, error);

        // Check if this is a configuration error that warrants fallback
        if (
          lastError instanceof ConfigurationError &&
          (await tryFallbackOnConfigError(lastError))
        ) {
          attempt = 0;
          continue;
        }

        // Don't retry timeout errors — they'll just timeout again at the same limit
        if (lastError instanceof TimeoutError) {
          logger.warn(
            `Skipping retry for timeout error (${(lastError as TimeoutError).timeoutMs}ms) — would timeout again`
          );
          break;
        }

        // If this is not the last attempt, wait before retrying
        if (attempt < this.fidelityParams.retryCount) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          logger.info(`Waiting ${backoffMs}ms before retry...`);
          await new Promise((resolve) =>
            globalThis.setTimeout(resolve, backoffMs)
          );
        }
      }
    }

    // All retries exhausted - update circuit breaker
    logger.error(
      `Agent execution failed after ${this.fidelityParams.retryCount} attempts`
    );

    // Only count retryable errors toward circuit breaker
    if (this.circuitBreaker && lastError && isRetryableError(lastError)) {
      await this.circuitBreaker.recordFailure(backend, lastError);
    }

    // Return last result if available, or create failure result
    // Add provider info to track which backend was attempted
    if (result) {
      return this.addProviderToResult(result, backend);
    }

    return {
      success: false,
      outputs: {
        analysis: `Agent execution failed after ${this.fidelityParams.retryCount} attempts`,
      },
      metrics: {
        tokensUsed: 0,
        duration: 0,
        cost: 0,
        provider: backend,
      },
      errors: lastError ? [lastError] : [new Error('Unknown error')],
    };
  }

  /**
   * Add provider info to execution result metrics
   */
  private addProviderToResult(
    result: ExecutionResult,
    provider: BackendType
  ): ExecutionResult {
    return {
      ...result,
      metrics: {
        ...result.metrics,
        provider,
      },
    };
  }

  /**
   * Load agent definition from AGENTS.md or defaults
   * If agents have been loaded from AGENTS.md via setLoadedAgents(),
   * those definitions are used to build the agent configuration:
   * - systemPrompt: built from purpose, responsibilities, tools, output
   * - capabilities: derived from tools (falls back to defaults)
   * - contextRequired: derived from responsibilities (falls back to defaults)
   */
  private loadAgentDefinition(
    role: AgentRole,
    systemPrompt?: string
  ): AgentDef {
    const defaultConfig = DEFAULT_AGENT_CONFIGS[role];
    const loadedDef = this.loadedAgents?.get(role);

    // If agent is defined in AGENTS.md, use it as the complete source of truth
    // (no fallback to defaults - this allows intentionally empty fields)
    if (loadedDef) {
      // Debug: Log when AGENTS.md config is used for an agent
      const providerInfo = loadedDef.provider
        ? `provider=${loadedDef.provider}${loadedDef.fallbackProvider ? `, fallback=${loadedDef.fallbackProvider}` : ''}`
        : 'no provider';
      const modelInfo = loadedDef.model ? `, model=${loadedDef.model}` : '';
      logger.debug(
        `[AGENTS.md] Using config for ${role}: purpose="${loadedDef.purpose?.slice(0, 50)}...", ` +
          `tools=[${loadedDef.tools.slice(0, 3).join(', ')}${loadedDef.tools.length > 3 ? '...' : ''}], ${providerInfo}${modelInfo}`
      );

      // Note on field mapping from AGENTS.md:
      // - tools -> capabilities: In AGENTS.md, "Tools" describes the mechanisms/APIs
      //   the agent uses. These map to "capabilities" which describe what the agent
      //   can do. For most agents, the tools they have access to define their capabilities.
      // - responsibilities -> contextRequired: "Responsibilities" in AGENTS.md describe
      //   the actions/tasks the agent performs. These map to "contextRequired" which
      //   indicates what information the agent needs. An agent's responsibilities
      //   determine what context it requires to fulfill them.
      // - provider/fallbackProvider: Included for debugging/logging; actual provider
      //   selection happens earlier in getAdapterForRole() via ProviderRouter.
      // If more precise definitions are needed, consider adding explicit "Capabilities"
      // and "Context Required" fields to AGENTS.md.
      return {
        role,
        capabilities: loadedDef.tools,
        contextRequired: loadedDef.responsibilities,
        systemPrompt: systemPrompt || this.buildPromptFromParsedDef(loadedDef),
        preferredModel: loadedDef.model,
        provider: loadedDef.provider,
        fallbackProvider: loadedDef.fallbackProvider,
        providerConfig: loadedDef.providerConfig,
      };
    }

    // No AGENTS.md definition - use built-in defaults entirely
    if (this.loadedAgents === null) {
      logger.debug(
        `[AGENTS.md] No AGENTS.md loaded, using built-in defaults for ${role}`
      );
    } else {
      logger.debug(
        `[AGENTS.md] Agent '${role}' not defined in ${this.loadedAgentsSource || 'loaded AGENTS.md'}, using built-in defaults`
      );
    }
    return {
      role,
      capabilities: defaultConfig.capabilities,
      contextRequired: defaultConfig.contextRequired,
      systemPrompt: systemPrompt || defaultConfig.defaultPrompt,
    };
  }

  /**
   * Build a system prompt from parsed AGENTS.md definition
   * If a custom System-Prompt is provided, use it directly.
   * Otherwise, auto-generate from purpose, responsibilities, tools, and output.
   */
  private buildPromptFromParsedDef(def: ParsedAgentDef): string {
    // If custom system prompt is provided, use it directly
    if (def.systemPrompt) {
      return def.systemPrompt;
    }

    // Auto-generate prompt from other fields
    const parts: string[] = [];

    if (def.purpose) {
      parts.push(`You are a ${def.role} agent. ${def.purpose}`);
    } else {
      parts.push(`You are a ${def.role} agent.`);
    }

    if (def.responsibilities.length > 0) {
      const responsibilitiesList = def.responsibilities
        .map((r) => `- ${r}`)
        .join('\n');
      parts.push(`\n\nYour responsibilities include:\n${responsibilitiesList}`);
    }

    if (def.tools.length > 0) {
      const toolsList = def.tools.map((t) => `- ${t}`).join('\n');
      parts.push(`\n\nYour tools include:\n${toolsList}`);
    }

    if (def.output) {
      parts.push(`\n\nYou produce: ${def.output}.`);
    }

    return parts.join('');
  }

  /**
   * Resolve @mentions in the task and enrich context with loaded files
   *
   * Parses the task for patterns like:
   * - @file:src/utils/config.ts
   * - @folder:src/utils
   * - @src/utils/config.ts (shorthand)
   *
   * Loads referenced files and adds them to additionalContext
   */
  private async resolveContextReferences(
    context: AgentExecutionContext
  ): Promise<AgentExecutionContext> {
    try {
      const result = await this.contextResolver.resolve(context.task);

      // If no references found, return unchanged
      if (result.references.length === 0) {
        return context;
      }

      logger.info(
        `Resolved ${result.resolved.length} context reference(s) in task`
      );

      if (result.failed.length > 0) {
        logger.warn(
          `Failed to resolve ${result.failed.length} reference(s): ` +
            result.failed.map((f) => f.reference.path).join(', ')
        );
      }

      // Log resolved files (cached vs loaded)
      for (const resolved of result.resolved) {
        const cacheStatus = resolved.fromCache ? '(cached)' : '(loaded)';
        logger.debug(`  ${resolved.reference.path} ${cacheStatus}`);
      }

      // Enrich the project context with resolved content
      const enrichedContext: ProjectContext = {
        ...context.projectContext,
        additionalContext: {
          ...context.projectContext.additionalContext,
          dynamicContext: result.context,
          resolvedFiles: result.resolved.map((r) => r.reference.path),
        },
      };

      return {
        ...context,
        projectContext: enrichedContext,
      };
    } catch (error) {
      // Context resolution failure is non-fatal - log and continue
      logger.warn(
        `Context resolution failed: ${error instanceof Error ? error.message : error}`
      );
      return context;
    }
  }

  /**
   * Get cache statistics for the context resolver
   */
  getContextCacheStats(): { size: number; keys: string[] } {
    return this.contextResolver.getCacheStats();
  }

  /**
   * Clear the context resolver cache
   */
  clearContextCache(): void {
    this.contextResolver.clearCache();
  }
}
