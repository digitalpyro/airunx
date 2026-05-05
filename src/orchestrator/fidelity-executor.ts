/**
 * Fidelity Executor - Apply fidelity parameters to execution
 * Resolves and applies fidelity settings to backend adapters
 */

import type { ExecutionAdapter } from '../core/adapter-types.js';
import type {
  PipelineStage,
  Pipeline,
  ExecutionFidelityLevel,
  FidelityParameters,
} from '../core/types.js';
import type { SystemConfig } from '../core/adapter-types.js';
import {
  resolveFidelity,
  getFidelityParams,
  type FidelityResolution,
} from '../utils/fidelity-resolver.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('fidelity-executor');

/**
 * Fidelity execution options
 */
export interface FidelityExecutionOptions {
  cliFlag?: ExecutionFidelityLevel;
  stage?: PipelineStage;
  pipeline?: Pipeline;
  systemConfig?: SystemConfig;
}

/**
 * Fidelity Executor class
 */
export class FidelityExecutor {
  /**
   * Resolve fidelity for a stage
   */
  static resolveStageFidelity(
    options: FidelityExecutionOptions
  ): FidelityResolution {
    logger.debug('Resolving stage fidelity');

    const resolution = resolveFidelity({
      cliFlag: options.cliFlag,
      stage: options.stage,
      pipeline: options.pipeline,
      systemConfig: options.systemConfig,
    });

    logger.info(
      `Resolved fidelity: ${resolution.level} (from ${resolution.source})`
    );

    return resolution;
  }

  /**
   * Get fidelity parameters for a level
   */
  static getFidelityParameters(
    level: ExecutionFidelityLevel,
    systemConfig?: SystemConfig
  ): FidelityParameters {
    return getFidelityParams(level, systemConfig);
  }

  /**
   * Apply fidelity parameters to adapter
   * This configures the adapter with the resolved fidelity settings
   */
  static async applyFidelityToAdapter(
    _adapter: ExecutionAdapter,
    _params: FidelityParameters
  ): Promise<void> {
    logger.debug('Applying fidelity parameters to adapter');

    // Note: In the current architecture, fidelity params are passed per-request
    // rather than being set on the adapter globally. This is handled in AgentInvoker.
    // This method is here for future use if needed.

    logger.debug('Fidelity parameters will be applied per-request');
  }

  /**
   * Check if verification should run for this fidelity level
   */
  static shouldRunVerification(params: FidelityParameters): boolean {
    return params.enableVerification;
  }

  /**
   * Get max iterations for this fidelity level
   */
  static getMaxIterations(params: FidelityParameters): number {
    return params.reviewIterations;
  }

  /**
   * Get retry count for this fidelity level
   */
  static getRetryCount(params: FidelityParameters): number {
    return params.retryCount;
  }

  /**
   * Check if multi-model voting is enabled
   */
  static isMultiModelVotingEnabled(params: FidelityParameters): boolean {
    return params.multiModelVoting;
  }

  /**
   * Generate fidelity summary for logging
   */
  static summarizeFidelity(resolution: FidelityResolution): string {
    const params = resolution.params;

    let summary = `Fidelity Level: ${resolution.level} (${resolution.source})\n`;
    summary += `- Temperature: ${params.temperature}\n`;
    summary += `- Max Tokens: ${params.maxTokens}\n`;
    summary += `- Retry Count: ${params.retryCount}\n`;
    summary += `- Review Iterations: ${params.reviewIterations}\n`;
    summary += `- Caching: ${params.useCaching ? 'enabled' : 'disabled'}\n`;
    summary += `- Verification: ${params.enableVerification ? 'enabled' : 'disabled'}\n`;
    summary += `- Multi-Model Voting: ${params.multiModelVoting ? 'enabled' : 'disabled'}\n`;

    return summary;
  }

  /**
   * Track fidelity metrics
   */
  static trackFidelityMetrics(
    level: ExecutionFidelityLevel,
    tokensUsed: number,
    cost: number
  ): void {
    logger.debug('Fidelity metrics', {
      level,
      tokensUsed,
      cost,
    });

    // In a full implementation, this would persist metrics to a database
    // or metrics service for analysis and optimization
  }
}
