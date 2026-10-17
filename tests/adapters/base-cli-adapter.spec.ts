/**
 * BaseCliAdapter tests
 * Validates CLI execution helpers: output parsing, timeout, buildEnv, error categorization
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { BaseCliAdapter } from '../../src/adapters/base-cli-adapter.js';
import type {
  CliAdapterConfig,
  SignalLadder,
} from '../../src/adapters/base-cli-adapter.js';
import {
  ShutdownInProgressError,
  shutdownCoordinator,
  type InterruptedSpawnSummary,
} from '../../src/utils/shutdown-coordinator.js';
import type {
  ExecutionRequest,
  ExecutionResult,
  BackendAvailability,
  AdapterConfig,
  SpawnObserver,
  SpawnRecord,
} from '../../src/core/adapter-types.js';
import type { ModelPricing } from '../../src/adapters/pricing.js';
import { CompoundEngineeringAdapter } from '../../src/adapters/compound-engineering-adapter.js';
import { TimeoutError } from '../../src/utils/errors.js';
import {
  KILL_ESTIMATE_BYTES_PER_TOKEN,
  KILL_ESTIMATE_CAP_FLOOR_MULTIPLIER,
  runSpendTracker,
} from '../../src/adapters/spend-estimator.js';

// Concrete test subclass to access protected methods
class TestableCliAdapter extends BaseCliAdapter {
  name = 'test-cli' as const;

  private cliConfig: CliAdapterConfig = {
    cliCommand: 'test-cli',
    installInstructions: 'npm install -g test-cli',
    pricingMap: {
      'test-model': {
        inputPer1M: 3.0,
        outputPer1M: 15.0,
      },
    },
    defaultModel: 'test-model',
  };

  protected getCliConfig(): CliAdapterConfig {
    return this.cliConfig;
  }

  protected buildCliArgs(): string[] {
    return ['--test'];
  }

  // Expose protected methods for testing
  public testParseOutput(
    stdout: string,
    stderr: string
  ): ReturnType<BaseCliAdapter['parseOutput']> {
    return this.parseOutput(stdout, stderr);
  }

  public testGetTimeoutMs(): number {
    return this.getTimeoutMs();
  }

  public testBuildEnv(): typeof process.env {
    return this.buildEnv();
  }

  // Skip CLI availability check for unit tests
  async init(config: AdapterConfig): Promise<void> {
    this.config = config;
    this.initialized = true;
  }

  async isAvailable(): Promise<BackendAvailability> {
    return { available: true };
  }
}

describe('BaseCliAdapter', () => {
  let adapter: TestableCliAdapter;

  beforeEach(() => {
    adapter = new TestableCliAdapter();
  });

  describe('parseOutput', () => {
    it('parses valid JSON output with token data', () => {
      const stdout = JSON.stringify({
        analysis: 'Test analysis',
        files: ['file1.ts'],
        recommendations: ['rec1'],
        tokens_used: 1000,
        input_tokens: 600,
        output_tokens: 400,
      });

      const result = adapter.testParseOutput(stdout, '');

      expect(result.tokensUsed).toBe(1000);
      expect(result.inputTokens).toBe(600);
      expect(result.outputTokens).toBe(400);
      expect(result.outputs.analysis).toBe('Test analysis');
      expect(result.outputs.files).toEqual(['file1.ts']);
      expect(result.outputs.recommendations).toEqual(['rec1']);
    });

    it('handles camelCase token field names', () => {
      const stdout = JSON.stringify({
        analysis: 'result',
        tokensUsed: 500,
        inputTokens: 300,
        outputTokens: 200,
      });

      const result = adapter.testParseOutput(stdout, '');

      expect(result.tokensUsed).toBe(500);
      expect(result.inputTokens).toBe(300);
      expect(result.outputTokens).toBe(200);
    });

    it('handles usage.total_tokens format', () => {
      const stdout = JSON.stringify({
        output: 'result',
        usage: {
          total_tokens: 750,
          prompt_tokens: 500,
          completion_tokens: 250,
        },
      });

      const result = adapter.testParseOutput(stdout, '');

      expect(result.tokensUsed).toBe(750);
      expect(result.inputTokens).toBe(500);
      expect(result.outputTokens).toBe(250);
    });

    it('computes total from input+output when total is missing', () => {
      const stdout = JSON.stringify({
        analysis: 'result',
        input_tokens: 100,
        output_tokens: 200,
      });

      const result = adapter.testParseOutput(stdout, '');

      expect(result.tokensUsed).toBe(300);
      expect(result.inputTokens).toBe(100);
      expect(result.outputTokens).toBe(200);
    });

    it('falls back to token estimation for non-JSON output', () => {
      const plainText = 'This is plain text output from the CLI';

      const result = adapter.testParseOutput(plainText, '');

      expect(result.tokensUsed).toBeGreaterThan(0);
      expect(result.inputTokens).toBeUndefined();
      expect(result.outputTokens).toBeUndefined();
      expect(result.outputs.analysis).toBe(plainText);
    });

    it('handles empty stdout', () => {
      const result = adapter.testParseOutput('', '');

      expect(result.tokensUsed).toBe(0);
      expect(result.outputs.analysis).toContain('No output');
    });

    it('includes stderr in output when present', () => {
      const result = adapter.testParseOutput('', 'Warning: something happened');

      expect(result.outputs.analysis).toContain('STDERR');
      expect(result.outputs.analysis).toContain('Warning: something happened');
    });

    it('prepends stderr to JSON analysis when both present', () => {
      const stdout = JSON.stringify({
        analysis: 'Main output',
        tokens_used: 100,
      });

      const result = adapter.testParseOutput(stdout, 'Some warning');

      expect(result.outputs.analysis).toContain('STDERR');
      expect(result.outputs.analysis).toContain('Main output');
    });

    it('handles JSON array output as plain text fallback', () => {
      const stdout = JSON.stringify([1, 2, 3]);

      const result = adapter.testParseOutput(stdout, '');

      // Arrays are not objects, so falls back to plain text parsing
      expect(result.tokensUsed).toBeGreaterThan(0);
    });

    it('ignores non-numeric token values', () => {
      const stdout = JSON.stringify({
        analysis: 'result',
        tokens_used: 'not-a-number',
      });

      const result = adapter.testParseOutput(stdout, '');

      // Should fall back to estimation since tokens_used is not numeric
      expect(result.tokensUsed).toBeGreaterThan(0);
    });
  });

  describe('getTimeoutMs', () => {
    it('returns default timeout when no config set', () => {
      const timeout = adapter.testGetTimeoutMs();
      expect(timeout).toBeGreaterThan(0);
    });

    it('converts config seconds to milliseconds', async () => {
      await adapter.init({ timeout: 60 } as AdapterConfig);
      const timeout = adapter.testGetTimeoutMs();
      expect(timeout).toBe(60000);
    });

    it('throws on negative timeout', async () => {
      await adapter.init({ timeout: -1 } as AdapterConfig);
      expect(() => adapter.testGetTimeoutMs()).toThrow('negative');
    });

    it('handles zero timeout', async () => {
      await adapter.init({ timeout: 0 } as AdapterConfig);
      const timeout = adapter.testGetTimeoutMs();
      expect(timeout).toBe(0);
    });
  });

  describe('buildEnv', () => {
    it('returns empty object by default (backend-specific keys only)', () => {
      const env = adapter.testBuildEnv();
      expect(env).toEqual({});
    });
  });

  describe('getFilteredEnv', () => {
    it('includes allowlisted system vars', () => {
      const env = (adapter as any).getFilteredEnv();
      // PATH and HOME should be allowlisted
      if (process.env.PATH) {
        expect(env.PATH).toBe(process.env.PATH);
      }
      if (process.env.HOME) {
        expect(env.HOME).toBe(process.env.HOME);
      }
    });

    it('excludes non-allowlisted vars', () => {
      const originalSecret = process.env.MY_SECRET_VALUE;
      process.env.MY_SECRET_VALUE = 'should-not-pass';
      try {
        const env = (adapter as any).getFilteredEnv();
        expect(env.MY_SECRET_VALUE).toBeUndefined();
      } finally {
        if (originalSecret === undefined) {
          delete process.env.MY_SECRET_VALUE;
        } else {
          process.env.MY_SECRET_VALUE = originalSecret;
        }
      }
    });

    it('supports AIRUNX_EXTRA_ENV_VARS escape hatch', () => {
      const origExtra = process.env.AIRUNX_EXTRA_ENV_VARS;
      const origCustom = process.env.CUSTOM_VAR;
      process.env.AIRUNX_EXTRA_ENV_VARS = 'CUSTOM_VAR';
      process.env.CUSTOM_VAR = 'custom-value';
      try {
        const env = (adapter as any).getFilteredEnv();
        expect(env.CUSTOM_VAR).toBe('custom-value');
      } finally {
        if (origExtra === undefined) delete process.env.AIRUNX_EXTRA_ENV_VARS;
        else process.env.AIRUNX_EXTRA_ENV_VARS = origExtra;
        if (origCustom === undefined) delete process.env.CUSTOM_VAR;
        else process.env.CUSTOM_VAR = origCustom;
      }
    });

    it('never passes provider admin keys to CLI children', () => {
      const keys = ['ANTHROPIC_ADMIN_KEY', 'OPENAI_ADMIN_KEY'] as const;
      const saved = Object.fromEntries(
        [...keys, 'AIRUNX_EXTRA_ENV_VARS'].map((k) => [k, process.env[k]])
      );
      process.env.ANTHROPIC_ADMIN_KEY = 'sk-ant-admin01-secret';
      process.env.OPENAI_ADMIN_KEY = 'sk-admin-secret';
      // Even the escape hatch cannot opt them in
      process.env.AIRUNX_EXTRA_ENV_VARS = keys.join(',');
      try {
        const env = (adapter as any).getFilteredEnv();
        for (const key of keys) expect(key in env).toBe(false);
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });

    it('includes CI vars when CI=true', () => {
      const origCI = process.env.CI;
      const origActions = process.env.GITHUB_ACTIONS;
      process.env.CI = 'true';
      process.env.GITHUB_ACTIONS = 'true';
      try {
        const env = (adapter as any).getFilteredEnv();
        expect(env.CI).toBe('true');
        expect(env.GITHUB_ACTIONS).toBe('true');
      } finally {
        if (origCI === undefined) delete process.env.CI;
        else process.env.CI = origCI;
        if (origActions === undefined) delete process.env.GITHUB_ACTIONS;
        else process.env.GITHUB_ACTIONS = origActions;
      }
    });
  });

  describe('zero-token scenarios', () => {
    it('parseOutput returns tokensUsed: 0 for empty stdout', () => {
      const result = adapter.testParseOutput('', '');
      expect(result.tokensUsed).toBe(0);
    });

    it('parseOutput returns tokensUsed: 0 for whitespace-only stdout', () => {
      const result = adapter.testParseOutput('   \n  \n  ', '');
      expect(result.tokensUsed).toBe(0);
    });
  });

  describe('cost field behavior', () => {
    it('parseOutput with JSON tokens produces non-zero tokensUsed for cost calc', () => {
      const stdout = JSON.stringify({ analysis: 'test', tokens_used: 500 });
      const result = adapter.testParseOutput(stdout, '');
      expect(result.tokensUsed).toBe(500);
      // Cost is calculated in execute(), not parseOutput
    });
  });
});

// ============================================================
// Spawn observer (llm_spawn ledger) tests
// ============================================================

/** CLI adapter whose spawn is stubbed, for observer tests */
class StubSpawnAdapter extends BaseCliAdapter {
  name = 'claude-code' as const;
  public spawnResult: { stdout: string; stderr: string } | Error = {
    stdout: JSON.stringify({
      result: 'done',
      input_tokens: 1000,
      output_tokens: 200,
      total_cost_usd: 0.0123,
      session_id: 'sess-abc',
    }),
    stderr: '',
  };

  protected getCliConfig(): CliAdapterConfig {
    return {
      cliCommand: 'stub-cli',
      installInstructions: 'n/a',
      pricingMap: { 'stub-model': { input: 3, output: 15 } },
      defaultModel: 'stub-model',
    };
  }

  protected buildCliArgs(_request: ExecutionRequest, prompt: string): string[] {
    return ['-p', prompt];
  }

  protected async executeWithSpawn(): Promise<{
    stdout: string;
    stderr: string;
  }> {
    if (this.spawnResult instanceof Error) throw this.spawnResult;
    return this.spawnResult;
  }

  async init(config: AdapterConfig): Promise<void> {
    this.config = config;
    this.initialized = true;
  }

  async isAvailable(): Promise<BackendAvailability> {
    return { available: true };
  }
}

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
  spawnContext: { workflowId: 'wf-1', stage: 'implement', iteration: 2 },
  ...overrides,
});

describe('BaseCliAdapter spawn observer', () => {
  let adapter: StubSpawnAdapter;
  let records: SpawnRecord[];
  let observer: SpawnObserver;

  beforeEach(async () => {
    adapter = new StubSpawnAdapter();
    await adapter.init({ type: 'cli' });
    records = [];
    observer = { onSpawnComplete: (record) => records.push(record) };
    adapter.setSpawnObserver(observer);
  });

  it('emits exactly one record with all R1 fields on success', async () => {
    const result = await adapter.execute(makeRequest());

    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record).toMatchObject({
      workflowId: 'wf-1',
      stage: 'implement',
      iteration: 2,
      backend: 'claude-code',
      model: 'stub-model',
      agentRole: 'developer',
      tokensUsed: 1200,
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.0123,
      exitReason: 'ok',
      success: true,
      salvaged: false,
      providerSessionId: 'sess-abc',
    });
    expect(record.promptBytes).toBeGreaterThan(0);
    expect(record.promptSections?.total).toBe(record.promptBytes);
    expect(record.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(record.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(Date.parse(record.endedAt)).toBeGreaterThanOrEqual(
      Date.parse(record.startedAt)
    );
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    expect(record.spawnId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.spawnId).toBe(record.spawnId);
  });

  it('gives each spawn a unique spawnId', async () => {
    await adapter.execute(makeRequest());
    await adapter.execute(makeRequest());
    expect(records).toHaveLength(2);
    expect(records[0].spawnId).not.toBe(records[1].spawnId);
  });

  it('emits one record with salvage status and exit reason for a salvaged timeout', async () => {
    const timeout = new TimeoutError(1000, 'CLI execution');
    Object.assign(timeout, {
      stdout: JSON.stringify({ result: 'partial', tokens_used: 500 }),
      stderr: '',
    });
    adapter.spawnResult = timeout;

    const result = await adapter.execute(makeRequest());

    expect(result.success).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      exitReason: 'timeout',
      success: false,
      salvaged: true,
      tokensUsed: 500,
      errorCategory: 'TimeoutError',
    });
    expect(records[0].costUsd).toBeGreaterThan(0);
    expect(result.spawnId).toBe(records[0].spawnId);
  });

  it('classifies hang detection kills as hang', async () => {
    adapter.spawnResult = new TimeoutError(300000, 'Process hang detected');
    await adapter.execute(makeRequest());
    expect(records[0]).toMatchObject({ exitReason: 'hang', salvaged: false });
  });

  it('classifies signal kills as signal', async () => {
    adapter.spawnResult = Object.assign(new Error('killed'), {
      signal: 'SIGKILL',
    });
    await adapter.execute(makeRequest());
    expect(records[0]).toMatchObject({
      exitReason: 'signal',
      success: false,
      tokensUsed: 0,
    });
  });

  it('classifies non-zero exits as error', async () => {
    adapter.spawnResult = Object.assign(new Error('exit 1'), {
      code: 1,
      stderr: 'boom',
    });
    await adapter.execute(makeRequest());
    expect(records[0]).toMatchObject({ exitReason: 'error', success: false });
    expect(records[0].errorCategory).toBe('RetryableError');
  });

  it('records spawns without spawnContext as unattributed', async () => {
    await adapter.execute(makeRequest({ spawnContext: undefined }));
    expect(records).toHaveLength(1);
    expect(records[0].workflowId).toBeUndefined();
    expect(records[0].stage).toBeUndefined();
  });

  it('does not throw when no observer is attached', async () => {
    adapter.setSpawnObserver(undefined);
    const result = await adapter.execute(makeRequest());
    expect(result.success).toBe(true);
    expect(result.spawnId).toBeDefined();
  });

  it('is unaffected by an observer that throws', async () => {
    adapter.setSpawnObserver({
      onSpawnComplete: () => {
        throw new Error('ledger down');
      },
    });
    const result = await adapter.execute(makeRequest());
    expect(result.success).toBe(true);
  });
});

describe('BaseCliAdapter kill-time spend estimation', () => {
  let adapter: StubSpawnAdapter;
  let records: SpawnRecord[];
  /** stub-model input price, USD per 1M tokens */
  const INPUT_PRICE = 3;
  const floorFor = (promptBytes: number): number =>
    (promptBytes / KILL_ESTIMATE_BYTES_PER_TOKEN) * (INPUT_PRICE / 1_000_000);

  beforeEach(async () => {
    runSpendTracker.reset();
    runSpendTracker.setReportsDir(null); // no historical rate from disk
    adapter = new StubSpawnAdapter();
    await adapter.init({ type: 'cli' });
    records = [];
    adapter.setSpawnObserver({
      onSpawnComplete: (record) => records.push(record),
    });
  });

  const killed = (
    timing: { spawnStartedAt?: number; lastOutputAt?: number },
    kind: 'signal' | 'hang' = 'signal'
  ): Error =>
    kind === 'signal'
      ? Object.assign(new Error('Process killed by signal: SIGTERM'), {
          signal: 'SIGTERM',
          stdout: '',
          stderr: '',
          ...timing,
        })
      : Object.assign(new TimeoutError(300_000, 'Process hang detected'), {
          stdout: '',
          stderr: '',
          ...timing,
        });

  it('SIGTERM-killed spawn with empty stdout gets an estimated non-zero cost', async () => {
    adapter.spawnResult = killed({ spawnStartedAt: Date.now() });

    const result = await adapter.execute(makeRequest());

    const record = records[0];
    const floor = floorFor(record.promptBytes!);
    expect(record.exitReason).toBe('signal');
    expect(record.costProvenance).toBe('estimated');
    expect(record.estimationMethods).toEqual(['kill_time']);
    expect(record.costUsd).toBeGreaterThan(0);
    // No burn rate observed yet → the prompt-bytes floor alone
    expect(record.costUsd).toBeCloseTo(floor, 10);
    expect(record.spendLostUsd).toBe(record.costUsd);
    expect(record.spendSalvagedUsd).toBeUndefined();
    expect(result.metrics.cost).toBe(record.costUsd);
    expect(result.metrics.costSummary).toMatchObject({
      provenance: 'estimated',
      estimatedSpawns: 1,
      missingCostSpawns: 0,
      estimationMethods: ['kill_time'],
    });
    expect(result.metrics.costSummary!.estimatedMicroUsd).toBeGreaterThan(0);
  });

  it('long-elapsed active spawn: burn-rate estimate exceeds the floor', async () => {
    // Earlier spawn in this run: $1.00 over 100s → $0.01/s
    runSpendTracker.record({
      backend: 'claude-code',
      costUsd: 1,
      activeMs: 100_000,
    });
    const now = Date.now();
    adapter.spawnResult = killed({
      spawnStartedAt: now - 60_000,
      lastOutputAt: now,
    });

    await adapter.execute(makeRequest());

    const record = records[0];
    expect(record.costUsd!).toBeGreaterThan(floorFor(record.promptBytes!));
    expect(record.costUsd!).toBeCloseTo(0.6, 2); // 60s × $0.01/s
    expect(record.costUsd!).toBeLessThan(1); // below the cap
  });

  it('long-idle hang: estimate is bounded by the cap, not wall clock', async () => {
    runSpendTracker.record({
      backend: 'claude-code',
      costUsd: 1,
      activeMs: 100_000,
    });
    const now = Date.now();
    // Started 2h ago, went silent 1h ago, killed now
    adapter.spawnResult = killed(
      { spawnStartedAt: now - 2 * 3_600_000, lastOutputAt: now - 3_600_000 },
      'hang'
    );

    await adapter.execute(makeRequest());

    const record = records[0];
    expect(record.exitReason).toBe('hang');
    // 3600s active × $0.01/s = $36 → capped at the largest observed spawn
    expect(record.costUsd).toBe(1);
    expect(record.spendLostUsd).toBe(1);
  });

  it('caps at floor × multiplier when no spawn cost has been observed', () => {
    runSpendTracker.setReportsDir(null);
    const estimate = runSpendTracker.estimateKillTimeSpend({
      backend: 'codex',
      activeMs: 3_600_000,
      promptBytes: 4_000,
      inputPricePer1M: 1,
    });
    // No rate at all → floor only
    expect(estimate.costUsd).toBeCloseTo(0.001, 10);
    expect(estimate.capUsd).toBeCloseTo(
      0.001 * KILL_ESTIMATE_CAP_FLOOR_MULTIPLIER,
      10
    );
    expect(estimate.rateSource).toBe('none');
  });

  it('clean exit still prefers CLI-reported figures', async () => {
    await adapter.execute(makeRequest());

    const record = records[0];
    expect(record.exitReason).toBe('ok');
    expect(record.costUsd).toBe(0.0123);
    expect(record.costProvenance).toBe('reported');
    expect(record.estimationMethods).not.toContain('kill_time');
    expect(record.spendLostUsd).toBeUndefined();
  });

  it('records salvaged partial cost as spend_salvaged without estimating', async () => {
    const timeout = new TimeoutError(1000, 'CLI execution');
    Object.assign(timeout, {
      stdout: JSON.stringify({ result: 'partial', total_cost_usd: 0.2 }),
      stderr: '',
    });
    adapter.spawnResult = timeout;

    await adapter.execute(makeRequest());

    const record = records[0];
    expect(record.salvaged).toBe(true);
    expect(record.costProvenance).toBe('reported');
    expect(record.spendSalvagedUsd).toBe(0.2);
    expect(record.spendLostUsd).toBeUndefined();
  });

  it('does not estimate a quick non-zero exit (rejection before work)', async () => {
    const now = Date.now();
    adapter.spawnResult = Object.assign(new Error('exit 1'), {
      code: 1,
      stdout: 'Error: invalid model',
      stderr: '',
      spawnStartedAt: now - 500,
      lastOutputAt: now,
    });

    const result = await adapter.execute(makeRequest());

    expect(records[0].exitReason).toBe('error');
    expect(records[0].costProvenance).toBeUndefined();
    expect(records[0].spendLostUsd).toBeUndefined();
    expect(result.metrics.cost).toBe(0);
  });
});

describe('CompoundEngineeringAdapter spawn attribution', () => {
  it('sub-agent spawns carry the parent spawn_id as parentSpawnId', async () => {
    const adapter = new CompoundEngineeringAdapter();
    // Skip CLI checks: mark initialized directly
    Object.assign(adapter, { config: { type: 'cli' }, initialized: true });
    vi.spyOn(
      adapter as unknown as { executeWithSpawn: () => Promise<unknown> },
      'executeWithSpawn'
    ).mockResolvedValue({
      stdout: JSON.stringify({
        result: 'analysis',
        input_tokens: 10,
        output_tokens: 5,
        total_cost_usd: 0.01,
      }),
      stderr: '',
    });

    const records: SpawnRecord[] = [];
    adapter.setSpawnObserver({
      onSpawnComplete: (record) => records.push(record),
    });

    const result = await adapter.execute(
      makeRequest({ task: 'Do a system design review of the module' })
    );

    // main spawn + 3 default sub-agents
    expect(records.length).toBe(4);
    const [main, ...subs] = records;
    expect(main.parentSpawnId).toBeUndefined();
    expect(result.spawnId).toBe(main.spawnId);
    for (const sub of subs) {
      expect(sub.parentSpawnId).toBe(main.spawnId);
      expect(sub).toMatchObject({
        workflowId: 'wf-1',
        stage: 'implement',
        iteration: 2,
      });
      expect(sub.spawnId).not.toBe(main.spawnId);
    }
    // Per-spawn costs sum to the merged result's cost
    const sum = records.reduce((acc, r) => acc + (r.costUsd ?? 0), 0);
    expect(sum).toBeCloseTo(result.metrics.cost ?? 0, 10);
  });
});

// ─── Signal ladder (U9) — real child processes ───────────────────────────────

const FAKE_CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'kill-path',
  'fake-cli.mjs'
);

/** Runs tests/fixtures/kill-path/fake-cli.mjs as the CLI, short ladder */
class ProcessCliAdapter extends BaseCliAdapter {
  name = 'claude-code' as const;
  public mode: 'honor' | 'ignore' | 'late' | 'finish' = 'honor';
  public logPath = '';
  public ladder: SignalLadder = {
    interruptGraceMs: 300,
    terminateGraceMs: 300,
    postKillSettleMs: 300,
  };

  protected getCliConfig(): CliAdapterConfig {
    return {
      cliCommand: process.execPath,
      installInstructions: 'n/a',
      pricingMap: { 'stub-model': { input: 3, output: 15 } },
      defaultModel: 'stub-model',
    };
  }

  protected buildCliArgs(): string[] {
    return [FAKE_CLI, this.mode, this.logPath];
  }

  protected getSignalLadder(): SignalLadder {
    return this.ladder;
  }

  public defaultLadder(): SignalLadder {
    return super.getSignalLadder();
  }

  async init(config: AdapterConfig): Promise<void> {
    this.config = config;
    this.initialized = true;
  }

  async isAvailable(): Promise<BackendAvailability> {
    return { available: true };
  }
}

describe.skipIf(process.platform === 'win32')(
  'BaseCliAdapter signal ladder (real processes)',
  () => {
    let adapter: ProcessCliAdapter;
    let records: SpawnRecord[];
    let workDir: string;

    const signalLog = (): string[] =>
      existsSync(adapter.logPath)
        ? readFileSync(adapter.logPath, 'utf-8').split('\n').filter(Boolean)
        : [];
    const signalsReceived = (): string[] =>
      signalLog().filter((l) => !l.startsWith('pid '));
    const cliPid = (): number =>
      Number(
        signalLog()
          .find((l) => l.startsWith('pid '))
          ?.slice(4)
      );
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    /** Resolves once the fake CLI has installed its signal handlers */
    const cliReady = async (): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!cliPid() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const request = (timeoutMs: number): ExecutionRequest => ({
      ...makeRequest({ context: { workingDirectory: workDir } }),
      fidelityParams: { timeoutMs },
    });

    beforeEach(async () => {
      shutdownCoordinator.reset();
      runSpendTracker.reset();
      runSpendTracker.setReportsDir(null);
      workDir = mkdtempSync(join(tmpdir(), 'kill-path-'));
      adapter = new ProcessCliAdapter();
      adapter.logPath = join(workDir, 'signals.log');
      await adapter.init({ type: 'cli' });
      records = [];
      adapter.setSpawnObserver({
        onSpawnComplete: (record) => records.push(record),
      });
    });

    afterEach(() => {
      shutdownCoordinator.reset();
      rmSync(workDir, { recursive: true, force: true });
    });

    it('default ladder is SIGINT → 3s → SIGTERM → 2s → SIGKILL (5s)', () => {
      const ladder = adapter.defaultLadder();
      expect(ladder.interruptGraceMs).toBe(3_000);
      expect(ladder.terminateGraceMs).toBe(2_000);
      expect(ladder.interruptGraceMs + ladder.terminateGraceMs).toBe(5_000);
    });

    it('clean exit: reported figures, no signals sent', async () => {
      adapter.mode = 'finish';
      const result = await adapter.execute(request(10_000));
      expect(result.success).toBe(true);
      expect(records).toHaveLength(1);
      expect(records[0].exitReason).toBe('ok');
      expect(records[0].costProvenance).toBe('reported');
      expect(signalsReceived()).toEqual([]);
    });

    it('timeout: CLI honoring SIGINT emits result JSON → spawn event is reported', async () => {
      adapter.mode = 'honor';
      const result = await adapter.execute(request(300));

      expect(result.success).toBe(false);
      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record.exitReason).toBe('timeout');
      expect(record.costProvenance).toBe('reported');
      expect(record.costUsd).toBeCloseTo(0.123, 6);
      expect(record.salvaged).toBe(true);
      expect(record.providerSessionId).toBe('fake-session');
      expect(record.estimationMethods).not.toContain('kill_time');
      // Exactly one interrupt, no escalation needed
      expect(signalsReceived()).toEqual(['SIGINT']);
    });

    it('timeout: CLI ignoring SIGINT is escalated to SIGTERM then SIGKILL and actually exits', async () => {
      adapter.mode = 'ignore';
      const started = Date.now();
      const result = await adapter.execute(request(200));
      const elapsed = Date.now() - started;

      expect(result.success).toBe(false);
      expect(signalsReceived()).toEqual(['SIGINT', 'SIGTERM']);
      // Asserted on exit, not child.killed: the process is gone
      expect(isAlive(cliPid())).toBe(false);
      expect(elapsed).toBeLessThan(5_000);
      const record = records[0];
      expect(record.exitReason).toBe('timeout');
      expect(record.costProvenance).toBe('estimated');
      expect(record.estimationMethods).toContain('kill_time');
      expect(record.costUsd).toBeGreaterThan(0);
    });

    it('output written after the signal is captured and parsed', async () => {
      adapter.mode = 'late';
      const result = await adapter.execute(request(300));
      expect(String(result.outputs.stdout)).toContain(
        'partial work after signal'
      );
      expect(records[0].exitReason).toBe('timeout');
      expect(signalsReceived()).toEqual(['SIGINT']);
    });

    it('shutdown: answering CLI is reported, event written before flush hooks', async () => {
      adapter.mode = 'honor';
      const recordsAtFlush: number[] = [];
      const interruptedAtFlush: InterruptedSpawnSummary[] = [];
      shutdownCoordinator.onFlush((interrupted) => {
        recordsAtFlush.push(records.length);
        interruptedAtFlush.push(...interrupted);
      });

      const pending = adapter.execute(request(60_000));
      await cliReady();
      expect(shutdownCoordinator.activeSpawnCount).toBe(1);
      await shutdownCoordinator.shutdown();
      const result = await pending;

      expect(result.success).toBe(false);
      expect(records).toHaveLength(1);
      expect(records[0].exitReason).toBe('signal');
      expect(records[0].costProvenance).toBe('reported');
      expect(recordsAtFlush).toEqual([1]);
      expect(interruptedAtFlush).toHaveLength(1);
      expect(interruptedAtFlush[0]).toMatchObject({
        workflowId: 'wf-1',
        stage: 'implement',
        backend: 'claude-code',
      });
      expect(interruptedAtFlush[0].costUsd).toBeCloseTo(0.123, 6);
      expect(signalsReceived()).toEqual(['SIGINT']);
      expect(shutdownCoordinator.activeSpawnCount).toBe(0);
    });

    it('shutdown: non-answering CLI gets an estimated event; a second shutdown does not re-signal', async () => {
      adapter.mode = 'ignore';
      const pending = adapter.execute(request(60_000));
      await cliReady();
      const first = shutdownCoordinator.shutdown();
      const second = shutdownCoordinator.shutdown();
      expect(second).toBe(first);
      await first;
      await pending;

      expect(records).toHaveLength(1);
      expect(records[0].exitReason).toBe('signal');
      expect(records[0].costProvenance).toBe('estimated');
      expect(records[0].estimationMethods).toContain('kill_time');
      expect(signalsReceived()).toEqual(['SIGINT', 'SIGTERM']);
      expect(isAlive(cliPid())).toBe(false);
    });

    it('shutdown after terminal Ctrl-C: no second SIGINT, ladder continues with SIGTERM', async () => {
      adapter.mode = 'ignore';
      const pending = adapter.execute(request(60_000));
      await cliReady();
      await shutdownCoordinator.shutdown({ alreadySignaled: true });
      await pending;
      expect(signalsReceived()).toEqual(['SIGTERM']);
      expect(isAlive(cliPid())).toBe(false);
    });

    it('no new spawns once shutdown began, and no ledger event for them', async () => {
      await shutdownCoordinator.shutdown();
      const result = await adapter.execute(request(10_000));
      expect(result.success).toBe(false);
      expect(result.errors[0]).toBeInstanceOf(ShutdownInProgressError);
      expect(records).toHaveLength(0);
      expect(signalLog()).toEqual([]);
    });
  }
);
