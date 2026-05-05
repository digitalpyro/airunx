import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubTaskQueue } from '../../src/task-queue/github-task-queue.js';
import type { TaskResult } from '../../src/task-queue/types.js';
import type { RunReport, StageRecord } from '../../src/core/types.js';

// Mock GitHubCLI
vi.mock('../../src/integrations/github-cli.js', () => ({
  GitHubCLI: {
    getCurrentUser: vi.fn().mockResolvedValue('test-user'),
    updateIssueLabels: vi.fn().mockResolvedValue(undefined),
    addIssueComment: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('GitHubTaskQueue', () => {
  let queue: GitHubTaskQueue;

  beforeEach(() => {
    vi.clearAllMocks();
    queue = new GitHubTaskQueue('owner/repo', 'test-user');
  });

  describe('completeTask', () => {
    it('should label completed and post comment when PR exists (issue closes on PR merge)', async () => {
      const { GitHubCLI } = await import(
        '../../src/integrations/github-cli.js'
      );
      const result: TaskResult = {
        status: 'completed',
        prUrl: 'https://github.com/owner/repo/pull/1',
        summary: 'Done',
        deliverables: [],
      };

      await queue.completeTask('42', result);

      expect(GitHubCLI.updateIssueLabels).toHaveBeenCalledWith(
        'owner/repo',
        '42',
        { remove: ['airunx:running'], add: ['airunx:completed'] }
      );
      expect(GitHubCLI.addIssueComment).toHaveBeenCalled();
    });

    it('should include metrics in success comment', async () => {
      const { GitHubCLI } = await import(
        '../../src/integrations/github-cli.js'
      );
      const result: TaskResult = {
        status: 'completed',
        prUrl: 'https://github.com/owner/repo/pull/1',
        summary: 'Done',
        deliverables: [],
        metrics: {
          costUsd: 1.2345,
          tokensUsed: 45230,
          durationMs: 192300,
          iterations: 3,
        },
      };

      await queue.completeTask('42', result);

      expect(GitHubCLI.addIssueComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('Cost: $1.2345'),
        })
      );
      expect(GitHubCLI.addIssueComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('Tokens: 45,230'),
        })
      );
      expect(GitHubCLI.addIssueComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('Duration: 192.3s'),
        })
      );
      expect(GitHubCLI.addIssueComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('Iterations: 3'),
        })
      );
    });

    it('should treat as failed when no PR exists', async () => {
      const { GitHubCLI } = await import(
        '../../src/integrations/github-cli.js'
      );
      const result: TaskResult = {
        status: 'completed',
        summary: 'Done',
        deliverables: ['commit:abc123', 'worktree:/tmp/wt'],
      };

      await queue.completeTask('42', result);

      expect(GitHubCLI.updateIssueLabels).toHaveBeenCalledWith(
        'owner/repo',
        '42',
        { remove: ['airunx:running'], add: ['airunx:failed'] }
      );
    });

    it('should preserve metrics when redirecting no-PR completion to failTask', async () => {
      const { GitHubCLI } = await import(
        '../../src/integrations/github-cli.js'
      );
      const result: TaskResult = {
        status: 'completed',
        summary: 'Processed task #10',
        deliverables: [],
        metrics: {
          costUsd: 5.5,
          tokensUsed: 100000,
          durationMs: 300000,
          iterations: 2,
        },
      };

      await queue.completeTask('10', result);

      expect(GitHubCLI.addIssueComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('Cost: $5.5000'),
        })
      );
      expect(GitHubCLI.addIssueComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('Completed without PR'),
        })
      );
    });

    it('should treat as failed when no PR and no deliverables', async () => {
      const { GitHubCLI } = await import(
        '../../src/integrations/github-cli.js'
      );
      const result: TaskResult = {
        status: 'completed',
        summary: 'Processed task #10398',
        deliverables: [],
      };

      await queue.completeTask('10398', result);

      expect(GitHubCLI.updateIssueLabels).toHaveBeenCalledWith(
        'owner/repo',
        '10398',
        { remove: ['airunx:running'], add: ['airunx:failed'] }
      );

      expect(GitHubCLI.addIssueComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('Completed without PR'),
        })
      );
    });

    it('should treat as failed when deliverables is undefined', async () => {
      const { GitHubCLI } = await import(
        '../../src/integrations/github-cli.js'
      );
      const result: TaskResult = {
        status: 'completed',
        summary: 'Processed task #99',
      };

      await queue.completeTask('99', result);

      expect(GitHubCLI.updateIssueLabels).toHaveBeenCalledWith(
        'owner/repo',
        '99',
        { remove: ['airunx:running'], add: ['airunx:failed'] }
      );
    });
  });

  describe('failTask', () => {
    it('should include metrics in failure comment', async () => {
      const { GitHubCLI } = await import(
        '../../src/integrations/github-cli.js'
      );
      const result: TaskResult = {
        status: 'failed',
        error: new Error('Pipeline failed'),
        metrics: {
          costUsd: 0.5678,
          tokensUsed: 12345,
          durationMs: 60000,
          iterations: 1,
        },
      };

      await queue.failTask('42', result);

      expect(GitHubCLI.updateIssueLabels).toHaveBeenCalledWith(
        'owner/repo',
        '42',
        { remove: ['airunx:running'], add: ['airunx:failed'] }
      );

      const call = vi.mocked(GitHubCLI.addIssueComment).mock.calls[0][0] as {
        body: string;
      };
      expect(call.body).toContain('Pipeline failed');
      expect(call.body).toContain('Cost: $0.5678');
      expect(call.body).toContain('Tokens: 12,345');
      expect(call.body).toContain('Duration: 60.0s');
      expect(call.body).toContain('Iterations: 1');
      expect(call.body).toContain(':bar_chart:');
    });

    it('should omit metrics line when no metrics available', async () => {
      const { GitHubCLI } = await import(
        '../../src/integrations/github-cli.js'
      );
      const result: TaskResult = {
        status: 'failed',
        error: new Error('Spawn failed'),
      };

      await queue.failTask('42', result);

      const call = vi.mocked(GitHubCLI.addIssueComment).mock.calls[0][0] as {
        body: string;
      };
      expect(call.body).toContain('Spawn failed');
      expect(call.body).not.toContain(':bar_chart:');
    });

    it('should show zero-value metrics for auth failures', async () => {
      const { GitHubCLI } = await import(
        '../../src/integrations/github-cli.js'
      );
      const result: TaskResult = {
        status: 'failed',
        error: new Error('Auth failed'),
        metrics: {
          costUsd: 0,
          tokensUsed: 0,
          durationMs: 0,
          iterations: 0,
        },
      };

      await queue.failTask('42', result);

      const call = vi.mocked(GitHubCLI.addIssueComment).mock.calls[0][0] as {
        body: string;
      };
      expect(call.body).toContain('Cost: $0.0000');
      expect(call.body).toContain('Tokens: 0');
      expect(call.body).toContain('Duration: 0.0s');
      expect(call.body).toContain('Iterations: 0');
    });

    it('should omit individual undefined metrics fields', async () => {
      const { GitHubCLI } = await import(
        '../../src/integrations/github-cli.js'
      );
      const result: TaskResult = {
        status: 'failed',
        error: new Error('Partial failure'),
        metrics: {
          costUsd: 2.5,
          durationMs: 45000,
        },
      };

      await queue.failTask('42', result);

      const call = vi.mocked(GitHubCLI.addIssueComment).mock.calls[0][0] as {
        body: string;
      };
      expect(call.body).toContain('Cost: $2.5000');
      expect(call.body).toContain('Duration: 45.0s');
      expect(call.body).not.toContain('Tokens:');
      expect(call.body).not.toContain('Iterations:');
    });

    it('should show Unknown error when result has no error', async () => {
      const { GitHubCLI } = await import(
        '../../src/integrations/github-cli.js'
      );
      const result: TaskResult = {
        status: 'failed',
      };

      await queue.failTask('42', result);

      const call = vi.mocked(GitHubCLI.addIssueComment).mock.calls[0][0] as {
        body: string;
      };
      expect(call.body).toContain('Unknown error');
    });

    it('should handle large token counts with locale formatting', async () => {
      const { GitHubCLI } = await import(
        '../../src/integrations/github-cli.js'
      );
      const result: TaskResult = {
        status: 'failed',
        error: new Error('Expensive failure'),
        metrics: {
          costUsd: 70.1234,
          tokensUsed: 100_000_000,
          durationMs: 2_700_000,
          iterations: 15,
        },
      };

      await queue.failTask('42', result);

      const call = vi.mocked(GitHubCLI.addIssueComment).mock.calls[0][0] as {
        body: string;
      };
      expect(call.body).toContain('Cost: $70.1234');
      expect(call.body).toContain('Tokens: 100,000,000');
      expect(call.body).toContain('Duration: 2700.0s');
      expect(call.body).toContain('Iterations: 15');
    });
  });

  describe('formatCompletionComment with runReport', () => {
    function makeStageRecords(): StageRecord[] {
      return [
        {
          stage: 'orchestrate',
          agent: 'developer',
          backend: 'claude-code',
          spawnCount: 1,
          durationMs: 311_000,
          tokensUsed: 13990,
          costUsd: 0.2093,
          promptSummary: 'Plan implementation for user search feature',
          timestamp: '2026-04-28T22:19:00.000Z',
          status: 'completed',
        },
        {
          stage: 'implement',
          agent: 'developer',
          backend: 'claude-code',
          spawnCount: 4,
          durationMs: 490_000,
          tokensUsed: 21766,
          costUsd: 0.1615,
          promptSummary: 'Implement the search feature following the plan',
          timestamp: '2026-04-28T22:24:00.000Z',
          status: 'completed',
        },
      ];
    }

    function makeRunReport(stages: StageRecord[]): RunReport {
      return {
        workflowId: 'wf-123',
        taskTitle: 'feat: Add search',
        pipelineName: 'standard',
        status: 'completed',
        startedAt: '2026-04-28T22:19:00.000Z',
        completedAt: '2026-04-28T22:33:00.000Z',
        totalDurationMs: 801_000,
        totalTokens: 35756,
        totalCostUsd: 0.3708,
        iterationCount: 1,
        maxIterations: 3,
        iterations: [],
        stages,
        timeline: stages.map((s) => ({
          timestamp: s.timestamp,
          event: `${s.stage} complete (${(s.durationMs / 1000).toFixed(1)}s)`,
          durationMs: s.durationMs,
        })),
      };
    }

    it('should render Pipeline Execution table when runReport is present', async () => {
      const { GitHubCLI } = await import(
        '../../src/integrations/github-cli.js'
      );
      const stages = makeStageRecords();
      const runReport = makeRunReport(stages);

      const result: TaskResult = {
        status: 'completed',
        prUrl: 'https://github.com/owner/repo/pull/5',
        summary: 'Search feature implemented',
        deliverables: ['pr:https://github.com/owner/repo/pull/5'],
        metrics: {
          costUsd: 0.3708,
          tokensUsed: 35756,
          durationMs: 801_000,
          iterations: 1,
        },
        runReport,
      };

      await queue.completeTask('100', result);

      const call = vi.mocked(GitHubCLI.addIssueComment).mock.calls[0][0] as {
        body: string;
      };
      // Table header
      expect(call.body).toContain('### Pipeline Execution');
      expect(call.body).toContain(
        '| # | Stage | Agent | Backend | Spawns | Duration | Tokens | Est. Cost |'
      );
      // Row data
      expect(call.body).toContain('orchestrate');
      expect(call.body).toContain('developer');
      expect(call.body).toContain('claude-code');
      expect(call.body).toContain('$0.2093');
      expect(call.body).toContain('$0.1615');
      // Totals row
      expect(call.body).toContain('**Totals**');
      expect(call.body).toContain('**5**'); // total spawns
      // Timeline
      expect(call.body).toContain('### Timeline');
      expect(call.body).toContain('orchestrate complete');
      expect(call.body).toContain('implement complete');
    });

    it('should fall back to simple metrics when runReport is absent', async () => {
      const { GitHubCLI } = await import(
        '../../src/integrations/github-cli.js'
      );
      const result: TaskResult = {
        status: 'completed',
        prUrl: 'https://github.com/owner/repo/pull/6',
        summary: 'Done',
        deliverables: [],
        metrics: {
          costUsd: 0.5,
          tokensUsed: 10000,
          durationMs: 60000,
          iterations: 1,
        },
      };

      await queue.completeTask('101', result);

      const call = vi.mocked(GitHubCLI.addIssueComment).mock.calls[0][0] as {
        body: string;
      };
      expect(call.body).not.toContain('### Pipeline Execution');
      expect(call.body).toContain('Cost: $0.5000');
      expect(call.body).toContain(':bar_chart:');
    });

    it('should include runReport table in failure comments', async () => {
      const { GitHubCLI } = await import(
        '../../src/integrations/github-cli.js'
      );
      const stages = makeStageRecords();
      const runReport = makeRunReport(stages);
      runReport.status = 'failed';

      const result: TaskResult = {
        status: 'failed',
        error: new Error('Judge: FAIL'),
        metrics: {
          costUsd: 0.3708,
          tokensUsed: 35756,
          durationMs: 801_000,
          iterations: 1,
        },
        runReport,
      };

      await queue.failTask('102', result);

      const call = vi.mocked(GitHubCLI.addIssueComment).mock.calls[0][0] as {
        body: string;
      };
      expect(call.body).toContain('AIRunX Failed');
      expect(call.body).toContain('### Pipeline Execution');
      expect(call.body).toContain('orchestrate');
      expect(call.body).toContain('implement');
    });
  });
});
