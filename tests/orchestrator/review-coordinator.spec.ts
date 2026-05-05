/**
 * Review coordinator tests
 */

import { describe, it, expect, vi } from 'vitest';
import {
  executeReview,
  runReviewIteration,
  runConsensusVoting,
  requiresConsensusVoting,
  validateReviewConfig,
} from '../../src/orchestrator/review-coordinator.js';
import type {
  ExecutionAdapter,
  ExecutionRequest,
  ExecutionResult,
  AgentDef,
  ProjectContext,
} from '../../src/core/adapter-types.js';
import type { FidelityParameters } from '../../src/core/types.js';

/**
 * Mock adapter for testing
 */
class MockAdapter implements ExecutionAdapter {
  name = 'mock-adapter' as const;
  type = 'sdk' as const;
  private shouldSucceed: boolean;
  private tokensUsed: number;
  private cost: number;
  private duration: number;

  constructor(
    shouldSucceed = true,
    tokensUsed = 100,
    cost = 0.01,
    duration = 1000
  ) {
    this.shouldSucceed = shouldSucceed;
    this.tokensUsed = tokensUsed;
    this.cost = cost;
    this.duration = duration;
  }

  async init(): Promise<void> {}

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    return {
      success: this.shouldSucceed,
      outputs: {
        analysis: 'Mock analysis',
        files: [],
        recommendations: [],
      },
      metrics: {
        tokensUsed: this.tokensUsed,
        cost: this.cost,
        duration: this.duration,
      },
      errors: this.shouldSucceed ? [] : [new Error('Mock error')],
    };
  }

  async isAvailable() {
    return { available: true, reason: 'Mock adapter always available' };
  }

  async cleanup(): Promise<void> {}
}

describe('Review Coordinator', () => {
  const mockAgent: AgentDef = {
    role: 'orchestrator',
    capabilities: ['code-review'],
    contextRequired: ['code'],
  };

  const mockContext: ProjectContext = {
    workingDirectory: '/test',
  };

  const mockRequest: ExecutionRequest = {
    agent: mockAgent,
    task: 'Review code',
    context: mockContext,
  };

  const baseFidelityParams: FidelityParameters = {
    temperature: 0.2,
    maxTokens: 4096,
    retryCount: 2,
    reviewIterations: 2,
    useCaching: true,
    enableVerification: true,
    multiModelVoting: false,
  };

  describe('runReviewIteration', () => {
    it('should execute a single iteration successfully', async () => {
      const adapter = new MockAdapter(true, 100, 0.01, 1000);
      const result = await runReviewIteration(
        adapter,
        mockRequest,
        baseFidelityParams,
        1
      );

      expect(result.iteration).toBe(1);
      expect(result.approved).toBe(true);
      expect(result.result.success).toBe(true);
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('should mark iteration as not approved on failure', async () => {
      const adapter = new MockAdapter(false);
      const result = await runReviewIteration(
        adapter,
        mockRequest,
        baseFidelityParams,
        1
      );

      expect(result.approved).toBe(false);
      expect(result.result.success).toBe(false);
    });

    it('should pass fidelity params to adapter', async () => {
      const adapter = new MockAdapter();
      const executeSpy = vi.spyOn(adapter, 'execute');

      await runReviewIteration(adapter, mockRequest, baseFidelityParams, 1);

      expect(executeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          fidelityParams: expect.objectContaining({
            temperature: 0.2,
            maxTokens: 4096,
            retryCount: 2,
            useCaching: true,
            enableVerification: true,
          }),
        })
      );
    });
  });

  describe('executeReview', () => {
    it('should execute review with specified iterations', async () => {
      const adapter = new MockAdapter(true, 100, 0.01, 1000);
      const fidelityParams = {
        ...baseFidelityParams,
        reviewIterations: 3,
      };

      const result = await executeReview({
        fidelityParams,
        adapter,
        request: mockRequest,
      });

      // Should complete iterations
      expect(result.totalIterations).toBeGreaterThan(0);
      expect(result.totalIterations).toBeLessThanOrEqual(3);
      expect(result.iterations).toHaveLength(result.totalIterations);
      expect(result.finalResult).toBeDefined();
    });

    it('should stop on first approval', async () => {
      const adapter = new MockAdapter(true);
      const fidelityParams = {
        ...baseFidelityParams,
        reviewIterations: 5,
      };

      const result = await executeReview({
        fidelityParams,
        adapter,
        request: mockRequest,
      });

      // Should stop early when approved
      expect(result.totalIterations).toBeLessThanOrEqual(5);
      expect(result.iterations.length).toBeGreaterThan(0);
      expect(result.finalResult).toBeDefined();
    });

    it('should continue through all iterations if not approved', async () => {
      const adapter = new MockAdapter(false);
      const fidelityParams = {
        ...baseFidelityParams,
        reviewIterations: 3,
      };

      const result = await executeReview({
        fidelityParams,
        adapter,
        request: mockRequest,
      });

      expect(result.totalIterations).toBe(3);
      expect(result.iterations).toHaveLength(3);
      expect(result.finalResult).toBeDefined();
    });

    it('should aggregate metrics across iterations', async () => {
      const adapter = new MockAdapter(false, 100, 0.01, 1000);
      const fidelityParams = {
        ...baseFidelityParams,
        reviewIterations: 3,
      };

      const result = await executeReview({
        fidelityParams,
        adapter,
        request: mockRequest,
      });

      expect(result.totalIterations).toBe(3);
      expect(result.metrics.totalTokens).toBeGreaterThan(0);
      expect(result.metrics.totalCost).toBeGreaterThan(0);
      expect(result.metrics.totalDuration).toBeGreaterThan(0);
    });

    it('should use maxIterations parameter when provided', async () => {
      const adapter = new MockAdapter(false);
      const fidelityParams = {
        ...baseFidelityParams,
        reviewIterations: 5,
      };

      const result = await executeReview({
        fidelityParams,
        adapter,
        request: mockRequest,
        maxIterations: 2, // Override
      });

      expect(result.totalIterations).toBe(2);
    });

    it('should handle single iteration correctly', async () => {
      const adapter = new MockAdapter(true);
      const fidelityParams = {
        ...baseFidelityParams,
        reviewIterations: 1,
      };

      const result = await executeReview({
        fidelityParams,
        adapter,
        request: mockRequest,
      });

      expect(result.totalIterations).toBe(1);
      expect(result.iterations).toHaveLength(1);
      expect(result.finalResult).toBeDefined();
    });
  });

  describe('runConsensusVoting', () => {
    it('should execute with 3 adapters and achieve consensus', async () => {
      const adapters = [
        new MockAdapter(true),
        new MockAdapter(true),
        new MockAdapter(false),
      ];

      const result = await runConsensusVoting(
        adapters,
        mockRequest,
        baseFidelityParams
      );

      expect(result.consensusAchieved).toBe(true);
      expect(result.votes.approve).toBe(2);
      expect(result.votes.reject).toBe(1);
      expect(result.results).toHaveLength(3);
    });

    it('should fail consensus with insufficient approvals', async () => {
      const adapters = [
        new MockAdapter(true),
        new MockAdapter(false),
        new MockAdapter(false),
      ];

      const result = await runConsensusVoting(
        adapters,
        mockRequest,
        baseFidelityParams
      );

      expect(result.consensusAchieved).toBe(false);
      expect(result.votes.approve).toBe(1);
      expect(result.votes.reject).toBe(2);
    });

    it('should require at least 3 adapters', async () => {
      const adapters = [new MockAdapter(true), new MockAdapter(true)];

      await expect(
        runConsensusVoting(adapters, mockRequest, baseFidelityParams)
      ).rejects.toThrow('at least 3 adapters');
    });

    it('should execute all adapters in parallel', async () => {
      const adapters = [
        new MockAdapter(true),
        new MockAdapter(true),
        new MockAdapter(true),
      ];

      const executeSpy1 = vi.spyOn(adapters[0], 'execute');
      const executeSpy2 = vi.spyOn(adapters[1], 'execute');
      const executeSpy3 = vi.spyOn(adapters[2], 'execute');

      await runConsensusVoting(adapters, mockRequest, baseFidelityParams);

      expect(executeSpy1).toHaveBeenCalled();
      expect(executeSpy2).toHaveBeenCalled();
      expect(executeSpy3).toHaveBeenCalled();
    });

    it('should disable caching for consensus voting', async () => {
      const adapters = [
        new MockAdapter(true),
        new MockAdapter(true),
        new MockAdapter(true),
      ];

      const executeSpy = vi.spyOn(adapters[0], 'execute');

      await runConsensusVoting(adapters, mockRequest, baseFidelityParams);

      expect(executeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          fidelityParams: expect.objectContaining({
            useCaching: false,
          }),
        })
      );
    });

    it('should use first successful result as final result', async () => {
      const adapters = [
        new MockAdapter(false),
        new MockAdapter(true, 200, 0.02, 2000),
        new MockAdapter(true, 300, 0.03, 3000),
      ];

      const result = await runConsensusVoting(
        adapters,
        mockRequest,
        baseFidelityParams
      );

      expect(result.finalResult.success).toBe(true);
      expect(result.finalResult.metrics.tokensUsed).toBe(200);
    });

    it('should use first result if none succeeded', async () => {
      const adapters = [
        new MockAdapter(false, 100),
        new MockAdapter(false, 200),
        new MockAdapter(false, 300),
      ];

      const result = await runConsensusVoting(
        adapters,
        mockRequest,
        baseFidelityParams
      );

      expect(result.finalResult.success).toBe(false);
      expect(result.finalResult.metrics.tokensUsed).toBe(100);
    });

    it('should achieve consensus with 3/3 approval', async () => {
      const adapters = [
        new MockAdapter(true),
        new MockAdapter(true),
        new MockAdapter(true),
      ];

      const result = await runConsensusVoting(
        adapters,
        mockRequest,
        baseFidelityParams
      );

      expect(result.consensusAchieved).toBe(true);
      expect(result.votes.approve).toBe(3);
      expect(result.votes.reject).toBe(0);
    });

    it('should work with more than 3 adapters', async () => {
      const adapters = [
        new MockAdapter(true),
        new MockAdapter(true),
        new MockAdapter(true),
        new MockAdapter(false),
        new MockAdapter(false),
      ];

      const result = await runConsensusVoting(
        adapters,
        mockRequest,
        baseFidelityParams
      );

      // 3/5 approvals = 60%, requires >= 2/3 = 66.67%
      expect(result.consensusAchieved).toBe(false);
      expect(result.votes.approve).toBe(3);
      expect(result.votes.reject).toBe(2);
    });
  });

  describe('requiresConsensusVoting', () => {
    it('should return true when multi_model_voting is true', () => {
      const fidelityParams = {
        ...baseFidelityParams,
        multiModelVoting: true,
      };

      expect(requiresConsensusVoting(fidelityParams)).toBe(true);
    });

    it('should return false when multi_model_voting is false', () => {
      const fidelityParams = {
        ...baseFidelityParams,
        multiModelVoting: false,
      };

      expect(requiresConsensusVoting(fidelityParams)).toBe(false);
    });
  });

  describe('validateReviewConfig', () => {
    it('should validate correct config', () => {
      const result = validateReviewConfig(baseFidelityParams);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject review_iterations < 1', () => {
      const fidelityParams = {
        ...baseFidelityParams,
        reviewIterations: 0,
      };

      const result = validateReviewConfig(fidelityParams);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('review_iterations must be at least 1');
    });

    it('should reject review_iterations > 15', () => {
      const fidelityParams = {
        ...baseFidelityParams,
        reviewIterations: 16,
      };

      const result = validateReviewConfig(fidelityParams);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'review_iterations cannot exceed 15 (cost protection)'
      );
    });

    it('should accept review_iterations at boundaries (1 and 15)', () => {
      const fidelityParams1 = {
        ...baseFidelityParams,
        reviewIterations: 1,
      };

      const fidelityParams15 = {
        ...baseFidelityParams,
        reviewIterations: 15,
      };

      expect(validateReviewConfig(fidelityParams1).valid).toBe(true);
      expect(validateReviewConfig(fidelityParams15).valid).toBe(true);
    });
  });
});
