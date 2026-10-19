/**
 * Centralized model pricing configuration
 * Prices are in USD per million tokens
 * Only subscription-based CLI providers are supported
 */

import { createHash } from 'crypto';
import type { NormalizedTokenUsage } from '../core/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('pricing');

/**
 * Zero-cost fallback pricing when model pricing is unavailable
 */
const ZERO_COST_PRICING: ModelPricing = { input: 0, output: 0 };

export interface ModelPricing {
  input: number; // Cost per million input tokens
  output: number; // Cost per million output tokens
}

/**
 * OpenAI model pricing (used by Cursor CLI, Codex)
 * Updated as of October 2026 (verified against OpenAI pricing docs 2026-10-15)
 */
export const OPENAI_PRICING: Record<string, ModelPricing> = {
  // GPT-6 family (rolled out in Codex 2026-09-22 / 2026-09-29)
  'gpt-6-astra': { input: 10, output: 50 },
  'gpt-6.1-sol': { input: 2, output: 10 },
  'gpt-6-sol': { input: 2, output: 10 },
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  // GPT-5.6 family (released 2026-07-09; prices reduced since launch)
  'gpt-5.6-sol': { input: 4, output: 20 },
  'gpt-5.6-terra': { input: 2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2 },
  // Earlier 2026 models
  'gpt-5.5': { input: 5, output: 30 },
  'gpt-5.4': { input: 2.5, output: 15 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25 },
  'gpt-5.3-codex': { input: 1.75, output: 14 },
  // 2025 models
  'gpt-4o': { input: 5, output: 15 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  o1: { input: 15, output: 60 },
  'o1-mini': { input: 3, output: 12 },
  // Legacy models (kept for backward compatibility)
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-4': { input: 30, output: 60 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
};

/**
 * Anthropic model pricing (used by Claude Code CLI)
 * Updated as of October 2026 (verified against Anthropic model docs 2026-10-06)
 * IDs from the 4.6 generation onward are dateless pinned snapshots.
 */
export const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  // Claude 5.x models
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  // Haiku 5.5 base rate for prompts up to 100K tokens; longer prompts bill
  // $0.50/$2.50. Tiers aren't modeled, so agentic sessions whose per-request
  // context grows past 100K tokens are under-estimated (~5x).
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  // Claude 4.x models
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // 2025 models
  'claude-opus-4-5-20251101': { input: 5, output: 25 },
  'claude-sonnet-4-5-20250929': { input: 3, output: 15 },
  'claude-opus-4-1-20250805': { input: 15, output: 75 },
  // Legacy entries (kept for backward compatibility so existing configs
  // keep validating; the 20250514/20250324 IDs never existed upstream but
  // were previously valid airunx values)
  'claude-sonnet-4-5-20250514': { input: 3, output: 15 },
  'claude-4-1-opus-20250324': { input: 15, output: 75 },
  'claude-4-1-sonnet-20250514': { input: 3, output: 15 },
  'claude-3.5-sonnet-20240620': { input: 3, output: 15 },
  'claude-3-opus-20240229': { input: 15, output: 75 },
  'claude-3-sonnet-20240229': { input: 3, output: 15 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
};

/**
 * Prompt-cache rates in USD per million tokens. Kept in separate per-model
 * tables (not global multipliers) because cache-read discounts vary by model.
 */
export interface CacheRates {
  cacheRead: number; // Cost per million cache-read input tokens
  cacheWrite5m: number; // Cost per million cache-write tokens, 5-minute TTL
  cacheWrite1h: number; // Cost per million cache-write tokens, 1-hour TTL
}

/** Anthropic: writes 1.25x (5m) / 2x (1h) input; reads a per-model fraction */
const anthropicCache = (input: number, readMultiplier = 0.1): CacheRates => ({
  cacheRead: round6(input * readMultiplier),
  cacheWrite5m: round6(input * 1.25),
  cacheWrite1h: round6(input * 2),
});

/** OpenAI: discounted cached input; no cache-write surcharge (input rate) */
const openaiCache = (input: number, cachedInput: number): CacheRates => ({
  cacheRead: cachedInput,
  cacheWrite5m: input,
  cacheWrite1h: input,
});

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Anthropic prompt-cache pricing (verified against Anthropic model docs
 * 2026-10-06): cache reads 0.1x input, except Fable 5.1 (0.025x, $0.25) and
 * Opus 5.5 (0.05x, $0.20); writes 1.25x (5m TTL) and 2x (1h TTL).
 */
export const ANTHROPIC_CACHE_PRICING: Record<string, CacheRates> = {
  'claude-fable-5-1': anthropicCache(10, 0.025),
  'claude-fable-5': anthropicCache(10),
  'claude-opus-5-5': anthropicCache(4, 0.05),
  'claude-opus-5': anthropicCache(5),
  'claude-sonnet-5-5': anthropicCache(2),
  'claude-sonnet-5': anthropicCache(2),
  'claude-haiku-5-5': anthropicCache(0.1),
  'claude-opus-4-8': anthropicCache(5),
  'claude-opus-4-7': anthropicCache(5),
  'claude-opus-4-6': anthropicCache(5),
  'claude-sonnet-4-6': anthropicCache(3),
  'claude-haiku-4-5': anthropicCache(1),
  'claude-opus-4-5-20251101': anthropicCache(5),
  'claude-sonnet-4-5-20250929': anthropicCache(3),
  'claude-opus-4-1-20250805': anthropicCache(15),
  'claude-sonnet-4-5-20250514': anthropicCache(3),
  'claude-4-1-opus-20250324': anthropicCache(15),
  'claude-4-1-sonnet-20250514': anthropicCache(3),
  'claude-3.5-sonnet-20240620': anthropicCache(3),
  'claude-3-opus-20240229': anthropicCache(15),
  'claude-3-haiku-20240307': anthropicCache(0.25),
};

/**
 * OpenAI cached-input pricing (GPT-5.x/6 cached input 0.1x input; GPT-4o
 * and o1 families 0.5x). Models without prompt caching are omitted and fall
 * back to the input rate.
 */
export const OPENAI_CACHE_PRICING: Record<string, CacheRates> = {
  'gpt-6-astra': openaiCache(10, 1),
  'gpt-6.1-sol': openaiCache(2, 0.2),
  'gpt-6-sol': openaiCache(2, 0.2),
  'gpt-6-luna': openaiCache(0.1, 0.01),
  'gpt-5.6-sol': openaiCache(4, 0.4),
  'gpt-5.6-terra': openaiCache(2, 0.2),
  'gpt-5.6-luna': openaiCache(0.2, 0.02),
  'gpt-5.5': openaiCache(5, 0.5),
  'gpt-5.4': openaiCache(2.5, 0.25),
  'gpt-5.4-mini': openaiCache(0.75, 0.075),
  'gpt-5.4-nano': openaiCache(0.2, 0.02),
  'gpt-5.3-codex': openaiCache(1.75, 0.175),
  'gpt-4o': openaiCache(5, 2.5),
  'gpt-4o-mini': openaiCache(0.15, 0.075),
  o1: openaiCache(15, 7.5),
  'o1-mini': openaiCache(3, 1.5),
};

/**
 * Model aliases for common short names
 * Maps user-friendly names to full model IDs
 */
export const MODEL_ALIASES: Record<string, string> = {
  // Anthropic aliases
  fable: 'claude-fable-5-1',
  'fable-5.1': 'claude-fable-5-1',
  'fable-5': 'claude-fable-5',
  opus: 'claude-opus-5-5',
  'opus-5.5': 'claude-opus-5-5',
  'opus-5': 'claude-opus-5',
  'opus-4.8': 'claude-opus-4-8',
  'opus-4.7': 'claude-opus-4-7',
  'opus-4.6': 'claude-opus-4-6',
  'opus-4.5': 'claude-opus-4-5-20251101',
  'opus-4.1': 'claude-opus-4-1-20250805',
  sonnet: 'claude-sonnet-5-5',
  'sonnet-5.5': 'claude-sonnet-5-5',
  'sonnet-5': 'claude-sonnet-5',
  'sonnet-4.6': 'claude-sonnet-4-6',
  'sonnet-4.5': 'claude-sonnet-4-5-20250929',
  // No real Sonnet 4.1 exists upstream; keep the historical target so
  // existing configs pinning this alias continue to resolve.
  'sonnet-4.1': 'claude-4-1-sonnet-20250514',
  haiku: 'claude-haiku-5-5',
  'haiku-5.5': 'claude-haiku-5-5',
  'haiku-4.5': 'claude-haiku-4-5',
  // OpenAI aliases (pricing-only: adapters pass the raw model string to the
  // CLIs, so new shorthand aliases would validate but fail in cursor-agent)
  'gpt-5.6': 'gpt-5.6-terra',
  // Note: 'gpt-4' alias intentionally omitted to preserve backward compatibility
  // with legacy 'gpt-4' pricing. Users wanting gpt-4o should use 'gpt-4o' explicitly.
  // Note: 'o1' and 'o1-mini' don't need aliases since getModelPricing normalizes
  // to lowercase and falls back to the normalized name if no alias is found.
  'gpt-4-mini': 'gpt-4o-mini',
};

/**
 * Resolve model alias to full model ID
 * Always returns lowercase for consistent matching
 */
export function resolveModelAlias(model: string): string {
  const lowerModel = model.toLowerCase();
  return MODEL_ALIASES[lowerModel] || lowerModel;
}

/**
 * Calculate cost given input/output tokens and pricing
 */
export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricing
): number {
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

/**
 * Get pricing for a model, with fallback to default
 * Supports model aliases (e.g., "sonnet" -> "claude-sonnet-5-5")
 * Case-insensitive: resolveModelAlias handles lowercase normalization
 *
 * If pricing is not found for either model or default, logs a warning and
 * returns zero-cost pricing to avoid breaking implicit fallback behavior.
 */
export function getModelPricing(
  model: string,
  pricingTable: Record<string, ModelPricing>,
  defaultModel: string
): ModelPricing {
  // Resolve alias (also normalizes to lowercase)
  const resolvedModel = resolveModelAlias(model);

  // Try specified model first
  const modelPricing = pricingTable[resolvedModel];
  if (modelPricing) {
    return modelPricing;
  }

  // Fall back to default model
  const defaultPricing = pricingTable[resolveModelAlias(defaultModel)];
  if (defaultPricing) {
    return defaultPricing;
  }

  // Neither found - warn and return zero cost to avoid breaking fallback behavior
  logger.warn(
    `No pricing found for model "${model}" or default "${defaultModel}", using zero cost`
  );
  return ZERO_COST_PRICING;
}

/**
 * Disjoint pricing buckets. Each token is in exactly one bucket, so pricing
 * them never double-counts.
 */
export interface TokenBuckets {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}

/**
 * Split normalized (inclusive) usage into disjoint buckets.
 * Unsplit cache writes are priced at the 5-minute (default TTL) tier.
 */
export function bucketsFromUsage(usage: NormalizedTokenUsage): TokenBuckets {
  const cacheRead = Math.max(0, usage.cacheReadInputTokens);
  const cacheWrite = Math.max(0, usage.cacheWriteInputTokens);
  const cacheWrite1h = Math.min(
    cacheWrite,
    Math.max(0, usage.cacheWrite1hInputTokens ?? 0)
  );
  const cacheWrite5m = cacheWrite - cacheWrite1h;
  return {
    uncachedInput: Math.max(0, usage.inputTokens - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite5m,
    cacheWrite1h,
    output: Math.max(0, usage.outputTokens),
  };
}

/** Models already warned about missing cache rates (one warning each) */
const warnedMissingCacheRates = new Set<string>();

/** Test hook: forget which models were already warned about */
export function resetPricingWarnings(): void {
  warnedMissingCacheRates.clear();
}

/**
 * Get cache rates for a model (alias-aware), falling back to the default
 * model's rates. Undefined when neither has published cache rates.
 */
export function getCacheRates(
  model: string,
  cacheTable: Record<string, CacheRates> | undefined,
  defaultModel: string
): CacheRates | undefined {
  if (!cacheTable) return undefined;
  return (
    cacheTable[resolveModelAlias(model)] ??
    cacheTable[resolveModelAlias(defaultModel)]
  );
}

/**
 * Price disjoint token buckets. Cache buckets without a published rate are
 * priced at the input rate, with a one-time warning per model.
 */
export function calculateCacheAwareCost(
  buckets: TokenBuckets,
  pricing: ModelPricing,
  cacheRates: CacheRates | undefined,
  modelLabel = 'unknown'
): number {
  const hasCacheTokens =
    buckets.cacheRead + buckets.cacheWrite5m + buckets.cacheWrite1h > 0;
  if (
    !cacheRates &&
    hasCacheTokens &&
    !warnedMissingCacheRates.has(modelLabel)
  ) {
    warnedMissingCacheRates.add(modelLabel);
    logger.warn(
      `No published cache rates for model "${modelLabel}"; pricing cache tokens at the input rate`
    );
  }
  const rates: CacheRates = cacheRates ?? {
    cacheRead: pricing.input,
    cacheWrite5m: pricing.input,
    cacheWrite1h: pricing.input,
  };
  return (
    (buckets.uncachedInput * pricing.input +
      buckets.cacheRead * rates.cacheRead +
      buckets.cacheWrite5m * rates.cacheWrite5m +
      buckets.cacheWrite1h * rates.cacheWrite1h +
      buckets.output * pricing.output) /
    1_000_000
  );
}

/**
 * Content hash of a pricing table set (stable key order). Stamped on every
 * derived figure so a figure can be re-priced or audited later.
 */
export function computePricingVersion(tables: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((k) => [k, canonical((value as Record<string, unknown>)[k])])
      );
    }
    return value;
  };
  const hash = createHash('sha256')
    .update(JSON.stringify(canonical(tables)))
    .digest('hex');
  return `sha256:${hash.slice(0, 12)}`;
}

/** Version of the active pricing tables (aliases included) */
export const PRICING_VERSION = computePricingVersion({
  anthropic: ANTHROPIC_PRICING,
  anthropicCache: ANTHROPIC_CACHE_PRICING,
  openai: OPENAI_PRICING,
  openaiCache: OPENAI_CACHE_PRICING,
  aliases: MODEL_ALIASES,
});
