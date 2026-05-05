/**
 * Tests for Fidelity Executor
 * Validates fidelity parameter resolution and application
 */

import { describe, it, expect } from 'vitest';
import { FidelityExecutor } from '../../src/orchestrator/fidelity-executor.js';
import type { ExecutionAdapter } from '../../src/core/adapter-types.js';
import type {
  ExecutionFidelityLevel,
  FidelityParameters,
  PipelineStage,
  Pipeline,
} from '../../src/core/types.js';

describe('Fidelity Executor', () => {
  describe('Fidelity Resolution', () => {
    it('should resolve fidelity from CLI flag', () => {
      const resolution = FidelityExecutor.resolveStageFidelity({
        cliFlag: 'thorough',
      });

      expect(resolution.level).toBe('thorough');
      expect(resolution.source).toBe('cli');
      expect(resolution.params).toBeDefined();
    });

    it('should resolve fidelity from stage definition', () => {
      const stage: PipelineStage = {
        name: 'test-stage',
        agent: 'developer',
        fidelity: 'standard',
      };

      const resolution = FidelityExecutor.resolveStageFidelity({
        stage,
      });

      expect(resolution.level).toBe('standard');
      expect(resolution.source).toBe('stage');
    });

    it('should resolve fidelity from pipeline default', () => {
      const pipeline: Pipeline = {
        name: 'test-pipeline',
        default_fidelity: 'fast',
        stages: [],
      };

      const resolution = FidelityExecutor.resolveStageFidelity({
        pipeline,
      });

      expect(resolution.level).toBe('fast');
      expect(resolution.source).toBe('pipeline');
    });

    it('should prioritize CLI flag over stage and pipeline', () => {
      const stage: PipelineStage = {
        name: 'test-stage',
        agent: 'developer',
        fidelity: 'standard',
      };

      const pipeline: Pipeline = {
        name: 'test-pipeline',
        default_fidelity: 'fast',
        stages: [],
      };

      const resolution = FidelityExecutor.resolveStageFidelity({
        cliFlag: 'ultra',
        stage,
        pipeline,
      });

      expect(resolution.level).toBe('ultra');
      expect(resolution.source).toBe('cli');
    });

    it('should use system default when no fidelity specified', () => {
      const resolution = FidelityExecutor.resolveStageFidelity({});

      expect(resolution.level).toBe('standard');
      expect(resolution.source).toBe('default');
    });
  });

  describe('Fidelity Parameters', () => {
    it('should get parameters for fast fidelity', () => {
      const params = FidelityExecutor.getFidelityParameters('fast');

      expect(params.temperature).toBe(0.3);
      expect(params.retryCount).toBe(1);
      expect(params.reviewIterations).toBe(1);
      expect(params.useCaching).toBe(true);
      expect(params.enableVerification).toBe(false);
      expect(params.multiModelVoting).toBe(false);
    });

    it('should get parameters for standard fidelity', () => {
      const params = FidelityExecutor.getFidelityParameters('standard');

      expect(params.temperature).toBe(0.2);
      expect(params.retryCount).toBe(2);
      expect(params.reviewIterations).toBe(5); // 5 passes: full rotation
      expect(params.useCaching).toBe(true);
      expect(params.enableVerification).toBe(true);
    });

    it('should get parameters for thorough fidelity', () => {
      const params = FidelityExecutor.getFidelityParameters('thorough');

      expect(params.temperature).toBe(0.1);
      expect(params.retryCount).toBe(3);
      expect(params.reviewIterations).toBe(8); // 8 passes: rotation + 3 deep dives
      expect(params.enableVerification).toBe(true);
    });

    it('should get parameters for ultra fidelity', () => {
      const params = FidelityExecutor.getFidelityParameters('ultra');

      expect(params.temperature).toBe(0.0);
      expect(params.retryCount).toBe(5);
      expect(params.reviewIterations).toBe(15); // 15 passes: 3x rotation + synthesis
      expect(params.enableVerification).toBe(true);
      expect(params.multiModelVoting).toBe(true);
    });
  });

  describe('Verification Checks', () => {
    it('should return true when verification enabled', () => {
      const params: FidelityParameters = {
        temperature: 0.2,
        maxTokens: 4096,
        retryCount: 2,
        useCaching: true,
        enableVerification: true,
        reviewIterations: 2,
      };

      expect(FidelityExecutor.shouldRunVerification(params)).toBe(true);
    });

    it('should return false when verification disabled', () => {
      const params: FidelityParameters = {
        temperature: 0.4,
        maxTokens: 2048,
        retryCount: 1,
        useCaching: true,
        enableVerification: false,
        reviewIterations: 1,
      };

      expect(FidelityExecutor.shouldRunVerification(params)).toBe(false);
    });
  });

  describe('Parameter Extraction', () => {
    it('should extract max iterations', () => {
      const params: FidelityParameters = {
        temperature: 0.2,
        maxTokens: 4096,
        retryCount: 2,
        useCaching: true,
        enableVerification: true,
        reviewIterations: 3,
      };

      expect(FidelityExecutor.getMaxIterations(params)).toBe(3);
    });

    it('should extract retry count', () => {
      const params: FidelityParameters = {
        temperature: 0.2,
        maxTokens: 4096,
        retryCount: 5,
        useCaching: true,
        enableVerification: true,
        reviewIterations: 2,
      };

      expect(FidelityExecutor.getRetryCount(params)).toBe(5);
    });

    it('should check multi-model voting enabled', () => {
      const paramsEnabled: FidelityParameters = {
        temperature: 0.0,
        maxTokens: 8192,
        retryCount: 5,
        useCaching: true,
        enableVerification: true,
        reviewIterations: 5,
        multiModelVoting: true,
      };

      expect(FidelityExecutor.isMultiModelVotingEnabled(paramsEnabled)).toBe(
        true
      );
    });

    it('should check multi-model voting disabled', () => {
      const paramsDisabled: FidelityParameters = {
        temperature: 0.2,
        maxTokens: 4096,
        retryCount: 2,
        useCaching: true,
        enableVerification: true,
        reviewIterations: 2,
        multiModelVoting: false,
      };

      expect(FidelityExecutor.isMultiModelVotingEnabled(paramsDisabled)).toBe(
        false
      );
    });
  });

  describe('Fidelity Summary', () => {
    it('should generate complete fidelity summary', () => {
      const resolution = FidelityExecutor.resolveStageFidelity({
        cliFlag: 'thorough',
      });

      const summary = FidelityExecutor.summarizeFidelity(resolution);

      expect(summary).toContain('Fidelity Level: thorough');
      expect(summary).toContain('(cli)');
      expect(summary).toContain('Temperature:');
      expect(summary).toContain('Max Tokens:');
      expect(summary).toContain('Retry Count:');
      expect(summary).toContain('Review Iterations:');
      expect(summary).toContain('Caching:');
      expect(summary).toContain('Verification:');
      expect(summary).toContain('Multi-Model Voting:');
    });

    it('should show enabled features correctly', () => {
      const resolution = FidelityExecutor.resolveStageFidelity({
        cliFlag: 'ultra',
      });

      const summary = FidelityExecutor.summarizeFidelity(resolution);

      expect(summary).toContain('Verification: enabled');
      expect(summary).toContain('Multi-Model Voting: enabled');
    });

    it('should show disabled features correctly', () => {
      const resolution = FidelityExecutor.resolveStageFidelity({
        cliFlag: 'fast',
      });

      const summary = FidelityExecutor.summarizeFidelity(resolution);

      expect(summary).toContain('Verification: disabled');
      expect(summary).toContain('Multi-Model Voting: disabled');
    });
  });

  describe('Adapter Application', () => {
    it('should apply fidelity to adapter without error', async () => {
      const mockAdapter: ExecutionAdapter = {
        name: 'mock-adapter',
        capabilities: ['coding'],
        execute: async () => ({
          success: true,
          outputs: {},
          metrics: { tokensUsed: 0, duration: 0 },
          errors: [],
        }),
      };

      const params: FidelityParameters = {
        temperature: 0.2,
        maxTokens: 4096,
        retryCount: 2,
        useCaching: true,
        enableVerification: true,
        reviewIterations: 2,
      };

      await expect(
        FidelityExecutor.applyFidelityToAdapter(mockAdapter, params)
      ).resolves.not.toThrow();
    });
  });

  describe('Metrics Tracking', () => {
    it('should track fidelity metrics without error', () => {
      expect(() => {
        FidelityExecutor.trackFidelityMetrics('standard', 1000, 0.05);
      }).not.toThrow();
    });

    it('should track metrics for all fidelity levels', () => {
      const levels: ExecutionFidelityLevel[] = [
        'fast',
        'standard',
        'thorough',
        'ultra',
      ];

      levels.forEach((level) => {
        expect(() => {
          FidelityExecutor.trackFidelityMetrics(level, 1000, 0.05);
        }).not.toThrow();
      });
    });
  });
});
