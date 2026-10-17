/**
 * Backend adapter types for AIRunX
 * Supports multiple execution backends: Claude Code CLI, Cursor CLI, SDK-based
 */

import { z } from 'zod';
import type { AgentRole, PromptSectionBytes } from './types.js';
import { AgentRoleSchema, FidelityConfigSchema } from './types.js';

/**
 * Array of all valid backend types - single source of truth
 * Used to derive both the TypeScript type and Zod schema
 * Only subscription-based CLI providers are supported
 *
 * Note: When using 'claude-code', Compound Engineering capabilities
 * (sub-agent delegation) are automatically included. Use the
 * disable_compound_engineering setting to use raw Claude Code.
 */
export const BACKEND_TYPES = ['claude-code', 'cursor', 'codex'] as const;

/** Default fallback backend when no provider is specified */
export const DEFAULT_FALLBACK_BACKEND: BackendType = 'claude-code';

export type BackendType = (typeof BACKEND_TYPES)[number];

/**
 * Sub-agent types available for compound engineering delegation.
 * Defined here in core to avoid utils→adapters dependency.
 */
export const SUB_AGENT_TYPES = [
  'architecture-strategist',
  'pattern-recognition-specialist',
  'framework-docs-researcher',
] as const;

export type SubAgentType = (typeof SUB_AGENT_TYPES)[number];
export type AdapterType = 'cli' | 'sdk';

/**
 * Zod schemas for runtime validation
 * Types are inferred from these schemas to ensure sync between validation and types
 */
export const BackendConfigSchema = z.object({
  type: z.enum(['cli', 'sdk']),
  executable: z.string().optional(),
  timeout: z.number().optional(),
  verify_install: z.boolean().optional(),
  api_key_env: z.string().optional(),
  model: z.string().optional(),
  max_tokens: z.number().optional(),
  temperature: z.number().min(0).max(2).optional(),
  retry_count: z.number().int().min(0).optional(),
  use_caching: z.boolean().optional(),
  enable_verification: z.boolean().optional(),
});

/**
 * Circuit breaker configuration schema
 * Controls fast-fail behavior for repeatedly failing backends
 */
export const CircuitBreakerConfigSchema = z.object({
  /** Whether circuit breaker is enabled (default: true) */
  enabled: z.boolean().default(true),
  /** Number of failures before circuit opens (default: 5) */
  failure_threshold: z.number().int().min(1).default(5),
  /** Seconds before attempting recovery (default: 60) */
  reset_timeout_seconds: z.number().int().min(1).default(60),
  /** Maximum reset timeout with backoff (default: 300) */
  max_reset_timeout_seconds: z.number().int().min(1).default(300),
  /** Successes needed to close circuit (default: 1) */
  half_open_success_threshold: z.number().int().min(1).default(1),
});

export const BackendTypeSchema = z.enum(BACKEND_TYPES);

export const SystemConfigSchema = z
  .object({
    agent_routing: z.record(AgentRoleSchema, BackendTypeSchema),
    backends: z.record(BackendTypeSchema, BackendConfigSchema),
    fallback_backend: BackendTypeSchema,
    verify_on_start: z.boolean().optional(),
    cache_ttl_minutes: z.number().int().positive().optional(),
    execution_fidelity: FidelityConfigSchema.optional(),
    circuit_breaker: CircuitBreakerConfigSchema.optional(),
  })
  .superRefine((config, ctx) => {
    const definedBackends = new Set(
      Object.keys(config.backends) as BackendType[]
    );

    // Check each agent routing entry for undefined backends
    for (const [agent, backend] of Object.entries(config.agent_routing)) {
      if (!definedBackends.has(backend)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Backend '${backend}' is not defined in the 'backends' object`,
          path: ['agent_routing', agent],
        });
      }
    }

    // Check fallback backend separately for more specific error path
    if (!definedBackends.has(config.fallback_backend)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Backend '${config.fallback_backend}' is not defined in the 'backends' object`,
        path: ['fallback_backend'],
      });
    }

    // Note: Unused backend detection is intentionally not implemented here.
    // While it would be helpful to warn users about defined but unused backends,
    // it's common to define all backends upfront for easy switching, so this
    // should be a warning rather than a validation error. This check could be
    // implemented in the doctor command or as a separate utility function.
  });

/**
 * Configuration for a specific adapter
 */
export interface AdapterConfig {
  type: AdapterType;
  executable?: string;
  apiKey?: string;
  model?: string;
  timeout?: number;
  maxTokens?: number;
  temperature?: number;
  retryCount?: number;
  useCaching?: boolean;
  enableVerification?: boolean;
}

/**
 * Provider configuration for compound engineering features
 */
export interface AgentProviderConfig {
  /** Sub-agents this agent can delegate to */
  subAgents?: string[];
  /** Whether delegation is enabled */
  delegation?: boolean;
  /** Disable compound-engineering entirely for this agent */
  disableCompoundEngineering?: boolean;
}

/**
 * Agent definition for execution
 */
export interface AgentDef {
  role: AgentRole;
  capabilities: string[];
  contextRequired: string[];
  preferredModel?: string;
  systemPrompt?: string;
  /** Preferred provider backend for this agent (from AGENTS.md) */
  provider?: BackendType;
  /** Fallback provider if primary is unavailable (from AGENTS.md) */
  fallbackProvider?: BackendType;
  /** Provider configuration for compound engineering features */
  providerConfig?: AgentProviderConfig;
}

/**
 * Additional context that can be injected into agent prompts
 */
export interface AdditionalContext {
  /** Static context from settings.context_location and --context flag */
  staticContext?: string;
  /** Dynamic context from resolved @mentions in task */
  dynamicContext?: string;
  /** List of file paths that were resolved from @mentions */
  resolvedFiles?: string[];
  /** When true, agent is running inside a pipeline — blocks gh PR/issue creation */
  pipelineMode?: boolean;
  /** Resolved tool configuration paths from settings (e.g., docs_location) */
  toolConfigs?: Record<string, string>;
  /** Serialized handoff context from previous pipeline stages */
  handoffContext?: string;
}

/**
 * Project context passed to agents
 */
export interface ProjectContext {
  workingDirectory: string;
  gitBranch?: string;
  files?: string[];
  recentCommits?: string[];
  issueContext?: string;
  additionalContext?: AdditionalContext;
}

/**
 * Request to execute an agent task
 */
export interface ExecutionRequest {
  agent: AgentDef;
  task: string;
  context: ProjectContext;
  previousOutputs?: Record<string, unknown>;
  fidelityParams?: {
    temperature?: number;
    maxTokens?: number;
    retryCount?: number;
    useCaching?: boolean;
    enableVerification?: boolean;
    /** Per-agent timeout override derived from fidelity level (milliseconds) */
    timeoutMs?: number;
  };
  /**
   * Attribution for the spawn(s) this request produces. Routed by the
   * SpawnObserver into the ledger; absent → spawn is recorded unattributed.
   */
  spawnContext?: SpawnContext;
}

/**
 * Attribution carried on an ExecutionRequest so every CLI spawn can be tied
 * back to its workflow, stage and iteration.
 */
export interface SpawnContext {
  workflowId: string;
  stage: string;
  /** 1-indexed iteration of the workflow (matches iteration history) */
  iteration: number;
  /** spawn_id of the spawn that delegated this one (CE sub-agents) */
  parentSpawnId?: string;
}

/** Why a spawn ended */
export const SPAWN_EXIT_REASONS = [
  'ok',
  'timeout',
  'hang',
  'signal',
  'error',
] as const;
export type SpawnExitReason = (typeof SPAWN_EXIT_REASONS)[number];

/** How the backend CLI authenticated (subscription login vs API key) */
export type SpawnAuthMode = 'subscription' | 'api_key';

/**
 * Structured record of one completed CLI spawn, handed to the SpawnObserver.
 * Later units extend this additively (provenance, billing basis,
 * normalized tokens, pricing version, estimation labels).
 */
export interface SpawnRecord {
  spawnId: string;
  parentSpawnId?: string;
  workflowId?: string;
  stage?: string;
  iteration?: number;
  backend: BackendType;
  /** Model the spawn was priced against (undefined when the CLI chose) */
  model?: string;
  authMode?: SpawnAuthMode;
  agentRole: AgentRole;
  promptBytes?: number;
  promptSections?: PromptSectionBytes;
  /** Raw (provider-reported or estimated) token figures, pre-normalization */
  tokensUsed: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** UTC RFC 3339 */
  startedAt: string;
  /** UTC RFC 3339 */
  endedAt: string;
  durationMs: number;
  exitReason: SpawnExitReason;
  success: boolean;
  /** True when metrics were recovered from a failed spawn's partial output */
  salvaged: boolean;
  /** Error class name on failure (an enum-like category, never the message) */
  errorCategory?: string;
  /** Provider session/thread ID when the CLI reports one */
  providerSessionId?: string;
}

/**
 * Receives one SpawnRecord per completed CLI spawn. Implementations must not
 * throw; adapters additionally guard calls so a failing observer never
 * affects execution.
 */
export interface SpawnObserver {
  onSpawnComplete(record: SpawnRecord, request: ExecutionRequest): void;
}

/**
 * Result from agent execution
 */
export interface ExecutionResult {
  success: boolean;
  outputs: {
    files?: Array<{
      path: string;
      action: 'create' | 'update' | 'delete';
      content?: string;
      diff?: string;
    }>;
    analysis?: string;
    recommendations?: string[];
    diff?: string;
    [key: string]: unknown;
  };
  metrics: {
    tokensUsed: number;
    duration: number;
    cost?: number;
    /** Provider/backend that executed this request */
    provider?: string;
    /** Number of CLI spawns for this execution (1 for simple, >1 for compound) */
    spawnCount?: number;
    /** UTF-8 byte size of the prompt sent to the backend */
    promptBytes?: number;
    /** Per-section byte breakdown of the prompt (explains large prompts) */
    promptSections?: PromptSectionBytes;
  };
  errors: Error[];
  /**
   * ID of the CLI spawn that produced this result (the main spawn when an
   * adapter performs several, e.g. CE delegation)
   */
  spawnId?: string;
}

/**
 * Prompt text plus its per-section byte breakdown
 */
export interface BuiltPrompt {
  prompt: string;
  sections: PromptSectionBytes;
}

/**
 * Backend availability check result
 */
export interface BackendAvailability {
  available: boolean;
  version?: string;
  error?: string;
  installInstructions?: string;
}

/**
 * Adapter interface that all backends must implement
 */
export interface ExecutionAdapter {
  name: BackendType;
  type: AdapterType;

  /**
   * Initialize the adapter with configuration
   */
  init(config: AdapterConfig): Promise<void>;

  /**
   * Execute an agent task
   */
  execute(request: ExecutionRequest): Promise<ExecutionResult>;

  /**
   * Check if this backend is available on the system
   */
  isAvailable(): Promise<BackendAvailability>;

  /**
   * Clean up resources
   */
  cleanup(): Promise<void>;

  /**
   * Attach the observer notified after every CLI spawn (optional; adapters
   * that never spawn may omit it)
   */
  setSpawnObserver?(observer: SpawnObserver | undefined): void;
}

/**
 * Types inferred from Zod schemas - single source of truth
 */
export type BackendConfig = z.infer<typeof BackendConfigSchema>;
export type SystemConfig = z.infer<typeof SystemConfigSchema>;
export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfigSchema>;
