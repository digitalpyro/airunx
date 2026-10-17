/**
 * Run cost summary: folds one run's ledger (`llm_spawn` / `attempt` /
 * `delegation` audit events) and its RunReport into the numbers the
 * `airunx costs` command shows.
 *
 * Double-count rule: spend is summed from spawn events only, never spawn
 * events + stage records. The one exception is a killed/incomplete run (or
 * a run with no ledger at all): a stage with no spawn events contributes its
 * report aggregate, labeled `report-only`. All money is integer micro-USD.
 */

import type { AuditEvent } from '../task-queue/types.js';
import type {
  BillingBasis,
  CostProvenance,
  CostSummary,
  NormalizedTokenUsage,
  RunReport,
  StageRecord,
} from './types.js';
import {
  billingBasisForAuth,
  emptyCostSummary,
  formatCostSummaryLine,
  mergeCostSummaries,
  microUsdToUsd,
  provenanceMix,
  spawnCostSummary,
  usdToMicroUsd,
  type ProvenanceMix,
} from './cost-accounting.js';

/** Bumped when the JSON shape of RunCostSummary changes incompatibly */
export const RUN_COST_SUMMARY_VERSION = 1;

/** Where a row's figures came from */
export type CostSource = 'ledger' | 'report-only';

/** Cost driver categories (views over the ledger; they may overlap) */
export type CostDriverKind =
  | 'delegation'
  | 'iteration_reruns'
  | 'retry_waste'
  | 'killed_spawn_losses';

export interface CostTotals {
  /** billed + API-equivalent + unknown basis */
  totalMicroUsd: number;
  billedMicroUsd: number;
  apiEquivalentMicroUsd: number;
  unknownBasisMicroUsd: number;
  reportedMicroUsd: number;
  derivedMicroUsd: number;
  estimatedMicroUsd: number;
  spawnCount: number;
  missingCostSpawns: number;
  estimatedSpawns: number;
  /** Weakest provenance across priced spend */
  provenance: CostProvenance | null;
  provenanceMix: ProvenanceMix;
}

export interface StageCostRow extends CostTotals {
  stage: string;
  source: CostSource;
  /** Run-report status of the stage's last record, when known */
  status: string | null;
}

export interface CostDriver {
  kind: CostDriverKind;
  label: string;
  microUsd: number;
  /** Spawns / attempts / sub-agents behind the figure */
  count: number;
}

export interface RunCostSummary {
  version: number;
  workflowId: string;
  /** Run status from the report (null when no report was found) */
  status: string | null;
  /** `ledger`: all rows from spawn events; `mixed`: some report-only */
  source: CostSource | 'mixed';
  totals: CostTotals;
  summaryLine: string;
  stages: StageCostRow[];
  /** Ranked by cost, highest first; zero-cost drivers omitted */
  drivers: CostDriver[];
  /** Distinct llm_spawn events counted (after event_id dedupe) */
  ledgerSpawnEvents: number;
  /** Torn/malformed audit lines skipped while reading */
  skippedLines: number;
  notices: string[];
}

export interface RunCostInput {
  workflowId: string;
  report?: RunReport | null;
  /** Audit events for this run (any type; non-cost events are ignored) */
  events: readonly AuditEvent[];
  skippedLines?: number;
  /** False when no audit log files exist at all */
  auditAvailable?: boolean;
}

const UNKNOWN_STAGE = '(unknown)';

const COMPLETED_STATUSES = new Set(['completed']);

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function microFrom(
  details: Record<string, unknown>,
  microKey: string,
  usdKey?: string
): number | undefined {
  const micro = num(details[microKey]);
  if (micro !== undefined) return Math.round(micro);
  const usd = usdKey ? num(details[usdKey]) : undefined;
  return usd === undefined ? undefined : usdToMicroUsd(usd);
}

const PROVENANCES: readonly string[] = ['reported', 'derived', 'estimated'];
const BASES: readonly string[] = ['billed', 'api_equivalent', 'unknown'];

function eventTokens(
  details: Record<string, unknown>
): NormalizedTokenUsage | undefined {
  const usage = details.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const tokens: NormalizedTokenUsage = {
    inputTokens: num(u.input_tokens) ?? 0,
    outputTokens: num(u.output_tokens) ?? 0,
    cacheReadInputTokens: num(u.cache_read_input_tokens) ?? 0,
    cacheWriteInputTokens: num(u.cache_write_input_tokens) ?? 0,
  };
  const w5 = num(u.cache_write_5m_input_tokens);
  const w1 = num(u.cache_write_1h_input_tokens);
  const r = num(u.reasoning_output_tokens);
  if (w5 !== undefined) tokens.cacheWrite5mInputTokens = w5;
  if (w1 !== undefined) tokens.cacheWrite1hInputTokens = w1;
  if (r !== undefined) tokens.reasoningOutputTokens = r;
  return tokens;
}

/** One `llm_spawn` event as a one-spawn CostSummary */
export function spawnEventCostSummary(event: AuditEvent): CostSummary {
  const d = event.details ?? {};
  const micro = microFrom(d, 'cost_micro_usd', 'cost_usd');
  const rawProvenance = str(d.cost_provenance);
  const provenance =
    rawProvenance && PROVENANCES.includes(rawProvenance)
      ? (rawProvenance as CostProvenance)
      : undefined;
  const rawBasis = str(d.billing_basis);
  const authMode = str(d.auth_mode);
  const billingBasis: BillingBasis =
    rawBasis && BASES.includes(rawBasis)
      ? (rawBasis as BillingBasis)
      : billingBasisForAuth(
          authMode === 'api_key' || authMode === 'subscription'
            ? authMode
            : undefined
        );
  const tokens = eventTokens(d);
  const tokenProvenance = str(d.token_provenance);
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return spawnCostSummary({
    // Missing provenance = unknown cost, never $0
    costUsd:
      micro !== undefined && provenance !== undefined
        ? microUsdToUsd(micro)
        : undefined,
    costProvenance: provenance,
    billingBasis,
    tokens,
    tokenProvenance:
      tokenProvenance === 'reported' || tokenProvenance === 'estimated'
        ? tokenProvenance
        : undefined,
    pricingVersion: str(d.pricing_version),
    estimationMethods: strings(d.estimation_methods),
    unmodeledModifiers: strings(d.unmodeled_modifiers),
  });
}

/** A stage record's aggregate (legacy records without one: unknown basis, estimated) */
function stageRecordCostSummary(record: StageRecord): CostSummary {
  if (record.costSummary) return record.costSummary;
  const summary = spawnCostSummary({
    costUsd: record.costUsd,
    costProvenance: 'estimated',
    billingBasis: 'unknown',
  });
  summary.spawnCount = record.spawnCount;
  summary.estimatedSpawns = record.spawnCount;
  return summary;
}

function priced(summary: CostSummary): number {
  return (
    summary.billedMicroUsd +
    summary.apiEquivalentMicroUsd +
    summary.unknownBasisMicroUsd
  );
}

/** Totals view of a CostSummary */
export function costTotals(summary: CostSummary | undefined): CostTotals {
  const s = summary ?? emptyCostSummary();
  return {
    totalMicroUsd: priced(s),
    billedMicroUsd: s.billedMicroUsd,
    apiEquivalentMicroUsd: s.apiEquivalentMicroUsd,
    unknownBasisMicroUsd: s.unknownBasisMicroUsd,
    reportedMicroUsd: s.reportedMicroUsd,
    derivedMicroUsd: s.derivedMicroUsd,
    estimatedMicroUsd: s.estimatedMicroUsd,
    spawnCount: s.spawnCount,
    missingCostSpawns: s.missingCostSpawns,
    estimatedSpawns: s.estimatedSpawns,
    provenance: s.provenance ?? null,
    provenanceMix: provenanceMix(s),
  };
}

/** Sum of priced spend of the matching spawn events */
function sumSpawns(
  spawns: readonly AuditEvent[],
  match: (e: AuditEvent) => boolean
): { microUsd: number; count: number } {
  let microUsd = 0;
  let count = 0;
  for (const e of spawns) {
    if (!match(e)) continue;
    microUsd += priced(spawnEventCostSummary(e));
    count++;
  }
  return { microUsd, count };
}

function computeDrivers(
  spawns: readonly AuditEvent[],
  events: readonly AuditEvent[],
  reportOnlyKilled: { microUsd: number; count: number }
): CostDriver[] {
  const drivers: CostDriver[] = [];

  // Delegation: sub-agent spawns (parented); completion events as fallback
  const subAgents = sumSpawns(spawns, (e) => Boolean(e.parent_spawn_id));
  if (subAgents.count > 0) {
    drivers.push({
      kind: 'delegation',
      label: 'Delegation sub-agent spend',
      ...subAgents,
    });
  } else {
    let microUsd = 0;
    let count = 0;
    for (const e of events) {
      if (e.event !== 'delegation') continue;
      const d = e.details ?? {};
      if (d.phase !== 'completion') continue;
      microUsd +=
        microFrom(d, 'marginal_cost_micro_usd', 'marginal_cost_usd') ?? 0;
      count += num(d.sub_agent_count) ?? 0;
    }
    drivers.push({
      kind: 'delegation',
      label: 'Delegation sub-agent spend',
      microUsd,
      count,
    });
  }

  drivers.push({
    kind: 'iteration_reruns',
    label: 'Iteration re-runs (iteration > 1)',
    ...sumSpawns(spawns, (e) => (num(e.details?.iteration) ?? 1) > 1),
  });

  // Retry waste: spend of the spawns behind failed attempts. Summed from
  // each failed spawn's own llm_spawn event (once per spawn_id), never from
  // attempt cost fields: an attempt's cost can fold in earlier spawns (e.g.
  // a Codex model-rejected spawn folded into its retry), which would double
  // count. Attempts without a spawn_id (legacy) fall back to their own cost.
  const failedSpawnIds = new Set<string>();
  let retryMicro = 0;
  let retryCount = 0;
  for (const e of events) {
    if (e.event !== 'attempt') continue;
    const d = e.details ?? {};
    if (d.outcome !== 'failure') continue;
    // A spawn interrupted by run shutdown is never retried: its spend is a
    // killed-spawn loss, not retry waste
    if (d.error_category === 'SpawnInterruptedError') continue;
    if (e.spawn_id) {
      failedSpawnIds.add(e.spawn_id);
      continue;
    }
    retryMicro += microFrom(d, 'cost_micro_usd', 'cost_usd') ?? 0;
    retryCount++;
  }
  const countedSpawnIds = new Set<string>();
  const failedSpawns = sumSpawns(spawns, (e) => {
    if (!e.spawn_id || !failedSpawnIds.has(e.spawn_id)) return false;
    if (countedSpawnIds.has(e.spawn_id)) return false;
    countedSpawnIds.add(e.spawn_id);
    return true;
  });
  retryMicro += failedSpawns.microUsd;
  retryCount += failedSpawns.count;
  drivers.push({
    kind: 'retry_waste',
    label: 'Retry waste (failed attempts)',
    microUsd: retryMicro,
    count: retryCount,
  });

  // Killed-spawn losses: kill-time estimates, signal-killed spawns whose CLI
  // still reported its spend, and report-only killed stages
  let lostMicro = reportOnlyKilled.microUsd;
  let lostCount = reportOnlyKilled.count;
  for (const e of spawns) {
    const d = e.details ?? {};
    const lost =
      microFrom(d, 'spend_lost_micro_usd') ??
      (d.exit_reason === 'signal'
        ? microFrom(d, 'cost_micro_usd', 'cost_usd')
        : undefined);
    if (lost === undefined) continue;
    lostMicro += lost;
    lostCount++;
  }
  drivers.push({
    kind: 'killed_spawn_losses',
    label: 'Killed-spawn losses',
    microUsd: lostMicro,
    count: lostCount,
  });

  return drivers
    .filter((d) => d.microUsd > 0)
    .sort((a, b) => b.microUsd - a.microUsd || a.kind.localeCompare(b.kind));
}

/**
 * Summarize one run's spend from its ledger events and run report.
 * Pure: no I/O.
 */
export function summarizeRunCosts(input: RunCostInput): RunCostSummary {
  const { workflowId, report } = input;
  const notices: string[] = [];
  const skippedLines = input.skippedLines ?? 0;
  if (skippedLines > 0) {
    notices.push(
      `skipped ${skippedLines} malformed line${skippedLines === 1 ? '' : 's'} in the audit log`
    );
  }

  // Defensive dedupe (AuditLogger.query already dedupes by event_id)
  const seen = new Set<string>();
  const events = input.events.filter((e) => {
    if (e.workflowId !== undefined && e.workflowId !== workflowId) return false;
    if (!e.event_id) return true;
    if (seen.has(e.event_id)) return false;
    seen.add(e.event_id);
    return true;
  });
  const spawns = events
    .filter((e) => e.event === 'llm_spawn')
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (input.auditAvailable === false) {
    notices.push('no audit log files found; showing report-only view');
  } else if (spawns.length === 0) {
    notices.push(
      'no llm_spawn ledger events for this run; showing report-only view'
    );
  }
  if (!report) {
    notices.push('no run report found; showing ledger events only');
  }

  // Ledger rows, grouped by stage
  const ledgerByStage = new Map<string, CostSummary>();
  for (const e of spawns) {
    const stage = str(e.details?.stage) ?? UNKNOWN_STAGE;
    ledgerByStage.set(
      stage,
      mergeCostSummaries(ledgerByStage.get(stage), spawnEventCostSummary(e))!
    );
  }

  // Report stage records, grouped by stage (flat across iterations)
  const reportByStage = new Map<string, StageRecord[]>();
  for (const record of report?.stages ?? []) {
    const list = reportByStage.get(record.stage) ?? [];
    list.push(record);
    reportByStage.set(record.stage, list);
  }

  const runIncomplete =
    !report || !COMPLETED_STATUSES.has(report.status) || spawns.length === 0;

  const stageOrder = [
    ...reportByStage.keys(),
    ...[...ledgerByStage.keys()].filter((s) => !reportByStage.has(s)),
  ];

  const rows: StageCostRow[] = [];
  const included: CostSummary[] = [];
  const reportOnlyKilled = { microUsd: 0, count: 0 };
  const excluded: string[] = [];

  for (const stage of stageOrder) {
    const records = reportByStage.get(stage) ?? [];
    const status = records.length ? records[records.length - 1].status : null;
    const ledger = ledgerByStage.get(stage);
    if (ledger) {
      rows.push({ stage, source: 'ledger', status, ...costTotals(ledger) });
      included.push(ledger);
      continue;
    }
    const stageKilled = records.some(
      (r) => r.status === 'killed' || r.status === 'error'
    );
    if (!runIncomplete && !stageKilled) {
      // Completed run: a stage without spawn events is not double-counted
      if (records.some((r) => r.costUsd > 0 || r.costSummary)) {
        excluded.push(stage);
      }
      continue;
    }
    const summary = mergeCostSummaries(...records.map(stageRecordCostSummary))!;
    rows.push({ stage, source: 'report-only', status, ...costTotals(summary) });
    included.push(summary);
    for (const r of records) {
      if (r.status !== 'killed') continue;
      reportOnlyKilled.microUsd += priced(stageRecordCostSummary(r));
      reportOnlyKilled.count += Math.max(r.spawnCount, 1);
    }
  }

  if (excluded.length > 0) {
    notices.push(
      `stage${excluded.length === 1 ? '' : 's'} ${excluded.join(', ')} ha${excluded.length === 1 ? 's' : 've'} report figures but no spawn events; excluded (ledger is authoritative)`
    );
  }

  const totalSummary = mergeCostSummaries(...included) ?? emptyCostSummary();
  const reportOnlyRows = rows.filter((r) => r.source === 'report-only').length;
  const source: RunCostSummary['source'] =
    reportOnlyRows === 0
      ? 'ledger'
      : reportOnlyRows === rows.length
        ? 'report-only'
        : 'mixed';

  return {
    version: RUN_COST_SUMMARY_VERSION,
    workflowId,
    status: report?.status ?? null,
    source,
    totals: costTotals(totalSummary),
    summaryLine: formatCostSummaryLine(totalSummary),
    stages: rows,
    drivers: computeDrivers(spawns, events, reportOnlyKilled),
    ledgerSpawnEvents: spawns.length,
    skippedLines,
    notices,
  };
}
