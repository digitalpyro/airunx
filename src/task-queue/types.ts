/**
 * Task Queue Types
 * All type definitions for the heartbeat execution and agent-native tools.
 */

import type { StateManager } from '../orchestrator/state-manager.js';
import type { AuditLogger } from '../audit/audit-logger.js';
import type {
  PipelineConfig,
  ExecutionFidelityLevel,
  RunReport,
} from '../core/types.js';
import type { Priority } from './constants.js';

// ============================================================
// Core Task Types
// ============================================================

export interface GitHubTask {
  id: string; // Issue number as string
  issueUrl: string;
  title: string;
  body: string;
  labels: string[];
  suggestedPipeline?: string; // From issue body or labels
  assignee?: string; // For atomic checkout
  createdAt: Date;
  priority: Priority; // p1 (critical), p2 (normal), p3 (low)
  depth?: number; // For subtask tracking (max 3)
}

export interface TaskResult {
  status: 'completed' | 'failed';
  prUrl?: string;
  summary?: string;
  deliverables?: string[];
  error?: Error;
  metrics?: {
    costUsd?: number;
    tokensUsed?: number;
    durationMs?: number;
    iterations?: number;
    /** Provenance/billing-labeled spend, e.g. "… — 60% reported/derived, 40% estimated" */
    costSummaryLine?: string;
  };
  /** Structured run report for rich completion comments */
  runReport?: RunReport;
}

// ============================================================
// Task Queue Interface
// ============================================================

export interface TaskQueue {
  pollTasks(): Promise<GitHubTask[]>;
  checkoutTask(taskId: string): Promise<boolean>;
  completeTask(taskId: string, result: TaskResult): Promise<void>;
  failTask(taskId: string, result: TaskResult): Promise<void>;
  releaseTask(taskId: string): Promise<void>;
}

// ============================================================
// Agent Context (passed to all agent tools)
// ============================================================

/**
 * GitHub operations interface for agent tools.
 * Subset of GitHubCLI methods exposed to agents.
 */
export interface AgentGitHubOperations {
  createIssue(options: {
    title: string;
    body: string;
    labels?: string[];
  }): Promise<{ number: number; html_url: string }>;
}

export interface AgentContext {
  taskQueue: TaskQueue;
  auditLogger: AuditLogger;
  stateManager: StateManager;
  pipelineConfig: PipelineConfig;
  currentTask?: GitHubTask;
  workflowId: string;
  github: AgentGitHubOperations; // V2: For create_task tool
  repo: string; // V2: Current repository (owner/repo)
}

// ============================================================
// Audit Types
// ============================================================

export type AuditEventType =
  | 'heartbeat_start'
  | 'heartbeat_stop'
  | 'heartbeat_error'
  | 'task_claimed'
  | 'task_completed'
  | 'task_completed_no_pr' // Pipeline completed but no PR/deliverables produced
  | 'task_failed'
  | 'task_released'
  | 'task_created' // V2: Agent-created subtasks
  | 'stage_start'
  | 'stage_complete'
  | 'stage_handoff'
  | 'stage_error'
  | 'agent_completion_signal'
  | 'circuit_open'
  // Cost ledger events (envelope v1)
  | 'llm_spawn' // One per CLI spawn
  | 'attempt' // Retry / provider-fallback attempt
  | 'iteration_decision' // Judge verdict with iteration cost
  | 'delegation'; // CE sub-agent delegation decision

/**
 * Cost-ledger event types. Excluded from the query_audit agent tool by default.
 */
export const LEDGER_EVENT_TYPES = [
  'llm_spawn',
  'attempt',
  'iteration_decision',
  'delegation',
] as const satisfies readonly AuditEventType[];

/** Current audit envelope schema version */
export const AUDIT_SCHEMA_VERSION = 1;

export interface AuditEvent {
  timestamp: string;
  workflowId?: string;
  event: AuditEventType;
  details?: Record<string, unknown>;
  // Envelope (R13) — present on every event written since schema v1
  schema_version?: number;
  /** Unique, time-sortable event ID (ULID) */
  event_id?: string;
  /** Run correlation ID (the workflow ID) */
  run_id?: string;
  spawn_id?: string;
  parent_spawn_id?: string;
}

// ============================================================
// Heartbeat Types
// ============================================================

export interface HeartbeatConfig {
  intervalMs: number; // Default: 10000 (10 seconds)
  maxIdleCycles: number; // Pause after N empty polls (default: 6)
  idlePauseMs: number; // Sleep duration when idle (default: 60000)
  defaultPipeline: string; // Fallback pipeline (default: 'standard')
  repo: string; // GitHub repo (owner/repo format)
  fidelityLevel?: ExecutionFidelityLevel; // Execution quality level (undefined = use pipeline/system defaults)
}

export interface HeartbeatState {
  isRunning: boolean;
  currentTaskId?: string;
  idleCycles: number;
  lastPollTime?: string;
}

// ============================================================
// Process Lock Types
// ============================================================

export interface LockResult {
  success: boolean;
  reason?: string;
}

export interface FileSystem {
  exists(path: string): boolean;
  read(path: string): string;
  write(path: string, content: string): void;
  delete(path: string): void;
}

// ============================================================
// Agent Tool Types
// ============================================================

export interface CompleteTaskParams {
  summary: string;
  deliverables: string[];
  testsPassing?: boolean;
}

export type CompleteTaskResult =
  | { status: 'accepted' }
  | { status: 'logged'; note: string };

export interface PipelineInfo {
  name: string;
  description: string;
  stages: string[];
  whenToUse?: string;
}

// ============================================================
// Heartbeat Runner Types
// ============================================================

export type CycleAction = 'wait' | 'idle_pause' | 'backoff';

export interface CycleResult {
  action: CycleAction;
}
