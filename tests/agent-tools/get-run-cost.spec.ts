/**
 * get_run_cost agent tool tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getRunCostTool,
  getGetRunCostToolDefinition,
} from '../../src/agent-tools/get-run-cost.js';
import { getAllAgentToolDefinitions } from '../../src/agent-tools/index.js';
import { AuditLogger } from '../../src/audit/audit-logger.js';
import type { AgentContext } from '../../src/task-queue/types.js';

const WF = 'wf-agent';
const PROMPT_TEXT = 'SECRET-PROMPT-do-not-leak-7f3a';

describe('get_run_cost tool', () => {
  let testDir: string;
  let auditDir: string;
  let reportsDir: string;
  let context: AgentContext;
  let seq = 0;

  function writeLedger(lines: Record<string, unknown>[]): void {
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(
      join(auditDir, 'audit-2026-10-15.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
    );
  }

  function spawnLine(
    stage: string,
    micro: number,
    workflowId = WF
  ): Record<string, unknown> {
    seq++;
    return {
      timestamp: new Date(Date.UTC(2026, 9, 15, 12, 0, seq)).toISOString(),
      schema_version: 1,
      event_id: `01EVT${String(seq).padStart(8, '0')}`,
      run_id: workflowId,
      workflowId,
      event: 'llm_spawn',
      spawn_id: `spawn-${seq}`,
      details: {
        backend: 'claude-code',
        stage,
        iteration: 1,
        cost_micro_usd: micro,
        cost_usd: micro / 1e6,
        cost_provenance: 'reported',
        billing_basis: 'billed',
        prompt: PROMPT_TEXT,
        system_prompt: PROMPT_TEXT,
      },
    };
  }

  beforeEach(() => {
    seq = 0;
    testDir = mkdtempSync(join(tmpdir(), 'airunx-get-run-cost-'));
    auditDir = join(testDir, 'audit');
    reportsDir = join(testDir, 'reports');
    context = {
      auditLogger: new AuditLogger(auditDir),
      workflowId: WF,
    } as AgentContext;
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('summarizes the current workflow from a real ledger file', async () => {
    writeLedger([
      spawnLine('plan', 1_500_000),
      spawnLine('implement', 2_000_000),
      spawnLine('implement', 500_000),
      spawnLine('plan', 9_000_000, 'wf-other'),
    ]);

    const result = await getRunCostTool.execute({}, context, { reportsDir });

    expect(result.success).toBe(true);
    if (!result.found) throw new Error('expected a summary');
    const { summary } = result;
    expect(summary.workflowId).toBe(WF);
    expect(summary.totals.totalMicroUsd).toBe(4_000_000);
    expect(summary.totals.billedMicroUsd).toBe(4_000_000);
    expect(summary.totals.spawnCount).toBe(3);
    expect(summary.ledgerSpawnEvents).toBe(3);
    expect(summary.stages.map((s) => [s.stage, s.totalMicroUsd])).toEqual([
      ['plan', 1_500_000],
      ['implement', 2_500_000],
    ]);
  });

  it('accepts an explicit workflowId', async () => {
    writeLedger([spawnLine('plan', 1_000_000, 'wf-other')]);
    const result = await getRunCostTool.execute(
      { workflowId: 'wf-other' },
      context,
      { reportsDir }
    );
    if (!result.found) throw new Error('expected a summary');
    expect(result.summary.totals.totalMicroUsd).toBe(1_000_000);
  });

  it('reports found: false for an unknown workflow id', async () => {
    writeLedger([spawnLine('plan', 1_000_000)]);
    const result = await getRunCostTool.execute(
      { workflowId: 'wf-missing' },
      context,
      { reportsDir }
    );
    expect(result).toMatchObject({
      success: false,
      found: false,
      workflowId: 'wf-missing',
    });
  });

  it('rejects a path-traversal workflow id before any file access', async () => {
    await expect(
      getRunCostTool.execute({ workflowId: '../etc' }, context, { reportsDir })
    ).rejects.toThrow(/Invalid workflow ID/);
    await expect(
      getRunCostTool.execute({ workflowId: '../../x/passwd' }, context, {
        reportsDir,
      })
    ).rejects.toThrow(/Invalid workflow ID/);
  });

  it('returns an empty summary for the current run with an empty ledger', async () => {
    const result = await getRunCostTool.execute({}, context, { reportsDir });

    if (!result.found) throw new Error('expected a summary');
    expect(result.summary.totals.totalMicroUsd).toBe(0);
    expect(result.summary.totals.spawnCount).toBe(0);
    expect(result.summary.stages).toEqual([]);
    expect(result.summary.ledgerSpawnEvents).toBe(0);
  });

  it('never returns prompt text or raw ledger lines', async () => {
    writeLedger([spawnLine('plan', 1_000_000), spawnLine('review', 250_000)]);

    const result = await getRunCostTool.execute({}, context, { reportsDir });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(PROMPT_TEXT);
    expect(serialized).not.toContain('event_id');
    expect(serialized).not.toContain('01EVT');
  });

  it('is registered with the agent tool definitions', () => {
    const definition = getGetRunCostToolDefinition();
    expect(definition.name).toBe('get_run_cost');
    expect(getAllAgentToolDefinitions().map((d) => d.name)).toContain(
      'get_run_cost'
    );
  });
});
