/**
 * Fidelity parameter resolver
 * Resolves execution fidelity from multiple sources with priority:
 * 1. CLI flag (highest)
 * 2. Stage-level config
 * 3. Pipeline-level config
 * 4. System config default
 * 5. Hardcoded default (lowest)
 */

import type {
  ExecutionFidelityLevel,
  FidelityParameters,
  FidelityConfig,
  PipelineStage,
  Pipeline,
} from '../core/types.js';
import { EXECUTION_FIDELITY_LEVELS } from '../core/types.js';
import type { SystemConfig } from '../core/adapter-types.js';

/**
 * Fidelity level descriptions for UI display
 */
export const FIDELITY_DESCRIPTIONS: Record<ExecutionFidelityLevel, string> = {
  fast: 'minimal verification, 1 pass (correctness only)',
  standard: 'focused rotation, 5 passes (full review cycle)',
  thorough: 'comprehensive verification, 8 passes (rotation + deep dives)',
  ultra: 'multi-model consensus, 15 passes (3x rotation + synthesis)',
};

/**
 * Fidelity level use-case descriptions for user guidance
 */
export const FIDELITY_USE_CASES: Record<ExecutionFidelityLevel, string> = {
  fast: 'Quick iterations, prototyping',
  standard: 'Balanced quality and cost',
  thorough: 'Important features, production code',
  ultra: 'Critical infrastructure, security patches',
};

/**
 * Default fidelity parameters for each level
 * Used as fallback when no configuration is provided
 * Uses camelCase for TypeScript convention
 *
 * Review iterations follow the focused rotation pattern:
 * - fast: 1 pass (correctness only)
 * - standard: 5 passes (full rotation: correctness, security, performance, style, touch points)
 * - thorough: 8 passes (full rotation + 3 deep dives)
 * - ultra: 15 passes (3x full rotation + synthesis)
 */
export const DEFAULT_FIDELITY_CONFIG: FidelityConfig = {
  default_level: 'standard',
  levels: {
    fast: {
      temperature: 0.3,
      maxTokens: 2048,
      retryCount: 1,
      reviewIterations: 1,
      useCaching: true,
      enableVerification: false,
      multiModelVoting: false,
    },
    standard: {
      temperature: 0.2,
      maxTokens: 4096,
      retryCount: 2,
      reviewIterations: 5,
      useCaching: true,
      enableVerification: true,
      multiModelVoting: false,
    },
    thorough: {
      temperature: 0.1,
      maxTokens: 8192,
      retryCount: 3,
      reviewIterations: 8,
      useCaching: false,
      enableVerification: true,
      multiModelVoting: false,
    },
    ultra: {
      temperature: 0.0,
      maxTokens: 16384,
      retryCount: 5,
      reviewIterations: 15,
      useCaching: false,
      enableVerification: true,
      multiModelVoting: true,
    },
  },
};

/**
 * Convert camelCase FidelityConfig to snake_case format for YAML/Zod schema
 * This is needed because the schema expects snake_case (from YAML files)
 * but our TypeScript constants use camelCase convention
 */
export function convertFidelityConfigToSnakeCase(config: FidelityConfig): {
  default_level: ExecutionFidelityLevel;
  levels: Record<
    ExecutionFidelityLevel,
    {
      temperature: number;
      max_tokens: number;
      retry_count: number;
      review_iterations: number;
      use_caching: boolean;
      enable_verification: boolean;
      multi_model_voting: boolean;
    }
  >;
} {
  return {
    default_level: config.default_level,
    levels: Object.fromEntries(
      Object.entries(config.levels).map(([level, params]) => [
        level,
        {
          temperature: params.temperature,
          max_tokens: params.maxTokens,
          retry_count: params.retryCount,
          review_iterations: params.reviewIterations,
          use_caching: params.useCaching,
          enable_verification: params.enableVerification,
          multi_model_voting: params.multiModelVoting,
        },
      ])
    ) as Record<
      ExecutionFidelityLevel,
      {
        temperature: number;
        max_tokens: number;
        retry_count: number;
        review_iterations: number;
        use_caching: boolean;
        enable_verification: boolean;
        multi_model_voting: boolean;
      }
    >,
  };
}

/**
 * Cost multipliers for each fidelity level (relative to standard)
 */
const FIDELITY_COST_MULTIPLIERS: Record<ExecutionFidelityLevel, number> = {
  fast: 0.3, // thin pipeline, fewer stages
  standard: 1.0, // baseline ~$10 per workflow
  thorough: 1.5, // enhanced review + more iterations
  ultra: 3.0, // multi-model consensus, many iterations
};

/**
 * Default baseline cost for standard fidelity (in dollars)
 * Empirically derived from production runs (issue #251):
 *   - thin/fast pipeline: ~$3-5 per workflow
 *   - standard pipeline: ~$10-15 per workflow
 * Previous value of $0.05 was 200x too low.
 */
const DEFAULT_BASELINE_COST = 10.0;

/**
 * Options for resolving fidelity
 */
export interface FidelityResolveOptions {
  cliFlag?: ExecutionFidelityLevel;
  stage?: PipelineStage;
  pipeline?: Pipeline;
  systemConfig?: SystemConfig;
}

/**
 * Result of fidelity resolution
 */
export interface FidelityResolution {
  level: ExecutionFidelityLevel;
  params: FidelityParameters;
  source: 'cli' | 'stage' | 'pipeline' | 'system' | 'default';
}

/**
 * Get fidelity configuration from system config or use defaults
 * Performs shallow merge to allow partial parameter overrides per fidelity level
 */
export function getFidelityConfig(systemConfig?: SystemConfig): FidelityConfig {
  if (systemConfig?.execution_fidelity) {
    const userLevels = systemConfig.execution_fidelity.levels || {};

    // Shallow merge: for each level, merge user params with defaults (sufficient for primitive values)
    const mergedLevels = Object.fromEntries(
      EXECUTION_FIDELITY_LEVELS.map((level) => [
        level,
        {
          ...DEFAULT_FIDELITY_CONFIG.levels[level],
          ...(userLevels[level] || {}),
        },
      ])
    ) as Record<ExecutionFidelityLevel, FidelityParameters>;

    return {
      default_level:
        systemConfig.execution_fidelity.default_level ||
        DEFAULT_FIDELITY_CONFIG.default_level,
      levels: mergedLevels,
    };
  }
  return DEFAULT_FIDELITY_CONFIG;
}

/**
 * Resolve fidelity level and parameters from multiple sources
 */
export function resolveFidelity(
  options: FidelityResolveOptions
): FidelityResolution {
  const fidelityConfig = getFidelityConfig(options.systemConfig);

  // Priority 1: CLI flag (highest)
  if (options.cliFlag) {
    return {
      level: options.cliFlag,
      params: fidelityConfig.levels[options.cliFlag],
      source: 'cli',
    };
  }

  // Priority 2: Stage-level config
  if (
    options.stage?.fidelity &&
    options.stage.fidelity !== 'inherit' &&
    options.stage.fidelity in fidelityConfig.levels
  ) {
    const level = options.stage.fidelity as ExecutionFidelityLevel;
    return {
      level,
      params: fidelityConfig.levels[level],
      source: 'stage',
    };
  }

  // Priority 3: Pipeline-level config
  if (options.pipeline?.default_fidelity) {
    return {
      level: options.pipeline.default_fidelity,
      params: fidelityConfig.levels[options.pipeline.default_fidelity],
      source: 'pipeline',
    };
  }

  // Priority 4: System config default
  if (options.systemConfig?.execution_fidelity?.default_level) {
    const level = options.systemConfig.execution_fidelity.default_level;
    return {
      level,
      params: fidelityConfig.levels[level],
      source: 'system',
    };
  }

  // Priority 5: Hardcoded default (lowest)
  const defaultLevel = fidelityConfig.default_level;
  return {
    level: defaultLevel,
    params: fidelityConfig.levels[defaultLevel],
    source: 'default',
  };
}

/**
 * Get fidelity parameters for a specific level
 */
export function getFidelityParams(
  level: ExecutionFidelityLevel,
  systemConfig?: SystemConfig
): FidelityParameters {
  const fidelityConfig = getFidelityConfig(systemConfig);
  return fidelityConfig.levels[level];
}

/**
 * Estimate workflow cost for a given fidelity level
 * @param level - Fidelity level
 * @param baselineCost - Baseline cost for standard fidelity (in dollars)
 * @returns Estimated cost in dollars
 */
export function estimateFidelityCost(
  level: ExecutionFidelityLevel,
  baselineCost: number = DEFAULT_BASELINE_COST
): number {
  return baselineCost * FIDELITY_COST_MULTIPLIERS[level];
}

/**
 * Get all fidelity cost estimates
 * @param baselineCost - Baseline cost for standard fidelity (in dollars)
 * @returns Map of fidelity level to estimated cost
 */
export function getAllFidelityCostEstimates(
  baselineCost: number = DEFAULT_BASELINE_COST
): Record<ExecutionFidelityLevel, number> {
  return {
    fast: estimateFidelityCost('fast', baselineCost),
    standard: estimateFidelityCost('standard', baselineCost),
    thorough: estimateFidelityCost('thorough', baselineCost),
    ultra: estimateFidelityCost('ultra', baselineCost),
  };
}

/**
 * Check if a fidelity level requires user approval for cost
 */
export function requiresCostWarning(level: ExecutionFidelityLevel): boolean {
  return level === 'ultra' || level === 'thorough';
}
