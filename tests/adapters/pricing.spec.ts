import { describe, it, expect, vi } from 'vitest';
import {
  resolveModelAlias,
  calculateCost,
  getModelPricing,
  OPENAI_PRICING,
  ANTHROPIC_PRICING,
  MODEL_ALIASES,
} from '../../src/adapters/pricing.js';
import type { ModelPricing } from '../../src/adapters/pricing.js';

describe('Pricing', () => {
  describe('resolveModelAlias', () => {
    it('should resolve known Anthropic aliases', () => {
      expect(resolveModelAlias('sonnet')).toBe('claude-sonnet-4-5-20250514');
      expect(resolveModelAlias('opus')).toBe('claude-opus-4-5-20251101');
      expect(resolveModelAlias('haiku')).toBe('claude-3-haiku-20240307');
    });

    it('should resolve versioned aliases', () => {
      expect(resolveModelAlias('opus-4.5')).toBe('claude-opus-4-5-20251101');
      expect(resolveModelAlias('opus-4.1')).toBe('claude-4-1-opus-20250324');
      expect(resolveModelAlias('sonnet-4.5')).toBe(
        'claude-sonnet-4-5-20250514'
      );
      expect(resolveModelAlias('sonnet-4.1')).toBe(
        'claude-4-1-sonnet-20250514'
      );
    });

    it('should resolve OpenAI aliases', () => {
      expect(resolveModelAlias('gpt-4-mini')).toBe('gpt-4o-mini');
    });

    it('should be case-insensitive', () => {
      expect(resolveModelAlias('SONNET')).toBe('claude-sonnet-4-5-20250514');
      expect(resolveModelAlias('Opus')).toBe('claude-opus-4-5-20251101');
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
      expect(pricing.input).toBe(3);
      expect(pricing.output).toBe(15);
    });

    it('should fall back to default model when specified model not found', () => {
      const pricing = getModelPricing(
        'nonexistent-model',
        ANTHROPIC_PRICING,
        'sonnet'
      );
      expect(pricing.input).toBe(3);
      expect(pricing.output).toBe(15);
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
      expect(pricing.input).toBe(3);
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
