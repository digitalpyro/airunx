/**
 * Tests for Judge Agent
 * Validates iteration decisions based on verification results
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JudgeAgent, type JudgeContext } from '../../src/orchestrator/judge-agent.js';
import type {
  ExecutionAdapter,
  ExecutionResult,
} from '../../src/core/adapter-types.js';
import type { FidelityParameters } from '../../src/core/types.js';
import type { FidelityCheckResult } from '../../src/orchestrator/fidelity-checker.js';

describe('Judge Agent', () => {
  let mockAdapter: ExecutionAdapter;
  let fidelityParams: FidelityParameters;
  let judgeAgent: JudgeAgent;
  let mockFidelityResult: FidelityCheckResult;

  beforeEach(() => {
    // Create mock adapter
    mockAdapter = {
      execute: vi.fn(),
      name: 'mock-adapter',
      capabilities: ['coding', 'analysis'],
    };

    // Default fidelity parameters
    fidelityParams = {
      temperature: 0.2,
      maxTokens: 4096,
      retryCount: 2,
      useCaching: true,
      enableVerification: true,
      reviewIterations: 2,
    };

    judgeAgent = new JudgeAgent(mockAdapter, fidelityParams);

    // Default fidelity check result (failed)
    mockFidelityResult = {
      passed: false,
      qualityMetrics: {},
      unmetCriteria: ['Test coverage too low'],
      findings: ['Coverage: 50% < 80%'],
    };
  });

  describe('Max Iterations', () => {
    it('should fail when max iterations reached with failed verification', async () => {
      const context: JudgeContext = {
        acceptanceCriteria: ['Criteria 1'],
        fidelityCheckResult: mockFidelityResult,
        currentIteration: 3,
        maxIterations: 3,
        workingDirectory: '/test',
      };

      const result = await judgeAgent.judge(context);

      expect(result.decision).toBe('FAIL');
      expect(result.shouldIterate).toBe(false);
      expect(result.reason).toContain('Maximum iterations reached');
      expect(result.reason).toContain('verification failures');
      expect(result.gaps).toEqual(['Test coverage too low']);
    });

    it('should proceed when max iterations reached with passing verification', async () => {
      const passingResult: FidelityCheckResult = {
        passed: true,
        qualityMetrics: {},
        unmetCriteria: [],
        findings: [],
      };

      const context: JudgeContext = {
        acceptanceCriteria: ['Criteria 1'],
        fidelityCheckResult: passingResult,
        currentIteration: 3,
        maxIterations: 3,
        workingDirectory: '/test',
      };

      const result = await judgeAgent.judge(context);

      expect(result.decision).toBe('PROCEED');
      expect(result.shouldIterate).toBe(false);
      expect(result.reason).toBe('Maximum iterations reached with passing verification');
      expect(result.gaps).toEqual([]);
    });

    it('should not invoke adapter when max iterations reached', async () => {
      const context: JudgeContext = {
        acceptanceCriteria: [],
        fidelityCheckResult: mockFidelityResult,
        currentIteration: 5,
        maxIterations: 5,
        workingDirectory: '/test',
      };

      await judgeAgent.judge(context);

      expect(mockAdapter.execute).not.toHaveBeenCalled();
    });
  });

  describe('Passing Checks (Fast Fidelity)', () => {
    it('should proceed when all checks passed with fast fidelity', async () => {
      const passingResult: FidelityCheckResult = {
        passed: true,
        qualityMetrics: {},
        unmetCriteria: [],
        findings: [],
      };

      const context: JudgeContext = {
        acceptanceCriteria: ['Criteria 1'],
        fidelityCheckResult: passingResult,
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
        fidelityLevel: 'fast',
      };

      const result = await judgeAgent.judge(context);

      expect(result.decision).toBe('PROCEED');
      expect(result.shouldIterate).toBe(false);
      expect(result.reason).toBe(
        'All acceptance criteria met and quality checks passed'
      );
      expect(result.gaps).toEqual([]);
    });

    it('should not invoke adapter when checks passed with fast fidelity', async () => {
      const passingResult: FidelityCheckResult = {
        passed: true,
        qualityMetrics: {},
        unmetCriteria: [],
        findings: [],
      };

      const context: JudgeContext = {
        acceptanceCriteria: [],
        fidelityCheckResult: passingResult,
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
        fidelityLevel: 'fast',
      };

      await judgeAgent.judge(context);

      expect(mockAdapter.execute).not.toHaveBeenCalled();
    });
  });

  describe('Failed Checks with Judge Invocation', () => {
    it('should invoke judge agent when checks failed', async () => {
      const judgeOutput: ExecutionResult = {
        success: true,
        outputs: {
          analysis: 'DECISION: ITERATE\n\nREASON: Coverage too low\n\nGAPS:\n- Increase test coverage to 80%',
        },
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(judgeOutput);

      const context: JudgeContext = {
        acceptanceCriteria: ['High test coverage'],
        fidelityCheckResult: mockFidelityResult,
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
      };

      const result = await judgeAgent.judge(context);

      expect(mockAdapter.execute).toHaveBeenCalledTimes(1);
      expect(result.decision).toBe('ITERATE');
      expect(result.shouldIterate).toBe(true);
      expect(result.reason).toBe('Coverage too low');
      expect(result.gaps).toContain('Increase test coverage to 80%');
    });

    it('should parse PROCEED decision from judge', async () => {
      const judgeOutput: ExecutionResult = {
        success: true,
        outputs: {
          analysis: 'DECISION: PROCEED\nREASON: Issues are minor, acceptable to proceed',
        },
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(judgeOutput);

      const context: JudgeContext = {
        acceptanceCriteria: [],
        fidelityCheckResult: mockFidelityResult,
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
      };

      const result = await judgeAgent.judge(context);

      expect(result.decision).toBe('PROCEED');
      expect(result.shouldIterate).toBe(false);
      expect(result.reason).toBe('Issues are minor, acceptable to proceed');
    });

    it('should pass project context to adapter', async () => {
      const judgeOutput: ExecutionResult = {
        success: true,
        outputs: { analysis: 'DECISION: PROCEED\nREASON: OK' },
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(judgeOutput);

      const context: JudgeContext = {
        acceptanceCriteria: [],
        fidelityCheckResult: mockFidelityResult,
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/custom/path',
      };

      await judgeAgent.judge(context);

      const call = vi.mocked(mockAdapter.execute).mock.calls[0][0];
      expect(call.context.workingDirectory).toBe('/custom/path');
    });

    it('should include acceptance criteria in prompt', async () => {
      const judgeOutput: ExecutionResult = {
        success: true,
        outputs: { analysis: 'DECISION: PROCEED' },
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(judgeOutput);

      const context: JudgeContext = {
        acceptanceCriteria: ['Criteria 1', 'Criteria 2'],
        fidelityCheckResult: mockFidelityResult,
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
      };

      await judgeAgent.judge(context);

      const call = vi.mocked(mockAdapter.execute).mock.calls[0][0];
      expect(call.task).toContain('Criteria 1');
      expect(call.task).toContain('Criteria 2');
    });
  });

  describe('Error Handling', () => {
    it('should handle judge execution failure with unmet criteria', async () => {
      vi.mocked(mockAdapter.execute).mockRejectedValue(
        new Error('Judge failed')
      );

      const context: JudgeContext = {
        acceptanceCriteria: [],
        fidelityCheckResult: mockFidelityResult,
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
      };

      const result = await judgeAgent.judge(context);

      // When adapter fails, AgentInvoker returns a failure result
      // that gets parsed by parseJudgeOutput, which defaults to ITERATE
      // when unmetCriteria is present
      expect(result.decision).toBe('ITERATE');
      expect(result.shouldIterate).toBe(true);
      expect(result.reason).toBe('Quality checks failed, iteration required');
      expect(result.gaps).toEqual(['Test coverage too low']);
    });

    it('should proceed on judge failure without unmet criteria', async () => {
      vi.mocked(mockAdapter.execute).mockRejectedValue(
        new Error('Judge failed')
      );

      const failedButNoGaps: FidelityCheckResult = {
        passed: false,
        qualityMetrics: {},
        unmetCriteria: [],
        findings: ['Some warnings'],
      };

      const context: JudgeContext = {
        acceptanceCriteria: [],
        fidelityCheckResult: failedButNoGaps,
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
      };

      const result = await judgeAgent.judge(context);

      // When adapter fails with no unmet criteria, parseJudgeOutput
      // defaults to PROCEED with standard reason
      expect(result.decision).toBe('PROCEED');
      expect(result.shouldIterate).toBe(false);
      expect(result.reason).toBe('Quality checks passed');
    });
  });

  describe('Output Parsing', () => {
    it('should parse judge output with gaps', async () => {
      const judgeOutput: ExecutionResult = {
        success: true,
        outputs: {
          analysis: `DECISION: ITERATE
REASON: Multiple issues found
GAPS:
- Add error handling
- Improve test coverage
- Fix type errors`,
        },
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(judgeOutput);

      const context: JudgeContext = {
        acceptanceCriteria: [],
        fidelityCheckResult: mockFidelityResult,
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
      };

      const result = await judgeAgent.judge(context);

      expect(result.gaps).toHaveLength(3);
      expect(result.gaps).toContain('Add error handling');
      expect(result.gaps).toContain('Improve test coverage');
      expect(result.gaps).toContain('Fix type errors');
    });

    it('should fallback to unmet criteria when no gaps parsed', async () => {
      const judgeOutput: ExecutionResult = {
        success: true,
        outputs: {
          analysis: 'DECISION: ITERATE\nREASON: Not good enough',
        },
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(judgeOutput);

      const context: JudgeContext = {
        acceptanceCriteria: [],
        fidelityCheckResult: {
          passed: false,
          qualityMetrics: {},
          unmetCriteria: ['Coverage below 80%', 'Lint errors'],
          findings: [],
        },
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
      };

      const result = await judgeAgent.judge(context);

      expect(result.gaps).toEqual(['Coverage below 80%', 'Lint errors']);
    });

    it('should default to ITERATE when no decision parsed but has unmet criteria', async () => {
      const judgeOutput: ExecutionResult = {
        success: true,
        outputs: {
          analysis: 'The implementation needs work.',
        },
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(judgeOutput);

      const context: JudgeContext = {
        acceptanceCriteria: [],
        fidelityCheckResult: mockFidelityResult,
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
      };

      const result = await judgeAgent.judge(context);

      expect(result.decision).toBe('ITERATE');
      expect(result.shouldIterate).toBe(true);
    });

    it('should default to PROCEED when no decision parsed and no unmet criteria', async () => {
      const judgeOutput: ExecutionResult = {
        success: true,
        outputs: {
          analysis: 'Everything looks acceptable.',
        },
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(judgeOutput);

      const context: JudgeContext = {
        acceptanceCriteria: [],
        fidelityCheckResult: {
          passed: false,
          qualityMetrics: {},
          unmetCriteria: [],
          findings: [],
        },
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
      };

      const result = await judgeAgent.judge(context);

      expect(result.decision).toBe('PROCEED');
      expect(result.shouldIterate).toBe(false);
    });
  });

  describe('Fidelity-Based Semantic Review', () => {
    it('should early-exit for fast fidelity when syntactic checks pass', async () => {
      const passingResult: FidelityCheckResult = {
        passed: true,
        qualityMetrics: {},
        unmetCriteria: [],
        findings: [],
      };

      const context: JudgeContext = {
        acceptanceCriteria: ['Criteria 1'],
        fidelityCheckResult: passingResult,
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
        fidelityLevel: 'fast',
      };

      const result = await judgeAgent.judge(context);

      expect(result.decision).toBe('PROCEED');
      expect(result.shouldIterate).toBe(false);
      expect(mockAdapter.execute).not.toHaveBeenCalled();
    });

    it('should early-exit ITERATE for fast fidelity when syntactic checks fail', async () => {
      const context: JudgeContext = {
        acceptanceCriteria: ['Criteria 1'],
        fidelityCheckResult: mockFidelityResult,
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
        fidelityLevel: 'fast',
      };

      const result = await judgeAgent.judge(context);

      expect(result.decision).toBe('ITERATE');
      expect(result.shouldIterate).toBe(true);
      expect(result.gaps).toEqual(['Test coverage too low']);
      expect(mockAdapter.execute).not.toHaveBeenCalled();
    });

    it('should invoke LLM for standard fidelity even when syntactic checks pass', async () => {
      const passingResult: FidelityCheckResult = {
        passed: true,
        qualityMetrics: {},
        unmetCriteria: [],
        findings: [],
      };

      const judgeOutput: ExecutionResult = {
        success: true,
        outputs: {
          analysis: '{"decision": "PROCEED", "reason": "Semantic review passed", "gaps": []}',
        },
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(judgeOutput);

      const context: JudgeContext = {
        acceptanceCriteria: [],
        fidelityCheckResult: passingResult,
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
        fidelityLevel: 'standard',
      };

      const result = await judgeAgent.judge(context);

      expect(mockAdapter.execute).toHaveBeenCalledTimes(1);
      expect(result.decision).toBe('PROCEED');
    });

    it('should invoke LLM for thorough fidelity even when syntactic checks pass', async () => {
      const passingResult: FidelityCheckResult = {
        passed: true,
        qualityMetrics: {},
        unmetCriteria: [],
        findings: [],
      };

      const judgeOutput: ExecutionResult = {
        success: true,
        outputs: {
          analysis: '{"decision": "ITERATE", "reason": "Found semantic issue", "gaps": ["Function does not persist data"]}',
        },
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(judgeOutput);

      const context: JudgeContext = {
        acceptanceCriteria: [],
        fidelityCheckResult: passingResult,
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
        fidelityLevel: 'thorough',
      };

      const result = await judgeAgent.judge(context);

      expect(mockAdapter.execute).toHaveBeenCalledTimes(1);
      expect(result.decision).toBe('ITERATE');
      expect(result.gaps).toContain('Function does not persist data');
    });

    it('should invoke LLM for ultra fidelity even when syntactic checks pass', async () => {
      const passingResult: FidelityCheckResult = {
        passed: true,
        qualityMetrics: {},
        unmetCriteria: [],
        findings: [],
      };

      const judgeOutput: ExecutionResult = {
        success: true,
        outputs: {
          analysis: '{"decision": "PROCEED", "reason": "All good", "gaps": []}',
        },
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(judgeOutput);

      const context: JudgeContext = {
        acceptanceCriteria: [],
        fidelityCheckResult: passingResult,
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
        fidelityLevel: 'ultra',
      };

      const result = await judgeAgent.judge(context);

      expect(mockAdapter.execute).toHaveBeenCalledTimes(1);
      expect(result.decision).toBe('PROCEED');
    });

    it('should default to standard behavior when fidelityLevel is undefined', async () => {
      const passingResult: FidelityCheckResult = {
        passed: true,
        qualityMetrics: {},
        unmetCriteria: [],
        findings: [],
      };

      const judgeOutput: ExecutionResult = {
        success: true,
        outputs: {
          analysis: '{"decision": "PROCEED", "reason": "OK", "gaps": []}',
        },
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(judgeOutput);

      const context: JudgeContext = {
        acceptanceCriteria: [],
        fidelityCheckResult: passingResult,
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
        // fidelityLevel is undefined - should run LLM (treat as standard+)
      };

      const result = await judgeAgent.judge(context);

      // When fidelityLevel is undefined, isFastFidelity is false,
      // so it should fall through to LLM review
      expect(mockAdapter.execute).toHaveBeenCalledTimes(1);
      expect(result.decision).toBe('PROCEED');
    });
  });

  describe('Extended Judge Results', () => {
    it('should return parsedOutput with judgeExtended', async () => {
      const judgeOutput: ExecutionResult = {
        success: true,
        outputs: {
          analysis: `\`\`\`json
{
  "decision": "ITERATE",
  "reason": "Coverage too low",
  "gaps": [
    {"description": "Increase test coverage", "severity": "major"},
    {"description": "Add error handling", "severity": "minor"}
  ]
}
\`\`\``,
        },
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(judgeOutput);

      const context: JudgeContext = {
        acceptanceCriteria: ['High test coverage'],
        fidelityCheckResult: mockFidelityResult,
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
      };

      const result = await judgeAgent.judgeExtended(context);

      // Verify legacy fields
      expect(result.decision).toBe('ITERATE');
      expect(result.shouldIterate).toBe(true);
      expect(result.reason).toBe('Coverage too low');

      // Verify parsedOutput is present
      expect(result.parsedOutput).toBeDefined();
      expect(result.parsedOutput?.confidence).toBe('high');
      expect(result.parsedOutput?.strategy).toBe('json_markdown_block');
      expect(result.parsedOutput?.gaps).toHaveLength(2);
      expect(result.parsedOutput?.gaps[0].severity).toBe('major');
      expect(result.parsedOutput?.gaps[1].severity).toBe('minor');
    });

    it('should not include parsedOutput for early-exit cases (fast fidelity)', async () => {
      const passingResult: FidelityCheckResult = {
        passed: true,
        qualityMetrics: {},
        unmetCriteria: [],
        findings: [],
      };

      const context: JudgeContext = {
        acceptanceCriteria: ['Criteria 1'],
        fidelityCheckResult: passingResult,
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
        fidelityLevel: 'fast',
      };

      const result = await judgeAgent.judgeExtended(context);

      expect(result.decision).toBe('PROCEED');
      expect(result.parsedOutput).toBeUndefined();
    });

    it('judge() should not include parsedOutput', async () => {
      const judgeOutput: ExecutionResult = {
        success: true,
        outputs: {
          analysis: '{"decision": "PROCEED", "reason": "All good", "gaps": []}',
        },
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(judgeOutput);

      const context: JudgeContext = {
        acceptanceCriteria: [],
        fidelityCheckResult: mockFidelityResult,
        currentIteration: 1,
        maxIterations: 3,
        workingDirectory: '/test',
      };

      const result = await judgeAgent.judge(context);

      // Legacy judge() should not have parsedOutput
      expect(result).not.toHaveProperty('parsedOutput');
      expect(result.decision).toBe('PROCEED');
    });
  });
});
