/**
 * costs command tests — single-run summary from fixture ledger + report
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildRunCostSummary,
  costsCommand,
  findLatestRunId,
} from '../../../src/cli/commands/costs.js';
import {
  summarizeRunCosts,
  type RunCostSummary,
} from '../../../src/core/run-cost-summary.js';
import { formatRunCosts } from '../../../src/cli/formatters/costs-formatter.js';
import {
  emptyCostSummary,
  spawnCostSummary,
} from '../../../src/core/cost-accounting.js';
import type {
  CostSummary,
  RunReport,
  StageRecord,
} from '../../../src/core/types.js';

const WF = 'workflow-1700000000000-abcd1234';

let tmpDir: string;
let reportsDir: string;
let auditDir: string;
let eventSeq = 0;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'costs-test-'));
  reportsDir = join(tmpDir, 'reports');
  auditDir = join(tmpDir, 'audit');
  mkdirSync(reportsDir, { recursive: true });
  eventSeq = 0;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface SpawnOpts {
  stage: string;
  micro?: number;
  provenance?: 'reported' | 'derived' | 'estimated' | 'missing';
  basis?: 'billed' | 'api_equivalent' | 'unknown';
  iteration?: number;
  parent?: string;
  spendLost?: number;
  workflowId?: string;
}

function spawnEvent(o: SpawnOpts): Record<string, unknown> {
  eventSeq++;
  const id = `01EVT${String(eventSeq).padStart(8, '0')}`;
  return {
    timestamp: new Date(Date.UTC(2026, 9, 15, 12, 0, eventSeq)).toISOString(),
    schema_version: 1,
    event_id: id,
    run_id: o.workflowId ?? WF,
    workflowId: o.workflowId ?? WF,
    event: 'llm_spawn',
    spawn_id: `spawn-${eventSeq}`,
    ...(o.parent ? { parent_spawn_id: o.parent } : {}),
    details: {
      backend: 'claude-code',
      stage: o.stage,
      iteration: o.iteration ?? 1,
      cost_usd: o.micro !== undefined ? o.micro / 1e6 : undefined,
      cost_micro_usd: o.micro,
      cost_provenance: o.provenance ?? 'reported',
      billing_basis: o.basis ?? 'api_equivalent',
      ...(o.spendLost !== undefined
        ? { spend_lost_micro_usd: o.spendLost }
        : {}),
    },
  };
}

function otherEvent(
  event: string,
  details: Record<string, unknown>
): Record<string, unknown> {
  eventSeq++;
  return {
    timestamp: new Date(Date.UTC(2026, 9, 15, 12, 0, eventSeq)).toISOString(),
    schema_version: 1,
    event_id: `01EVT${String(eventSeq).padStart(8, '0')}`,
    workflowId: WF,
    event,
    details,
  };
}

function writeAudit(lines: Array<Record<string, unknown> | string>): void {
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(
    join(auditDir, 'audit-2026-10-15.jsonl'),
    lines
      .map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))
      .join('\n') + '\n'
  );
}

function stage(
  name: string,
  costUsd: number,
  status: StageRecord['status'] = 'completed',
  costSummary?: CostSummary
): StageRecord {
  return {
    stage: name,
    agent: name,
    backend: 'claude-code',
    spawnCount: 1,
    durationMs: 1000,
    tokensUsed: 100,
    costUsd,
    timestamp: '2026-10-15T12:00:00.000Z',
    status,
    ...(costSummary ? { costSummary } : {}),
  };
}

function writeReport(
  stages: StageRecord[],
  extra: Partial<RunReport> = {},
  id = WF
): void {
  const report: RunReport = {
    workflowId: id,
    status: 'completed',
    startedAt: '2026-10-15T12:00:00.000Z',
    completedAt: '2026-10-15T12:10:00.000Z',
    totalDurationMs: 600000,
    totalTokens: 0,
    totalCostUsd: stages.reduce((a, s) => a + s.costUsd, 0),
    iterationCount: 1,
    maxIterations: 3,
    iterations: [],
    stages,
    timeline: [],
    ...extra,
  };
  writeFileSync(join(reportsDir, `${id}.json`), JSON.stringify(report));
}

const summarize = (workflowId?: string): Promise<RunCostSummary> =>
  buildRunCostSummary({ workflowId, reportsDir, auditDir });

describe('airunx costs — single-run summary', () => {
  it('totals match the JSONL sum exactly (integer micro-USD)', async () => {
    const micros = [1_234_567, 89, 3_000_001, 1];
    writeAudit([
      spawnEvent({ stage: 'plan', micro: micros[0] }),
      spawnEvent({ stage: 'implement', micro: micros[1] }),
      spawnEvent({ stage: 'implement', micro: micros[2] }),
      spawnEvent({ stage: 'review', micro: micros[3] }),
      // Another run's spawn is never counted
      spawnEvent({ stage: 'plan', micro: 999_999, workflowId: 'other-run' }),
    ]);
    writeReport([
      stage('plan', 1.234567),
      stage('implement', 3.00009),
      stage('review', 0.000001),
    ]);

    const s = await summarize(WF);
    const expected = micros.reduce((a, b) => a + b, 0);
    expect(s.totals.totalMicroUsd).toBe(expected);
    expect(s.totals.apiEquivalentMicroUsd).toBe(expected);
    expect(s.totals.spawnCount).toBe(4);
    expect(s.source).toBe('ledger');
    expect(
      s.stages.map((r) => [r.stage, r.totalMicroUsd, r.spawnCount])
    ).toEqual([
      ['plan', micros[0], 1],
      ['implement', micros[1] + micros[2], 2],
      ['review', micros[3], 1],
    ]);
  });

  it('counts duplicated event lines once', async () => {
    const e = spawnEvent({ stage: 'plan', micro: 500_000 });
    writeAudit([e, e, e]);
    writeReport([stage('plan', 0.5)]);
    const s = await summarize(WF);
    expect(s.totals.totalMicroUsd).toBe(500_000);
    expect(s.ledgerSpawnEvents).toBe(1);
  });

  it('skips torn lines and reports a notice', async () => {
    writeAudit([
      spawnEvent({ stage: 'plan', micro: 100 }),
      '{"timestamp":"2026-10-15T12:00:00Z","event":"llm_sp',
      spawnEvent({ stage: 'plan', micro: 200 }),
    ]);
    writeReport([stage('plan', 0.0003)]);
    const s = await summarize(WF);
    expect(s.totals.totalMicroUsd).toBe(300);
    expect(s.skippedLines).toBe(1);
    expect(s.notices).toContain('skipped 1 malformed line in the audit log');
    expect(formatRunCosts(s)).toContain('skipped 1 malformed line');
  });

  it('computes provenance percentages from priced spend', async () => {
    writeAudit([
      spawnEvent({ stage: 'a', micro: 600_000, provenance: 'reported' }),
      spawnEvent({ stage: 'a', micro: 300_000, provenance: 'derived' }),
      spawnEvent({ stage: 'b', micro: 100_000, provenance: 'estimated' }),
      spawnEvent({ stage: 'b', provenance: 'missing' }),
    ]);
    writeReport([stage('a', 0.9), stage('b', 0.1)]);
    const s = await summarize(WF);
    expect(s.totals.provenanceMix).toEqual({
      reportedPct: 60,
      derivedPct: 30,
      estimatedPct: 10,
      trustedPct: 90,
    });
    expect(s.totals.provenance).toBe('estimated');
    expect(s.totals.missingCostSpawns).toBe(1);
    expect(s.totals.totalMicroUsd).toBe(1_000_000);
  });

  it('keeps billed and API-equivalent separate on a mixed-auth run', async () => {
    writeAudit([
      spawnEvent({ stage: 'plan', micro: 1_200_000, basis: 'billed' }),
      spawnEvent({ stage: 'implement', micro: 3_400_000 }),
    ]);
    writeReport([stage('plan', 1.2), stage('implement', 3.4)]);
    const s = await summarize(WF);
    expect(s.totals.billedMicroUsd).toBe(1_200_000);
    expect(s.totals.apiEquivalentMicroUsd).toBe(3_400_000);
    expect(s.summaryLine).toContain('$1.20 billed');
    expect(s.summaryLine).toContain('$3.40 API-equivalent');
    const text = formatRunCosts(s);
    expect(text).toMatch(/Billed:\s+\$1\.2000/);
    expect(text).toMatch(/API-equivalent:\s+\$3\.4000/);
  });

  it('ranks drivers by cost', async () => {
    writeAudit([
      spawnEvent({ stage: 'plan', micro: 100_000 }),
      spawnEvent({ stage: 'implement', micro: 50_000, parent: 'spawn-1' }),
      spawnEvent({ stage: 'implement', micro: 70_000, parent: 'spawn-1' }),
      spawnEvent({ stage: 'implement', micro: 900_000, iteration: 2 }),
      spawnEvent({
        stage: 'review',
        micro: 30_000,
        provenance: 'estimated',
        spendLost: 30_000,
      }),
      otherEvent('attempt', {
        stage: 'implement',
        outcome: 'failure',
        cost_micro_usd: 400_000,
      }),
      otherEvent('attempt', {
        stage: 'implement',
        outcome: 'success',
        cost_micro_usd: 999_000,
      }),
    ]);
    writeReport([stage('plan', 0.1), stage('implement', 1.02)]);
    const s = await summarize(WF);
    expect(s.drivers.map((d) => [d.kind, d.microUsd, d.count])).toEqual([
      ['iteration_reruns', 900_000, 1],
      ['retry_waste', 400_000, 1],
      ['delegation', 120_000, 2],
      ['killed_spawn_losses', 30_000, 1],
    ]);
  });

  it('falls back to a report-only view with a notice when audit files are missing', async () => {
    const summary = spawnCostSummary({
      costUsd: 2.5,
      costProvenance: 'reported',
      billingBasis: 'billed',
    });
    writeReport([stage('plan', 2.5, 'completed', summary)], {
      costSummary: summary,
    });
    const s = await summarize(WF);
    expect(s.source).toBe('report-only');
    expect(s.totals.billedMicroUsd).toBe(2_500_000);
    expect(s.stages[0].source).toBe('report-only');
    expect(s.notices).toContain(
      'no audit log files found; showing report-only view'
    );
  });

  it('killed run: total matches the heartbeat-posted report figure', async () => {
    const planSummary = spawnCostSummary({
      costUsd: 0.8,
      costProvenance: 'reported',
      billingBasis: 'api_equivalent',
    });
    const killedSummary = spawnCostSummary({
      costUsd: 0.35,
      costProvenance: 'estimated',
      billingBasis: 'api_equivalent',
    });
    const runSummary: CostSummary = {
      ...emptyCostSummary(),
      provenance: 'estimated',
      apiEquivalentMicroUsd: 1_150_000,
      reportedMicroUsd: 800_000,
      estimatedMicroUsd: 350_000,
      spawnCount: 2,
      estimatedSpawns: 1,
    };
    // Plan's spawn is in the ledger; the killed stage never logged one
    writeAudit([spawnEvent({ stage: 'plan', micro: 800_000 })]);
    writeReport(
      [
        stage('plan', 0.8, 'completed', planSummary),
        stage('implement', 0.35, 'killed', killedSummary),
      ],
      { status: 'interrupted', costSummary: runSummary, totalCostUsd: 1.15 }
    );
    const s = await summarize(WF);
    expect(s.source).toBe('mixed');
    expect(s.totals.totalMicroUsd).toBe(
      runSummary.apiEquivalentMicroUsd +
        runSummary.billedMicroUsd +
        runSummary.unknownBasisMicroUsd
    );
    expect(s.stages.find((r) => r.stage === 'implement')?.source).toBe(
      'report-only'
    );
    expect(s.drivers).toContainEqual({
      kind: 'killed_spawn_losses',
      label: 'Killed-spawn losses',
      microUsd: 350_000,
      count: 1,
    });
  });

  it('never adds stage records on top of spawn events (completed run)', () => {
    const report: RunReport = {
      workflowId: WF,
      status: 'completed',
      startedAt: '',
      completedAt: '',
      totalDurationMs: 0,
      totalTokens: 0,
      totalCostUsd: 5,
      iterationCount: 1,
      maxIterations: 1,
      iterations: [],
      stages: [stage('plan', 1), stage('orphan', 4)],
      timeline: [],
    };
    const s = summarizeRunCosts({
      workflowId: WF,
      report,
      events: [spawnEvent({ stage: 'plan', micro: 1_000_000 }) as never],
    });
    expect(s.totals.totalMicroUsd).toBe(1_000_000);
    expect(s.stages.map((r) => r.stage)).toEqual(['plan']);
    expect(s.notices.some((n) => n.includes('orphan'))).toBe(true);
  });

  it('defaults to the latest report by mtime', async () => {
    writeReport([stage('plan', 1)], {}, 'older-run');
    writeReport([stage('plan', 2)], {}, 'newer-run');
    utimesSync(join(reportsDir, 'older-run.json'), 1000, 1000);
    utimesSync(join(reportsDir, 'newer-run.json'), 2000, 2000);
    writeFileSync(join(reportsDir, 'not valid!.json'), '{}');
    expect(findLatestRunId(reportsDir)).toBe('newer-run');
    const s = await summarize();
    expect(s.workflowId).toBe('newer-run');
  });

  it('rejects an invalid --workflow-id before any file access', async () => {
    await expect(summarize('../../etc/passwd')).rejects.toThrow(
      /Invalid workflow ID/
    );
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await costsCommand({ workflowId: '../x', reportsDir, auditDir });
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('Invalid workflow ID');
  });

  it('--json output is stable and parseable', async () => {
    writeAudit([
      spawnEvent({ stage: 'plan', micro: 250_000, basis: 'billed' }),
    ]);
    writeReport([stage('plan', 0.25)]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as never);
    await costsCommand({ workflowId: WF, json: true, reportsDir, auditDir });
    await costsCommand({ workflowId: WF, json: true, reportsDir, auditDir });
    expect(exit).toHaveBeenCalledWith(0);
    const [first, second] = log.mock.calls.map((c) => String(c[0]));
    expect(first).toBe(second);
    const parsed = JSON.parse(first) as RunCostSummary;
    expect(Object.keys(parsed)).toEqual([
      'version',
      'workflowId',
      'status',
      'source',
      'totals',
      'summaryLine',
      'stages',
      'drivers',
      'ledgerSpawnEvents',
      'skippedLines',
      'notices',
    ]);
    expect(parsed.totals.billedMicroUsd).toBe(250_000);
    expect(parsed.version).toBe(1);
  });

  it('errors when neither report nor ledger exists for the run', async () => {
    await expect(summarize('missing-run')).rejects.toThrow(
      /No run report or ledger events/
    );
  });
});
