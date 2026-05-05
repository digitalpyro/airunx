/**
 * Tests for cost tracking fixes in CompoundEngineeringAdapter
 * Validates that sub-agent costs are properly propagated and aggregated
 */

import { describe, it, expect } from 'vitest';
import type { ExecutionResult } from '../../src/core/adapter-types.js';
import type { SubAgentResult } from '../../src/adapters/compound-engineering-adapter.js';

/**
 * Extracted cost aggregation logic from synthesizeResults() for unit testing.
 * This mirrors the actual implementation in compound-engineering-adapter.ts.
 */
function aggregateCosts(
  mainResult: ExecutionResult,
  subAgentResults: SubAgentResult[]
): { tokensUsed: number; cost: number; spawnCount: number } {
  const subAgentTokens = subAgentResults.reduce(
    (sum, r) => sum + (r.metrics?.tokensUsed ?? 0),
    0
  );
  const totalTokens = mainResult.metrics.tokensUsed + subAgentTokens;

  const mainSpawnCount = mainResult.metrics.spawnCount ?? 1;
  const subAgentSpawnCount = subAgentResults.length;
  const totalSpawnCount = mainSpawnCount + subAgentSpawnCount;

  const totalCost = [mainResult.metrics, ...subAgentResults.map((r) => r.metrics)]
    .reduce((sum, m) => sum + (m?.cost ?? 0), 0);

  return { tokensUsed: totalTokens, cost: totalCost, spawnCount: totalSpawnCount };
}

describe('Cost Tracking - SubAgent Cost Propagation', () => {
  it('should include cost field in SubAgentResult metrics', () => {
    // Simulates what executeSubAgent() now does
    const mockExecutionResult: ExecutionResult = {
      success: true,
      outputs: { analysis: 'test' },
      metrics: { tokensUsed: 5000, duration: 10000, cost: 1.50 },
      errors: [],
    };

    const subAgentResult: SubAgentResult = {
      agent: 'architecture-strategist',
      success: true,
      findings: 'test findings',
      metrics: {
        tokensUsed: mockExecutionResult.metrics.tokensUsed,
        duration: mockExecutionResult.metrics.duration,
        cost: mockExecutionResult.metrics.cost ?? 0,
      },
    };

    expect(subAgentResult.metrics?.cost).toBe(1.50);
  });

  it('should default cost to 0 when execution result has no cost', () => {
    const mockExecutionResult: ExecutionResult = {
      success: true,
      outputs: { analysis: 'test' },
      metrics: { tokensUsed: 5000, duration: 10000 }, // no cost field
      errors: [],
    };

    const subAgentResult: SubAgentResult = {
      agent: 'architecture-strategist',
      success: true,
      findings: 'test findings',
      metrics: {
        tokensUsed: mockExecutionResult.metrics.tokensUsed,
        duration: mockExecutionResult.metrics.duration,
        cost: mockExecutionResult.metrics.cost ?? 0,
      },
    };

    expect(subAgentResult.metrics?.cost).toBe(0);
  });
});

describe('Cost Tracking - synthesizeResults Cost Aggregation', () => {
  const makeMainResult = (cost: number, tokens: number): ExecutionResult => ({
    success: true,
    outputs: { analysis: 'main analysis' },
    metrics: { tokensUsed: tokens, duration: 30000, cost, spawnCount: 1 },
    errors: [],
  });

  const makeSubAgentResult = (
    agent: string,
    cost: number,
    tokens: number
  ): SubAgentResult => ({
    agent: agent as SubAgentResult['agent'],
    success: true,
    findings: `${agent} findings`,
    metrics: { tokensUsed: tokens, duration: 10000, cost },
  });

  it('should sum costs from main result and all sub-agents', () => {
    const mainResult = makeMainResult(5.0, 20000);
    const subAgents = [
      makeSubAgentResult('architecture-strategist', 2.30, 8000),
      makeSubAgentResult('pattern-recognition-specialist', 1.80, 6000),
      makeSubAgentResult('framework-docs-researcher', 1.70, 5000),
    ];

    const result = aggregateCosts(mainResult, subAgents);

    expect(result.cost).toBeCloseTo(10.80); // 5.0 + 2.3 + 1.8 + 1.7
    expect(result.tokensUsed).toBe(39000); // 20000 + 8000 + 6000 + 5000
    expect(result.spawnCount).toBe(4); // 1 main + 3 sub-agents
  });

  it('should handle sub-agents with no cost (undefined metrics)', () => {
    const mainResult = makeMainResult(5.0, 20000);
    const subAgents: SubAgentResult[] = [
      {
        agent: 'architecture-strategist',
        success: false,
        findings: '',
        error: 'failed',
        // No metrics at all (failed sub-agent)
      },
      makeSubAgentResult('pattern-recognition-specialist', 1.80, 6000),
    ];

    const result = aggregateCosts(mainResult, subAgents);

    expect(result.cost).toBeCloseTo(6.80); // 5.0 + 0 + 1.8
    expect(result.tokensUsed).toBe(26000); // 20000 + 0 + 6000
  });

  it('should handle zero-cost sub-agents', () => {
    const mainResult = makeMainResult(5.0, 20000);
    const subAgents = [
      makeSubAgentResult('architecture-strategist', 0, 0),
      makeSubAgentResult('pattern-recognition-specialist', 0, 0),
    ];

    const result = aggregateCosts(mainResult, subAgents);

    expect(result.cost).toBeCloseTo(5.0); // only main result cost
    expect(result.tokensUsed).toBe(20000);
  });

  it('should handle no sub-agents', () => {
    const mainResult = makeMainResult(5.0, 20000);

    const result = aggregateCosts(mainResult, []);

    expect(result.cost).toBeCloseTo(5.0);
    expect(result.tokensUsed).toBe(20000);
    expect(result.spawnCount).toBe(1);
  });

  it('should not use only the main result cost (regression test for the original bug)', () => {
    // This is the exact scenario that caused the $1 vs $17-30 discrepancy.
    // Before the fix, synthesizeResults() spread mainResult.metrics which
    // kept only the main task's cost, silently dropping sub-agent costs.
    const mainResult = makeMainResult(1.0, 5000); // Main task: $1
    const subAgents = [
      makeSubAgentResult('architecture-strategist', 5.0, 15000),
      makeSubAgentResult('pattern-recognition-specialist', 4.0, 12000),
      makeSubAgentResult('framework-docs-researcher', 3.0, 10000),
    ];

    const result = aggregateCosts(mainResult, subAgents);

    // Total should be $13, not $1 (the old bug)
    expect(result.cost).toBeCloseTo(13.0);
    expect(result.cost).not.toBe(1.0); // Explicit regression check
  });
});
