/**
 * Review Coordinator
 * Coordinates multi-iteration reviews and multi-model consensus voting
 * Integrates with Judge agent for approval workflows
 */

import type {
  ExecutionAdapter,
  ExecutionRequest,
  ExecutionResult,
} from '../core/adapter-types.js';
import type { FidelityParameters } from '../core/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('review-coordinator');

/**
 * Options for review execution
 */
export interface ReviewExecutionOptions {
  fidelityParams: FidelityParameters;
  adapter: ExecutionAdapter;
  request: ExecutionRequest;
  maxIterations?: number;
}

/**
 * Result of a single review iteration
 */
export interface ReviewIterationResult {
  iteration: number;
  result: ExecutionResult;
  approved: boolean;
  feedback?: string;
  timestamp: Date;
}

/**
 * Result of the full review process
 */
export interface ReviewExecutionResult {
  success: boolean;
  iterations: ReviewIterationResult[];
  finalResult: ExecutionResult;
  totalIterations: number;
  consensusAchieved?: boolean;
  metrics: {
    totalTokens: number;
    totalCost: number;
    totalDuration: number;
  };
}

/**
 * Multi-model consensus voting result
 */
export interface ConsensusVotingResult {
  consensusAchieved: boolean;
  results: ExecutionResult[];
  votes: {
    approve: number;
    reject: number;
  };
  finalResult: ExecutionResult;
}

/**
 * Execute a review with multiple iterations based on fidelity parameters
 */
export async function executeReview(
  options: ReviewExecutionOptions
): Promise<ReviewExecutionResult> {
  const {
    fidelityParams,
    adapter,
    request,
    maxIterations = fidelityParams.reviewIterations,
  } = options;

  logger.info(
    `Starting review with max ${maxIterations} iterations (fidelity: ${fidelityParams.reviewIterations})`
  );

  const iterations: ReviewIterationResult[] = [];
  let totalTokens = 0;
  let totalCost = 0;
  let totalDuration = 0;
  let approved = false;
  let finalResult: ExecutionResult | null = null;

  for (let i = 1; i <= maxIterations; i++) {
    logger.info(`Executing review iteration ${i}/${maxIterations}`);

    const iterationResult = await runReviewIteration(
      adapter,
      request,
      fidelityParams,
      i
    );

    totalTokens += iterationResult.result.metrics.tokensUsed;
    totalCost += iterationResult.result.metrics.cost || 0;
    totalDuration += iterationResult.result.metrics.duration;

    iterations.push(iterationResult);
    finalResult = iterationResult.result;

    // Check if approved
    if (iterationResult.approved) {
      logger.info(`Review approved on iteration ${i}`);
      approved = true;
      break;
    }

    // If not approved and not last iteration, prepare for next iteration
    if (i < maxIterations) {
      logger.info(`Review not approved, preparing iteration ${i + 1}`);
      // In a real implementation, we would update the request with feedback
      // For now, we just continue
    }
  }

  const success = approved && finalResult !== null && finalResult.success;

  return {
    success,
    iterations,
    finalResult: finalResult!,
    totalIterations: iterations.length,
    metrics: {
      totalTokens,
      totalCost,
      totalDuration,
    },
  };
}

/**
 * Run a single review iteration
 */
export async function runReviewIteration(
  adapter: ExecutionAdapter,
  request: ExecutionRequest,
  fidelityParams: FidelityParameters,
  iteration: number
): Promise<ReviewIterationResult> {
  const startTime = new Date();

  // Execute the request with fidelity parameters
  // Construct explicit subset - ExecutionRequest.fidelityParams excludes reviewIterations and multiModelVoting
  const requestWithFidelity: ExecutionRequest = {
    ...request,
    fidelityParams: {
      temperature: fidelityParams.temperature,
      maxTokens: fidelityParams.maxTokens,
      retryCount: fidelityParams.retryCount,
      useCaching: fidelityParams.useCaching,
      enableVerification: fidelityParams.enableVerification,
    },
  };

  const result = await adapter.execute(requestWithFidelity);

  // Approve on first successful result - review_iterations is a maximum, not minimum
  // In a real implementation, this would involve more sophisticated Judge agent logic
  const approved = result.success;

  return {
    iteration,
    result,
    approved,
    timestamp: startTime,
  };
}

/**
 * Run multi-model consensus voting for ultra fidelity
 */
export async function runConsensusVoting(
  adapters: ExecutionAdapter[],
  request: ExecutionRequest,
  fidelityParams: FidelityParameters
): Promise<ConsensusVotingResult> {
  logger.info(`Starting consensus voting with ${adapters.length} models`);

  if (adapters.length < 3) {
    throw new Error(
      'Consensus voting requires at least 3 adapters (ultra fidelity)'
    );
  }

  // Execute with all adapters in parallel
  // Construct explicit subset - ExecutionRequest.fidelityParams excludes reviewIterations and multiModelVoting
  // Caching is explicitly disabled for consensus voting to ensure independent results
  const results = await Promise.all(
    adapters.map((adapter) =>
      adapter.execute({
        ...request,
        fidelityParams: {
          temperature: fidelityParams.temperature,
          maxTokens: fidelityParams.maxTokens,
          retryCount: fidelityParams.retryCount,
          useCaching: false,
          enableVerification: fidelityParams.enableVerification,
        },
      })
    )
  );

  // Count votes (simple approval based on success)
  let approveCount = 0;
  let rejectCount = 0;

  for (const result of results) {
    if (result.success) {
      approveCount++;
    } else {
      rejectCount++;
    }
  }

  // Require 2/3 consensus for approval
  const consensusAchieved =
    approveCount >= Math.ceil((adapters.length * 2) / 3);

  logger.info(
    `Consensus voting complete: ${approveCount} approve, ${rejectCount} reject. ` +
      `Consensus: ${consensusAchieved ? 'ACHIEVED' : 'NOT ACHIEVED'}`
  );

  // Use the first successful result as the final result, or the first result if none succeeded
  const finalResult = results.find((r) => r.success) || results[0];

  return {
    consensusAchieved,
    results,
    votes: {
      approve: approveCount,
      reject: rejectCount,
    },
    finalResult,
  };
}

/**
 * Check if a review requires multi-model consensus voting
 */
export function requiresConsensusVoting(
  fidelityParams: FidelityParameters
): boolean {
  return fidelityParams.multiModelVoting;
}

/**
 * Validate review configuration
 */
export function validateReviewConfig(fidelityParams: FidelityParameters): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (fidelityParams.reviewIterations < 1) {
    errors.push('review_iterations must be at least 1');
  }

  if (fidelityParams.reviewIterations > 15) {
    errors.push('review_iterations cannot exceed 15 (cost protection)');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
