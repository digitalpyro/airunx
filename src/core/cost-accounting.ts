/**
 * Cost accounting helpers: provenance/billing-tagged cost summaries.
 *
 * A CostSummary folds any number of spawns into integer micro-USD totals
 * partitioned two ways (by billing basis and by provenance), plus summed
 * normalized tokens. Merging takes the weakest provenance; billed and
 * API-equivalent totals are never added together without a label.
 */

import type {
  BillingBasis,
  CostProvenance,
  CostSummary,
  NormalizedTokenUsage,
} from './types.js';
import { COST_PROVENANCES } from './types.js';

/** Auth mode → billing basis (unknown auth is treated as not billed) */
export function billingBasisForAuth(
  authMode: 'subscription' | 'api_key' | undefined
): BillingBasis {
  if (authMode === 'api_key') return 'billed';
  if (authMode === 'subscription') return 'api_equivalent';
  return 'unknown';
}

/** USD → integer micro-USD */
export function usdToMicroUsd(usd: number): number {
  return Number.isFinite(usd) ? Math.round(usd * 1_000_000) : 0;
}

/** Integer micro-USD → USD */
export function microUsdToUsd(microUsd: number): number {
  return microUsd / 1_000_000;
}

/** Zeroed token usage */
export function emptyTokenUsage(): NormalizedTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
  };
}

/** Sum two normalized usages (optional split fields kept only if either has them) */
export function addTokenUsage(
  a: NormalizedTokenUsage,
  b: NormalizedTokenUsage
): NormalizedTokenUsage {
  const sumOptional = (
    x: number | undefined,
    y: number | undefined
  ): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const out: NormalizedTokenUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
  };
  const w5 = sumOptional(a.cacheWrite5mInputTokens, b.cacheWrite5mInputTokens);
  const w1 = sumOptional(a.cacheWrite1hInputTokens, b.cacheWrite1hInputTokens);
  const r = sumOptional(a.reasoningOutputTokens, b.reasoningOutputTokens);
  if (w5 !== undefined) out.cacheWrite5mInputTokens = w5;
  if (w1 !== undefined) out.cacheWrite1hInputTokens = w1;
  if (r !== undefined) out.reasoningOutputTokens = r;
  return out;
}

/** An empty summary (zero spawns) */
export function emptyCostSummary(): CostSummary {
  return {
    billedMicroUsd: 0,
    apiEquivalentMicroUsd: 0,
    unknownBasisMicroUsd: 0,
    reportedMicroUsd: 0,
    derivedMicroUsd: 0,
    estimatedMicroUsd: 0,
    spawnCount: 0,
    missingCostSpawns: 0,
    estimatedSpawns: 0,
    estimationMethods: [],
    tokens: emptyTokenUsage(),
    pricingVersions: [],
    unmodeledModifiers: [],
  };
}

/** Facts about a single spawn's cost, as produced by an adapter */
export interface SpawnCostFacts {
  /** Headline cost in USD; undefined = missing (unknown, not $0) */
  costUsd?: number;
  costProvenance?: CostProvenance;
  billingBasis: BillingBasis;
  tokens?: NormalizedTokenUsage;
  tokenProvenance?: 'reported' | 'estimated';
  pricingVersion?: string;
  estimationMethods?: string[];
  unmodeledModifiers?: string[];
}

/** Build a one-spawn summary */
export function spawnCostSummary(facts: SpawnCostFacts): CostSummary {
  const summary = emptyCostSummary();
  summary.spawnCount = 1;
  summary.tokens = facts.tokens ? { ...facts.tokens } : emptyTokenUsage();
  summary.tokenProvenance = facts.tokens ? facts.tokenProvenance : undefined;
  summary.estimationMethods = [...new Set(facts.estimationMethods ?? [])];
  summary.unmodeledModifiers = [...new Set(facts.unmodeledModifiers ?? [])];
  if (facts.pricingVersion) summary.pricingVersions = [facts.pricingVersion];

  const estimated =
    facts.costProvenance === 'estimated' ||
    facts.tokenProvenance === 'estimated';
  if (estimated) summary.estimatedSpawns = 1;

  if (facts.costUsd === undefined || facts.costProvenance === undefined) {
    summary.missingCostSpawns = 1;
    return summary;
  }

  const micro = usdToMicroUsd(facts.costUsd);
  summary.provenance = facts.costProvenance;
  if (facts.billingBasis === 'billed') summary.billedMicroUsd = micro;
  else if (facts.billingBasis === 'api_equivalent')
    summary.apiEquivalentMicroUsd = micro;
  else summary.unknownBasisMicroUsd = micro;
  if (facts.costProvenance === 'reported') summary.reportedMicroUsd = micro;
  else if (facts.costProvenance === 'derived') summary.derivedMicroUsd = micro;
  else summary.estimatedMicroUsd = micro;
  return summary;
}

/** The weaker of two provenances (undefined = absent, not weak) */
export function weakestProvenance<T extends string>(
  order: readonly T[],
  a: T | undefined,
  b: T | undefined
): T | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

const TOKEN_PROVENANCES = ['reported', 'estimated'] as const;

const union = (a: string[], b: string[]): string[] => [
  ...new Set([...a, ...b]),
];

/**
 * Merge summaries (undefined inputs are skipped). Provenance is the weakest
 * of the inputs; all totals are summed; lists are de-duplicated.
 */
export function mergeCostSummaries(
  ...summaries: Array<CostSummary | undefined>
): CostSummary | undefined {
  const present = summaries.filter((s): s is CostSummary => s !== undefined);
  if (present.length === 0) return undefined;
  return present.reduce((acc, s) => ({
    provenance: weakestProvenance(
      COST_PROVENANCES,
      acc.provenance,
      s.provenance
    ),
    tokenProvenance: weakestProvenance(
      TOKEN_PROVENANCES,
      acc.tokenProvenance,
      s.tokenProvenance
    ),
    billedMicroUsd: acc.billedMicroUsd + s.billedMicroUsd,
    apiEquivalentMicroUsd: acc.apiEquivalentMicroUsd + s.apiEquivalentMicroUsd,
    unknownBasisMicroUsd: acc.unknownBasisMicroUsd + s.unknownBasisMicroUsd,
    reportedMicroUsd: acc.reportedMicroUsd + s.reportedMicroUsd,
    derivedMicroUsd: acc.derivedMicroUsd + s.derivedMicroUsd,
    estimatedMicroUsd: acc.estimatedMicroUsd + s.estimatedMicroUsd,
    spawnCount: acc.spawnCount + s.spawnCount,
    missingCostSpawns: acc.missingCostSpawns + s.missingCostSpawns,
    estimatedSpawns: acc.estimatedSpawns + s.estimatedSpawns,
    estimationMethods: union(acc.estimationMethods, s.estimationMethods),
    tokens: addTokenUsage(acc.tokens, s.tokens),
    pricingVersions: union(acc.pricingVersions, s.pricingVersions),
    unmodeledModifiers: union(acc.unmodeledModifiers, s.unmodeledModifiers),
  }));
}

/** Share of priced spend by provenance, as whole percentages */
export interface ProvenanceMix {
  reportedPct: number;
  derivedPct: number;
  estimatedPct: number;
  /** reported + derived */
  trustedPct: number;
}

/** Provenance mix of priced spend (all zero when nothing is priced) */
export function provenanceMix(summary: CostSummary): ProvenanceMix {
  const total =
    summary.reportedMicroUsd +
    summary.derivedMicroUsd +
    summary.estimatedMicroUsd;
  if (total <= 0) {
    return { reportedPct: 0, derivedPct: 0, estimatedPct: 0, trustedPct: 0 };
  }
  const pct = (n: number): number => Math.round((n / total) * 100);
  const estimatedPct = pct(summary.estimatedMicroUsd);
  return {
    reportedPct: pct(summary.reportedMicroUsd),
    derivedPct: pct(summary.derivedMicroUsd),
    estimatedPct,
    // Derived from estimatedPct so the two always sum to 100
    trustedPct: 100 - estimatedPct,
  };
}

const usd = (micro: number): string => `$${microUsdToUsd(micro).toFixed(2)}`;

/**
 * One-line run summary (R9), e.g.
 * "$1.20 billed / $3.40 API-equivalent — 95% reported/derived, 5% estimated"
 * "$4.12 API-equivalent (subscription) — 100% reported/derived, 0% estimated"
 */
export function formatCostSummaryLine(summary: CostSummary): string {
  const parts: string[] = [];
  const hasBilled = summary.billedMicroUsd > 0;
  const hasApiEq = summary.apiEquivalentMicroUsd > 0;
  const hasUnknown = summary.unknownBasisMicroUsd > 0;
  const single = [hasBilled, hasApiEq, hasUnknown].filter(Boolean).length <= 1;

  if (hasBilled || (!hasApiEq && !hasUnknown)) {
    parts.push(`${usd(summary.billedMicroUsd)} billed`);
  }
  if (hasApiEq) {
    parts.push(
      `${usd(summary.apiEquivalentMicroUsd)} API-equivalent${single ? ' (subscription)' : ''}`
    );
  }
  if (hasUnknown) {
    parts.push(`${usd(summary.unknownBasisMicroUsd)} unknown basis`);
  }

  const mix = provenanceMix(summary);
  let line = `${parts.join(' / ')} — ${mix.trustedPct}% reported/derived, ${mix.estimatedPct}% estimated`;
  if (summary.missingCostSpawns > 0) {
    const s = summary.missingCostSpawns === 1 ? '' : 's';
    line += ` (${summary.missingCostSpawns} spawn${s} with unknown cost)`;
  }
  return line;
}

/**
 * One-per-run estimation warning (R10), or undefined when nothing was
 * estimated
 */
export function formatEstimationWarning(
  summary: CostSummary
): string | undefined {
  if (summary.estimatedSpawns <= 0) return undefined;
  const s = summary.estimatedSpawns === 1 ? '' : 's';
  const methods =
    summary.estimationMethods.length > 0
      ? ` (${summary.estimationMethods.join(', ')})`
      : '';
  return `${summary.estimatedSpawns} spawn${s} used estimated tokens/cost${methods}; figures are approximate`;
}
