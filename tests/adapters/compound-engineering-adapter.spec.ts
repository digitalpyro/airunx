/**
 * CompoundEngineeringAdapter delegation ledger events (U4)
 * Validates `delegation` decision/completion events: trigger reason, keyword,
 * sub-agent count, and marginal sub-agent cost equal to the sub-agent spawns.
 */

import { describe, it, expect, vi } from 'vitest';
import { CompoundEngineeringAdapter } from '../../src/adapters/compound-engineering-adapter.js';
import type {
  DelegationRecord,
  ExecutionRequest,
  SpawnRecord,
} from '../../src/core/adapter-types.js';

const makeRequest = (
  overrides: Partial<ExecutionRequest> = {}
): ExecutionRequest => ({
  agent: {
    role: 'developer',
    capabilities: ['code'],
    contextRequired: [],
    systemPrompt: 'You are a developer.',
  },
  task: 'Implement the thing',
  context: { workingDirectory: '/tmp' },
  spawnContext: { workflowId: 'wf-ce', stage: 'implement', iteration: 1 },
  ...overrides,
});

/** CE adapter with the CLI stubbed: spawn N costs costs[N] */
function makeAdapter(
  costs: number[],
  analysis = 'analysis'
): {
  adapter: CompoundEngineeringAdapter;
  spawns: SpawnRecord[];
  delegations: DelegationRecord[];
} {
  const adapter = new CompoundEngineeringAdapter();
  Object.assign(adapter, { config: { type: 'cli' }, initialized: true });
  let call = 0;
  vi.spyOn(
    adapter as unknown as { executeWithSpawn: () => Promise<unknown> },
    'executeWithSpawn'
  ).mockImplementation(async () => {
    const cost = costs[call] ?? 0.01;
    call++;
    return {
      stdout: JSON.stringify({
        result: call === 1 ? analysis : 'findings',
        input_tokens: 10,
        output_tokens: 5,
        total_cost_usd: cost,
      }),
      stderr: '',
    };
  });

  const spawns: SpawnRecord[] = [];
  const delegations: DelegationRecord[] = [];
  adapter.setSpawnObserver({
    onSpawnComplete: (record) => spawns.push(record),
    onDelegation: (record) => delegations.push(record),
  });
  return { adapter, spawns, delegations };
}

describe('CompoundEngineeringAdapter delegation events', () => {
  it('reports a length trigger with decision and completion events', async () => {
    const { adapter, spawns, delegations } = makeAdapter([
      0.5, 0.111111, 0.222222, 0.333333,
    ]);
    const result = await adapter.execute(
      makeRequest({ task: 'Implement this carefully. '.repeat(30) })
    );

    expect(delegations.map((d) => d.phase)).toEqual(['decision', 'completion']);
    const [decision, completion] = delegations;
    const main = spawns.find((s) => !s.parentSpawnId)!;
    expect(decision).toMatchObject({
      triggerReason: 'length',
      subAgentCount: 3,
      lengthThreshold: 500,
      workflowId: 'wf-ce',
      stage: 'implement',
      iteration: 1,
      spawnId: main.spawnId,
    });
    expect(decision.keyword).toBeUndefined();
    expect(decision.taskLength).toBeGreaterThan(500);
    expect(decision.marginalCostMicroUsd).toBeUndefined();

    // Marginal cost equals the sum of the sub-agent llm_spawn costs
    const subSpawns = spawns.filter((s) => s.parentSpawnId === main.spawnId);
    expect(subSpawns).toHaveLength(3);
    const subMicro = subSpawns.reduce(
      (sum, s) => sum + Math.round((s.costUsd ?? 0) * 1e6),
      0
    );
    expect(completion.marginalCostMicroUsd).toBe(subMicro);
    expect(completion.marginalCostMicroUsd).toBe(666_666);
    expect(completion.succeededCount).toBe(3);
    expect(completion.marginalCostSummary?.spawnCount).toBe(3);

    // Stage aggregate = main + sub-agent spawns
    const spawnSum = spawns.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
    expect(result.metrics.cost).toBeCloseTo(spawnSum, 10);
  });

  it('reports a keyword trigger with the matched keyword', async () => {
    const { adapter, delegations } = makeAdapter([0.1, 0.01, 0.01, 0.01]);
    await adapter.execute(
      makeRequest({ task: 'Do a system design review of the module' })
    );

    expect(delegations[0]).toMatchObject({
      phase: 'decision',
      triggerReason: 'keyword',
      keyword: 'system design',
      keywordSource: 'task',
    });
  });

  it('reports a keyword matched in the main analysis', async () => {
    const { adapter, delegations } = makeAdapter(
      [0.1, 0.01, 0.01, 0.01],
      'This needs a cross-cutting concern review'
    );
    await adapter.execute(makeRequest({ task: 'Fix the bug' }));

    expect(delegations[0]).toMatchObject({
      triggerReason: 'keyword',
      keyword: 'cross-cutting concern',
      keywordSource: 'analysis',
    });
  });

  it('counts only configured sub-agents', async () => {
    const { adapter, delegations } = makeAdapter([0.1, 0.02]);
    await adapter.execute(
      makeRequest({
        task: 'Do a system design review',
        agent: {
          role: 'developer',
          capabilities: [],
          contextRequired: [],
          providerConfig: { subAgents: ['architecture-strategist'] },
        },
      })
    );

    expect(delegations[0]).toMatchObject({
      subAgentCount: 1,
      subAgents: ['architecture-strategist'],
    });
    expect(delegations[1].marginalCostMicroUsd).toBe(20_000);
  });

  it('emits nothing when delegation does not trigger', async () => {
    const { adapter, spawns, delegations } = makeAdapter([0.1]);
    await adapter.execute(makeRequest({ task: 'Fix the bug' }));

    expect(spawns).toHaveLength(1);
    expect(delegations).toEqual([]);
  });
});

describe('CompoundEngineeringAdapter MCP isolation (issue #20)', () => {
  it('passes --strict-mcp-config to the main and every sub-agent spawn', async () => {
    const { adapter } = makeAdapter([0.5, 0.1, 0.1, 0.1]);
    const spy = vi.mocked(
      (adapter as unknown as { executeWithSpawn: () => Promise<unknown> })
        .executeWithSpawn
    );
    await adapter.execute(
      makeRequest({ task: 'Implement this carefully. '.repeat(30) })
    );

    expect(spy.mock.calls).toHaveLength(4);
    for (const call of spy.mock.calls as unknown[][]) {
      expect(call[1]).toContain('--strict-mcp-config');
    }
  });
});
