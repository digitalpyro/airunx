/**
 * ShutdownCoordinator spawn recording (killed-stage accounting)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  ExecutionRequest,
  SpawnRecord,
} from '../../src/core/adapter-types.js';
import { ShutdownCoordinator } from '../../src/utils/shutdown-coordinator.js';

const record = (overrides: Partial<SpawnRecord> = {}): SpawnRecord => ({
  spawnId: 's1',
  workflowId: 'wf',
  stage: 'implement',
  backend: 'claude-code',
  agentRole: 'developer',
  tokensUsed: 10,
  costUsd: 0.5,
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:00:01.000Z',
  durationMs: 1_000,
  exitReason: 'ok',
  success: true,
  salvaged: false,
  costProvenance: 'reported',
  billingBasis: 'billed',
  ...overrides,
});

describe('ShutdownCoordinator spawn recording', () => {
  let coordinator: ShutdownCoordinator;
  const request = {} as ExecutionRequest;

  beforeEach(() => {
    coordinator = new ShutdownCoordinator();
  });

  it('observeSpawns records every spawn and forwards to the inner observer', () => {
    const inner = {
      onSpawnComplete: vi.fn(),
      onAttempt: vi.fn(),
    };
    const observer = coordinator.observeSpawns(inner);
    observer.onSpawnComplete(record(), request);
    expect(inner.onSpawnComplete).toHaveBeenCalledOnce();
    expect(observer.onAttempt).toBeDefined();
    expect(observer.onDelegation).toBeUndefined();
    const [spawn] = coordinator.recordedSpawns();
    expect(spawn).toMatchObject({ spawnId: 's1', costUsd: 0.5 });
    expect(spawn.costSummary?.spawnCount).toBe(1);
    expect(spawn.costSummary?.billedMicroUsd).toBe(500_000);
  });

  it('an interrupted spawn seen both ways is counted once (interrupted wins)', () => {
    coordinator.observeSpawns().onSpawnComplete(record(), request);
    coordinator
      .observeSpawns()
      .onSpawnComplete(
        record({ spawnId: 's2', startedAt: '2026-01-01T00:00:05.000Z' }),
        request
      );
    coordinator.recordInterruptedSpawn({
      workflowId: 'wf',
      stage: 'implement',
      backend: 'claude-code',
      agentRole: 'developer',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 1_000,
      tokensUsed: 10,
      costUsd: 0.7,
    });
    const spawns = coordinator.recordedSpawns();
    expect(spawns).toHaveLength(2);
    expect(spawns.map((s) => s.costUsd).sort()).toEqual([0.5, 0.7]);
  });

  it('flush hooks receive the recorded spawns; reset clears them', async () => {
    coordinator.observeSpawns().onSpawnComplete(record(), request);
    const hook = vi.fn();
    coordinator.onFlush(hook);
    await coordinator.shutdown({ timeoutMs: 10, flushTimeoutMs: 10 });
    expect(hook.mock.calls[0][0]).toHaveLength(1);
    coordinator.reset();
    expect(coordinator.recordedSpawns()).toEqual([]);
  });
});
