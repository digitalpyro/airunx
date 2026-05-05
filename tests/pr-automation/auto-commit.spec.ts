import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutoCommit } from '../../src/pr-automation/auto-commit.js';
import type { WorkflowContext } from '../../src/core/types.js';

// Mock child_process
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

// Mock util
vi.mock('util', () => ({
  promisify: vi.fn((fn) => fn),
}));

describe('AutoCommit', () => {
  let autoCommit: AutoCommit;

  beforeEach(() => {
    autoCommit = new AutoCommit();
    vi.clearAllMocks();
  });

  describe('generateMessage', () => {
    it('should generate commit message with all metadata', () => {
      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Add dark mode',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Add dark mode feature',
        fidelityLevel: 'standard',
        backend: 'claude-code',
        iterationCount: 2,
        maxIterations: 3,
        todos: [
          { id: '001', title: 'Implement toggle UI', status: 'completed', priority: 'p1', createdAt: new Date(), updatedAt: new Date() },
          { id: '002', title: 'Add state management', status: 'completed', priority: 'p2', createdAt: new Date(), updatedAt: new Date() },
          { id: '003', title: 'Write tests', status: 'pending', priority: 'p3', createdAt: new Date(), updatedAt: new Date() },
        ],
        metrics: {
          tokensUsed: 8500,
          totalTokens: 8500,
          runtimeMs: 12340000,
          totalRuntimeMs: 12340000,
          totalCost: 0.12,
        },
      };

      const message = autoCommit.generateMessage(context);

      expect(message).toContain('feat: Add dark mode feature');
      expect(message).toContain('Implemented via AIRunX workflow');
      expect(message).toContain('Fidelity: standard');
      expect(message).toContain('Backend: claude-code');
      expect(message).toContain('Iterations: 2/3');
      expect(message).toContain('Tokens: 8,500');
      expect(message).toContain('Cost: $0.12');
      expect(message).toContain('✓ Implement toggle UI');
      expect(message).toContain('✓ Add state management');
      expect(message).not.toContain('✓ Write tests'); // pending todo
      expect(message).toContain('Co-authored-by: AIRunX');
    });

    it('should include issue number when provided', () => {
      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Fix bug',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Fix authentication bug',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      const message = autoCommit.generateMessage(context, { issueNumber: 123 });

      // "Fix" keyword in title triggers fix: prefix via inferCommitType
      expect(message).toContain('fix: Fix authentication bug (#123)');
    });

    it('should use custom commit type', () => {
      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Fix bug',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Fix authentication bug',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      const message = autoCommit.generateMessage(context, { commitType: 'fix' });

      expect(message).toContain('fix: Fix authentication bug');
    });

    it('should handle missing todos gracefully', () => {
      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Quick task',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Quick task',
        metrics: {
          tokensUsed: 500,
          runtimeMs: 1000,
          totalTokens: 500,
          totalRuntimeMs: 1000,
          totalCost: 0.01,
        },
      };

      const message = autoCommit.generateMessage(context);

      expect(message).toContain('No specific todos tracked');
    });

    it('should format duration correctly', () => {
      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Task',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Task',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 3661000, // 1 hour, 1 minute, 1 second
          totalRuntimeMs: 3661000,
          totalTokens: 1000,
          totalCost: 0.05,
        },
      };

      const message = autoCommit.generateMessage(context);

      expect(message).toContain('Runtime: 01:01:01');
    });
  });

  describe('commit', () => {
    it('should throw error when no worktree path', async () => {
      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Task',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        metrics: {
          tokensUsed: 0,
          runtimeMs: 0,
          totalTokens: 0,
          totalRuntimeMs: 0,
          totalCost: 0,
        },
      };

      await expect(autoCommit.commit(context)).rejects.toThrow(
        'No worktree path in workflow context'
      );
    });

    it('should throw error when no changes to commit', async () => {
      const { execFile } = await import('child_process');
      // Mock git status returning empty (no changes)
      vi.mocked(execFile).mockImplementation(
        (_cmd, args, _opts, callback?: unknown) => {
          if (args && args[0] === 'status') {
            if (typeof callback === 'function') {
              callback(null, { stdout: '', stderr: '' });
            }
            return { stdout: '' } as never;
          }
          return {} as never;
        }
      );

      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Task',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        worktreePath: '/tmp/test-worktree',
        metrics: {
          tokensUsed: 0,
          runtimeMs: 0,
          totalTokens: 0,
          totalRuntimeMs: 0,
          totalCost: 0,
        },
      };

      await expect(autoCommit.commit(context)).rejects.toThrow(
        'No changes to commit'
      );
    });

    it('should execute git commands in correct order on successful commit', async () => {
      const { execFile } = await import('child_process');
      const callOrder: string[] = [];

      vi.mocked(execFile).mockImplementation(
        (_cmd, args, _opts, callback?: unknown) => {
          const command = args ? args[0] : '';
          callOrder.push(command);

          let result = { stdout: '', stderr: '' };

          if (command === 'status') {
            result = { stdout: 'M file.ts', stderr: '' };
          } else if (command === 'rev-parse') {
            result = { stdout: 'abc123def456', stderr: '' };
          } else if (command === 'branch') {
            result = { stdout: 'feature-branch', stderr: '' };
          }

          if (typeof callback === 'function') {
            callback(null, result);
          }
          return result as never;
        }
      );

      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Task',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        worktreePath: '/tmp/test-worktree',
        taskTitle: 'Test task',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      const result = await autoCommit.commit(context, { skipPush: true });

      expect(result.commitSha).toBe('abc123def456');
      expect(result.pushed).toBe(false);
      expect(callOrder).toContain('status');
      expect(callOrder).toContain('add');
      expect(callOrder).toContain('commit');
      expect(callOrder).toContain('rev-parse');
    });

    it('should handle push failure gracefully', async () => {
      const { execFile } = await import('child_process');

      vi.mocked(execFile).mockImplementation(
        (_cmd, args, _opts, callback?: unknown) => {
          const command = args ? args[0] : '';

          if (command === 'push') {
            const error = new Error('Push failed: remote rejected');
            if (typeof callback === 'function') {
              callback(error, { stdout: '', stderr: '' });
            }
            throw error;
          }

          let result = { stdout: '', stderr: '' };
          if (command === 'status') {
            result = { stdout: 'M file.ts', stderr: '' };
          } else if (command === 'rev-parse') {
            result = { stdout: 'abc123def456', stderr: '' };
          } else if (command === 'branch') {
            result = { stdout: 'feature-branch', stderr: '' };
          }

          if (typeof callback === 'function') {
            callback(null, result);
          }
          return result as never;
        }
      );

      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Task',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        worktreePath: '/tmp/test-worktree',
        taskTitle: 'Test task',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      const result = await autoCommit.commit(context);

      expect(result.commitSha).toBe('abc123def456');
      expect(result.pushed).toBe(false);
    });
  });
});
