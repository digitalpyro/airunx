/**
 * Spawn ledger integration test
 *
 * Drives a real LangGraphRunner (plan → implement → judge) through a CLI
 * adapter whose process spawn is stubbed with fixture output, and verifies the
 * audit JSONL: one llm_spawn per spawn, every spawn attributed to a stage and
 * iteration, and per-spawn costs summing to the run total.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BaseCliAdapter } from '../../src/adapters/base-cli-adapter.js';
import type { CliAdapterConfig } from '../../src/adapters/base-cli-adapter.js';
import type {
  AdapterConfig,
  BackendAvailability,
  ExecutionRequest,
} from '../../src/core/adapter-types.js';
import type { Pipeline, WorkflowContext } from '../../src/core/types.js';
import { LangGraphRunner } from '../../src/orchestrator/langgraph-runner.js';
import { StateManager } from '../../src/orchestrator/state-manager.js';
import {
  AuditLogger,
  createAuditSpawnObserver,
} from '../../src/audit/audit-logger.js';
import type { AuditEvent } from '../../src/audit/audit-logger.js';

/** Fixture CLI: each spawn reports a distinct cost; the judge proceeds */
class FixtureCliAdapter extends BaseCliAdapter {
  name = 'claude-code' as const;
  private spawnIndex = 0;
  private lastRole = '';

  protected getCliConfig(): CliAdapterConfig {
    return {
      cliCommand: 'fixture-cli',
      installInstructions: 'n/a',
      pricingMap: { 'fixture-model': { input: 3, output: 15 } },
      defaultModel: 'fixture-model',
    };
  }

  protected buildCliArgs(request: ExecutionRequest, prompt: string): string[] {
    this.lastRole = request.agent.role;
    return ['-p', prompt];
  }

  protected async executeWithSpawn(): Promise<{
    stdout: string;
    stderr: string;
  }> {
    this.spawnIndex++;
    const result =
      this.lastRole === 'code-judge'
        ? 'DECISION: PROCEED\nREASON: All criteria met'
        : `Work for spawn ${this.spawnIndex}`;
    return {
      stdout: JSON.stringify({
        result,
        input_tokens: 1000 * this.spawnIndex,
        output_tokens: 100 * this.spawnIndex,
        total_cost_usd: 0.0101 * this.spawnIndex,
        session_id: `fixture-session-${this.spawnIndex}`,
      }),
      stderr: '',
    };
  }

  async init(config: AdapterConfig): Promise<void> {
    this.config = config;
    this.initialized = true;
  }

  async isAvailable(): Promise<BackendAvailability> {
    return { available: true };
  }
}

describe('llm_spawn ledger (fixture-driven run)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'airunx-spawn-ledger-'));
    // Keep run reports out of the repo's .airunx-state
    vi.spyOn(
      LangGraphRunner.prototype as unknown as {
        writeRunReport: () => void;
      },
      'writeRunReport'
    ).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('records one attributed llm_spawn per spawn and sums to the run total', async () => {
    const auditDir = join(testDir, 'audit');
    const auditLogger = new AuditLogger(auditDir);
    const stateManager = new StateManager(join(testDir, 'state'));

    const adapter = new FixtureCliAdapter();
    await adapter.init({ type: 'cli' });
    adapter.setSpawnObserver(createAuditSpawnObserver(auditLogger));

    const pipeline: Pipeline = {
      name: 'ledger-pipeline',
      description: 'Ledger fixture pipeline',
      default_fidelity: 'standard',
      stages: [
        { name: 'plan', agent: 'orchestrator', input: 'Plan the work' },
        { name: 'implement', agent: 'developer', input: 'Implement it' },
        { name: 'judge', agent: 'code-judge', evaluatesStage: 'implement' },
      ],
    } as Pipeline;

    const workflowContext: WorkflowContext = {
      id: 'wf-ledger-fixture',
      input: 'Add a feature',
      inputType: 'prompt',
      mode: 'pipeline',
      fidelityLevel: 'standard',
      createdAt: new Date(),
      status: 'initializing',
      iterationCount: 0,
      maxIterations: 3,
      todos: [],
      metrics: {
        tokensUsed: 0,
        totalTokens: 0,
        runtime: 0,
        totalRuntimeMs: 0,
        stagesCompleted: 0,
        totalStages: 3,
        errors: 0,
        totalCost: 0,
      },
    };
    await stateManager.save(workflowContext);

    const runner = new LangGraphRunner({
      adapter,
      stateManager,
      pipeline,
      workflowContext,
      auditLogger,
    });
    const finalContext = await runner.execute();

    const events: AuditEvent[] = readdirSync(auditDir)
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) =>
        readFileSync(join(auditDir, f), 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as AuditEvent)
      );
    const spawns = events.filter((e) => e.event === 'llm_spawn');

    expect(spawns.length).toBeGreaterThanOrEqual(3);
    for (const spawn of spawns) {
      expect(spawn.workflowId).toBe('wf-ledger-fixture');
      expect(spawn.run_id).toBe('wf-ledger-fixture');
      expect(spawn.schema_version).toBe(1);
      expect(spawn.spawn_id).toBeDefined();
      expect(typeof spawn.details?.stage).toBe('string');
      expect(spawn.details?.iteration).toBe(1);
      expect(Number.isInteger(spawn.details?.cost_micro_usd)).toBe(true);
    }
    expect(new Set(spawns.map((s) => s.event_id)).size).toBe(spawns.length);
    expect(new Set(spawns.map((s) => s.spawn_id)).size).toBe(spawns.length);

    const judgeSpawns = spawns.filter((s) => s.details?.stage === 'judge');
    expect(judgeSpawns).toHaveLength(1);
    expect(judgeSpawns[0].details?.agent_role).toBe('code-judge');

    // Per-spawn costs sum to the run total (micro-USD, allow per-spawn rounding)
    const spawnMicroUsd = spawns.reduce(
      (sum, s) => sum + Number(s.details?.cost_micro_usd ?? 0),
      0
    );
    const runMicroUsd = Math.round((finalContext.metrics.totalCost ?? 0) * 1e6);
    expect(runMicroUsd).toBeGreaterThan(0);
    expect(Math.abs(spawnMicroUsd - runMicroUsd)).toBeLessThanOrEqual(
      spawns.length
    );

    // stage_start precedes stage_complete for every stage
    const stageEvents = events
      .filter((e) => e.event === 'stage_start' || e.event === 'stage_complete')
      .map((e) => `${e.event}:${e.details?.stageName}`);
    for (const stage of ['plan', 'implement', 'judge']) {
      const start = stageEvents.indexOf(`stage_start:${stage}`);
      const complete = stageEvents.indexOf(`stage_complete:${stage}`);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(complete).toBeGreaterThan(start);
    }
  });
});
