import { describe, it, expect, vi } from 'vitest';
import {
  resolveModelAlias,
  calculateCost,
  getModelPricing,
  OPENAI_PRICING,
  ANTHROPIC_PRICING,
  MODEL_ALIASES,
  ANTHROPIC_CACHE_PRICING,
  OPENAI_CACHE_PRICING,
  PRICING_VERSION,
  bucketsFromUsage,
  calculateCacheAwareCost,
  computePricingVersion,
  getCacheRates,
  resetPricingWarnings,
} from '../../src/adapters/pricing.js';
import type { ModelPricing } from '../../src/adapters/pricing.js';
import { Logger } from '../../src/utils/logger.js';

describe('Pricing', () => {
  describe('resolveModelAlias', () => {
    it('should resolve known Anthropic aliases', () => {
      expect(resolveModelAlias('sonnet')).toBe('claude-sonnet-5-5');
      expect(resolveModelAlias('opus')).toBe('claude-opus-5-5');
      expect(resolveModelAlias('haiku')).toBe('claude-haiku-5-5');
      expect(resolveModelAlias('fable')).toBe('claude-fable-5-1');
    });

    it('should resolve versioned aliases', () => {
      expect(resolveModelAlias('fable-5.1')).toBe('claude-fable-5-1');
      expect(resolveModelAlias('fable-5')).toBe('claude-fable-5');
      expect(resolveModelAlias('opus-5.5')).toBe('claude-opus-5-5');
      expect(resolveModelAlias('opus-5')).toBe('claude-opus-5');
      expect(resolveModelAlias('sonnet-5.5')).toBe('claude-sonnet-5-5');
      expect(resolveModelAlias('haiku-5.5')).toBe('claude-haiku-5-5');
      // Previously-current pinned aliases keep their targets
      expect(resolveModelAlias('haiku-4.5')).toBe('claude-haiku-4-5');
      expect(resolveModelAlias('sonnet-5')).toBe('claude-sonnet-5');
      expect(resolveModelAlias('sonnet-4.6')).toBe('claude-sonnet-4-6');
      expect(resolveModelAlias('opus-4.8')).toBe('claude-opus-4-8');
      expect(resolveModelAlias('opus-4.7')).toBe('claude-opus-4-7');
      expect(resolveModelAlias('opus-4.5')).toBe('claude-opus-4-5-20251101');
      expect(resolveModelAlias('opus-4.1')).toBe('claude-opus-4-1-20250805');
      expect(resolveModelAlias('sonnet-4.5')).toBe(
        'claude-sonnet-4-5-20250929'
      );
      // No real Sonnet 4.1 exists upstream; historical target preserved
      expect(resolveModelAlias('sonnet-4.1')).toBe(
        'claude-4-1-sonnet-20250514'
      );
    });

    it('should resolve OpenAI aliases', () => {
      expect(resolveModelAlias('gpt-5.6')).toBe('gpt-5.6-terra');
      expect(resolveModelAlias('gpt-4-mini')).toBe('gpt-4o-mini');
    });

    it('should not add OpenAI shorthand aliases that CLIs cannot accept', () => {
      // Aliases only drive pricing; the raw string reaches the CLI
      expect(MODEL_ALIASES['gpt-6']).toBeUndefined();
      expect(MODEL_ALIASES['gpt-6.1']).toBeUndefined();
    });

    it('should be case-insensitive', () => {
      expect(resolveModelAlias('SONNET')).toBe('claude-sonnet-5-5');
      expect(resolveModelAlias('Opus')).toBe('claude-opus-5-5');
      expect(resolveModelAlias('FABLE')).toBe('claude-fable-5-1');
    });

    it('should return lowercased input for unknown models', () => {
      expect(resolveModelAlias('unknown-model')).toBe('unknown-model');
      expect(resolveModelAlias('GPT-5-TURBO')).toBe('gpt-5-turbo');
    });
  });

  describe('calculateCost', () => {
    it('should calculate cost correctly for standard usage', () => {
      const pricing: ModelPricing = { input: 3, output: 15 };
      // 1M input tokens at $3/M + 500K output tokens at $15/M = $3 + $7.50 = $10.50
      const cost = calculateCost(1_000_000, 500_000, pricing);
      expect(cost).toBe(10.5);
    });

    it('should return 0 for zero tokens', () => {
      const pricing: ModelPricing = { input: 3, output: 15 };
      expect(calculateCost(0, 0, pricing)).toBe(0);
    });

    it('should handle zero-cost pricing', () => {
      const pricing: ModelPricing = { input: 0, output: 0 };
      expect(calculateCost(1_000_000, 1_000_000, pricing)).toBe(0);
    });

    it('should handle small token counts', () => {
      const pricing: ModelPricing = { input: 3, output: 15 };
      // 1000 input tokens at $3/M = $0.003
      const cost = calculateCost(1000, 0, pricing);
      expect(cost).toBeCloseTo(0.003);
    });

    it('should handle large token counts', () => {
      const pricing: ModelPricing = { input: 15, output: 75 };
      // 10M input + 5M output
      const cost = calculateCost(10_000_000, 5_000_000, pricing);
      expect(cost).toBe(150 + 375);
    });
  });

  describe('getModelPricing', () => {
    it('should return pricing for known Anthropic model', () => {
      const pricing = getModelPricing(
        'claude-sonnet-4-5-20250514',
        ANTHROPIC_PRICING,
        'claude-sonnet-4-5-20250514'
      );
      expect(pricing.input).toBe(3);
      expect(pricing.output).toBe(15);
    });

    it('should return pricing for known OpenAI model', () => {
      const pricing = getModelPricing('gpt-4o', OPENAI_PRICING, 'gpt-5.5');
      expect(pricing.input).toBe(5);
      expect(pricing.output).toBe(15);
    });

    it('should resolve aliases before lookup', () => {
      const pricing = getModelPricing(
        'sonnet',
        ANTHROPIC_PRICING,
        'claude-sonnet-4-5-20250514'
      );
      expect(pricing.input).toBe(2);
      expect(pricing.output).toBe(10);
    });

    it('should fall back to default model when specified model not found', () => {
      const pricing = getModelPricing(
        'nonexistent-model',
        ANTHROPIC_PRICING,
        'sonnet'
      );
      expect(pricing.input).toBe(2);
      expect(pricing.output).toBe(10);
    });

    it('should return zero-cost when neither model nor default found', () => {
      const pricing = getModelPricing(
        'nonexistent',
        ANTHROPIC_PRICING,
        'also-nonexistent'
      );
      expect(pricing.input).toBe(0);
      expect(pricing.output).toBe(0);
    });

    it('should be case-insensitive via alias resolution', () => {
      const pricing = getModelPricing(
        'SONNET',
        ANTHROPIC_PRICING,
        'claude-sonnet-4-5-20250514'
      );
      expect(pricing.input).toBe(2);
    });

    it('should price 2026 models correctly', () => {
      expect(
        getModelPricing('claude-sonnet-5', ANTHROPIC_PRICING, 'sonnet')
      ).toEqual({ input: 2, output: 10 });
      expect(
        getModelPricing('claude-opus-4-8', ANTHROPIC_PRICING, 'sonnet')
      ).toEqual({ input: 5, output: 25 });
      expect(
        getModelPricing('claude-haiku-4-5', ANTHROPIC_PRICING, 'sonnet')
      ).toEqual({ input: 1, output: 5 });
      expect(
        getModelPricing('gpt-5.6-sol', OPENAI_PRICING, 'gpt-5.6-terra')
      ).toEqual({ input: 4, output: 20 });
      expect(
        getModelPricing('gpt-5.6-terra', OPENAI_PRICING, 'gpt-5.6-terra')
      ).toEqual({ input: 2, output: 12 });
      expect(
        getModelPricing('gpt-5.6-luna', OPENAI_PRICING, 'gpt-5.6-terra')
      ).toEqual({ input: 0.2, output: 1.2 });
      expect(
        getModelPricing('gpt-5.4-nano', OPENAI_PRICING, 'gpt-5.6-terra')
      ).toEqual({ input: 0.2, output: 1.25 });
    });

    it('should price October 2026 models correctly', () => {
      expect(
        getModelPricing('claude-fable-5-1', ANTHROPIC_PRICING, 'sonnet')
      ).toEqual({ input: 10, output: 50 });
      expect(
        getModelPricing('claude-fable-5', ANTHROPIC_PRICING, 'sonnet')
      ).toEqual({ input: 10, output: 50 });
      expect(
        getModelPricing('claude-opus-5-5', ANTHROPIC_PRICING, 'sonnet')
      ).toEqual({ input: 4, output: 20 });
      expect(
        getModelPricing('claude-opus-5', ANTHROPIC_PRICING, 'sonnet')
      ).toEqual({ input: 5, output: 25 });
      expect(
        getModelPricing('claude-sonnet-5-5', ANTHROPIC_PRICING, 'sonnet')
      ).toEqual({ input: 2, output: 10 });
      expect(
        getModelPricing('claude-haiku-5-5', ANTHROPIC_PRICING, 'sonnet')
      ).toEqual({ input: 0.1, output: 0.5 });
      expect(
        getModelPricing('gpt-6-astra', OPENAI_PRICING, 'gpt-6.1-sol')
      ).toEqual({ input: 10, output: 50 });
      expect(
        getModelPricing('gpt-6.1-sol', OPENAI_PRICING, 'gpt-6.1-sol')
      ).toEqual({ input: 2, output: 10 });
      expect(
        getModelPricing('gpt-6-sol', OPENAI_PRICING, 'gpt-6.1-sol')
      ).toEqual({ input: 2, output: 10 });
      expect(
        getModelPricing('gpt-6-luna', OPENAI_PRICING, 'gpt-6.1-sol')
      ).toEqual({ input: 0.1, output: 0.5 });
    });

    it('should price short aliases at their current-generation targets', () => {
      expect(getModelPricing('opus', ANTHROPIC_PRICING, 'sonnet')).toEqual({
        input: 4,
        output: 20,
      });
      expect(getModelPricing('fable', ANTHROPIC_PRICING, 'sonnet')).toEqual({
        input: 10,
        output: 50,
      });
      expect(getModelPricing('haiku', ANTHROPIC_PRICING, 'sonnet')).toEqual({
        input: 0.1,
        output: 0.5,
      });
    });

    it('should keep legacy IDs priced for backward compatibility', () => {
      expect(
        getModelPricing(
          'claude-sonnet-4-5-20250514',
          ANTHROPIC_PRICING,
          'sonnet'
        )
      ).toEqual({ input: 3, output: 15 });
      expect(
        getModelPricing('claude-4-1-opus-20250324', ANTHROPIC_PRICING, 'sonnet')
      ).toEqual({ input: 15, output: 75 });
    });
  });

  describe('pricing tables', () => {
    it('should have entries for all model aliases', () => {
      for (const [alias, fullModel] of Object.entries(MODEL_ALIASES)) {
        const inOpenAI = fullModel in OPENAI_PRICING;
        const inAnthropic = fullModel in ANTHROPIC_PRICING;
        expect(
          inOpenAI || inAnthropic,
          `Alias "${alias}" -> "${fullModel}" not found in any pricing table`
        ).toBe(true);
      }
    });

    it('should have positive pricing for all models', () => {
      for (const [model, pricing] of Object.entries(OPENAI_PRICING)) {
        expect(pricing.input, `${model} input`).toBeGreaterThanOrEqual(0);
        expect(pricing.output, `${model} output`).toBeGreaterThan(0);
      }
      for (const [model, pricing] of Object.entries(ANTHROPIC_PRICING)) {
        expect(pricing.input, `${model} input`).toBeGreaterThanOrEqual(0);
        expect(pricing.output, `${model} output`).toBeGreaterThan(0);
      }
    });
  });
});

describe('cache-aware pricing', () => {
  it('sets per-model Anthropic cache rates (reads vary, writes 1.25x/2x)', () => {
    expect(ANTHROPIC_CACHE_PRICING['claude-sonnet-5-5']).toEqual({
      cacheRead: 0.2,
      cacheWrite5m: 2.5,
      cacheWrite1h: 4,
    });
    // Newer models discount reads more deeply
    expect(ANTHROPIC_CACHE_PRICING['claude-opus-5-5'].cacheRead).toBe(0.2);
    expect(ANTHROPIC_CACHE_PRICING['claude-fable-5-1'].cacheRead).toBe(0.25);
    expect(ANTHROPIC_CACHE_PRICING['claude-fable-5'].cacheRead).toBe(1);
  });

  it('sets per-model OpenAI cached-input rates without a write surcharge', () => {
    expect(OPENAI_CACHE_PRICING['gpt-5.6-terra']).toEqual({
      cacheRead: 0.2,
      cacheWrite5m: 2,
      cacheWrite1h: 2,
    });
    expect(OPENAI_CACHE_PRICING['gpt-4o'].cacheRead).toBe(2.5);
  });

  it('has cache rates only for priced models', () => {
    for (const model of Object.keys(ANTHROPIC_CACHE_PRICING)) {
      expect(ANTHROPIC_PRICING[model]).toBeDefined();
    }
    for (const model of Object.keys(OPENAI_CACHE_PRICING)) {
      expect(OPENAI_PRICING[model]).toBeDefined();
    }
  });

  it('resolves cache rates via aliases and the default model', () => {
    expect(getCacheRates('sonnet', ANTHROPIC_CACHE_PRICING, 'opus')).toBe(
      ANTHROPIC_CACHE_PRICING['claude-sonnet-5-5']
    );
    expect(getCacheRates('unknown', ANTHROPIC_CACHE_PRICING, 'opus')).toBe(
      ANTHROPIC_CACHE_PRICING['claude-opus-5-5']
    );
    expect(getCacheRates('x', undefined, 'opus')).toBeUndefined();
  });

  it('splits inclusive usage into disjoint buckets', () => {
    const buckets = bucketsFromUsage({
      inputTokens: 1_000 + 20_000 + 3_000 + 4_000,
      outputTokens: 500,
      cacheReadInputTokens: 20_000,
      cacheWriteInputTokens: 7_000,
      cacheWrite5mInputTokens: 3_000,
      cacheWrite1hInputTokens: 4_000,
    });
    expect(buckets).toEqual({
      uncachedInput: 1_000,
      cacheRead: 20_000,
      cacheWrite5m: 3_000,
      cacheWrite1h: 4_000,
      output: 500,
    });
  });

  it('prices unsplit cache writes at the 5-minute tier', () => {
    const buckets = bucketsFromUsage({
      inputTokens: 100,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 60,
    });
    expect(buckets.cacheWrite5m).toBe(60);
    expect(buckets.cacheWrite1h).toBe(0);
    expect(buckets.uncachedInput).toBe(40);
  });

  it('prices each bucket at its own Anthropic rate', () => {
    const pricing = ANTHROPIC_PRICING['claude-sonnet-5-5']; // $2 / $10
    const rates = ANTHROPIC_CACHE_PRICING['claude-sonnet-5-5'];
    const cost = calculateCacheAwareCost(
      {
        uncachedInput: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite5m: 1_000_000,
        cacheWrite1h: 1_000_000,
        output: 1_000_000,
      },
      pricing,
      rates,
      'claude-sonnet-5-5'
    );
    // 2 + 0.2 + 2.5 + 4 + 10
    expect(cost).toBeCloseTo(18.7, 10);
  });

  it('falls back to the input rate with one warning per model when cache rates are missing', () => {
    resetPricingWarnings();
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const buckets = {
      uncachedInput: 0,
      cacheRead: 1_000_000,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 0,
    };
    const pricing = { input: 3, output: 15 };
    expect(calculateCacheAwareCost(buckets, pricing, undefined, 'm-x')).toBe(3);
    calculateCacheAwareCost(buckets, pricing, undefined, 'm-x');
    const cacheWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes('No published cache rates')
    );
    expect(cacheWarnings).toHaveLength(1);
    warn.mockRestore();
  });

  it('is unchanged from calculateCost when there are no cache tokens', () => {
    const pricing = { input: 3, output: 15 };
    expect(
      calculateCacheAwareCost(
        {
          uncachedInput: 1000,
          cacheRead: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          output: 500,
        },
        pricing,
        undefined
      )
    ).toBeCloseTo(calculateCost(1000, 500, pricing), 12);
  });
});

describe('pricing_version', () => {
  it('is a stable content hash', () => {
    expect(PRICING_VERSION).toMatch(/^sha256:[0-9a-f]{12}$/);
    const table = { a: { input: 1, output: 2 }, b: { input: 3, output: 4 } };
    const reordered = {
      b: { output: 4, input: 3 },
      a: { output: 2, input: 1 },
    };
    expect(computePricingVersion(table)).toBe(computePricingVersion(reordered));
  });

  it('changes when the pricing table changes', () => {
    const base = {
      anthropic: ANTHROPIC_PRICING,
      anthropicCache: ANTHROPIC_CACHE_PRICING,
      openai: OPENAI_PRICING,
      openaiCache: OPENAI_CACHE_PRICING,
      aliases: MODEL_ALIASES,
    };
    expect(computePricingVersion(base)).toBe(PRICING_VERSION);
    const changed = {
      ...base,
      anthropic: {
        ...ANTHROPIC_PRICING,
        'claude-sonnet-5-5': { input: 2.5, output: 10 },
      },
    };
    expect(computePricingVersion(changed)).not.toBe(PRICING_VERSION);
  });
});
