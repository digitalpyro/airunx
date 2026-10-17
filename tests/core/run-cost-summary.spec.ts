/**
 * run-cost-summary driver tests
 */

import { describe, it, expect } from 'vitest';
import { summarizeRunCosts } from '../../src/core/run-cost-summary.js';
import type { AuditEvent } from '../../src/task-queue/types.js';

const WF = 'workflow-1700000000000-abcd1234';
let seq = 0;

function event(
  type: string,
  spawnId: string | undefined,
  details: Record<string, unknown>
): AuditEvent {
  seq++;
  return {
    timestamp: new Date(Date.UTC(2026, 9, 15, 12, 0, seq)).toISOString(),
    schema_version: 1,
    event_id: `01EVT${String(seq).padStart(8, '0')}`,
    workflowId: WF,
    event: type,
    ...(spawnId ? { spawn_id: spawnId } : {}),
    details,
  } as AuditEvent;
}

const spawn = (id: string, micro: number): AuditEvent =>
  event('llm_spawn', id, {
    stage: 'implement',
    cost_micro_usd: micro,
    cost_provenance: 'reported',
    billing_basis: 'billed',
  });

const retryWaste = (events: AuditEvent[]) =>
  summarizeRunCosts({ workflowId: WF, events }).drivers.find(
    (d) => d.kind === 'retry_waste'
  );

describe('retry_waste driver', () => {
  it('counts a Codex model-rejected spawn once when its retry also fails', () => {
    const events = [
      spawn('spawn-rejected', 100_000),
      // CodexAdapter: rejected first spawn
      event('attempt', 'spawn-rejected', {
        outcome: 'failure',
        error_category: 'model_rejected',
        cost_micro_usd: 100_000,
      }),
      spawn('spawn-retry', 300_000),
      // AgentInvoker: the retry failed; its cost folds in the rejected spawn
      event('attempt', 'spawn-retry', {
        outcome: 'failure',
        cost_micro_usd: 400_000,
      }),
    ];
    expect(retryWaste(events)).toMatchObject({ microUsd: 400_000, count: 2 });
  });

  it('ignores successful attempts and their spawns', () => {
    const events = [
      spawn('spawn-ok', 999_000),
      event('attempt', 'spawn-ok', { outcome: 'success', cost_micro_usd: 1 }),
      spawn('spawn-bad', 50_000),
      event('attempt', 'spawn-bad', { outcome: 'failure' }),
    ];
    expect(retryWaste(events)).toMatchObject({ microUsd: 50_000, count: 1 });
  });

  it('counts a spawn once even with several failed attempts naming it', () => {
    const events = [
      spawn('spawn-a', 70_000),
      event('attempt', 'spawn-a', { outcome: 'failure' }),
      event('attempt', 'spawn-a', { outcome: 'failure' }),
    ];
    expect(retryWaste(events)).toMatchObject({ microUsd: 70_000, count: 1 });
  });

  it('falls back to the attempt cost for legacy attempts without a spawn_id', () => {
    const events = [
      spawn('spawn-x', 10_000),
      event('attempt', undefined, {
        outcome: 'failure',
        cost_micro_usd: 25_000,
      }),
    ];
    expect(retryWaste(events)).toMatchObject({ microUsd: 25_000, count: 1 });
  });
});
