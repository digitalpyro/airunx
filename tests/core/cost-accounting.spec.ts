/**
 * Cost accounting: provenance/billing-tagged summaries and the run line
 */

import { describe, it, expect } from 'vitest';
import {
  billingBasisForAuth,
  formatCostSummaryLine,
  formatEstimationWarning,
  mergeCostSummaries,
  provenanceMix,
  spawnCostSummary,
} from '../../src/core/cost-accounting.js';

const tokens = (input: number, output: number) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
});

describe('billingBasisForAuth', () => {
  it('maps auth modes to billing bases (unknown is not billed)', () => {
    expect(billingBasisForAuth('api_key')).toBe('billed');
    expect(billingBasisForAuth('subscription')).toBe('api_equivalent');
    expect(billingBasisForAuth(undefined)).toBe('unknown');
  });
});

describe('spawnCostSummary', () => {
  it('stores money as integer micro-USD under its basis and provenance', () => {
    const s = spawnCostSummary({
      costUsd: 0.1234567,
      costProvenance: 'reported',
      billingBasis: 'api_equivalent',
      tokens: tokens(10, 5),
      tokenProvenance: 'reported',
    });
    expect(s.apiEquivalentMicroUsd).toBe(123_457);
    expect(s.reportedMicroUsd).toBe(123_457);
    expect(s.billedMicroUsd).toBe(0);
    expect(s.provenance).toBe('reported');
  });

  it('counts a spawn without a cost as missing, never as $0 reported', () => {
    const s = spawnCostSummary({ billingBasis: 'billed' });
    expect(s.missingCostSpawns).toBe(1);
    expect(s.provenance).toBeUndefined();
    expect(s.reportedMicroUsd).toBe(0);
  });
});

describe('mergeCostSummaries', () => {
  const reportedSub = spawnCostSummary({
    costUsd: 3,
    costProvenance: 'reported',
    billingBasis: 'api_equivalent',
    tokens: { ...tokens(1000, 100), cacheReadInputTokens: 800 },
    tokenProvenance: 'reported',
  });
  const derivedKey = spawnCostSummary({
    costUsd: 0.75,
    costProvenance: 'derived',
    billingBasis: 'billed',
    tokens: tokens(500, 50),
    tokenProvenance: 'reported',
    pricingVersion: 'sha256:aaaaaaaaaaaa',
  });
  const estimatedKey = spawnCostSummary({
    costUsd: 0.25,
    costProvenance: 'estimated',
    billingBasis: 'billed',
    tokens: tokens(100, 100),
    tokenProvenance: 'estimated',
    pricingVersion: 'sha256:aaaaaaaaaaaa',
    estimationMethods: ['chars_div_4', 'split_50_50'],
  });

  it('returns undefined when nothing is present', () => {
    expect(mergeCostSummaries(undefined, undefined)).toBeUndefined();
  });

  it('takes the weakest provenance and sums totals', () => {
    const merged = mergeCostSummaries(reportedSub, derivedKey)!;
    expect(merged.provenance).toBe('derived');
    expect(mergeCostSummaries(merged, estimatedKey)!.provenance).toBe(
      'estimated'
    );
    expect(merged.spawnCount).toBe(2);
    expect(merged.tokens).toEqual({
      inputTokens: 1500,
      outputTokens: 150,
      cacheReadInputTokens: 800,
      cacheWriteInputTokens: 0,
    });
  });

  it('keeps billed and API-equivalent totals separate in a mixed-auth run', () => {
    const merged = mergeCostSummaries(reportedSub, derivedKey, estimatedKey)!;
    expect(merged.billedMicroUsd).toBe(1_000_000);
    expect(merged.apiEquivalentMicroUsd).toBe(3_000_000);
    expect(formatCostSummaryLine(merged)).toBe(
      '$1.00 billed / $3.00 API-equivalent — 94% reported/derived, 6% estimated'
    );
  });

  it('reports the provenance mix as percentages of priced spend', () => {
    const merged = mergeCostSummaries(reportedSub, derivedKey, estimatedKey)!;
    expect(provenanceMix(merged)).toEqual({
      reportedPct: 75,
      derivedPct: 19,
      estimatedPct: 6,
      trustedPct: 94,
    });
  });

  it('de-duplicates pricing versions and estimation methods', () => {
    const merged = mergeCostSummaries(derivedKey, estimatedKey, estimatedKey)!;
    expect(merged.pricingVersions).toEqual(['sha256:aaaaaaaaaaaa']);
    expect(merged.estimationMethods).toEqual(['chars_div_4', 'split_50_50']);
    expect(merged.estimatedSpawns).toBe(2);
  });
});

describe('formatCostSummaryLine', () => {
  it('labels a subscription-only run as API-equivalent', () => {
    const s = spawnCostSummary({
      costUsd: 4.12,
      costProvenance: 'reported',
      billingBasis: 'api_equivalent',
    });
    expect(formatCostSummaryLine(s)).toBe(
      '$4.12 API-equivalent (subscription) — 100% reported/derived, 0% estimated'
    );
  });

  it('notes spawns with unknown cost and unknown-basis spend', () => {
    const s = mergeCostSummaries(
      spawnCostSummary({
        costUsd: 1,
        costProvenance: 'derived',
        billingBasis: 'unknown',
      }),
      spawnCostSummary({ billingBasis: 'billed' })
    )!;
    expect(formatCostSummaryLine(s)).toBe(
      '$1.00 unknown basis — 100% reported/derived, 0% estimated (1 spawn with unknown cost)'
    );
  });
});

describe('formatEstimationWarning', () => {
  it('produces one warning naming the methods, or nothing', () => {
    expect(
      formatEstimationWarning(
        spawnCostSummary({
          costUsd: 1,
          costProvenance: 'reported',
          billingBasis: 'billed',
        })
      )
    ).toBeUndefined();
    const est = spawnCostSummary({
      costUsd: 1,
      costProvenance: 'estimated',
      billingBasis: 'billed',
      estimationMethods: ['chars_div_4'],
    });
    expect(formatEstimationWarning(est)).toBe(
      '1 spawn used estimated tokens/cost (chars_div_4); figures are approximate'
    );
  });
});
