/**
 * Iteration Manager - Control iteration flow and feedback
 * Manages iteration count, feeds judge feedback back to agents, and enforces limits
 */

import type { JudgeResult } from './judge-agent.js';
import { StateManager } from './state-manager.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('iteration-manager');

/** Default max iterations when not specified in workflow context */
export const DEFAULT_MAX_ITERATIONS = 3;

/**
 * Iteration feedback
 */
export interface IterationFeedback {
  iterationNumber: number;
  gaps: string[];
  reason: string;
  previousAttempts: number;
}

/**
 * Iteration Manager class
 */
export class IterationManager {
  private stateManager: StateManager;

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  /**
   * Check if should iterate based on judge result
   */
  async shouldIterate(
    workflowId: string,
    judgeResult: JudgeResult
  ): Promise<{ shouldIterate: boolean; reason: string }> {
    const context = await this.stateManager.load(workflowId);
    if (!context) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const currentIteration = context.iterationCount ?? 0;
    const maxIterations = context.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    // Check if we've reached max iterations
    if (currentIteration >= maxIterations) {
      logger.warn(
        `Max iterations (${maxIterations}) reached for workflow: ${workflowId}`
      );
      return {
        shouldIterate: false,
        reason: `Maximum iterations (${maxIterations}) reached`,
      };
    }

    // Check judge decision
    if (!judgeResult.shouldIterate) {
      logger.info('Judge decided to proceed');
      return {
        shouldIterate: false,
        reason: judgeResult.reason,
      };
    }

    logger.info(
      `Judge decided to iterate (${currentIteration + 1}/${maxIterations})`
    );
    return {
      shouldIterate: true,
      reason: judgeResult.reason,
    };
  }

  /**
   * Prepare iteration feedback for agent
   */
  async prepareIterationFeedback(
    workflowId: string,
    judgeResult: JudgeResult
  ): Promise<IterationFeedback> {
    const context = await this.stateManager.load(workflowId);
    if (!context) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const iterationNumber = (context.iterationCount ?? 0) + 1;

    const feedback: IterationFeedback = {
      iterationNumber,
      gaps: judgeResult.gaps,
      reason: judgeResult.reason,
      previousAttempts: context.iterationCount ?? 0,
    };

    logger.info(
      `Prepared iteration feedback: ${feedback.gaps.length} gap(s) identified`
    );

    return feedback;
  }

  /**
   * Start new iteration
   */
  async startIteration(
    workflowId: string,
    targetStage: string
  ): Promise<number> {
    logger.info(`Starting iteration for workflow: ${workflowId}`);

    // Increment iteration count
    const iterationCount =
      await this.stateManager.incrementIteration(workflowId);

    // Update current stage to target (usually developer implement stage)
    await this.stateManager.updateCurrentStage(workflowId, targetStage);

    // Update status to running
    await this.stateManager.updateStatus(workflowId, 'running');

    logger.info(
      `Iteration ${iterationCount} started, returning to stage: ${targetStage}`
    );

    return iterationCount;
  }

  /**
   * Complete iteration cycle
   */
  async completeIteration(workflowId: string, success: boolean): Promise<void> {
    logger.info(
      `Completing iteration for workflow: ${workflowId} (success: ${success})`
    );

    if (success) {
      await this.stateManager.updateStatus(workflowId, 'completed');
      logger.info('Workflow completed successfully');
    } else {
      await this.stateManager.updateStatus(workflowId, 'failed');
      logger.error('Workflow failed after iteration');
    }
  }

  /**
   * Get iteration summary for PR
   */
  async getIterationSummary(workflowId: string): Promise<string> {
    const context = await this.stateManager.load(workflowId);
    if (!context) {
      return '';
    }

    const iterationCount = context.iterationCount ?? 0;
    const maxIterations = context.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    let summary = '## Iteration Summary\n\n';

    if (iterationCount === 0) {
      summary += '✓ Implementation completed on first attempt\n';
    } else {
      summary += `Iterations: ${iterationCount}/${maxIterations}\n\n`;
      summary += 'The implementation went through multiple refinement cycles ';
      summary += 'to meet all acceptance criteria and quality standards.\n';
    }

    return summary;
  }

  /**
   * Format feedback for agent prompt
   */
  formatFeedbackForAgent(feedback: IterationFeedback): string {
    let prompt = `## Iteration ${feedback.iterationNumber} Feedback\n\n`;

    prompt += `**Previous Attempts:** ${feedback.previousAttempts}\n`;
    prompt += `**Reason for Iteration:** ${feedback.reason}\n\n`;

    if (feedback.gaps.length > 0) {
      prompt += '**Gaps to Address:**\n\n';
      feedback.gaps.forEach((gap, idx) => {
        prompt += `${idx + 1}. ${gap}\n`;
      });
      prompt += '\n';
    }

    prompt += 'Please address the above gaps in this iteration.\n';

    return prompt;
  }

  /**
   * Check if max iterations would be exceeded
   */
  async wouldExceedMaxIterations(workflowId: string): Promise<boolean> {
    const context = await this.stateManager.load(workflowId);
    if (!context) {
      return true; // Safe default
    }

    const currentIteration = context.iterationCount ?? 0;
    const maxIterations = context.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    return currentIteration >= maxIterations;
  }
}
