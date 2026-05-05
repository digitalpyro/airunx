/**
 * Tests for Iteration Manager
 * Validates iteration control flow and feedback management
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IterationManager } from '../../src/orchestrator/iteration-manager.js';
import { StateManager } from '../../src/orchestrator/state-manager.js';
import type { JudgeResult } from '../../src/orchestrator/judge-agent.js';
import type { WorkflowContext } from '../../src/core/types.js';

describe('Iteration Manager', () => {
  let stateManager: StateManager;
  let iterationManager: IterationManager;
  let mockContext: WorkflowContext;

  beforeEach(() => {
    // Create mocked state manager
    stateManager = {
      load: vi.fn(),
      incrementIteration: vi.fn(),
      updateCurrentStage: vi.fn(),
      updateStatus: vi.fn(),
    } as any;

    iterationManager = new IterationManager(stateManager);

    // Default mock context
    mockContext = {
      id: 'test-workflow',
      input: 'Test task',
      inputType: 'prompt',
      mode: 'autonomous',
      worktreePath: '/test',
      createdAt: new Date(),
      status: 'running',
      fidelityLevel: 'standard',
      iterationCount: 0,
      maxIterations: 3,
      todos: [],
      metrics: {
        tokensUsed: 0,
        totalTokens: 0,
        runtime: 0,
        totalRuntimeMs: 0,
        stagesCompleted: 0,
        totalStages: 0,
        errors: 0,
        totalCost: 0,
      },
    };
  });

  describe('shouldIterate', () => {
    it('should return true when judge decides to iterate and under max iterations', async () => {
      vi.mocked(stateManager.load).mockResolvedValue(mockContext);

      const judgeResult: JudgeResult = {
        decision: 'ITERATE',
        shouldIterate: true,
        reason: 'Code quality issues found',
        gaps: ['Missing error handling'],
        score: 65,
      };

      const result = await iterationManager.shouldIterate(
        'test-workflow',
        judgeResult
      );

      expect(result.shouldIterate).toBe(true);
      expect(result.reason).toBe('Code quality issues found');
    });

    it('should return false when judge decides to proceed', async () => {
      vi.mocked(stateManager.load).mockResolvedValue(mockContext);

      const judgeResult: JudgeResult = {
        decision: 'PROCEED',
        shouldIterate: false,
        reason: 'All criteria met',
        gaps: [],
        score: 95,
      };

      const result = await iterationManager.shouldIterate(
        'test-workflow',
        judgeResult
      );

      expect(result.shouldIterate).toBe(false);
      expect(result.reason).toBe('All criteria met');
    });

    it('should return false when max iterations reached', async () => {
      const contextAtMax = {
        ...mockContext,
        iterationCount: 3,
        maxIterations: 3,
      };

      vi.mocked(stateManager.load).mockResolvedValue(contextAtMax);

      const judgeResult: JudgeResult = {
        decision: 'ITERATE',
        shouldIterate: true,
        reason: 'Still has issues',
        gaps: ['Some issue'],
        score: 70,
      };

      const result = await iterationManager.shouldIterate(
        'test-workflow',
        judgeResult
      );

      expect(result.shouldIterate).toBe(false);
      expect(result.reason).toContain('Maximum iterations (3) reached');
    });

    it('should throw error when workflow not found', async () => {
      vi.mocked(stateManager.load).mockResolvedValue(null);

      const judgeResult: JudgeResult = {
        decision: 'ITERATE',
        shouldIterate: true,
        reason: 'Test',
        gaps: [],
        score: 70,
      };

      await expect(
        iterationManager.shouldIterate('non-existent', judgeResult)
      ).rejects.toThrow('Workflow not found');
    });

    it('should allow iteration when under max iterations', async () => {
      const contextInProgress = {
        ...mockContext,
        iterationCount: 1,
        maxIterations: 3,
      };

      vi.mocked(stateManager.load).mockResolvedValue(contextInProgress);

      const judgeResult: JudgeResult = {
        decision: 'ITERATE',
        shouldIterate: true,
        reason: 'Needs improvement',
        gaps: ['Gap 1'],
        score: 75,
      };

      const result = await iterationManager.shouldIterate(
        'test-workflow',
        judgeResult
      );

      expect(result.shouldIterate).toBe(true);
    });
  });

  describe('prepareIterationFeedback', () => {
    it('should prepare feedback with gaps from judge result', async () => {
      vi.mocked(stateManager.load).mockResolvedValue(mockContext);

      const judgeResult: JudgeResult = {
        decision: 'ITERATE',
        shouldIterate: true,
        reason: 'Quality issues',
        gaps: ['Missing tests', 'Poor error handling'],
        score: 70,
      };

      const feedback = await iterationManager.prepareIterationFeedback(
        'test-workflow',
        judgeResult
      );

      expect(feedback.iterationNumber).toBe(1);
      expect(feedback.gaps).toEqual(['Missing tests', 'Poor error handling']);
      expect(feedback.reason).toBe('Quality issues');
      expect(feedback.previousAttempts).toBe(0);
    });

    it('should increment iteration number based on context', async () => {
      const contextWithIterations = {
        ...mockContext,
        iterationCount: 2,
      };

      vi.mocked(stateManager.load).mockResolvedValue(contextWithIterations);

      const judgeResult: JudgeResult = {
        decision: 'ITERATE',
        shouldIterate: true,
        reason: 'Still needs work',
        gaps: ['Issue 1'],
        score: 75,
      };

      const feedback = await iterationManager.prepareIterationFeedback(
        'test-workflow',
        judgeResult
      );

      expect(feedback.iterationNumber).toBe(3);
      expect(feedback.previousAttempts).toBe(2);
    });

    it('should throw error when workflow not found', async () => {
      vi.mocked(stateManager.load).mockResolvedValue(null);

      const judgeResult: JudgeResult = {
        decision: 'ITERATE',
        shouldIterate: true,
        reason: 'Test',
        gaps: [],
        score: 70,
      };

      await expect(
        iterationManager.prepareIterationFeedback('non-existent', judgeResult)
      ).rejects.toThrow('Workflow not found');
    });
  });

  describe('startIteration', () => {
    it('should increment iteration count and update stage', async () => {
      vi.mocked(stateManager.incrementIteration).mockResolvedValue(1);

      const iterationCount = await iterationManager.startIteration(
        'test-workflow',
        'developer'
      );

      expect(iterationCount).toBe(1);
      expect(stateManager.incrementIteration).toHaveBeenCalledWith(
        'test-workflow'
      );
      expect(stateManager.updateCurrentStage).toHaveBeenCalledWith(
        'test-workflow',
        'developer'
      );
      expect(stateManager.updateStatus).toHaveBeenCalledWith(
        'test-workflow',
        'running'
      );
    });

    it('should return correct iteration count for subsequent iterations', async () => {
      vi.mocked(stateManager.incrementIteration).mockResolvedValue(3);

      const iterationCount = await iterationManager.startIteration(
        'test-workflow',
        'developer'
      );

      expect(iterationCount).toBe(3);
    });
  });

  describe('completeIteration', () => {
    it('should mark workflow as completed on success', async () => {
      await iterationManager.completeIteration('test-workflow', true);

      expect(stateManager.updateStatus).toHaveBeenCalledWith(
        'test-workflow',
        'completed'
      );
    });

    it('should mark workflow as failed on failure', async () => {
      await iterationManager.completeIteration('test-workflow', false);

      expect(stateManager.updateStatus).toHaveBeenCalledWith(
        'test-workflow',
        'failed'
      );
    });
  });

  describe('getIterationSummary', () => {
    it('should return summary for first attempt completion', async () => {
      vi.mocked(stateManager.load).mockResolvedValue(mockContext);

      const summary = await iterationManager.getIterationSummary(
        'test-workflow'
      );

      expect(summary).toContain('## Iteration Summary');
      expect(summary).toContain('completed on first attempt');
    });

    it('should return summary with iteration count', async () => {
      const contextWithIterations = {
        ...mockContext,
        iterationCount: 2,
        maxIterations: 3,
      };

      vi.mocked(stateManager.load).mockResolvedValue(contextWithIterations);

      const summary = await iterationManager.getIterationSummary(
        'test-workflow'
      );

      expect(summary).toContain('Iterations: 2/3');
      expect(summary).toContain('refinement cycles');
    });

    it('should return empty string when workflow not found', async () => {
      vi.mocked(stateManager.load).mockResolvedValue(null);

      const summary = await iterationManager.getIterationSummary(
        'non-existent'
      );

      expect(summary).toBe('');
    });
  });

  describe('formatFeedbackForAgent', () => {
    it('should format feedback with gaps', () => {
      const feedback = {
        iterationNumber: 2,
        gaps: ['Missing error handling', 'Incomplete tests'],
        reason: 'Quality issues',
        previousAttempts: 1,
      };

      const formatted = iterationManager.formatFeedbackForAgent(feedback);

      expect(formatted).toContain('## Iteration 2 Feedback');
      expect(formatted).toContain('**Previous Attempts:** 1');
      expect(formatted).toContain('**Reason for Iteration:** Quality issues');
      expect(formatted).toContain('1. Missing error handling');
      expect(formatted).toContain('2. Incomplete tests');
      expect(formatted).toContain('address the above gaps');
    });

    it('should format feedback without gaps', () => {
      const feedback = {
        iterationNumber: 1,
        gaps: [],
        reason: 'Performance optimization needed',
        previousAttempts: 0,
      };

      const formatted = iterationManager.formatFeedbackForAgent(feedback);

      expect(formatted).toContain('## Iteration 1 Feedback');
      expect(formatted).toContain('**Previous Attempts:** 0');
      expect(formatted).toContain(
        '**Reason for Iteration:** Performance optimization needed'
      );
    });
  });

  describe('wouldExceedMaxIterations', () => {
    it('should return false when under max iterations', async () => {
      vi.mocked(stateManager.load).mockResolvedValue(mockContext);

      const wouldExceed = await iterationManager.wouldExceedMaxIterations(
        'test-workflow'
      );

      expect(wouldExceed).toBe(false);
    });

    it('should return true when at max iterations', async () => {
      const contextAtMax = {
        ...mockContext,
        iterationCount: 3,
        maxIterations: 3,
      };

      vi.mocked(stateManager.load).mockResolvedValue(contextAtMax);

      const wouldExceed = await iterationManager.wouldExceedMaxIterations(
        'test-workflow'
      );

      expect(wouldExceed).toBe(true);
    });

    it('should return true when workflow not found (safe default)', async () => {
      vi.mocked(stateManager.load).mockResolvedValue(null);

      const wouldExceed = await iterationManager.wouldExceedMaxIterations(
        'non-existent'
      );

      expect(wouldExceed).toBe(true);
    });
  });
});
