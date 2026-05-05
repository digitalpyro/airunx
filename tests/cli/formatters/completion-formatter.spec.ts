/**
 * Unit tests for Completion Formatter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkflowContext, WorkflowStatus } from '../../../src/core/types.js';
import {
  formatCompletion,
  formatCompletionJson,
  type FormattedCompletion,
} from '../../../src/cli/formatters/completion-formatter.js';

describe('Completion Formatter', () => {
  // Mock console.log to prevent output during tests
  const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  afterEach(() => {
    consoleSpy.mockClear();
  });

  function createMockContext(
    status: WorkflowStatus,
    overrides: Partial<WorkflowContext> = {}
  ): WorkflowContext {
    return {
      id: 'test-workflow-123',
      input: 'Test input',
      inputType: 'prompt',
      mode: 'pipeline',
      createdAt: new Date(),
      status,
      metrics: {
        tokensUsed: 0,
        totalTokens: 1500,
        runtime: 0,
        totalRuntimeMs: 45000,
        stagesCompleted: 3,
        totalStages: 5,
        errors: 0,
        totalCost: 0.0025,
      },
      iterationCount: 2,
      ...overrides,
    };
  }

  describe('formatCompletion', () => {
    describe('Status: completed', () => {
      it('should return success header for TTY mode', () => {
        const context = createMockContext('completed');
        const result = formatCompletion(context, { tty: true });

        expect(result.header).toContain('Workflow completed successfully');
      });

      it('should return plain header for non-TTY mode', () => {
        const context = createMockContext('completed');
        const result = formatCompletion(context, { tty: false });

        expect(result.header).toBe('[COMPLETED] Workflow completed successfully');
      });

      it('should include appropriate next steps', () => {
        const context = createMockContext('completed', {
          worktreePath: '/tmp/worktree',
        });
        const result = formatCompletion(context, { tty: true });

        expect(result.nextSteps).toContain('Review changes in the worktree');
        expect(result.nextSteps).toContain('Run tests to verify implementation');
        expect(result.nextSteps).toContain('Create a pull request');
      });

      it('should include no failed stages', () => {
        const context = createMockContext('completed');
        const result = formatCompletion(context, { tty: true });

        expect(result.failedStages).toHaveLength(0);
      });
    });

    describe('Status: completed_with_errors', () => {
      it('should return warning header for TTY mode', () => {
        const context = createMockContext('completed_with_errors');
        const result = formatCompletion(context, { tty: true });

        expect(result.header).toContain('Workflow completed with errors');
      });

      it('should extract failed stages from stageResults', () => {
        const context = createMockContext('completed_with_errors', {
          stageResults: {
            stage1: { success: true, outputs: {}, metrics: { tokensUsed: 100, duration: 1000 } },
            stage2: {
              success: false,
              outputs: {},
              metrics: { tokensUsed: 50, duration: 500 },
              errors: [{ message: 'Stage 2 failed' }],
            },
            stage3: {
              success: false,
              outputs: {},
              metrics: { tokensUsed: 0, duration: 100 },
              errors: [{ message: 'Stage 3 also failed' }],
            },
          },
        });
        const result = formatCompletion(context, { tty: true });

        expect(result.failedStages).toHaveLength(2);
        expect(result.failedStages[0]).toContain('stage2');
        expect(result.failedStages[0]).toContain('Stage 2 failed');
        expect(result.failedStages[1]).toContain('stage3');
      });

      it('should suggest reviewing worktree when available', () => {
        const context = createMockContext('completed_with_errors', {
          worktreePath: '/tmp/test-worktree',
        });
        const result = formatCompletion(context, { tty: true });

        expect(result.nextSteps.some(s => s.includes('Review changes in worktree'))).toBe(true);
      });

      it('should suggest running doctor', () => {
        const context = createMockContext('completed_with_errors');
        const result = formatCompletion(context, { tty: true });

        expect(result.nextSteps.some(s => s.includes('doctor'))).toBe(true);
      });
    });

    describe('Status: failed', () => {
      it('should return error header for TTY mode', () => {
        const context = createMockContext('failed');
        const result = formatCompletion(context, { tty: true });

        expect(result.header).toContain('Workflow failed');
      });

      it('should detect auth error pattern', () => {
        const context = createMockContext('failed', {
          stageResults: {
            stage1: {
              success: false,
              outputs: {},
              metrics: { tokensUsed: 0, duration: 0 },
              errors: [{ message: 'Not logged in. Please sign in first.' }],
            },
          },
        });
        const result = formatCompletion(context, { tty: true });

        expect(result.nextSteps.some(s => s.includes('authentication'))).toBe(true);
      });

      it('should detect timeout error pattern', () => {
        const context = createMockContext('failed', {
          stageResults: {
            stage1: {
              success: false,
              outputs: {},
              metrics: { tokensUsed: 0, duration: 0 },
              errors: [{ message: 'Execution timed out after 30000ms' }],
            },
          },
        });
        const result = formatCompletion(context, { tty: true });

        expect(result.nextSteps.some(s => s.includes('timed out') || s.includes('timeout'))).toBe(true);
      });

      it('should detect circuit error pattern', () => {
        const context = createMockContext('failed', {
          stageResults: {
            stage1: {
              success: false,
              outputs: {},
              metrics: { tokensUsed: 0, duration: 0 },
              errors: [{ message: "CircuitOpenError: Backend 'cursor' circuit is OPEN" }],
            },
          },
        });
        const result = formatCompletion(context, { tty: true });

        expect(result.nextSteps.some(s => s.includes('circuit'))).toBe(true);
      });

      it('should suggest DEBUG mode', () => {
        const context = createMockContext('failed');
        const result = formatCompletion(context, { tty: true });

        expect(result.nextSteps.some(s => s.includes('DEBUG'))).toBe(true);
      });
    });

    describe('Metrics', () => {
      it('should include token count in metrics', () => {
        const context = createMockContext('completed', {
          metrics: {
            tokensUsed: 0,
            totalTokens: 2500,
            runtime: 0,
            totalRuntimeMs: 30000,
            stagesCompleted: 3,
            totalStages: 3,
            errors: 0,
            totalCost: 0.005,
          },
        });
        const result = formatCompletion(context, { tty: true });

        expect(result.metrics.some(m => m.includes('2,500') || m.includes('2500'))).toBe(true);
      });

      it('should include cost in metrics', () => {
        const context = createMockContext('completed', {
          metrics: {
            tokensUsed: 0,
            totalTokens: 1000,
            runtime: 0,
            totalRuntimeMs: 10000,
            stagesCompleted: 2,
            totalStages: 2,
            errors: 0,
            totalCost: 0.0123,
          },
        });
        const result = formatCompletion(context, { tty: true });

        expect(result.metrics.some(m => m.includes('$') && m.includes('0.01'))).toBe(true);
      });

      it('should include duration in metrics', () => {
        const context = createMockContext('completed', {
          metrics: {
            tokensUsed: 0,
            totalTokens: 1000,
            runtime: 0,
            totalRuntimeMs: 45000,
            stagesCompleted: 2,
            totalStages: 2,
            errors: 0,
          },
        });
        const result = formatCompletion(context, { tty: true });

        expect(result.metrics.some(m => m.includes('45') && m.includes('s'))).toBe(true);
      });

      it('should include stage progress in metrics', () => {
        const context = createMockContext('completed_with_errors', {
          metrics: {
            tokensUsed: 0,
            totalTokens: 1000,
            runtime: 0,
            stagesCompleted: 3,
            totalStages: 5,
            errors: 0,
          },
        });
        const result = formatCompletion(context, { tty: true });

        expect(result.metrics.some(m => m.includes('3') && m.includes('5'))).toBe(true);
      });
    });
  });

  describe('formatCompletionJson', () => {
    it('should return valid JSON structure', () => {
      const context = createMockContext('completed');
      const result = formatCompletionJson(context);

      expect(result).toHaveProperty('status', 'completed');
      expect(result).toHaveProperty('workflowId', 'test-workflow-123');
      expect(result).toHaveProperty('totalStages');
      expect(result).toHaveProperty('completedStages');
      expect(result).toHaveProperty('failedStages');
      expect(result).toHaveProperty('errors');
      expect(result).toHaveProperty('metrics');
      expect(result).toHaveProperty('nextSteps');
    });

    it('should include metrics object', () => {
      const context = createMockContext('completed', {
        metrics: {
          tokensUsed: 0,
          totalTokens: 2000,
          runtime: 0,
          totalRuntimeMs: 30000,
          stagesCompleted: 3,
          totalStages: 3,
          errors: 0,
          totalCost: 0.05,
        },
        iterationCount: 2,
      });
      const result = formatCompletionJson(context) as {
        metrics: { tokensUsed: number; cost: number; durationMs: number; iterations: number };
      };

      expect(result.metrics.tokensUsed).toBe(2000);
      expect(result.metrics.cost).toBe(0.05);
      expect(result.metrics.durationMs).toBe(30000);
      expect(result.metrics.iterations).toBe(2);
    });

    it('should extract failed stage names', () => {
      const context = createMockContext('completed_with_errors', {
        stageResults: {
          stage1: { success: true, outputs: {}, metrics: { tokensUsed: 100, duration: 1000 } },
          stage2: {
            success: false,
            outputs: {},
            metrics: { tokensUsed: 0, duration: 0 },
            errors: [{ message: 'Failed' }],
          },
        },
      });
      const result = formatCompletionJson(context) as { failedStages: string[] };

      expect(result.failedStages).toContain('stage2');
      expect(result.failedStages).not.toContain('stage1');
    });

    it('should extract all error messages', () => {
      const context = createMockContext('failed', {
        stageResults: {
          stage1: {
            success: false,
            outputs: {},
            metrics: { tokensUsed: 0, duration: 0 },
            errors: [{ message: 'Error 1' }, { message: 'Error 2' }],
          },
          stage2: {
            success: false,
            outputs: {},
            metrics: { tokensUsed: 0, duration: 0 },
            errors: [{ message: 'Error 3' }],
          },
        },
      });
      const result = formatCompletionJson(context) as { errors: string[] };

      expect(result.errors).toContain('Error 1');
      expect(result.errors).toContain('Error 2');
      expect(result.errors).toContain('Error 3');
    });

    it('should be valid JSON', () => {
      const context = createMockContext('completed');
      const result = formatCompletionJson(context);

      // Should not throw
      const stringified = JSON.stringify(result);
      const parsed = JSON.parse(stringified);

      expect(parsed.status).toBe('completed');
    });
  });
});
