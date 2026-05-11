/**
 * Handoff Context Formatter tests
 */

import { describe, it, expect } from 'vitest';
import {
  formatHandoffContext,
  resolveHandoffFormat,
} from '../../src/orchestrator/handoff-context.js';

const makeMockOutput = (overrides: Record<string, unknown> = {}) => ({
  success: true,
  outputs: {
    analysis: 'Test analysis output from this stage',
    files: [
      { path: 'src/index.ts', action: 'update' as const },
      { path: 'src/utils.ts', action: 'create' as const },
    ],
    recommendations: ['Use dependency injection', 'Add error handling'],
    ...overrides,
  },
  metrics: { tokensUsed: 1000, duration: 5000, cost: 0.5 },
  errors: [],
});

describe('resolveHandoffFormat', () => {
  it('returns compact for fast fidelity', () => {
    expect(resolveHandoffFormat('fast')).toBe('compact');
  });

  it('returns full for standard fidelity', () => {
    expect(resolveHandoffFormat('standard')).toBe('full');
  });

  it('returns full for thorough fidelity', () => {
    expect(resolveHandoffFormat('thorough')).toBe('full');
  });

  it('returns full for ultra fidelity', () => {
    expect(resolveHandoffFormat('ultra')).toBe('full');
  });
});

describe('formatHandoffContext', () => {
  it('returns undefined for empty stage outputs', () => {
    const result = formatHandoffContext({}, { fidelityLevel: 'fast' });
    expect(result).toBeUndefined();
  });

  it('includes stage names as headers', () => {
    const result = formatHandoffContext(
      { orchestrate: makeMockOutput(), strategize: makeMockOutput() },
      { fidelityLevel: 'standard' }
    );
    expect(result).toContain('### orchestrate');
    expect(result).toContain('### strategize');
  });

  it('includes file paths in output', () => {
    const result = formatHandoffContext(
      { orchestrate: makeMockOutput() },
      { fidelityLevel: 'standard' }
    );
    expect(result).toContain('src/index.ts');
    expect(result).toContain('src/utils.ts');
  });

  it('includes recommendations in full mode', () => {
    const result = formatHandoffContext(
      { orchestrate: makeMockOutput() },
      { fidelityLevel: 'standard' }
    );
    expect(result).toContain('dependency injection');
  });

  it('truncates analysis in compact mode', () => {
    const longAnalysis = 'A'.repeat(1000);
    const result = formatHandoffContext(
      { orchestrate: makeMockOutput({ analysis: longAnalysis }) },
      { fidelityLevel: 'fast' }
    );
    // Compact truncates analysis to 500 chars
    expect(result!.length).toBeLessThan(1000);
    expect(result).toContain('...');
  });

  it('compresses implement stage to files-changed list only', () => {
    const result = formatHandoffContext(
      {
        implement: makeMockOutput({
          analysis: 'Very long implementation details that should be excluded',
        }),
      },
      { fidelityLevel: 'standard' }
    );
    expect(result).toContain('Files changed');
    expect(result).toContain('src/index.ts');
    // Should NOT include the full analysis text for implement stage
    expect(result).not.toContain('Very long implementation details');
  });

  it('truncates earliest stages first when exceeding budget', () => {
    // Create outputs that exceed a small budget
    const largeAnalysis = 'B'.repeat(500);
    const stageOutputs = {
      orchestrate: makeMockOutput({ analysis: largeAnalysis }),
      strategize: makeMockOutput({ analysis: largeAnalysis }),
      implement: makeMockOutput({ analysis: 'short' }),
    };

    const result = formatHandoffContext(stageOutputs, {
      fidelityLevel: 'standard',
      maxBytes: 800, // Small budget forces truncation
    });

    // Later stages should be preserved, earlier ones truncated
    expect(result).toContain('### implement');
    // orchestrate should be truncated (earliest)
    expect(result).toContain('truncated');
  });

  it('respects maxBytes budget', () => {
    const largeAnalysis = 'C'.repeat(2000);
    const stageOutputs = {
      orchestrate: makeMockOutput({ analysis: largeAnalysis }),
      strategize: makeMockOutput({ analysis: largeAnalysis }),
    };

    const result = formatHandoffContext(stageOutputs, {
      fidelityLevel: 'standard',
      maxBytes: 1000,
    });

    expect(result!.length).toBeLessThanOrEqual(1200); // Allow some overhead for headers
  });
});
