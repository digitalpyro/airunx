/**
 * Audit Logger
 * Simple append-only JSON Lines logger for heartbeat events.
 * Provides runtime audit trail for agent actions.
 */

import {
  appendFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
} from 'fs';
import { dirname, join } from 'path';
import type { AuditEvent } from '../task-queue/types.js';

export type { AuditEvent };

/**
 * Query options for filtering audit events
 */
export interface AuditQueryOptions {
  workflowId?: string;
  eventTypes?: string[];
  since?: Date;
  limit?: number;
}

export class AuditLogger {
  private logDir: string;
  private logPath: string;

  constructor(logDir: string = '.airunx-state/audit') {
    this.logDir = logDir;
    const date = new Date().toISOString().slice(0, 10);
    this.logPath = join(logDir, `audit-${date}.jsonl`);

    // Ensure directory exists
    if (!existsSync(dirname(this.logPath))) {
      mkdirSync(dirname(this.logPath), { recursive: true });
    }
  }

  /**
   * Log an audit event.
   * Events are appended as JSON Lines for efficient streaming and parsing.
   */
  log(event: Omit<AuditEvent, 'timestamp'>): void {
    const entry: AuditEvent = {
      timestamp: new Date().toISOString(),
      ...event,
    };

    appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
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
  logTaskCompleted(workflowId: string, taskId: string, prUrl?: string): void {
    this.log({
      event: 'task_completed',
      workflowId,
      details: { taskId, prUrl },
    });
  }

  /**
   * Log when a task completed pipeline execution but produced no PR or deliverables.
   * Distinct from task_failed (pipeline threw) and task_completed (PR created).
   */
  logTaskCompletedNoPR(workflowId: string, taskId: string): void {
    this.log({
      event: 'task_completed_no_pr',
      workflowId,
      details: { taskId },
    });
  }

  /**
   * Log a task failed event
   */
  logTaskFailed(workflowId: string, taskId: string, error: string): void {
    this.log({
      event: 'task_failed',
      workflowId,
      details: { taskId, error },
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
   * Get the path to the current log file
   */
  getLogPath(): string {
    return this.logPath;
  }

  /**
   * Read recent audit events (for debugging/status)
   * @param limit Maximum number of events to return
   */
  readRecentEvents(limit: number = 100): AuditEvent[] {
    if (!existsSync(this.logPath)) {
      return [];
    }

    const content = readFileSync(this.logPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    // Get last N lines
    const recentLines = lines.slice(-limit);

    return recentLines.map((line) => JSON.parse(line) as AuditEvent);
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
    const results: AuditEvent[] = [];
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

        try {
          const event = JSON.parse(line) as AuditEvent;

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

          results.push(event);
        } catch {
          // Skip malformed lines
        }
      }
    }

    return results;
  }
}

/**
 * Default audit log directory
 */
export function getDefaultAuditDir(): string {
  return '.airunx-state/audit';
}
