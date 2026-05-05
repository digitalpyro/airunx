/**
 * BaseCliAdapter tests
 * Validates CLI execution helpers: output parsing, timeout, buildEnv, error categorization
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BaseCliAdapter } from '../../src/adapters/base-cli-adapter.js';
import type { CliAdapterConfig } from '../../src/adapters/base-cli-adapter.js';
import type {
  ExecutionRequest,
  ExecutionResult,
  BackendAvailability,
  AdapterConfig,
} from '../../src/core/adapter-types.js';
import type { ModelPricing } from '../../src/adapters/pricing.js';

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
