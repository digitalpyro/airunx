/**
 * Costs command — single-run spend summary from the cost ledger.
 *
 * `airunx costs [--workflow-id <id>] [--json]` reads the run report from
 * `.airunx-state/reports/<id>.json` (default: the most recently modified
 * report) and the run's audit events, then prints billed and API-equivalent
 * totals, provenance mix, a per-stage table and the top cost drivers.
 */

import chalk from 'chalk';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { Command } from 'commander';
import { AuditLogger, getDefaultAuditDir } from '../../audit/audit-logger.js';
import type { AuditEvent } from '../../task-queue/types.js';
import type { RunReport } from '../../core/types.js';
import {
  summarizeRunCosts,
  type RunCostSummary,
} from '../../core/run-cost-summary.js';
import {
  RUN_REPORTS_DIR,
  assertValidWorkflowId,
  getRunReportPath,
  isValidWorkflowId,
} from '../../utils/workflow-id.js';
import { formatRunCosts } from '../formatters/costs-formatter.js';
import {
  formatReconcileReport,
  reconcileUsage,
  type ReconcileOptions,
  type ReconcileReport,
} from '../../integrations/usage-reconciler.js';

export interface CostsOptions {
  workflowId?: string;
  json?: boolean;
  /** Overrides for tests; default to the standard state locations */
  reportsDir?: string;
  auditDir?: string;
}

/** Workflow ID of the most recently modified report, or undefined */
export function findLatestRunId(
  reportsDir: string = RUN_REPORTS_DIR
): string | undefined {
  if (!existsSync(reportsDir)) return undefined;
  let latest: { id: string; mtimeMs: number } | undefined;
  for (const file of readdirSync(reportsDir)) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -'.json'.length);
    if (!isValidWorkflowId(id)) continue;
    try {
      const { mtimeMs } = statSync(join(reportsDir, file));
      if (!latest || mtimeMs > latest.mtimeMs) latest = { id, mtimeMs };
    } catch {
      // Vanished between readdir and stat
    }
  }
  return latest?.id;
}

/** Read a run report; null when absent or unparsable */
export function loadRunReport(
  workflowId: string,
  reportsDir: string = RUN_REPORTS_DIR
): RunReport | null {
  const path = getRunReportPath(workflowId, reportsDir);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as RunReport) : null;
  } catch {
    return null;
  }
}

/** A run's audit events (deduped by event_id) plus skipped-line count */
export async function loadRunEvents(
  workflowId: string,
  auditDir: string = getDefaultAuditDir()
): Promise<{ events: AuditEvent[]; skipped: number; available: boolean }> {
  // Check first: constructing an AuditLogger creates the directory
  if (!existsSync(auditDir))
    return { events: [], skipped: 0, available: false };
  const logger = new AuditLogger(auditDir);
  if (logger.listLogFiles().length === 0) {
    return { events: [], skipped: 0, available: false };
  }
  const { events, skipped } = await logger.queryWithStats({ workflowId });
  return { events, skipped, available: true };
}

/**
 * Resolve the run and build its summary. Throws on an invalid workflow ID
 * or when neither a report nor any ledger events exist.
 */
export async function buildRunCostSummary(
  options: CostsOptions
): Promise<RunCostSummary> {
  const reportsDir = options.reportsDir ?? RUN_REPORTS_DIR;
  let workflowId = options.workflowId;
  if (workflowId !== undefined) {
    assertValidWorkflowId(workflowId);
  } else {
    workflowId = findLatestRunId(reportsDir);
    if (!workflowId) {
      throw new Error(
        `No run reports found in ${reportsDir}; pass --workflow-id <id>`
      );
    }
  }

  const report = loadRunReport(workflowId, reportsDir);
  const { events, skipped, available } = await loadRunEvents(
    workflowId,
    options.auditDir
  );
  if (!report && events.length === 0) {
    throw new Error(`No run report or ledger events for ${workflowId}`);
  }
  return summarizeRunCosts({
    workflowId,
    report,
    events,
    skippedLines: skipped,
    auditAvailable: available,
  });
}

/** `airunx costs` action */
export async function costsCommand(options: CostsOptions): Promise<void> {
  let summary: RunCostSummary;
  try {
    summary = await buildRunCostSummary(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      console.log(JSON.stringify({ error: message }, null, 2));
    } else {
      console.error(chalk.red(`Error: ${message}`));
    }
    process.exit(1);
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatRunCosts(summary));
  }
  process.exit(0);
}

export interface ReconcileCommandOptions extends ReconcileOptions {
  json?: boolean;
}

/**
 * `airunx costs reconcile` action. Exits 0 whenever reconciliation ran —
 * missing admin keys, provider failures and drift are reported, not fatal.
 * Exits 1 only on invalid options.
 */
export async function reconcileCommand(
  options: ReconcileCommandOptions
): Promise<void> {
  const { json, ...reconcileOptions } = options;
  let report: ReconcileReport;
  try {
    report = await reconcileUsage(reconcileOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      console.log(JSON.stringify({ error: message }, null, 2));
    } else {
      console.error(chalk.red(`Error: ${message}`));
    }
    process.exit(1);
    return;
  }

  // Warnings are already redacted and never carry provider response bodies
  for (const warning of report.warnings) {
    console.error(chalk.yellow(`Warning: ${warning}`));
  }
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReconcileReport(report));
  }
  process.exit(0);
}

function parseDays(value: string): number {
  const n = Number(value);
  // Range is validated by the reconciler; NaN passes through to fail there
  return Number.isInteger(n) ? n : Number.NaN;
}

/**
 * Register `costs` and its subcommands. `costs show` is the default, so
 * `airunx costs --workflow-id <id>` works; further subcommands (e.g.
 * `reconcile`) attach to the returned command.
 */
export function registerCostsCommands(program: Command): Command {
  const costs = program
    .command('costs')
    .description('Summarize LLM spend from the cost ledger');

  costs
    .command('show', { isDefault: true })
    .description(
      'Single-run summary: totals, provenance, per-stage table, top drivers (default: latest run)'
    )
    .option(
      '--workflow-id <id>',
      'Run to summarize (default: most recent run report)'
    )
    .option('-j, --json', 'Output machine-readable JSON')
    .action((opts: { workflowId?: string; json?: boolean }) =>
      costsCommand({ workflowId: opts.workflowId, json: opts.json })
    );

  costs
    .command('reconcile')
    .description(
      'Compare billed (API-key) ledger spend per closed UTC day against provider cost reports (needs ANTHROPIC_ADMIN_KEY / OPENAI_ADMIN_KEY)'
    )
    .option(
      '--date <YYYY-MM-DD>',
      'Last UTC day to reconcile (default: yesterday)'
    )
    .option('--days <n>', 'Number of days ending at --date (1-31)', parseDays)
    .option(
      '--anthropic-workspace <id>',
      'Restrict Anthropic totals to this workspace (env AIRUNX_ANTHROPIC_WORKSPACE_ID)'
    )
    .option(
      '--openai-project <id>',
      'Restrict OpenAI totals to this project (env AIRUNX_OPENAI_PROJECT_ID)'
    )
    .option('-j, --json', 'Output machine-readable JSON')
    .action(
      (opts: {
        date?: string;
        days?: number;
        anthropicWorkspace?: string;
        openaiProject?: string;
        json?: boolean;
      }) => reconcileCommand(opts)
    );

  return costs;
}
