/**
 * Audit Logger
 * Append-only JSON Lines logger for heartbeat, pipeline and cost-ledger events.
 * Provides runtime audit trail for agent actions.
 *
 * Every record carries a versioned envelope (schema_version, event_id, run_id,
 * spawn correlation), is written with one synchronous append to a 0600 file
 * named for the current UTC day, has secrets redacted from `details`, and is
 * capped at MAX_AUDIT_RECORD_BYTES.
 */

import {
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from 'fs';
import { join } from 'path';
import { AUDIT_SCHEMA_VERSION, type AuditEvent } from '../task-queue/types.js';
import type {
  AttemptRecord,
  DelegationRecord,
  ExecutionRequest,
  SpawnObserver,
  SpawnRecord,
} from '../core/adapter-types.js';
import type { CostSummary } from '../core/types.js';
import { isSensitiveKey, redactSecrets } from '../utils/redaction.js';
import { ulid } from '../utils/ulid.js';

export type { AuditEvent };

/** Hard cap on one serialized record, including the trailing newline */
export const MAX_AUDIT_RECORD_BYTES = 4096;

/** Longest string value kept intact in details before truncation kicks in */
const MAX_DETAIL_STRING_CHARS = 256;

const TRUNCATION_SUFFIX = '…[truncated]';

/**
 * Query options for filtering audit events
 */
export interface AuditQueryOptions {
  workflowId?: string;
  eventTypes?: string[];
  /** Event types to leave out (applied before the limit) */
  excludeEventTypes?: readonly string[];
  since?: Date;
  limit?: number;
}

/**
 * Query result with integrity stats
 */
export interface AuditQueryResult {
  events: AuditEvent[];
  /** Lines skipped because they were torn or not valid audit records */
  skipped: number;
}

/**
 * Event fields a caller may set; timestamp and envelope IDs are filled in
 */
export type AuditEventInput = Omit<
  AuditEvent,
  'timestamp' | 'schema_version' | 'event_id'
> & { event_id?: string };

/**
 * Recursively redact sensitive keys and secret-shaped strings
 */
function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        isSensitiveKey(k) ? '[redacted]' : redactValue(v),
      ])
    );
  }
  return value;
}

/**
 * Shorten long strings anywhere in a value
 */
function shortenStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_DETAIL_STRING_CHARS
      ? value.slice(0, MAX_DETAIL_STRING_CHARS) + TRUNCATION_SUFFIX
      : value;
  }
  if (Array.isArray(value)) return value.map(shortenStrings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        shortenStrings(v),
      ])
    );
  }
  return value;
}

function serializedBytes(entry: AuditEvent): number {
  return Buffer.byteLength(JSON.stringify(entry) + '\n', 'utf8');
}

/**
 * Keep a record under MAX_AUDIT_RECORD_BYTES by truncating `details`.
 * Step 1 shortens long strings; step 2 replaces details with a bounded
 * preview. Truncated details carry `_truncated: true` and the original size.
 */
function capRecordSize(entry: AuditEvent): AuditEvent {
  if (serializedBytes(entry) <= MAX_AUDIT_RECORD_BYTES || !entry.details) {
    return entry;
  }

  const originalBytes = Buffer.byteLength(
    JSON.stringify(entry.details),
    'utf8'
  );
  const marker = { _truncated: true, _original_bytes: originalBytes };

  const shortened: AuditEvent = {
    ...entry,
    details: {
      ...(shortenStrings(entry.details) as Record<string, unknown>),
      ...marker,
    },
  };
  if (serializedBytes(shortened) <= MAX_AUDIT_RECORD_BYTES) {
    return shortened;
  }

  // Still too large (many keys / deep nesting): keep a preview of the JSON
  const fullJson = JSON.stringify(entry.details);
  let previewChars = Math.min(fullJson.length, MAX_AUDIT_RECORD_BYTES);
  while (previewChars > 0) {
    const candidate: AuditEvent = {
      ...entry,
      details: {
        ...marker,
        preview: fullJson.slice(0, previewChars) + TRUNCATION_SUFFIX,
      },
    };
    if (serializedBytes(candidate) <= MAX_AUDIT_RECORD_BYTES) {
      return candidate;
    }
    previewChars = Math.floor(previewChars * 0.75);
  }
  return { ...entry, details: marker };
}

/**
 * Convert USD to integer micro-USD (undefined stays undefined)
 */
export function toMicroUsd(usd: number | undefined): number | undefined {
  return usd === undefined || !Number.isFinite(usd)
    ? undefined
    : Math.round(usd * 1_000_000);
}

/**
 * Compact, numbers-only view of a CostSummary for decision events
 */
export function compactCostSummary(
  summary: CostSummary | undefined
): Record<string, unknown> | undefined {
  if (!summary) return undefined;
  return {
    provenance: summary.provenance ?? 'missing',
    billed_micro_usd: summary.billedMicroUsd,
    api_equivalent_micro_usd: summary.apiEquivalentMicroUsd,
    unknown_basis_micro_usd: summary.unknownBasisMicroUsd,
    spawn_count: summary.spawnCount,
    missing_cost_spawns: summary.missingCostSpawns,
  };
}

/**
 * Judge verdict facts for an `iteration_decision` event (R2)
 */
export interface IterationDecisionDetails {
  stage: string;
  /** Stage the judge evaluated (the re-run target on ITERATE) */
  evaluatesStage?: string;
  verdict: string;
  /** 1-indexed iteration that just completed */
  iteration: number;
  maxIterations: number;
  gapCount: number;
  /** The judge decided to run another iteration */
  willIterate: boolean;
  /** Cost of the completed iteration (all its stage records, judge included) */
  iterationCostUsd?: number;
  /** Projected cost of the re-run (ITERATE only) */
  projectedRerunCostUsd?: number;
  remainingIterations?: number;
  /** Run total so far */
  runCostUsd?: number;
  spawnId?: string;
}

export class AuditLogger {
  private logDir: string;
  /** Paths whose permissions were already tightened in this process */
  private securedPaths = new Set<string>();

  constructor(logDir: string = '.airunx-state/audit') {
    this.logDir = logDir;

    // Ensure directory exists (owner-only when we create it)
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * Log an audit event.
   * Events are appended as JSON Lines for efficient streaming and parsing:
   * one synchronous write per record on an append-mode descriptor, to the
   * file for the current UTC day.
   */
  log(event: AuditEventInput): void {
    const { event_id, details, ...rest } = event;
    const entry: AuditEvent = capRecordSize({
      timestamp: new Date().toISOString(),
      schema_version: AUDIT_SCHEMA_VERSION,
      event_id: event_id ?? ulid(),
      ...(rest.workflowId && !rest.run_id ? { run_id: rest.workflowId } : {}),
      ...rest,
      ...(details !== undefined
        ? { details: redactValue(details) as Record<string, unknown> }
        : {}),
    });

    this.appendLine(this.getLogPath(), JSON.stringify(entry) + '\n');
  }

  /**
   * Append one line with a single write(2) on an O_APPEND descriptor
   */
  private appendLine(path: string, line: string): void {
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
    }
    const buffer = Buffer.from(line, 'utf8');
    const fd = openSync(path, 'a', 0o600);
    try {
      if (!this.securedPaths.has(path)) {
        // Tighten files created before permissions were enforced
        try {
          fchmodSync(fd, 0o600);
        } catch {
          // Not our file / unsupported FS — keep writing
        }
        this.securedPaths.add(path);
      }
      const written = writeSync(fd, buffer, 0, buffer.length);
      if (written !== buffer.length) {
        throw new Error(
          `Short audit write to ${path}: ${written}/${buffer.length} bytes`
        );
      }
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Log one CLI spawn into the cost ledger (llm_spawn event)
   */
  logLlmSpawn(record: SpawnRecord): void {
    this.log({
      event: 'llm_spawn',
      workflowId: record.workflowId,
      spawn_id: record.spawnId,
      ...(record.parentSpawnId
        ? { parent_spawn_id: record.parentSpawnId }
        : {}),
      details: {
        backend: record.backend,
        model: record.model,
        auth_mode: record.authMode,
        agent_role: record.agentRole,
        stage: record.stage,
        iteration: record.iteration,
        prompt_bytes: record.promptBytes,
        prompt_sections: record.promptSections,
        tokens_used: record.tokensUsed,
        input_tokens: record.inputTokens,
        output_tokens: record.outputTokens,
        cost_usd: record.costUsd,
        cost_micro_usd: toMicroUsd(record.costUsd),
        started_at: record.startedAt,
        ended_at: record.endedAt,
        duration_ms: record.durationMs,
        exit_reason: record.exitReason,
        success: record.success,
        salvaged: record.salvaged,
        error_category: record.errorCategory,
        provider_session_id: record.providerSessionId,
        // U3: provenance, billing basis, normalized tokens
        cost_provenance: record.costProvenance ?? 'missing',
        billing_basis: record.billingBasis,
        derived_cost_micro_usd: toMicroUsd(record.derivedCostUsd),
        pricing_version: record.pricingVersion,
        unmodeled_modifiers: record.unmodeledModifiers,
        token_provenance: record.tokenProvenance,
        estimation_methods: record.estimationMethods,
        semconv_version: record.semconvVersion,
        ...(record.tokens
          ? {
              usage: {
                input_tokens: record.tokens.inputTokens,
                output_tokens: record.tokens.outputTokens,
                cache_read_input_tokens: record.tokens.cacheReadInputTokens,
                cache_write_input_tokens: record.tokens.cacheWriteInputTokens,
                cache_write_5m_input_tokens:
                  record.tokens.cacheWrite5mInputTokens,
                cache_write_1h_input_tokens:
                  record.tokens.cacheWrite1hInputTokens,
                reasoning_output_tokens: record.tokens.reasoningOutputTokens,
              },
            }
          : {}),
        provider_usage: record.providerUsage,
        cost_basis: record.costBasis,
        // U5: killed-spawn spend (estimated lost / salvaged partial)
        ...(record.spendLostUsd !== undefined
          ? { spend_lost_micro_usd: toMicroUsd(record.spendLostUsd) }
          : {}),
        ...(record.spendSalvagedUsd !== undefined
          ? { spend_salvaged_micro_usd: toMicroUsd(record.spendSalvagedUsd) }
          : {}),
      },
    });
  }

  /**
   * Log one execution attempt (retry / fallback / model-rejection retry)
   */
  logAttempt(record: AttemptRecord): void {
    this.log({
      event: 'attempt',
      workflowId: record.workflowId,
      ...(record.spawnId ? { spawn_id: record.spawnId } : {}),
      ...(record.parentSpawnId
        ? { parent_spawn_id: record.parentSpawnId }
        : {}),
      details: {
        stage: record.stage,
        iteration: record.iteration,
        attempt: record.attempt,
        backend_attempt: record.backendAttempt,
        max_attempts: record.maxAttempts,
        backend: record.backend,
        agent_role: record.agentRole,
        outcome: record.outcome,
        error_category: record.errorCategory,
        fallback: record.fallback,
        fallback_to: record.fallbackTo,
        salvaged: record.outcome === 'failure',
        cost_usd: record.costUsd,
        cost_micro_usd: toMicroUsd(record.costUsd),
        cost_summary: compactCostSummary(record.costSummary),
      },
    });
  }

  /**
   * Log a judge verdict and its spend projection (iteration_decision)
   */
  logIterationDecision(
    workflowId: string,
    decision: IterationDecisionDetails
  ): void {
    this.log({
      event: 'iteration_decision',
      workflowId,
      ...(decision.spawnId ? { spawn_id: decision.spawnId } : {}),
      details: {
        stage: decision.stage,
        evaluates_stage: decision.evaluatesStage,
        verdict: decision.verdict,
        iteration: decision.iteration,
        max_iterations: decision.maxIterations,
        gap_count: decision.gapCount,
        will_iterate: decision.willIterate,
        iteration_cost_usd: decision.iterationCostUsd,
        iteration_cost_micro_usd: toMicroUsd(decision.iterationCostUsd),
        projected_rerun_cost_usd: decision.projectedRerunCostUsd,
        projected_rerun_cost_micro_usd: toMicroUsd(
          decision.projectedRerunCostUsd
        ),
        remaining_iterations: decision.remainingIterations,
        run_cost_micro_usd: toMicroUsd(decision.runCostUsd),
      },
    });
  }

  /**
   * Log a CE delegation decision or completion (delegation)
   */
  logDelegation(record: DelegationRecord): void {
    this.log({
      event: 'delegation',
      workflowId: record.workflowId,
      ...(record.spawnId ? { spawn_id: record.spawnId } : {}),
      ...(record.parentSpawnId
        ? { parent_spawn_id: record.parentSpawnId }
        : {}),
      details: {
        phase: record.phase,
        stage: record.stage,
        iteration: record.iteration,
        trigger_reason: record.triggerReason,
        keyword: record.keyword,
        keyword_source: record.keywordSource,
        task_length: record.taskLength,
        length_threshold: record.lengthThreshold,
        sub_agent_count: record.subAgentCount,
        sub_agents: record.subAgents,
        succeeded_count: record.succeededCount,
        marginal_cost_usd: record.marginalCostUsd,
        marginal_cost_micro_usd: record.marginalCostMicroUsd,
        marginal_cost_summary: compactCostSummary(record.marginalCostSummary),
      },
    });
  }

  /**
   * Log a heartbeat start event
   */
  logHeartbeatStart(details: Record<string, unknown> = {}): void {
    this.log({ event: 'heartbeat_start', details });
  }

  /**
   * Log a heartbeat stop event
   */
  logHeartbeatStop(details: Record<string, unknown> = {}): void {
    this.log({ event: 'heartbeat_stop', details });
  }

  /**
   * Log a heartbeat error event
   */
  logHeartbeatError(error: Error, details: Record<string, unknown> = {}): void {
    this.log({
      event: 'heartbeat_error',
      details: {
        ...details,
        error: error.message,
        stack: error.stack,
      },
    });
  }

  /**
   * Log a task claimed event
   */
  logTaskClaimed(workflowId: string, taskId: string, title: string): void {
    this.log({
      event: 'task_claimed',
      workflowId,
      details: { taskId, title },
    });
  }

  /**
   * Log a task completed event
   */
  logTaskCompleted(
    workflowId: string,
    taskId: string,
    prUrl?: string,
    cost?: TaskCostDetails
  ): void {
    this.log({
      event: 'task_completed',
      workflowId,
      details: { taskId, prUrl, ...taskCostFields(cost) },
    });
  }

  /**
   * Log when a task completed pipeline execution but produced no PR or deliverables.
   * Distinct from task_failed (pipeline threw) and task_completed (PR created).
   */
  logTaskCompletedNoPR(
    workflowId: string,
    taskId: string,
    cost?: TaskCostDetails
  ): void {
    this.log({
      event: 'task_completed_no_pr',
      workflowId,
      details: { taskId, ...taskCostFields(cost) },
    });
  }

  /**
   * Log a task failed event
   */
  logTaskFailed(
    workflowId: string,
    taskId: string,
    error: string,
    cost?: TaskCostDetails
  ): void {
    this.log({
      event: 'task_failed',
      workflowId,
      details: { taskId, error, ...taskCostFields(cost) },
    });
  }

  /**
   * Log a task released event
   */
  logTaskReleased(workflowId: string, taskId: string, reason: string): void {
    this.log({
      event: 'task_released',
      workflowId,
      details: { taskId, reason },
    });
  }

  /**
   * Log a pipeline stage start
   */
  logStageStart(workflowId: string, stageName: string): void {
    this.log({
      event: 'stage_start',
      workflowId,
      details: { stageName },
    });
  }

  /**
   * Log a pipeline stage completion with optional per-stage metrics
   */
  logStageComplete(
    workflowId: string,
    stageName: string,
    durationMs: number,
    metrics?: {
      tokensUsed?: number;
      costUsd?: number;
      agent?: string;
      spawnCount?: number;
    }
  ): void {
    this.log({
      event: 'stage_complete',
      workflowId,
      details: { stageName, durationMs, ...metrics },
    });
  }

  /**
   * Log a stage handoff event with observability metrics
   */
  logStageHandoff(
    workflowId: string,
    details: {
      fromStage: string;
      toStage: string;
      outputSizeBytes: number;
      handoffContextSizeBytes: number;
      cumulativeCost: number;
      cumulativeTokens: number;
      budgetRemainingPercent: number;
    }
  ): void {
    this.log({
      event: 'stage_handoff',
      workflowId,
      details,
    });
  }

  /**
   * Log a pipeline stage error
   */
  logStageError(workflowId: string, stageName: string, error: string): void {
    this.log({
      event: 'stage_error',
      workflowId,
      details: { stageName, error },
    });
  }

  /**
   * Log an agent completion signal
   */
  logAgentCompletionSignal(
    workflowId: string,
    summary: string,
    deliverables: string[]
  ): void {
    this.log({
      event: 'agent_completion_signal',
      workflowId,
      details: { summary, deliverables },
    });
  }

  /**
   * Log a circuit breaker open event
   */
  logCircuitOpen(backend: string): void {
    this.log({
      event: 'circuit_open',
      details: { backend },
    });
  }

  /**
   * Get the path to the log file for the current UTC day
   */
  getLogPath(): string {
    const date = new Date().toISOString().slice(0, 10);
    return join(this.logDir, `audit-${date}.jsonl`);
  }

  /**
   * Read recent audit events (for debugging/status)
   * @param limit Maximum number of events to return
   */
  readRecentEvents(limit: number = 100): AuditEvent[] {
    const logPath = this.getLogPath();
    if (!existsSync(logPath)) {
      return [];
    }

    const content = readFileSync(logPath, 'utf-8');
    const events = content
      .split('\n')
      .filter(Boolean)
      .map(parseAuditLine)
      .filter((event): event is AuditEvent => event !== null);

    // Get last N events
    return events.slice(-limit);
  }

  /**
   * List all audit log files
   */
  listLogFiles(): string[] {
    if (!existsSync(this.logDir)) {
      return [];
    }

    return readdirSync(this.logDir)
      .filter((file) => file.startsWith('audit-') && file.endsWith('.jsonl'))
      .sort()
      .reverse(); // Most recent first
  }

  /**
   * Query audit events with filtering options.
   * Used by query_audit agent tool for learning from history.
   * Searches across all log files (newest first) to handle queries spanning multiple days.
   */
  async query(options: AuditQueryOptions): Promise<AuditEvent[]> {
    return (await this.queryWithStats(options)).events;
  }

  /**
   * Query audit events and report how many lines were skipped as torn or
   * malformed. Events with a repeated event_id are returned once.
   */
  async queryWithStats(options: AuditQueryOptions): Promise<AuditQueryResult> {
    const results: AuditEvent[] = [];
    const seenEventIds = new Set<string>();
    let skipped = 0;
    const logFiles = this.listLogFiles(); // Already sorted newest to oldest

    fileLoop: for (const logFile of logFiles) {
      const logPath = join(this.logDir, logFile);
      if (!existsSync(logPath)) {
        continue;
      }

      const content = readFileSync(logPath, 'utf-8');
      // Process lines in reverse order (newest first within each file)
      const lines = content.split('\n').filter(Boolean).reverse();

      for (const line of lines) {
        // Check limit first
        if (options.limit && results.length >= options.limit) {
          break fileLoop;
        }

        const event = parseAuditLine(line);
        if (!event) {
          skipped++;
          continue;
        }

        // Filter by workflowId if specified
        if (options.workflowId && event.workflowId !== options.workflowId) {
          continue;
        }

        // Filter by since timestamp - if we've gone past the cutoff, stop searching
        if (options.since && new Date(event.timestamp) < options.since) {
          break fileLoop;
        }

        // Filter by eventTypes if specified
        if (
          options.eventTypes?.length &&
          !options.eventTypes.includes(event.event)
        ) {
          continue;
        }

        if (options.excludeEventTypes?.includes(event.event)) {
          continue;
        }

        // Dedupe by event_id (legacy events without one are kept)
        if (event.event_id) {
          if (seenEventIds.has(event.event_id)) continue;
          seenEventIds.add(event.event_id);
        }

        results.push(event);
      }
    }

    return { events: results, skipped };
  }
}

/**
 * Parse one JSONL line; null for torn, malformed or non-event lines
 */
function parseAuditLine(line: string): AuditEvent | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as AuditEvent).event === 'string' &&
      typeof (parsed as AuditEvent).timestamp === 'string'
    ) {
      return parsed as AuditEvent;
    }
  } catch {
    // Torn or malformed line
  }
  return null;
}

/** Run cost carried on heartbeat task_* events */
export interface TaskCostDetails {
  costUsd?: number;
  /** Provenance/billing label from the run report */
  costSummaryLine?: string;
}

function taskCostFields(cost?: TaskCostDetails): Record<string, unknown> {
  if (!cost) return {};
  return {
    ...(cost.costUsd !== undefined
      ? { cost_usd: cost.costUsd, cost_micro_usd: toMicroUsd(cost.costUsd) }
      : {}),
    ...(cost.costSummaryLine
      ? { cost_summary_line: cost.costSummaryLine }
      : {}),
  };
}

/**
 * SpawnObserver that writes each spawn to the audit ledger as `llm_spawn`,
 * and attempt/delegation decision events as `attempt` / `delegation`.
 * Routing is purely on the request's spawnContext (carried in the record),
 * so one observer serves every runner sharing an adapter factory.
 * Write failures are swallowed — the ledger must never break a run.
 */
export function createAuditSpawnObserver(
  auditLogger: AuditLogger,
  onError?: (error: unknown) => void
): SpawnObserver {
  return {
    onSpawnComplete(record: SpawnRecord, _request: ExecutionRequest): void {
      try {
        auditLogger.logLlmSpawn(record);
      } catch (error) {
        onError?.(error);
      }
    },
    onAttempt(record: AttemptRecord, _request: ExecutionRequest): void {
      try {
        auditLogger.logAttempt(record);
      } catch (error) {
        onError?.(error);
      }
    },
    onDelegation(record: DelegationRecord, _request: ExecutionRequest): void {
      try {
        auditLogger.logDelegation(record);
      } catch (error) {
        onError?.(error);
      }
    },
  };
}

/**
 * Default audit log directory
 */
export function getDefaultAuditDir(): string {
  return '.airunx-state/audit';
}
