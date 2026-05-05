/**
 * Tests for Iteration History
 * Validates iteration recording and formatting for agent consumption
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IterationHistory } from '../../src/orchestrator/iteration-history.js';
import type { StateManager } from '../../src/orchestrator/state-manager.js';
import type { WorkflowContext } from '../../src/core/types.js';

describe('IterationHistory', () => {
  let stateManager: StateManager;
  let iterationHistory: IterationHistory;
  let mockContext: WorkflowContext;

  beforeEach(() => {
    // Create mocked state manager
    stateManager = {
      load: vi.fn(),
      update: vi.fn(),
    } as unknown as StateManager;

    iterationHistory = new IterationHistory(stateManager, 'test-workflow');

    // Default mock context without history
    mockContext = {
      id: 'test-workflow',
      input: 'Test task',
      inputType: 'prompt',
      mode: 'autonomous',
      createdAt: new Date(),
      status: 'running',
      metrics: {
        tokensUsed: 0,
        runtime: 0,
        stagesCompleted: 0,
        totalStages: 0,
        errors: 0,
      },
    };
  });

  describe('record', () => {
    it('should record an iteration entry', async () => {
      let capturedUpdate: ((ctx: WorkflowContext) => WorkflowContext) | null =
        null;
      vi.mocked(stateManager.update).mockImplementation(
        async (_id, updateFn) => {
          capturedUpdate = updateFn as (
            ctx: WorkflowContext
          ) => WorkflowContext;
        }
      );

      await iterationHistory.record({
        iteration: 1,
        timestamp: new Date('2026-04-01T12:00:00Z'),
        approach: 'Added basic validation',
        verdict: 'ITERATE',
        gaps: ['missing error handling', 'no tests'],
      });

      expect(stateManager.update).toHaveBeenCalledWith(
        'test-workflow',
        expect.any(Function)
      );

      // Execute the captured update function
      const result = capturedUpdate!(mockContext);
      expect(result.iterationHistory?.entries).toHaveLength(1);
      expect(result.iterationHistory?.entries[0].approach).toBe(
        'Added basic validation'
      );
    });

    it('should append to existing history', async () => {
      const contextWithHistory: WorkflowContext = {
        ...mockContext,
        iterationHistory: {
          entries: [
            {
              iteration: 1,
              timestamp: new Date('2026-04-01T11:00:00Z'),
              approach: 'First attempt',
              verdict: 'ITERATE',
              gaps: ['gap1'],
            },
          ],
        },
      };

      let capturedUpdate: ((ctx: WorkflowContext) => WorkflowContext) | null =
        null;
      vi.mocked(stateManager.update).mockImplementation(
        async (_id, updateFn) => {
          capturedUpdate = updateFn as (
            ctx: WorkflowContext
          ) => WorkflowContext;
        }
      );

      await iterationHistory.record({
        iteration: 2,
        timestamp: new Date('2026-04-01T12:00:00Z'),
        approach: 'Second attempt',
        verdict: 'PROCEED',
        gaps: [],
      });

      const result = capturedUpdate!(contextWithHistory);
      expect(result.iterationHistory?.entries).toHaveLength(2);
    });
  });

  describe('formatForAgent', () => {
    it('should return message when no history exists', async () => {
      vi.mocked(stateManager.load).mockResolvedValue(mockContext);

      const result = await iterationHistory.formatForAgent();

      expect(result).toBe('No previous iterations.');
    });

    it('should format failed approaches', async () => {
      const contextWithHistory: WorkflowContext = {
        ...mockContext,
        iterationHistory: {
          entries: [
            {
              iteration: 1,
              timestamp: new Date('2026-04-01T11:00:00Z'),
              approach: 'Added basic validation',
              verdict: 'ITERATE',
              gaps: ['missing error handling', 'no tests'],
            },
          ],
        },
      };
      vi.mocked(stateManager.load).mockResolvedValue(contextWithHistory);

      const result = await iterationHistory.formatForAgent();

      expect(result).toContain('## Previous Iterations (1)');
      expect(result).toContain("### Approaches That Didn't Work");
      expect(result).toContain('Iteration 1 (ITERATE): Added basic validation');
      expect(result).toContain('missing error handling, no tests');
    });

    it('should highlight recurring gaps', async () => {
      const contextWithHistory: WorkflowContext = {
        ...mockContext,
        iterationHistory: {
          entries: [
            {
              iteration: 1,
              timestamp: new Date('2026-04-01T11:00:00Z'),
              approach: 'First attempt',
              verdict: 'ITERATE',
              gaps: ['missing tests', 'no error handling'],
            },
            {
              iteration: 2,
              timestamp: new Date('2026-04-01T12:00:00Z'),
              approach: 'Second attempt',
              verdict: 'ITERATE',
              gaps: ['missing tests'], // Recurring gap
            },
          ],
        },
      };
      vi.mocked(stateManager.load).mockResolvedValue(contextWithHistory);

      const result = await iterationHistory.formatForAgent();

      expect(result).toContain('### Recurring Gaps (Address First)');
      expect(result).toContain('missing tests (2x)');
    });

    it('should not show recurring gaps section if none exist', async () => {
      const contextWithHistory: WorkflowContext = {
        ...mockContext,
        iterationHistory: {
          entries: [
            {
              iteration: 1,
              timestamp: new Date('2026-04-01T11:00:00Z'),
              approach: 'First attempt',
              verdict: 'ITERATE',
              gaps: ['gap1'],
            },
            {
              iteration: 2,
              timestamp: new Date('2026-04-01T12:00:00Z'),
              approach: 'Second attempt',
              verdict: 'PROCEED',
              gaps: ['gap2'], // Different gap
            },
          ],
        },
      };
      vi.mocked(stateManager.load).mockResolvedValue(contextWithHistory);

      const result = await iterationHistory.formatForAgent();

      expect(result).not.toContain('### Recurring Gaps');
    });
  });

  describe('getEntries', () => {
    it('should return empty array when no history', async () => {
      vi.mocked(stateManager.load).mockResolvedValue(mockContext);

      const entries = await iterationHistory.getEntries();

      expect(entries).toEqual([]);
    });

    it('should return all entries', async () => {
      const contextWithHistory: WorkflowContext = {
        ...mockContext,
        iterationHistory: {
          entries: [
            {
              iteration: 1,
              timestamp: new Date(),
              approach: 'Attempt 1',
              verdict: 'ITERATE',
              gaps: ['gap1'],
            },
            {
              iteration: 2,
              timestamp: new Date(),
              approach: 'Attempt 2',
              verdict: 'PROCEED',
              gaps: [],
            },
          ],
        },
      };
      vi.mocked(stateManager.load).mockResolvedValue(contextWithHistory);

      const entries = await iterationHistory.getEntries();

      expect(entries).toHaveLength(2);
      expect(entries[0].approach).toBe('Attempt 1');
      expect(entries[1].approach).toBe('Attempt 2');
    });
  });
});
