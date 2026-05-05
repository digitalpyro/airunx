/**
 * Tests for judge agent metrics capture
 * Validates that judge LLM calls report real costs, and early-exit paths report zero
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JudgeAgent, type JudgeContext } from '../../src/orchestrator/judge-agent.js';
import type {
  ExecutionAdapter,
  ExecutionResult,
} from '../../src/core/adapter-types.js';
import type { FidelityParameters } from '../../src/core/types.js';
import type { FidelityCheckResult } from '../../src/orchestrator/fidelity-checker.js';

describe('Judge Agent - Metrics Capture', () => {
  let mockAdapter: ExecutionAdapter;
  let fidelityParams: FidelityParameters;
  let judgeAgent: JudgeAgent;

  beforeEach(() => {
    mockAdapter = {
      execute: vi.fn(),
      name: 'mock-adapter',
      capabilities: ['coding', 'analysis'],
    };

    fidelityParams = {
      temperature: 0.2,
      maxTokens: 4096,
      retryCount: 2,
      useCaching: true,
      enableVerification: true,
      reviewIterations: 2,
    };

    judgeAgent = new JudgeAgent(mockAdapter, fidelityParams);
  });

  describe('Early-exit paths report zero/undefined metrics', () => {
    it('should have no metrics when max iterations reached with failed verification', async () => {
      const context: JudgeContext = {
        acceptanceCriteria: ['Criteria 1'],
        fidelityCheckResult: {
          passed: false,
          qualityMetrics: {},
          unmetCriteria: ['Tests failing'],
          findings: [],
        },
        currentIteration: 3,
        maxIterations: 3,
        workingDirectory: '/test',
      };

      const result = await judgeAgent.judgeExtended(context);

      expect(result.decision).toBe('FAIL');
      expect(result.metrics).toBeUndefined(); // No LLM call made
    });

    it('should have no metrics when max iterations reached with passing verification', async () => {
      const context: JudgeContext = {
        acceptanceCriteria: ['Criteria 1'],
        fidelityCheckResult: {
          passed: true,
          qualityMetrics: {},
          unmetCriteria: [],
          findings: [],
        },
        currentIteration: 3,
        maxIterations: 3,
        workingDirectory: '/test',
      };

      const result = await judgeAgent.judgeExtended(context);

      expect(result.decision).toBe('PROCEED');
      expect(result.metrics).toBeUndefined(); // No LLM call made
    });

    it('should have no metrics on fast fidelity with passing checks', async () => {
      const context: JudgeContext = {
        acceptanceCriteria: ['Criteria 1'],
        fidelityCheckResult: {
          passed: true,
          qualityMetrics: {},
          unmetCriteria: [],
          findings: [],
        },
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
        fidelityLevel: 'fast',
      };

      const result = await judgeAgent.judgeExtended(context);

      expect(result.decision).toBe('PROCEED');
      expect(result.metrics).toBeUndefined(); // Fast fidelity early-exit
    });

    it('should have no metrics on fast fidelity with failing checks', async () => {
      const context: JudgeContext = {
        acceptanceCriteria: ['Criteria 1'],
        fidelityCheckResult: {
          passed: false,
          qualityMetrics: {},
          unmetCriteria: ['Tests failing'],
          findings: [],
        },
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
        fidelityLevel: 'fast',
      };

      const result = await judgeAgent.judgeExtended(context);

      expect(result.decision).toBe('ITERATE');
      expect(result.metrics).toBeUndefined(); // Fast fidelity, no LLM call
    });
  });

  describe('Standard fidelity captures real metrics', () => {
    it('should capture metrics from LLM call on standard fidelity', async () => {
      const mockLlmResult: ExecutionResult = {
        success: true,
        outputs: {
          analysis: JSON.stringify({
            decision: 'PROCEED',
            reason: 'All criteria met',
            gaps: [],
          }),
        },
        metrics: {
          tokensUsed: 3500,
          duration: 8000,
          cost: 0.85,
        },
        errors: [],
      };

      (mockAdapter.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockLlmResult);

      const context: JudgeContext = {
        acceptanceCriteria: ['Criteria 1'],
        fidelityCheckResult: {
          passed: true, // Standard+ still calls LLM even when syntactic passes
          qualityMetrics: {},
          unmetCriteria: [],
          findings: [],
        },
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
        fidelityLevel: 'standard',
      };

      const result = await judgeAgent.judgeExtended(context);

      expect(result.metrics).toBeDefined();
      expect(result.metrics!.tokensUsed).toBe(3500);
      expect(result.metrics!.duration).toBe(8000);
      expect(result.metrics!.cost).toBe(0.85);
    });

    it('should report zero-cost metrics when LLM call fails', async () => {
      (mockAdapter.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('LLM call failed')
      );

      const context: JudgeContext = {
        acceptanceCriteria: ['Criteria 1'],
        fidelityCheckResult: {
          passed: false,
          qualityMetrics: {},
          unmetCriteria: ['Tests failing'],
          findings: [],
        },
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
        fidelityLevel: 'standard',
      };

      const result = await judgeAgent.judgeExtended(context);

      // AgentInvoker returns a failure result (doesn't throw) with zero metrics
      expect(result.decision).toBe('ITERATE');
      expect(result.metrics).toBeDefined();
      expect(result.metrics!.cost).toBe(0);
      expect(result.metrics!.tokensUsed).toBe(0);
    });

    it('should default cost to 0 when LLM result has no cost field', async () => {
      const mockLlmResult: ExecutionResult = {
        success: true,
        outputs: {
          analysis: JSON.stringify({
            decision: 'PROCEED',
            reason: 'All criteria met',
            gaps: [],
          }),
        },
        metrics: {
          tokensUsed: 3500,
          duration: 8000,
          // no cost field
        },
        errors: [],
      };

      (mockAdapter.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockLlmResult);

      const context: JudgeContext = {
        acceptanceCriteria: ['Criteria 1'],
        fidelityCheckResult: {
          passed: true,
          qualityMetrics: {},
          unmetCriteria: [],
          findings: [],
        },
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
        fidelityLevel: 'standard',
      };

      const result = await judgeAgent.judgeExtended(context);

      expect(result.metrics).toBeDefined();
      expect(result.metrics!.cost).toBe(0); // Defaults to 0
    });
  });
});
