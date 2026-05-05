/**
 * Fidelity resolver tests
 */

import { describe, it, expect } from 'vitest';
import {
  resolveFidelity,
  getFidelityConfig,
  getFidelityParams,
  estimateFidelityCost,
  getAllFidelityCostEstimates,
  requiresCostWarning,
  DEFAULT_FIDELITY_CONFIG,
} from '../../src/utils/fidelity-resolver.js';
import type { SystemConfig } from '../../src/core/adapter-types.js';
import type { Pipeline, PipelineStage } from '../../src/core/types.js';

describe('Fidelity Resolver', () => {
  describe('getFidelityConfig', () => {
    it('should return default config when no system config provided', () => {
      const config = getFidelityConfig();

      expect(config).toEqual(DEFAULT_FIDELITY_CONFIG);
      expect(config.default_level).toBe('standard');
      expect(config.levels.fast).toBeDefined();
      expect(config.levels.standard).toBeDefined();
      expect(config.levels.thorough).toBeDefined();
      expect(config.levels.ultra).toBeDefined();
    });

    it('should return default config when system config has no execution_fidelity', () => {
      const systemConfig: SystemConfig = {
        agent_routing: { orchestrator: 'claude-code' },
        backends: {
          'claude-code': {
            type: 'cli',
            executable: 'claude',
          },
        },
        fallback_backend: 'claude-code',
      };

      const config = getFidelityConfig(systemConfig);
      expect(config).toEqual(DEFAULT_FIDELITY_CONFIG);
    });

    it('should merge partial user config with defaults', () => {
      const systemConfig: SystemConfig = {
        agent_routing: { orchestrator: 'claude-code' },
        backends: {
          'claude-code': { type: 'cli', executable: 'claude' },
        },
        fallback_backend: 'claude-code',
        execution_fidelity: {
          default_level: 'thorough',
          levels: {
            fast: {
              temperature: 0.5, // Override only temperature
              maxTokens: 2048,
              retryCount: 1,
              reviewIterations: 1,
              useCaching: true,
              enableVerification: false,
              multiModelVoting: false,
            },
            standard: DEFAULT_FIDELITY_CONFIG.levels.standard,
            thorough: DEFAULT_FIDELITY_CONFIG.levels.thorough,
            ultra: DEFAULT_FIDELITY_CONFIG.levels.ultra,
          },
        },
      };

      const config = getFidelityConfig(systemConfig);

      expect(config.default_level).toBe('thorough');
      expect(config.levels.fast.temperature).toBe(0.5);
      expect(config.levels.fast.maxTokens).toBe(2048); // Other params unchanged
    });

    it('should handle missing levels by using defaults', () => {
      const systemConfig: SystemConfig = {
        agent_routing: { orchestrator: 'claude-code' },
        backends: {
          'claude-code': { type: 'cli', executable: 'claude' },
        },
        fallback_backend: 'claude-code',
        execution_fidelity: {
          default_level: 'standard',
          levels: {
            fast: DEFAULT_FIDELITY_CONFIG.levels.fast,
            standard: DEFAULT_FIDELITY_CONFIG.levels.standard,
            thorough: DEFAULT_FIDELITY_CONFIG.levels.thorough,
            ultra: DEFAULT_FIDELITY_CONFIG.levels.ultra,
          },
        },
      };

      const config = getFidelityConfig(systemConfig);

      // All levels should be populated
      expect(config.levels.fast).toBeDefined();
      expect(config.levels.standard).toBeDefined();
      expect(config.levels.thorough).toBeDefined();
      expect(config.levels.ultra).toBeDefined();
    });
  });

  describe('resolveFidelity', () => {
    it('should prioritize CLI flag (highest priority)', () => {
      const systemConfig: SystemConfig = {
        agent_routing: { orchestrator: 'claude-code' },
        backends: {
          'claude-code': { type: 'cli', executable: 'claude' },
        },
        fallback_backend: 'claude-code',
        execution_fidelity: {
          default_level: 'standard',
          levels: DEFAULT_FIDELITY_CONFIG.levels,
        },
      };

      const pipeline: Pipeline = {
        name: 'test',
        default_fidelity: 'thorough',
        stages: [],
      };

      const stage: PipelineStage = {
        name: 'test-stage',
        agent: 'orchestrator',
        fidelity: 'standard',
      };

      const result = resolveFidelity({
        cliFlag: 'ultra',
        stage,
        pipeline,
        systemConfig,
      });

      expect(result.level).toBe('ultra');
      expect(result.source).toBe('cli');
      expect(result.params).toEqual(DEFAULT_FIDELITY_CONFIG.levels.ultra);
    });

    it('should use stage-level config when no CLI flag', () => {
      const stage: PipelineStage = {
        name: 'test-stage',
        agent: 'orchestrator',
        fidelity: 'fast',
      };

      const pipeline: Pipeline = {
        name: 'test',
        default_fidelity: 'thorough',
        stages: [],
      };

      const result = resolveFidelity({
        stage,
        pipeline,
      });

      expect(result.level).toBe('fast');
      expect(result.source).toBe('stage');
    });

    it('should skip stage-level if fidelity is "inherit"', () => {
      const stage: PipelineStage = {
        name: 'test-stage',
        agent: 'orchestrator',
        fidelity: 'inherit',
      };

      const pipeline: Pipeline = {
        name: 'test',
        default_fidelity: 'thorough',
        stages: [],
      };

      const result = resolveFidelity({
        stage,
        pipeline,
      });

      expect(result.level).toBe('thorough');
      expect(result.source).toBe('pipeline');
    });

    it('should use pipeline-level config when no CLI flag or stage config', () => {
      const pipeline: Pipeline = {
        name: 'test',
        default_fidelity: 'ultra',
        stages: [],
      };

      const result = resolveFidelity({
        pipeline,
      });

      expect(result.level).toBe('ultra');
      expect(result.source).toBe('pipeline');
    });

    it('should use system config default when higher priorities absent', () => {
      const systemConfig: SystemConfig = {
        agent_routing: { orchestrator: 'claude-code' },
        backends: {
          'claude-code': { type: 'cli', executable: 'claude' },
        },
        fallback_backend: 'claude-code',
        execution_fidelity: {
          default_level: 'thorough',
          levels: DEFAULT_FIDELITY_CONFIG.levels,
        },
      };

      const result = resolveFidelity({
        systemConfig,
      });

      expect(result.level).toBe('thorough');
      expect(result.source).toBe('system');
    });

    it('should use hardcoded default when all other sources absent', () => {
      const result = resolveFidelity({});

      expect(result.level).toBe('standard');
      expect(result.source).toBe('default');
      expect(result.params).toEqual(DEFAULT_FIDELITY_CONFIG.levels.standard);
    });

    it('should handle undefined system config gracefully', () => {
      const result = resolveFidelity({
        systemConfig: undefined,
      });

      expect(result.level).toBe('standard');
      expect(result.source).toBe('default');
    });
  });

  describe('getFidelityParams', () => {
    it('should return params for fast level', () => {
      const params = getFidelityParams('fast');

      expect(params.temperature).toBe(0.3);
      expect(params.maxTokens).toBe(2048);
      expect(params.retryCount).toBe(1);
      expect(params.reviewIterations).toBe(1);
      expect(params.useCaching).toBe(true);
      expect(params.enableVerification).toBe(false);
      expect(params.multiModelVoting).toBe(false);
    });

    it('should return params for standard level', () => {
      const params = getFidelityParams('standard');

      expect(params.temperature).toBe(0.2);
      expect(params.maxTokens).toBe(4096);
      expect(params.retryCount).toBe(2);
      expect(params.reviewIterations).toBe(5); // 5 passes: full rotation
      expect(params.useCaching).toBe(true);
      expect(params.enableVerification).toBe(true);
      expect(params.multiModelVoting).toBe(false);
    });

    it('should return params for thorough level', () => {
      const params = getFidelityParams('thorough');

      expect(params.temperature).toBe(0.1);
      expect(params.maxTokens).toBe(8192);
      expect(params.retryCount).toBe(3);
      expect(params.reviewIterations).toBe(8); // 8 passes: rotation + 3 deep dives
      expect(params.useCaching).toBe(false);
      expect(params.enableVerification).toBe(true);
      expect(params.multiModelVoting).toBe(false);
    });

    it('should return params for ultra level', () => {
      const params = getFidelityParams('ultra');

      expect(params.temperature).toBe(0.0);
      expect(params.maxTokens).toBe(16384);
      expect(params.retryCount).toBe(5);
      expect(params.reviewIterations).toBe(15); // 15 passes: 3x rotation + synthesis
      expect(params.useCaching).toBe(false);
      expect(params.enableVerification).toBe(true);
      expect(params.multiModelVoting).toBe(true);
    });

    it('should respect custom system config', () => {
      const systemConfig: SystemConfig = {
        agent_routing: { orchestrator: 'claude-code' },
        backends: {
          'claude-code': { type: 'cli', executable: 'claude' },
        },
        fallback_backend: 'claude-code',
        execution_fidelity: {
          default_level: 'standard',
          levels: {
            fast: {
              ...DEFAULT_FIDELITY_CONFIG.levels.fast,
              temperature: 0.5,
            },
            standard: DEFAULT_FIDELITY_CONFIG.levels.standard,
            thorough: DEFAULT_FIDELITY_CONFIG.levels.thorough,
            ultra: DEFAULT_FIDELITY_CONFIG.levels.ultra,
          },
        },
      };

      const params = getFidelityParams('fast', systemConfig);
      expect(params.temperature).toBe(0.5);
    });
  });

  describe('estimateFidelityCost', () => {
    it('should calculate cost for fast level', () => {
      const cost = estimateFidelityCost('fast', 1.0);
      expect(cost).toBe(0.3);
    });

    it('should calculate cost for standard level (baseline)', () => {
      const cost = estimateFidelityCost('standard', 1.0);
      expect(cost).toBe(1.0);
    });

    it('should calculate cost for thorough level', () => {
      const cost = estimateFidelityCost('thorough', 1.0);
      expect(cost).toBe(1.5);
    });

    it('should calculate cost for ultra level', () => {
      const cost = estimateFidelityCost('ultra', 1.0);
      expect(cost).toBe(3.0);
    });

    it('should use default baseline cost when not provided', () => {
      const cost = estimateFidelityCost('standard');
      expect(cost).toBe(10.0); // DEFAULT_BASELINE_COST=10.0 * standard multiplier=1.0
    });

    it('should work with custom baseline cost', () => {
      const cost = estimateFidelityCost('ultra', 0.10);
      expect(cost).toBeCloseTo(0.3);
    });
  });

  describe('getAllFidelityCostEstimates', () => {
    it('should return estimates for all fidelity levels', () => {
      const estimates = getAllFidelityCostEstimates(1.0);

      expect(estimates.fast).toBe(0.3);
      expect(estimates.standard).toBe(1.0);
      expect(estimates.thorough).toBe(1.5);
      expect(estimates.ultra).toBe(3.0);
    });

    it('should use default baseline when not provided', () => {
      const estimates = getAllFidelityCostEstimates();

      expect(estimates.standard).toBe(10.0);
    });
  });

  describe('requiresCostWarning', () => {
    it('should return false for fast level', () => {
      expect(requiresCostWarning('fast')).toBe(false);
    });

    it('should return false for standard level', () => {
      expect(requiresCostWarning('standard')).toBe(false);
    });

    it('should return true for thorough level', () => {
      expect(requiresCostWarning('thorough')).toBe(true);
    });

    it('should return true for ultra level', () => {
      expect(requiresCostWarning('ultra')).toBe(true);
    });
  });
});
