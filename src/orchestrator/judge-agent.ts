/**
 * Judge Agent - Iteration decisions based on verification results
 * Decides whether to iterate or proceed based on quality checks
 */

import type { ExecutionAdapter } from '../core/adapter-types.js';
import type {
  FidelityParameters,
  ExecutionFidelityLevel,
} from '../core/types.js';
import type { FidelityCheckResult } from './fidelity-checker.js';
import { AgentInvoker } from './agent-invoker.js';
import { createLogger } from '../utils/logger.js';
import { toError } from '../utils/error-handlers.js';
import {
  JudgeOutputParser,
  toLegacyFormat,
  type JudgeDecision as ParserJudgeDecision,
  type ParsedJudgeOutput,
} from './judge-output-parser.js';

const logger = createLogger('judge-agent');

/**
 * Judge decision type
 */
export type JudgeDecision = ParserJudgeDecision;

/**
 * Judge result
 */
export interface JudgeResult {
  decision: JudgeDecision;
  reason: string;
  gaps: string[];
  shouldIterate: boolean;
}

/**
 * Extended judge result with parsing metadata
 */
export interface ExtendedJudgeResult extends JudgeResult {
  /** Parsed output with full metadata (for advanced use cases) */
  parsedOutput?: ParsedJudgeOutput;
  /** Execution metrics from the judge LLM call (undefined for early-exit paths) */
  metrics?: {
    tokensUsed: number;
    duration: number;
    cost: number;
  };
}

/**
 * Judge context
 */
export interface JudgeContext {
  acceptanceCriteria: string[];
  fidelityCheckResult: FidelityCheckResult;
  currentIteration: number;
  maxIterations: number;
  workingDirectory: string;
  /** Fidelity level - determines whether to run semantic LLM review */
  fidelityLevel?: ExecutionFidelityLevel;
  /** Checkbox items from the source GitHub issue (for marking completed items) */
  issueCheckboxes?: string[];
  /** Pre-judge test output — if tests failed in the worktree, this contains the failure output */
  preJudgeTestOutput?: string;
}

/**
 * Judge Agent class
 */
export class JudgeAgent {
  private adapter: ExecutionAdapter;
  private fidelityParams: FidelityParameters;

  constructor(adapter: ExecutionAdapter, fidelityParams: FidelityParameters) {
    this.adapter = adapter;
    this.fidelityParams = fidelityParams;
  }

  /**
   * Execute judge agent to make iteration decision
   * Returns legacy format for backward compatibility
   */
  async judge(context: JudgeContext): Promise<JudgeResult> {
    const extended = await this.executeJudgeCore(context);
    // Return only the legacy fields by excluding parsedOutput
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { parsedOutput, ...legacyResult } = extended;
    return legacyResult;
  }

  /**
   * Execute judge and return extended result with parsing metadata
   * Use this when you need access to gap severities, parsing strategy, etc.
   */
  async judgeExtended(context: JudgeContext): Promise<ExtendedJudgeResult> {
    return this.executeJudgeCore(context);
  }

  /**
   * Core judge execution logic that returns full extended result
   * Both judge() and judgeExtended() delegate to this method
   */
  private async executeJudgeCore(
    context: JudgeContext
  ): Promise<ExtendedJudgeResult> {
    logger.info(
      `Judge executing (iteration ${context.currentIteration}/${context.maxIterations})`
    );

    // If we've reached max iterations, check if verification passed
    if (context.currentIteration >= context.maxIterations) {
      // If verification failed at max iterations, return FAIL instead of PROCEED
      // This prevents misleading "completed" status when the workflow didn't succeed
      if (!context.fidelityCheckResult.passed) {
        const errorCount =
          context.fidelityCheckResult.verification?.errors?.length ?? 0;
        logger.error(
          `Max iterations reached with ${errorCount} verification error(s). Workflow failed.`
        );
        return {
          decision: 'FAIL',
          reason: `Maximum iterations reached with verification failures (${errorCount} errors)`,
          gaps: context.fidelityCheckResult.unmetCriteria,
          shouldIterate: false,
        };
      }

      logger.warn(
        'Max iterations reached, proceeding with passed verification'
      );
      return {
        decision: 'PROCEED',
        reason: 'Maximum iterations reached with passing verification',
        gaps: context.fidelityCheckResult.unmetCriteria,
        shouldIterate: false,
        // Include all checkboxes as completed since verification passed
        parsedOutput: context.issueCheckboxes?.length
          ? {
              decision: 'PROCEED' as const,
              reason: 'Maximum iterations reached with passing verification',
              gaps: [],
              confidence: 'high' as const,
              strategy: 'json_raw' as const,
              rawGaps: [],
              checkboxesToComplete: context.issueCheckboxes,
            }
          : undefined,
      };
    }

    // For fast fidelity: early-exit if syntactic checks passed (speed priority)
    // For standard+: always invoke LLM for semantic review even when syntactic passes
    const isFastFidelity = context.fidelityLevel === 'fast';

    if (isFastFidelity && context.fidelityCheckResult.passed) {
      logger.info('Fast fidelity: all syntactic checks passed, proceeding');
      return {
        decision: 'PROCEED',
        reason: 'All acceptance criteria met and quality checks passed',
        gaps: [],
        shouldIterate: false,
        // No parsedOutput for early-exit cases
      };
    }

    // For fast fidelity with failures: iterate without LLM review
    if (isFastFidelity && !context.fidelityCheckResult.passed) {
      logger.info('Fast fidelity: syntactic checks failed, iterating');
      return {
        decision: 'ITERATE',
        reason: 'Syntactic verification failed',
        gaps: context.fidelityCheckResult.unmetCriteria,
        shouldIterate: true,
      };
    }

    // Standard+ fidelity: if syntactic checks passed, still run LLM for semantic review
    if (context.fidelityCheckResult.passed) {
      logger.info(
        'Standard+ fidelity: syntactic checks passed, running semantic review'
      );
    }

    // Build judge prompt
    const prompt = this.buildJudgePrompt(context);

    // Execute judge agent via invoker
    const invoker = new AgentInvoker(this.adapter, this.fidelityParams);

    try {
      const result = await invoker.execute({
        role: 'code-judge',
        task: prompt,
        projectContext: {
          workingDirectory: context.workingDirectory,
        },
      });

      // Create parser with context-aware options
      const parser = new JudgeOutputParser({
        verbose: false,
        unmetCriteria: context.fidelityCheckResult.unmetCriteria,
        findings: context.fidelityCheckResult.findings,
        // Parser defaults to ITERATE when unmetCriteria exist, so just set fallback for no-criteria case
        defaultDecision: 'PROCEED',
      });

      // Parse judge output using the enhanced parser
      const parsedOutput = parser.parse(result.outputs.analysis || '');

      // Log parsing details
      logger.info(
        `Judge decision: ${parsedOutput.decision} (confidence: ${parsedOutput.confidence}, strategy: ${parsedOutput.strategy})`
      );
      if (parsedOutput.rawGaps.length > 0) {
        logger.info(`Gaps identified: ${parsedOutput.rawGaps.length}`);
        parsedOutput.rawGaps.forEach((gap) => logger.debug(`  - ${gap}`));
      }

      // Log gap severities if present
      const criticalGaps = parsedOutput.gaps.filter(
        (g) => g.severity === 'critical'
      );
      if (criticalGaps.length > 0) {
        logger.warn(`Critical gaps identified: ${criticalGaps.length}`);
        criticalGaps.forEach((gap) =>
          logger.warn(`  - [CRITICAL] ${gap.description}`)
        );
      }

      // Return extended result with full parsed output and execution metrics
      return {
        ...toLegacyFormat(parsedOutput),
        parsedOutput,
        metrics: {
          tokensUsed: result.metrics.tokensUsed,
          duration: result.metrics.duration,
          cost: result.metrics.cost ?? 0,
        },
      };
    } catch (error) {
      logger.error('Judge agent execution failed:', toError(error));

      // Default to iterate if we have unmet criteria and haven't reached max iterations
      if (context.fidelityCheckResult.unmetCriteria.length > 0) {
        return {
          decision: 'ITERATE',
          reason: 'Judge execution failed, but unmet criteria detected',
          gaps: context.fidelityCheckResult.unmetCriteria,
          shouldIterate: true,
          // No parsedOutput for error cases
        };
      }

      // Otherwise proceed with warnings
      return {
        decision: 'PROCEED',
        reason: 'Judge execution failed, proceeding with caution',
        gaps: [],
        shouldIterate: false,
        // No parsedOutput for error cases
      };
    }
  }

  /**
   * Build judge prompt from context
   * Uses JSON format for more reliable parsing
   */
  private buildJudgePrompt(context: JudgeContext): string {
    let prompt =
      'Review the implementation against these acceptance criteria:\n\n';

    if (context.acceptanceCriteria.length > 0) {
      prompt += '**Acceptance Criteria:**\n';
      context.acceptanceCriteria.forEach((criteria, idx) => {
        prompt += `${idx + 1}. ${criteria}\n`;
      });
      prompt += '\n';
    }

    prompt += '**Verification Results:**\n';
    if (context.fidelityCheckResult.verification) {
      const verification = context.fidelityCheckResult.verification;
      prompt += `- Overall: ${verification.passed ? 'PASSED' : 'FAILED'}\n`;
      prompt += `- Errors: ${verification.errors.length}\n`;
      prompt += `- Warnings: ${verification.warnings.length}\n`;

      if (verification.errors.length > 0) {
        prompt += '\n**Errors:**\n';
        verification.errors.forEach((error) => {
          prompt += `- ${error}\n`;
        });
      }

      if (verification.warnings.length > 0) {
        prompt += '\n**Warnings:**\n';
        verification.warnings.forEach((warning) => {
          prompt += `- ${warning}\n`;
        });
      }
    }

    if (context.fidelityCheckResult.coverage !== undefined) {
      prompt += `\n**Test Coverage:** ${context.fidelityCheckResult.coverage.toFixed(1)}%\n`;
    }

    // Inject pre-judge test results if tests failed in the worktree
    if (context.preJudgeTestOutput) {
      prompt += '\n**PRE-JUDGE TEST RESULTS: FAILED**\n';
      prompt +=
        'Tests were run in the worktree before this evaluation and FAILED.\n';
      prompt +=
        'You MUST issue ITERATE to fix these failures before proceeding.\n';
      prompt +=
        'If failures are snapshot assertion mismatches, the developer must update the __snapshots__/ files.\n\n';
      prompt += '```\n' + context.preJudgeTestOutput + '\n```\n\n';
    }

    prompt += `\n**Current Iteration:** ${context.currentIteration}/${context.maxIterations}\n\n`;

    // Include issue checkboxes if available (for marking completed items)
    if (context.issueCheckboxes && context.issueCheckboxes.length > 0) {
      prompt += '**Source Issue Checkboxes:**\n';
      context.issueCheckboxes.forEach((cb) => {
        prompt += `- [ ] ${cb}\n`;
      });
      prompt +=
        '\nFor each checkbox that has been fully completed by the implementation, include it in the `checkboxes_to_complete` array.\n\n';
    }

    prompt += 'Respond with a JSON object in the following format:\n';
    prompt += '```json\n';
    prompt += '{\n';
    prompt += '  "decision": "ITERATE" or "PROCEED",\n';
    prompt += '  "reason": "Brief explanation of your decision",\n';
    prompt +=
      '  "gaps": ["List", "of", "unmet", "criteria"] // Empty array if PROCEED';
    if (context.issueCheckboxes && context.issueCheckboxes.length > 0) {
      prompt += ',\n';
      prompt +=
        '  "checkboxes_to_complete": ["Exact text of completed checkbox items"] // Only include fully completed items';
    }
    prompt += '\n}\n';
    prompt += '```\n\n';
    prompt +=
      'IMPORTANT: Respond ONLY with the JSON object, no additional text.';

    return prompt;
  }
}
