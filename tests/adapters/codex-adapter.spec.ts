/**
 * CodexAdapter tests
 * Validates CLI argument construction for OpenAI Codex CLI
 */

import * as path from 'path';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex-adapter.js';
import type {
  AdapterConfig,
  AttemptRecord,
  ExecutionRequest,
  ExecutionResult,
  SpawnRecord,
} from '../../src/core/adapter-types.js';
import {
  OPENAI_CACHE_PRICING,
  OPENAI_PRICING,
  calculateCost,
} from '../../src/adapters/pricing.js';
import { RetryableError } from '../../src/utils/errors.js';

// Create a test subclass to access protected methods
class TestableCodexAdapter extends CodexAdapter {
  public testBuildCliArgs(request: ExecutionRequest, prompt: string): string[] {
    return this.buildCliArgs(request, prompt);
  }

  public setBackendModel(model: string): void {
    this.config = { ...this.config, model } as typeof this.config;
  }
}

/**
 * Factory function for creating type-safe mock execution requests
 * Uses destructuring to separate nested objects for proper deep merging
 */
const createMockRequest = (
  overrides: Partial<ExecutionRequest> = {}
): ExecutionRequest => {
  const baseRequest: ExecutionRequest = {
    agent: {
      role: 'developer',
      capabilities: [],
      contextRequired: [],
    },
    task: 'test task',
    context: {
      workingDirectory: '/test/path',
    },
  };

  const { agent, context, ...rest } = overrides;

  return {
    ...baseRequest,
    ...rest,
    agent: { ...baseRequest.agent, ...agent },
    context: { ...baseRequest.context, ...context },
  };
};

describe('CodexAdapter', () => {
  let adapter: TestableCodexAdapter;

  beforeEach(() => {
    adapter = new TestableCodexAdapter();
  });

  describe('buildCliArgs', () => {
    it('should include exec subcommand as first argument', () => {
      const request = createMockRequest({
        context: { workingDirectory: '/test/path' },
      });

      const args = adapter.testBuildCliArgs(request, 'test prompt');

      expect(args[0]).toBe('exec');
    });

    it('should use -C flag for working directory', () => {
      const request = createMockRequest({
        context: { workingDirectory: '/test/path' },
      });

      const args = adapter.testBuildCliArgs(request, 'test prompt');

      expect(args).toContain('-C');
      expect(args[args.indexOf('-C') + 1]).toBe('/test/path');
    });

    it('should include -- separator before prompt', () => {
      const request = createMockRequest({
        context: { workingDirectory: '/test/path' },
      });

      const args = adapter.testBuildCliArgs(request, 'test prompt');
      const separatorIndex = args.indexOf('--');

      expect(separatorIndex).toBeGreaterThan(0);
      expect(args[separatorIndex + 1]).toBe('test prompt');
    });

    it('should produce correct argument order: exec -C <path> [approval-flags] -- <prompt>', () => {
      const request = createMockRequest({
        context: { workingDirectory: '/test/path' },
      });

      const args = adapter.testBuildCliArgs(request, 'test prompt');

      // Default approval_mode is 'auto', which adds '--sandbox workspace-write'
      // No --model flag when no explicit model override — let CLI use its own default
      expect(args).toEqual([
        'exec',
        '-C',
        '/test/path',
        '--json',
        '--sandbox',
        'workspace-write',
        '--',
        'test prompt',
      ]);
    });

    it('should not pass the removed --full-auto flag', () => {
      const args = adapter.testBuildCliArgs(createMockRequest(), 'test prompt');

      expect(args).not.toContain('--full-auto');
    });

    it('should pass --sandbox only once in pipeline mode', () => {
      const request = createMockRequest({
        context: {
          workingDirectory: '/test/path',
          additionalContext: { pipelineMode: true },
        },
      });

      const args = adapter.testBuildCliArgs(request, 'test prompt');

      expect(args.filter((arg) => arg === '--sandbox')).toHaveLength(1);
      expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write');
    });

    it('should handle relative paths by normalizing to absolute', () => {
      const request = createMockRequest({
        context: { workingDirectory: './relative/path' },
      });

      const args = adapter.testBuildCliArgs(request, 'test prompt');
      const pathArg = args[args.indexOf('-C') + 1];

      expect(path.isAbsolute(pathArg)).toBe(true);
    });

    it('should fallback to process.cwd() when workingDirectory is undefined', () => {
      // @ts-expect-error Testing fallback for undefined workingDirectory, which the type disallows
      const request = createMockRequest({
        context: { workingDirectory: undefined },
      });

      const args = adapter.testBuildCliArgs(request, 'test prompt');
      const pathArg = args[args.indexOf('-C') + 1];

      expect(pathArg).toBe(process.cwd());
    });

    it('should handle prompts with special characters', () => {
      const request = createMockRequest({
        context: { workingDirectory: '/test/path' },
      });
      const specialPrompt =
        'test with "quotes" and \'single quotes\' and $vars';

      const args = adapter.testBuildCliArgs(request, specialPrompt);

      expect(args[args.indexOf('--') + 1]).toBe(specialPrompt);
    });

    it('should handle paths with spaces by normalizing', () => {
      const request = createMockRequest({
        context: { workingDirectory: '/path/with spaces/test' },
      });

      const args = adapter.testBuildCliArgs(request, 'test prompt');
      const pathArg = args[args.indexOf('-C') + 1];

      expect(pathArg).toBe('/path/with spaces/test');
    });
  });

  describe('execute model fallback', () => {
    const baseExecute = Object.getPrototypeOf(CodexAdapter.prototype) as {
      execute: (request: ExecutionRequest) => Promise<ExecutionResult>;
    };

    const result = (success: boolean, stderr = ''): ExecutionResult => ({
      success,
      outputs: { stdout: success ? 'OK' : '', stderr },
      metrics: { tokensUsed: 0, duration: 0 },
      errors: [],
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('retries without --model when an older Codex CLI rejects a GPT-6 model', async () => {
      // Exact error text from Codex CLI 0.144.5 on a ChatGPT login
      const rejection =
        'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account."}}';
      const spy = vi
        .spyOn(baseExecute, 'execute')
        .mockResolvedValueOnce(result(false, rejection))
        .mockResolvedValueOnce(result(true));

      const outcome = await adapter.execute(
        createMockRequest({ agent: { preferredModel: 'gpt-6.1-sol' } })
      );

      expect(outcome.success).toBe(true);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[0][0].agent.preferredModel).toBe('gpt-6.1-sol');
      expect(spy.mock.calls[1][0].agent.preferredModel).toBeUndefined();
    });

    it('omits --model on retry even when the backend config sets a model', async () => {
      adapter.setBackendModel('gpt-6.1-sol');
      const spy = vi
        .spyOn(baseExecute, 'execute')
        .mockResolvedValueOnce(
          result(false, "The 'gpt-6.1-sol' model is not supported")
        )
        .mockResolvedValueOnce(result(true));

      await adapter.execute(createMockRequest());

      const firstArgs = adapter.testBuildCliArgs(spy.mock.calls[0][0], 'p');
      const retryArgs = adapter.testBuildCliArgs(spy.mock.calls[1][0], 'p');
      expect(firstArgs).toContain('--model');
      expect(retryArgs).not.toContain('--model');
    });

    it('does not retry on unrelated failures', async () => {
      const spy = vi
        .spyOn(baseExecute, 'execute')
        .mockResolvedValueOnce(result(false, 'network timeout'));

      const outcome = await adapter.execute(
        createMockRequest({ agent: { preferredModel: 'gpt-6.1-sol' } })
      );

      expect(outcome.success).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('adapter properties', () => {
    it('should have name set to codex', () => {
      expect(adapter.name).toBe('codex');
    });

    it('should have type set to cli', () => {
      expect(adapter.type).toBe('cli');
    });
  });
});

/** CodexAdapter with the CLI spawn stubbed and auth mode settable */
class StubbedCodexAdapter extends CodexAdapter {
  public stdout = '';
  public records: SpawnRecord[] = [];

  setSubscription(subscription: boolean): void {
    (this as unknown as { useSubscriptionAuth: boolean }).useSubscriptionAuth =
      subscription;
  }

  async init(config: AdapterConfig): Promise<void> {
    this.config = config;
    this.initialized = true;
    this.setSpawnObserver({
      onSpawnComplete: (record) => this.records.push(record),
    });
  }

  protected async executeWithSpawn(): Promise<{
    stdout: string;
    stderr: string;
  }> {
    return { stdout: this.stdout, stderr: '' };
  }
}

const jsonl = (...events: object[]): string =>
  events.map((e) => JSON.stringify(e)).join('\n');

describe('CodexAdapter normalized tokens and cache-aware cost', () => {
  let adapter: StubbedCodexAdapter;

  beforeEach(async () => {
    adapter = new StubbedCodexAdapter();
    await adapter.init({ type: 'cli', model: 'gpt-5.6-terra' });
  });

  it('subtracts cached tokens from input before pricing (no double count)', async () => {
    adapter.stdout = jsonl(
      { type: 'thread.started', thread_id: 'th-1' },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 60_000,
          cached_input_tokens: 50_000,
          output_tokens: 4_000,
          reasoning_output_tokens: 1_500,
        },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 40_000,
          cached_input_tokens: 30_000,
          output_tokens: 1_000,
          reasoning_output_tokens: 500,
        },
      },
      { type: 'item.completed', item: { text: 'done' } }
    );
    const result = await adapter.execute(createMockRequest());
    const [record] = adapter.records;

    // input_tokens is already inclusive of cached tokens
    expect(record.tokens).toEqual({
      inputTokens: 100_000,
      outputTokens: 5_000,
      cacheReadInputTokens: 80_000,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 2_000,
    });
    const p = OPENAI_PRICING['gpt-5.6-terra'];
    const c = OPENAI_CACHE_PRICING['gpt-5.6-terra'];
    const expected =
      (20_000 * p.input + 80_000 * c.cacheRead + 5_000 * p.output) / 1e6;
    expect(result.metrics.cost).toBeCloseTo(expected, 12);
    // Cheaper than pricing every input token at the full rate
    expect(result.metrics.cost!).toBeLessThan(calculateCost(100_000, 5_000, p));
    expect(record.costProvenance).toBe('derived');
    expect(record.providerUsage).toEqual({
      input_tokens: 100_000,
      cached_input_tokens: 80_000,
      output_tokens: 5_000,
      reasoning_output_tokens: 2_000,
    });
    // Legacy totals unchanged (no breakdown summing)
    expect(result.metrics.tokensUsed).toBe(105_000);
  });

  it('records cache_write_input_tokens when present', async () => {
    adapter.stdout = jsonl({
      type: 'turn.completed',
      usage: {
        input_tokens: 1_000,
        cached_input_tokens: 200,
        cache_write_input_tokens: 300,
        output_tokens: 10,
      },
    });
    await adapter.execute(createMockRequest());
    expect(adapter.records[0].tokens).toMatchObject({
      inputTokens: 1_000,
      cacheReadInputTokens: 200,
      cacheWriteInputTokens: 300,
    });
  });

  it('handles absent cache fields as zero cache tokens', async () => {
    adapter.stdout = jsonl({
      type: 'turn.completed',
      usage: { input_tokens: 1_000, output_tokens: 100 },
    });
    const result = await adapter.execute(createMockRequest());
    expect(adapter.records[0].tokens).toEqual({
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
    expect(result.metrics.cost).toBeCloseTo(
      calculateCost(1_000, 100, OPENAI_PRICING['gpt-5.6-terra']),
      12
    );
  });

  it('tags billing basis from the resolved auth mode', async () => {
    adapter.stdout = jsonl({
      type: 'turn.completed',
      usage: { input_tokens: 1_000, output_tokens: 100 },
    });
    adapter.setSubscription(true);
    await adapter.execute(createMockRequest());
    adapter.setSubscription(false);
    await adapter.execute(createMockRequest());
    expect(adapter.records.map((r) => r.billingBasis)).toEqual([
      'api_equivalent',
      'billed',
    ]);
  });
});

describe('CodexAdapter model-rejection retry ledger (U4)', () => {
  /** Stub whose spawns are scripted: each entry returns or throws */
  class ScriptedCodexAdapter extends CodexAdapter {
    public records: SpawnRecord[] = [];
    public attempts: AttemptRecord[] = [];
    public script: Array<() => { stdout: string; stderr: string }> = [];

    async init(config: AdapterConfig): Promise<void> {
      this.config = config;
      this.initialized = true;
      this.setSpawnObserver({
        onSpawnComplete: (record) => this.records.push(record),
        onAttempt: (record) => this.attempts.push(record),
      });
    }

    protected async executeWithSpawn(): Promise<{
      stdout: string;
      stderr: string;
    }> {
      const next = this.script.shift();
      if (!next) throw new Error('no scripted spawn left');
      return next();
    }
  }

  const usage = (input: number, output: number): string =>
    jsonl(
      {
        type: 'turn.completed',
        usage: { input_tokens: input, output_tokens: output },
      },
      { type: 'item.completed', item: { text: 'done' } }
    );

  it('emits two llm_spawn events, one attempt event, and sums both spawns', async () => {
    const adapter = new ScriptedCodexAdapter();
    await adapter.init({ type: 'cli', model: 'gpt-5.6-terra' });
    adapter.script = [
      () => {
        // Rejected after doing some billable work (partial usage salvaged)
        throw Object.assign(new RetryableError('codex exited 1', undefined), {
          stdout: usage(10_000, 500),
          stderr: "The 'gpt-5.6-terra' model is not supported",
        });
      },
      () => ({ stdout: usage(20_000, 1_000), stderr: '' }),
    ];

    const result = await adapter.execute(
      createMockRequest({
        spawnContext: {
          workflowId: 'wf-codex',
          stage: 'developer',
          iteration: 1,
        },
      })
    );

    expect(result.success).toBe(true);
    expect(adapter.records).toHaveLength(2);
    const [rejected, retry] = adapter.records;
    expect(rejected.success).toBe(false);
    expect(rejected.costUsd).toBeGreaterThan(0);

    expect(adapter.attempts).toHaveLength(1);
    expect(adapter.attempts[0]).toMatchObject({
      attempt: 1,
      outcome: 'failure',
      errorCategory: 'model_rejected',
      backend: 'codex',
      spawnId: rejected.spawnId,
      workflowId: 'wf-codex',
      stage: 'developer',
      costUsd: rejected.costUsd,
    });

    // Stage aggregate equals the spawn sum
    expect(result.metrics.cost).toBeCloseTo(
      (rejected.costUsd ?? 0) + (retry.costUsd ?? 0),
      10
    );
    expect(result.metrics.spawnCount).toBe(2);
    expect(result.metrics.tokensUsed).toBe(
      rejected.tokensUsed + retry.tokensUsed
    );
    const summary = result.metrics.costSummary;
    expect(summary?.spawnCount).toBe(2);
    expect(
      (summary?.billedMicroUsd ?? 0) +
        (summary?.apiEquivalentMicroUsd ?? 0) +
        (summary?.unknownBasisMicroUsd ?? 0)
    ).toBe(
      Math.round((rejected.costUsd ?? 0) * 1e6) +
        Math.round((retry.costUsd ?? 0) * 1e6)
    );
    expect(result.spawnId).toBe(retry.spawnId);
  });
});
