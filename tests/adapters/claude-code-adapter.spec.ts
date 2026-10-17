/**
 * ClaudeCodeAdapter tests
 * Validates CLI argument construction for Claude Code CLI
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code-adapter.js';
import {
  ANTHROPIC_CACHE_PRICING,
  ANTHROPIC_PRICING,
  PRICING_VERSION,
} from '../../src/adapters/pricing.js';
import {
  AGENT_DISALLOWED_TOOLS,
  ORCHESTRATOR_DISALLOWED_TOOLS,
} from '../../src/adapters/constants.js';
import { AgentRoleSchema } from '../../src/core/types.js';
import type {
  AdapterConfig,
  ExecutionRequest,
  SpawnRecord,
} from '../../src/core/adapter-types.js';
import type { ParsedCliOutput } from '../../src/adapters/base-cli-adapter.js';

// Create a test subclass to access protected methods
class TestableClaudeCodeAdapter extends ClaudeCodeAdapter {
  public testBuildCliArgs(request: ExecutionRequest, prompt: string): string[] {
    return this.buildCliArgs(request, prompt);
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

describe('ClaudeCodeAdapter', () => {
  let adapter: TestableClaudeCodeAdapter;

  beforeEach(() => {
    adapter = new TestableClaudeCodeAdapter();
  });

  describe('buildCliArgs', () => {
    it('should include -p flag for print mode', () => {
      const request = createMockRequest();
      const args = adapter.testBuildCliArgs(request, 'test prompt');

      expect(args).toContain('-p');
    });

    it('should include --output-format json', () => {
      const request = createMockRequest();
      const args = adapter.testBuildCliArgs(request, 'test prompt');

      expect(args).toContain('--output-format');
      expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    });

    it('should include --no-session-persistence', () => {
      const request = createMockRequest();
      const args = adapter.testBuildCliArgs(request, 'test prompt');

      expect(args).toContain('--no-session-persistence');
    });

    it('should place prompt as the last argument', () => {
      const request = createMockRequest();
      const prompt = 'test prompt';
      const args = adapter.testBuildCliArgs(request, prompt);

      expect(args[args.length - 1]).toBe(prompt);
    });

    it('should handle prompts with special characters', () => {
      const request = createMockRequest();
      const specialPrompt =
        'test with "quotes" and \'single quotes\' and $vars';
      const args = adapter.testBuildCliArgs(request, specialPrompt);

      expect(args[args.length - 1]).toBe(specialPrompt);
    });
  });

  describe('disallowed tools for non-orchestrator agents', () => {
    // Dynamically derive non-orchestrator roles from the schema
    const nonOrchestratorRoles = AgentRoleSchema.options.filter(
      (role) => role !== 'orchestrator'
    );

    it.each(nonOrchestratorRoles)(
      'adds --disallowedTools for non-orchestrator role: %s',
      (role) => {
        const request = createMockRequest({ agent: { role } });
        const args = adapter.testBuildCliArgs(request, 'test prompt');

        expect(args).toContain('--disallowedTools');
        const toolsIndex = args.indexOf('--disallowedTools');
        expect(args[toolsIndex + 1]).toBe(AGENT_DISALLOWED_TOOLS.join(','));
      }
    );

    it('adds ORCHESTRATOR_DISALLOWED_TOOLS for orchestrator role', () => {
      const request = createMockRequest({ agent: { role: 'orchestrator' } });
      const args = adapter.testBuildCliArgs(request, 'test prompt');

      expect(args).toContain('--disallowedTools');
      const toolsIndex = args.indexOf('--disallowedTools');
      expect(args[toolsIndex + 1]).toBe(
        ORCHESTRATOR_DISALLOWED_TOOLS.join(',')
      );
    });
  });

  describe('adapter properties', () => {
    it('should have name set to claude-code', () => {
      expect(adapter.name).toBe('claude-code');
    });

    it('should have type set to cli', () => {
      expect(adapter.type).toBe('cli');
    });
  });
});

/** ClaudeCodeAdapter with the CLI spawn stubbed and auth mode settable */
class StubbedClaudeCodeAdapter extends ClaudeCodeAdapter {
  public stdout = '';
  public records: SpawnRecord[] = [];

  setSubscription(subscription: boolean): void {
    (this as unknown as { useSubscriptionAuth: boolean }).useSubscriptionAuth =
      subscription;
  }

  public parse(stdout: string): ParsedCliOutput {
    return this.parseOutput(stdout, '');
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

const MTOK = 1_000_000;

describe('ClaudeCodeAdapter cost provenance and normalized tokens', () => {
  let adapter: StubbedClaudeCodeAdapter;

  beforeEach(async () => {
    adapter = new StubbedClaudeCodeAdapter();
    await adapter.init({ type: 'cli', model: 'claude-sonnet-5-5' });
  });

  // `usage` covers only the main thread; `modelUsage` includes subagents
  const resultWithSubagents = {
    type: 'result',
    subtype: 'success',
    result: 'done',
    session_id: 'sess-1',
    total_cost_usd: 0.4321,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 1_000,
      cache_creation_input_tokens: 200,
      cache_creation: {
        ephemeral_5m_input_tokens: 200,
        ephemeral_1h_input_tokens: 0,
      },
    },
    modelUsage: {
      'claude-sonnet-5-5': {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 1_000,
        cacheCreationInputTokens: 200,
        costUSD: 0.3,
        costBasis: 'api',
      },
      'claude-haiku-5-5': {
        inputTokens: 400,
        outputTokens: 300,
        cacheReadInputTokens: 5_000,
        cacheCreationInputTokens: 0,
        costUSD: 0.1321,
      },
    },
  };

  it('tags total_cost_usd as reported and takes tokens from modelUsage', async () => {
    adapter.stdout = JSON.stringify(resultWithSubagents);
    const result = await adapter.execute(createMockRequest());

    expect(result.metrics.cost).toBe(0.4321);
    const [record] = adapter.records;
    expect(record.costProvenance).toBe('reported');
    expect(record.costUsd).toBe(0.4321);
    // Normalized tokens include the subagent (haiku) usage missing from `usage`
    expect(record.tokens).toMatchObject({
      inputTokens: 100 + 1_000 + 200 + 400 + 5_000,
      outputTokens: 350,
      cacheReadInputTokens: 6_000,
      cacheWriteInputTokens: 200,
    });
    expect(record.tokenProvenance).toBe('reported');
    // Derived cross-check kept alongside the reported figure
    expect(record.derivedCostUsd).toBeGreaterThan(0);
    expect(record.pricingVersion).toBe(PRICING_VERSION);
    expect(record.costBasis).toEqual({ 'claude-sonnet-5-5': 'api' });
    // Served models come from modelUsage, not the configured model
    expect(record.responseModels).toEqual([
      'claude-haiku-5-5',
      'claude-sonnet-5-5',
    ]);
    expect(record.providerUsage).toMatchObject({
      total_cost_usd: 0.4321,
      'usage.input_tokens': 100,
      'modelUsage.claude-haiku-5-5.inputTokens': 400,
    });
    expect(record.semconvVersion).toBeDefined();
    // Raw legacy fields stay the CLI's main-thread values
    expect(record.inputTokens).toBe(100);
    expect(result.metrics.costSummary).toMatchObject({
      provenance: 'reported',
      reportedMicroUsd: 432_100,
      spawnCount: 1,
    });
  });

  it('normalizes cache read + 5m + 1h writes and prices each bucket', async () => {
    adapter.stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      usage: {
        input_tokens: 1_000,
        output_tokens: 2_000,
        cache_read_input_tokens: 10_000,
        cache_creation_input_tokens: 7_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 3_000,
          ephemeral_1h_input_tokens: 4_000,
        },
      },
    });
    const result = await adapter.execute(createMockRequest());
    const [record] = adapter.records;

    expect(record.tokens).toEqual({
      inputTokens: 1_000 + 10_000 + 7_000,
      outputTokens: 2_000,
      cacheReadInputTokens: 10_000,
      cacheWriteInputTokens: 7_000,
      cacheWrite5mInputTokens: 3_000,
      cacheWrite1hInputTokens: 4_000,
    });
    const p = ANTHROPIC_PRICING['claude-sonnet-5-5'];
    const c = ANTHROPIC_CACHE_PRICING['claude-sonnet-5-5'];
    const expected =
      (1_000 * p.input +
        10_000 * c.cacheRead +
        3_000 * c.cacheWrite5m +
        4_000 * c.cacheWrite1h +
        2_000 * p.output) /
      MTOK;
    expect(record.costProvenance).toBe('derived');
    expect(result.metrics.cost).toBeCloseTo(expected, 12);
    expect(record.pricingVersion).toBe(PRICING_VERSION);
  });

  it('treats a zeroed error_during_execution cost as missing, not $0', () => {
    const parsed = adapter.parse(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: {},
      })
    );
    expect(parsed.totalCostUsd).toBeUndefined();
  });

  it('records a missing cost (not reported $0) for a zeroed error result', async () => {
    adapter.stdout = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const result = await adapter.execute(createMockRequest());
    const [record] = adapter.records;
    expect(record.costProvenance).toBeUndefined();
    expect(record.costUsd).toBeUndefined();
    expect(result.metrics.costSummary).toMatchObject({
      missingCostSpawns: 1,
      reportedMicroUsd: 0,
    });
    expect(result.metrics.costSummary?.provenance).toBeUndefined();
  });

  it('tolerates absent cache fields (zero cache tokens)', async () => {
    adapter.stdout = JSON.stringify({
      result: 'ok',
      usage: { input_tokens: 500, output_tokens: 100 },
    });
    await adapter.execute(createMockRequest());
    expect(adapter.records[0].tokens).toEqual({
      inputTokens: 500,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
    expect(adapter.records[0].costProvenance).toBe('derived');
  });

  it('labels unparsable stdout as estimated', async () => {
    adapter.stdout = 'plain text output, not JSON at all';
    const result = await adapter.execute(createMockRequest());
    const [record] = adapter.records;
    expect(record.costProvenance).toBe('estimated');
    expect(record.tokenProvenance).toBe('estimated');
    expect(record.estimationMethods).toEqual(['chars_div_4', 'split_50_50']);
    expect(result.metrics.costSummary?.estimatedSpawns).toBe(1);
  });

  it('tags subscription spawns api_equivalent and API-key spawns billed', async () => {
    adapter.stdout = JSON.stringify(resultWithSubagents);
    adapter.setSubscription(true);
    const sub = await adapter.execute(createMockRequest());
    adapter.setSubscription(false);
    const key = await adapter.execute(createMockRequest());

    expect(adapter.records.map((r) => r.billingBasis)).toEqual([
      'api_equivalent',
      'billed',
    ]);
    expect(adapter.records.map((r) => r.authMode)).toEqual([
      'subscription',
      'api_key',
    ]);
    expect(sub.metrics.costSummary?.apiEquivalentMicroUsd).toBe(432_100);
    expect(sub.metrics.costSummary?.billedMicroUsd).toBe(0);
    expect(key.metrics.costSummary?.billedMicroUsd).toBe(432_100);
  });

  it('flags fast mode as an unmodeled modifier', async () => {
    adapter.stdout = JSON.stringify({
      result: 'ok',
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 10, speed: 'fast' },
    });
    const result = await adapter.execute(createMockRequest());
    expect(adapter.records[0].unmodeledModifiers).toEqual(['fast_mode']);
    expect(result.metrics.costSummary?.unmodeledModifiers).toEqual([
      'fast_mode',
    ]);
  });
});
