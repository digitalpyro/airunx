/**
 * Core type definitions for AIRunX
 */

import { z } from 'zod';

export type InputType = 'github' | 'prd' | 'prompt';

/**
 * Supported programming languages for multi-language tooling
 * Note: Python, Ruby, Go support planned for future releases
 */
export const SUPPORTED_LANGUAGES = ['typescript', 'javascript', 'php'] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * Generic tool types that map to language-specific implementations
 */
export const TOOL_TYPES = [
  'linter',
  'type_checker',
  'test_runner',
  'coverage',
  'formatter',
  'security_scanner',
] as const;

export type ToolType = (typeof TOOL_TYPES)[number];

/**
 * Configuration for a language-specific tool
 */
export interface ToolConfig {
  language: SupportedLanguage;
  toolType: ToolType;
  command: string;
  configFile?: string;
  requiredFiles?: string[];
}

/**
 * Zod schemas for language and tool types
 */
export const SupportedLanguageSchema = z.enum(SUPPORTED_LANGUAGES);
export const ToolTypeSchema = z.enum(TOOL_TYPES);

export const ToolConfigSchema = z.object({
  language: SupportedLanguageSchema,
  toolType: ToolTypeSchema,
  command: z.string().min(1),
  configFile: z.string().optional(),
  requiredFiles: z.array(z.string()).optional(),
});

/**
 * Pipeline types - each produces a specific deliverable
 */
export const PIPELINE_TYPES = [
  'thin',
  'standard',
  'feature',
  'mission-critical',
] as const;

export type PipelineType = (typeof PIPELINE_TYPES)[number];

/**
 * Required pipeline types - must be defined in pipelines.yaml
 */
export const REQUIRED_PIPELINE_TYPES = ['thin', 'standard'] as const;

/**
 * Deliverable types - concrete outputs from pipelines
 */
export const DELIVERABLE_TYPES = [
  'github_issue',
  'pull_request',
  'documentation',
  'report',
] as const;

export type DeliverableType = (typeof DELIVERABLE_TYPES)[number];

/**
 * Orchestration mode - pipeline-driven or raw LLM execution
 */
export type OrchestrationMode = 'pipeline' | 'raw';

/**
 * Execution fidelity levels for quality-cost tradeoffs
 */
export const EXECUTION_FIDELITY_LEVELS = [
  'fast',
  'standard',
  'thorough',
  'ultra',
] as const;

export type ExecutionFidelityLevel = (typeof EXECUTION_FIDELITY_LEVELS)[number];

/**
 * Type guard for validating a string is a valid ExecutionFidelityLevel.
 * Use this instead of `as ExecutionFidelityLevel` casts for safe validation.
 */
export function isExecutionFidelityLevel(
  value: string
): value is ExecutionFidelityLevel {
  return (EXECUTION_FIDELITY_LEVELS as readonly string[]).includes(value);
}

/**
 * Approval modes for CLI adapter permission handling
 * Controls how adapters handle interactive prompts and sandboxing
 */
export const APPROVAL_MODES = [
  'manual', // Interactive prompts for all actions
  'auto', // Auto-approve all actions (default for airunx)
  'yolo', // Skip all approvals and sandboxing (DANGEROUS - enables most permissive flags)
] as const;

export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const ApprovalModeSchema = z.enum(APPROVAL_MODES);

/**
 * Array of all valid agent roles - single source of truth
 * Used to derive both the TypeScript type and Zod schema
 *
 * Naming convention: {role}-{descriptive} for clarity
 * - orchestrator: Central coordinator, no descriptor needed
 * - developer: Combined strategic + implementation agent
 * - code-*: Code quality agents (reviewer, judge)
 * - static-analyzer: LLM-powered test/lint failure interpretation
 * - *-creator/*-generator: Output-specific agents
 */
export const AGENT_ROLES = [
  'code-judge',
  'code-reviewer',
  'developer',
  'docs-generator',
  'orchestrator',
  'static-analyzer',
  'test-creator',
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

/**
 * Judge verdict enum for code-judge agent decisions
 * Controls pipeline iteration flow
 */
export const JUDGE_VERDICTS = ['ITERATE', 'PROCEED', 'BLOCK', 'FAIL'] as const;

export type JudgeVerdict = (typeof JUDGE_VERDICTS)[number];

export const JudgeVerdictSchema = z.enum(JUDGE_VERDICTS);

/**
 * Fidelity parameters configuration for a specific fidelity level
 * Uses camelCase for TypeScript convention
 */
export interface FidelityParameters {
  temperature: number;
  maxTokens: number;
  retryCount: number;
  reviewIterations: number;
  useCaching: boolean;
  enableVerification: boolean;
  multiModelVoting: boolean;
}

/**
 * System-wide fidelity configuration
 */
export interface FidelityConfig {
  default_level: ExecutionFidelityLevel;
  levels: Record<ExecutionFidelityLevel, FidelityParameters>;
}

/**
 * Metrics tracked for fidelity-aware execution
 */
export interface FidelityMetrics {
  level: ExecutionFidelityLevel;
  reviewIterations: number;
  verificationsPassed: number;
  consensusAchieved?: boolean;
  estimatedCost: number;
  actualCost: number;
  costEfficiency: number;
}

/**
 * Validation limits for fidelity parameters
 * Single source of truth for both Zod schemas and runtime validation
 */
export const FIDELITY_PARAM_LIMITS = {
  MAX_TEMPERATURE: 2,
  MAX_TOKENS: 32768,
  MAX_RETRIES: 10,
} as const;

/**
 * Pipeline timeout limits in minutes
 * Single source of truth for both Zod schemas and runtime validation
 */
export const PIPELINE_TIMEOUT_LIMITS = {
  MIN_MINUTES: 1,
  MAX_MINUTES: 480, // 8 hours
} as const;

/**
 * Reusable schema for pipeline timeout in minutes
 * Used by both RawPipelineSchema and PipelineSchema
 */
export const TimeoutMinutesSchema = z
  .number()
  .int()
  .min(PIPELINE_TIMEOUT_LIMITS.MIN_MINUTES)
  .max(PIPELINE_TIMEOUT_LIMITS.MAX_MINUTES)
  .optional();

/**
 * Zod schemas for runtime validation
 * Types are inferred from these schemas to ensure sync between validation and types
 */
export const AgentRoleSchema = z.enum(AGENT_ROLES);

export const ExecutionFidelityLevelSchema = z.enum(EXECUTION_FIDELITY_LEVELS);

export const PipelineTypeSchema = z.enum(PIPELINE_TYPES);

export const DeliverableTypeSchema = z.enum(DELIVERABLE_TYPES);

// Base schema for a single fidelity level's parameters, matching the YAML (snake_case)
const FidelityParametersObjectSchema = z.object({
  temperature: z.number().min(0).max(FIDELITY_PARAM_LIMITS.MAX_TEMPERATURE),
  max_tokens: z.number().int().positive().max(FIDELITY_PARAM_LIMITS.MAX_TOKENS),
  retry_count: z.number().int().min(0).max(FIDELITY_PARAM_LIMITS.MAX_RETRIES),
  review_iterations: z.number().int().positive(),
  use_caching: z.boolean(),
  enable_verification: z.boolean(),
  multi_model_voting: z.boolean(),
});

/**
 * Partial schema for user-provided fidelity parameters in YAML.
 * This allows users to override only specific snake_case parameters.
 */
export const PartialFidelityParametersSchema =
  FidelityParametersObjectSchema.partial();

export const FidelityConfigSchema = z.object({
  default_level: ExecutionFidelityLevelSchema,
  // Users provide partial snake_case config. We validate that and transform to partial camelCase.
  // The final merging with defaults is handled by the `getFidelityConfig` resolver.
  levels: z
    .record(
      ExecutionFidelityLevelSchema,
      PartialFidelityParametersSchema.transform((data) => {
        const mapping: Record<string, string> = {
          max_tokens: 'maxTokens',
          retry_count: 'retryCount',
          review_iterations: 'reviewIterations',
          use_caching: 'useCaching',
          enable_verification: 'enableVerification',
          multi_model_voting: 'multiModelVoting',
        };

        return Object.fromEntries(
          Object.entries(data)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [mapping[key] || key, value])
        );
      })
    )
    .optional(),
});

/**
 * Internal schema for parsing snake_case YAML keys.
 * PipelineStageSchema transforms these to camelCase for TypeScript usage.
 */
const PipelineStageInputSchema = z.object({
  name: z.string().min(1, 'Stage name cannot be empty'),
  agent: AgentRoleSchema.optional(),
  tools: z.array(z.string()).optional(),
  input: z.string().optional(),
  output: z.string().optional(),
  decision: z.string().optional(),
  description: z.string().optional(),
  fidelity: z
    .union([ExecutionFidelityLevelSchema, z.literal('inherit')])
    .optional(),
  optional: z.boolean().optional().default(false),
  skip_condition: z.string().optional(),
  skip_on_iterate: z.boolean().optional(),
  evaluates_stage: z.string().optional(),
  insert_before: z.string().optional(),
  insert_after: z.string().optional(),
  ignore_context: z.boolean().optional().default(false),
});

export const PipelineStageSchema = PipelineStageInputSchema.transform(
  (data) => ({
    name: data.name,
    agent: data.agent,
    tools: data.tools,
    input: data.input,
    output: data.output,
    decision: data.decision,
    description: data.description,
    fidelity: data.fidelity,
    optional: data.optional,
    skipCondition: data.skip_condition,
    skipOnIterate: data.skip_on_iterate,
    evaluatesStage: data.evaluates_stage,
    insertBefore: data.insert_before,
    insertAfter: data.insert_after,
    ignoreContext: data.ignore_context,
  })
);

/**
 * Raw pipeline schema - allows stages_inherit for inheritance
 * This is the schema for YAML parsing before inheritance resolution
 */
export const RawPipelineSchema = z
  .object({
    name: z.string().min(1, 'Pipeline name cannot be empty'),
    description: z.string().optional(),
    deliverable: DeliverableTypeSchema.default('pull_request'),
    default_fidelity: ExecutionFidelityLevelSchema.optional(),
    max_iterations: z.number().int().positive().optional(),
    timeout_minutes: TimeoutMinutesSchema,
    // Either stages OR stages_inherit must be present
    stages: z.array(PipelineStageSchema).optional(),
    // Inherit stages from another pipeline
    stages_inherit: PipelineTypeSchema.optional(),
    // Override specific stages from inherited pipeline
    stage_overrides: z.array(PipelineStageSchema).optional(),
  })
  .refine((data) => data.stages || data.stages_inherit, {
    message:
      "A pipeline must have either a 'stages' array or a 'stages_inherit' property.",
  });

/**
 * Resolved pipeline schema - after inheritance is processed
 * All pipelines must have stages after resolution
 */
export const PipelineSchema = z.object({
  name: z.string().min(1, 'Pipeline name cannot be empty'),
  description: z.string().optional(),
  deliverable: DeliverableTypeSchema.default('pull_request'),
  default_fidelity: ExecutionFidelityLevelSchema.optional(),
  max_iterations: z.number().int().positive().optional(),
  timeout_minutes: TimeoutMinutesSchema,
  stages: z
    .array(PipelineStageSchema)
    .min(1, 'Pipeline must have at least one stage'),
});

/**
 * Raw pipeline config schema - for YAML parsing before inheritance resolution
 */
export const RawPipelineConfigSchema = z.object({
  global: z
    .object({
      verdict_enum: z.array(z.string()).optional(),
      handoff_schema_version: z.string().optional(),
      default_tools: z.array(z.string()).optional(),
    })
    .optional(),
  pipelines: z
    .record(z.string(), RawPipelineSchema)
    .refine((pipelines) => Object.keys(pipelines).length > 0, {
      message: 'Pipelines configuration must contain at least one pipeline.',
    }),
});

/**
 * Resolved pipeline config schema - after inheritance is processed
 */
export const PipelineConfigSchema = z.object({
  global: z
    .object({
      verdict_enum: z.array(z.string()).optional(),
      handoff_schema_version: z.string().optional(),
      default_tools: z.array(z.string()).optional(),
    })
    .optional(),
  pipelines: z
    .record(z.string(), PipelineSchema)
    .refine((pipelines) => Object.keys(pipelines).length > 0, {
      message: 'Pipelines configuration must contain at least one pipeline.',
    })
    .superRefine((pipelines, ctx) => {
      // Validate each pipeline key and report specific invalid keys
      for (const key in pipelines) {
        // Use includes with proper type - key is string, we're checking if it's a valid PipelineType
        if (!(PIPELINE_TYPES as readonly string[]).includes(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid pipeline type '${key}' used as a key. Valid types are: ${PIPELINE_TYPES.join(', ')}.`,
            path: [key],
          });
        }
      }
    }),
});

/**
 * Input and orchestration type schemas
 */
export const InputTypeSchema = z.enum(['github', 'prd', 'prompt']);
export const OrchestrationModeSchema = z.enum(['pipeline', 'raw']);
export const WorkflowStatusSchema = z.enum([
  'initializing',
  'running',
  'paused',
  'completed',
  'completed_with_errors', // Workflow finished but some stages failed
  'failed',
]);

/**
 * Todo schema with Date transformation for deserialization
 */
export const TodoSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'blocked']),
  priority: z.enum(['p1', 'p2', 'p3']),
  createdAt: z.union([z.date(), z.string().transform((val) => new Date(val))]),
  updatedAt: z.union([z.date(), z.string().transform((val) => new Date(val))]),
});

/**
 * Quality metrics schema
 */
export const QualityMetricsSchema = z.object({
  coverage: z.number().optional(),
  lintPassed: z.boolean().optional(),
  typeCheckPassed: z.boolean().optional(),
  securityIssues: z.number().optional(),
});

/**
 * Workflow metrics schema
 */
export const WorkflowMetricsSchema = z.object({
  tokensUsed: z.number(),
  totalTokens: z.number().optional(),
  runtime: z.number(),
  totalRuntimeMs: z.number().optional(),
  stagesCompleted: z.number(),
  totalStages: z.number(),
  errors: z.number(),
  fidelityLevel: ExecutionFidelityLevelSchema.optional(),
  costEstimate: z.number().optional(),
  actualCost: z.number().optional(),
  totalCost: z.number().optional(),
});

/**
 * Fidelity parameters schema (camelCase for runtime use)
 */
export const FidelityParametersSchema = z.object({
  temperature: z.number().min(0).max(FIDELITY_PARAM_LIMITS.MAX_TEMPERATURE),
  maxTokens: z.number().int().positive().max(FIDELITY_PARAM_LIMITS.MAX_TOKENS),
  retryCount: z.number().int().min(0).max(FIDELITY_PARAM_LIMITS.MAX_RETRIES),
  reviewIterations: z.number().int().positive(),
  useCaching: z.boolean(),
  enableVerification: z.boolean(),
  multiModelVoting: z.boolean(),
});

/**
 * Fidelity metrics schema
 */
export const FidelityMetricsSchema = z.object({
  level: ExecutionFidelityLevelSchema,
  reviewIterations: z.number(),
  verificationsPassed: z.number(),
  consensusAchieved: z.boolean().optional(),
  estimatedCost: z.number(),
  actualCost: z.number(),
  costEfficiency: z.number(),
});

/**
 * Workflow context schema with Date transformation for deserialization
 * This schema validates serialized workflow state from JSON files
 */
export const WorkflowContextSchema = z.object({
  id: z.string(),
  input: z.string(),
  inputType: InputTypeSchema,
  mode: OrchestrationModeSchema,

  // Git/Repository
  worktreePath: z.string().optional(),
  repoPath: z.string().optional(),
  branchName: z.string().optional(),

  // Workflow state - transform string dates to Date objects
  createdAt: z.union([z.date(), z.string().transform((val) => new Date(val))]),
  status: WorkflowStatusSchema,
  currentStage: z.string().optional(),
  // Accept both snake_case (from YAML/pipeline parse) and camelCase (from serialized state)
  currentStageObj: PipelineStageSchema.optional(),

  // Task metadata
  taskTitle: z.string().optional(),
  taskDescription: z.string().optional(),
  commitType: z.string().optional(),
  issueNumber: z.string().optional(),
  /** Full GitHub issue URL for PR linking (enables cross-repo issue closing) */
  issueUrl: z.string().optional(),
  /** Custom test plan for PR (can be set by agent during implementation) */
  testPlan: z.string().optional(),

  // Execution
  backend: z.string().optional(),
  pipelineName: z.string().optional(), // Pipeline used for this workflow (for resume)
  executionFidelity: ExecutionFidelityLevelSchema.optional(),
  fidelityLevel: ExecutionFidelityLevelSchema.optional(),
  fidelityParams: FidelityParametersSchema.optional(),
  fidelityMetrics: FidelityMetricsSchema.optional(),

  // Iteration
  iterationCount: z.number().optional(),
  maxIterations: z.number().optional(),
  iterationHistory: z
    .object({
      entries: z.array(
        z.object({
          iteration: z.number(),
          timestamp: z.union([
            z.date(),
            z.string().transform((val) => new Date(val)),
          ]),
          approach: z.string(),
          verdict: JudgeVerdictSchema,
          gaps: z.array(z.string()),
          durationMs: z.number().optional(),
          costUsd: z.number().optional(),
          tokensUsed: z.number().optional(),
          stageRecords: z
            .array(
              z.object({
                stage: z.string(),
                agent: z.string(),
                backend: z.string(),
                spawnCount: z.number(),
                durationMs: z.number(),
                tokensUsed: z.number(),
                costUsd: z.number(),
                promptSummary: z.string().optional(),
                timestamp: z.string(),
                status: z.enum(['completed', 'error', 'skipped']),
              })
            )
            .optional(),
        })
      ),
    })
    .optional(),

  // Stage results for resumability
  stageResults: z.record(z.string(), z.unknown()).optional(),

  // Todos and quality
  todos: z.array(TodoSchema).optional(),
  qualityMetrics: QualityMetricsSchema.optional(),

  // Metrics
  metrics: WorkflowMetricsSchema,

  // Stage timing for performance visibility
  stageTiming: z
    .array(
      z.object({
        stage: z.string(),
        duration: z.number(), // milliseconds
      })
    )
    .optional(),

  // Rich per-stage records for run reporting
  stageRecords: z
    .array(
      z.object({
        stage: z.string(),
        agent: z.string(),
        backend: z.string(),
        spawnCount: z.number(),
        durationMs: z.number(),
        tokensUsed: z.number(),
        costUsd: z.number(),
        promptSummary: z.string().optional(),
        timestamp: z.string(),
        status: z.enum(['completed', 'error', 'skipped']),
      })
    )
    .optional(),

  // External integrations
  cardUrl: z.string().optional(),
  prUrl: z.string().optional(),
  prNumber: z.number().optional(),
  commitSha: z.string().optional(),

  // Failure diagnostics
  failureReason: z.string().optional(),
});

export type WorkflowStatus =
  | 'initializing'
  | 'running'
  | 'paused'
  | 'completed'
  | 'completed_with_errors' // Workflow finished but some stages failed
  | 'failed';

export interface Todo {
  id: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  priority: 'p1' | 'p2' | 'p3';
  createdAt: Date;
  updatedAt: Date;
}

export interface QualityMetrics {
  coverage?: number;
  lintPassed?: boolean;
  typeCheckPassed?: boolean;
  securityIssues?: number;
}

/**
 * Stage timing record for performance visibility
 * @deprecated Use StageRecord for richer per-stage data
 */
export interface StageTiming {
  stage: string;
  duration: number; // milliseconds
}

/**
 * Rich per-stage record capturing everything needed for run report tables.
 * Replaces StageTiming as the canonical per-stage data source.
 */
export interface StageRecord {
  stage: string;
  agent: string; // role name (e.g., "developer", "code-reviewer")
  backend: string; // provider (e.g., "claude-code", "codex")
  spawnCount: number; // CLI spawns for this stage
  durationMs: number; // wall-clock milliseconds
  tokensUsed: number;
  costUsd: number;
  promptSummary?: string; // first 200 chars of the task prompt
  timestamp: string; // ISO 8601 start time
  status: 'completed' | 'error' | 'skipped';
}

/**
 * Timeline event for structured run reporting
 */
export interface TimelineEvent {
  timestamp: string; // ISO 8601
  event: string; // e.g., "orchestrate complete", "judge: PROCEED"
  durationMs?: number;
  details?: string;
}

/**
 * Structured run report written at pipeline completion.
 * Single JSON artifact that any consumer (issue comments, PR templates,
 * CLI output, dashboards) can read to render rich tables.
 */
export interface RunReport {
  workflowId: string;
  taskTitle?: string;
  pipelineName?: string;
  status: string;
  startedAt: string; // ISO 8601
  completedAt: string; // ISO 8601
  totalDurationMs: number;
  totalTokens: number;
  totalCostUsd: number;
  iterationCount: number;
  maxIterations: number;
  iterations: IterationEntry[];
  stages: StageRecord[]; // flat list across all iterations
  timeline: TimelineEvent[]; // ordered list of key events
}

/**
 * Entry recording a single iteration attempt
 */
export interface IterationEntry {
  iteration: number;
  timestamp: Date;
  approach: string; // What was tried (high-level summary)
  verdict: JudgeVerdict;
  gaps: string[]; // What's still wrong
  durationMs?: number; // wall-clock for the full iteration
  costUsd?: number; // sum of all stage costs in this iteration
  tokensUsed?: number; // sum of all stage tokens in this iteration
  stageRecords?: StageRecord[]; // per-stage breakdown for this iteration
}

/**
 * State shape for iteration history
 */
export interface IterationHistoryState {
  entries: IterationEntry[];
}

export interface WorkflowContext {
  id: string;
  input: string;
  inputType: InputType;
  mode: OrchestrationMode;

  // Git/Repository
  worktreePath?: string;
  repoPath?: string;
  branchName?: string;

  // Workflow state
  createdAt: Date;
  status: WorkflowStatus;
  currentStage?: string;
  currentStageObj?: PipelineStage; // Full stage object

  // Task metadata
  taskTitle?: string;
  taskDescription?: string;
  commitType?: string; // e.g., 'feat', 'fix', 'refactor'
  issueNumber?: string;
  /** Full GitHub issue URL for PR linking (enables cross-repo issue closing) */
  issueUrl?: string;
  /** Custom test plan for PR (can be set by agent during implementation) */
  testPlan?: string;

  // Execution
  backend?: string; // e.g., 'claude-code', 'cursor'
  pipelineName?: string; // Pipeline used for this workflow (for resume)
  /** @deprecated Use fidelityLevel instead. */
  executionFidelity?: ExecutionFidelityLevel;
  fidelityLevel?: ExecutionFidelityLevel;
  fidelityParams?: FidelityParameters;
  fidelityMetrics?: FidelityMetrics;

  // Iteration
  iterationCount?: number;
  maxIterations?: number;
  iterationHistory?: IterationHistoryState;

  // Stage results for resumability - maps stage name to its execution result
  stageResults?: Record<string, unknown>;

  // Stage timing for performance visibility
  /** @deprecated Use stageRecords for richer per-stage data */
  stageTiming?: StageTiming[];

  // Rich per-stage records for run reporting
  stageRecords?: StageRecord[];

  // Todos and quality
  todos?: Todo[];
  qualityMetrics?: QualityMetrics;

  // Metrics
  metrics: WorkflowMetrics;

  // External integrations
  cardUrl?: string; // GitHub Projects card URL
  prUrl?: string; // Pull request URL
  prNumber?: number; // Pull request number
  commitSha?: string; // Commit SHA from auto-commit

  // Failure diagnostics
  failureReason?: string;
}

export interface WorkflowMetrics {
  /** @deprecated Use totalTokens instead. */
  tokensUsed: number;
  totalTokens?: number;
  /** @deprecated Use totalRuntimeMs instead. */
  runtime: number;
  totalRuntimeMs?: number; // Runtime in milliseconds
  stagesCompleted: number;
  totalStages: number;
  errors: number;
  fidelityLevel?: ExecutionFidelityLevel;
  costEstimate?: number;
  /** @deprecated Use totalCost instead. */
  actualCost?: number;
  totalCost?: number;
}

export interface AgentConfig {
  role: AgentRole;
  name: string;
  description: string;
  tools: string[];
  systemPrompt?: string;
}

/**
 * Types inferred from Zod schemas - single source of truth
 */
export type PipelineStage = z.infer<typeof PipelineStageSchema>;
export type Pipeline = z.infer<typeof PipelineSchema>;
export type RawPipeline = z.infer<typeof RawPipelineSchema>;
export type RawPipelineConfig = z.infer<typeof RawPipelineConfigSchema>;
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;

export interface DashboardState {
  workflows: WorkflowContext[];
  lastUpdate: Date;
}
