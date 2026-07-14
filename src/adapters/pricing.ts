/**
 * Centralized model pricing configuration
 * Prices are in USD per million tokens
 * Only subscription-based CLI providers are supported
 */

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
 * Updated as of July 2026 (verified against OpenAI pricing docs 2026-07-14)
 */
export const OPENAI_PRICING: Record<string, ModelPricing> = {
  // GPT-5.6 family (released 2026-07-09)
  'gpt-5.6-sol': { input: 5, output: 30 },
  'gpt-5.6-terra': { input: 2.5, output: 15 },
  'gpt-5.6-luna': { input: 1, output: 6 },
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
 * Updated as of July 2026 (verified against Anthropic model docs 2026-07-14)
 * IDs from the 4.6 generation onward are dateless pinned snapshots.
 */
export const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  // 2026 models
  // Sonnet 5 standard pricing; introductory pricing of $2/$10 applies
  // through 2026-08-31 — we record the durable standard rate.
  'claude-sonnet-5': { input: 3, output: 15 },
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
 * Model aliases for common short names
 * Maps user-friendly names to full model IDs
 */
export const MODEL_ALIASES: Record<string, string> = {
  // Anthropic aliases
  opus: 'claude-opus-4-8',
  'opus-4.8': 'claude-opus-4-8',
  'opus-4.7': 'claude-opus-4-7',
  'opus-4.6': 'claude-opus-4-6',
  'opus-4.5': 'claude-opus-4-5-20251101',
  'opus-4.1': 'claude-opus-4-1-20250805',
  sonnet: 'claude-sonnet-5',
  'sonnet-5': 'claude-sonnet-5',
  'sonnet-4.6': 'claude-sonnet-4-6',
  'sonnet-4.5': 'claude-sonnet-4-5-20250929',
  // No real Sonnet 4.1 exists upstream; keep the historical target so
  // existing configs pinning this alias continue to resolve.
  'sonnet-4.1': 'claude-4-1-sonnet-20250514',
  haiku: 'claude-haiku-4-5',
  'haiku-4.5': 'claude-haiku-4-5',
  // OpenAI aliases
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
 * Supports model aliases (e.g., "sonnet" -> "claude-sonnet-5")
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
