import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PRGenerator } from '../../src/pr-automation/pr-generator.js';
import type { WorkflowContext } from '../../src/core/types.js';

// Mock GitHubCLI
vi.mock('../../src/integrations/github-cli.js', () => ({
  GitHubCLI: {
    getCurrentRepo: vi.fn(),
    createPullRequest: vi.fn(),
    applyLabels: vi.fn(),
    listPullRequests: vi.fn(),
    updatePullRequest: vi.fn(),
  },
}));

// Mock settings module
vi.mock('../../src/utils/settings.js', () => ({
  loadSettings: vi.fn(() => ({
    gh_pr_title_rules: null,
    gh_pr_label_rules: null,
  })),
}));

describe('PRGenerator', () => {
  let prGenerator: PRGenerator;

  beforeEach(async () => {
    prGenerator = new PRGenerator();
    vi.clearAllMocks();
    // Default: no existing PR
    const { GitHubCLI } = await import('../../src/integrations/github-cli.js');
    vi.mocked(GitHubCLI.listPullRequests).mockResolvedValue([]);
  });

  describe('create', () => {
    it('should throw error when repository cannot be determined', async () => {
      const { GitHubCLI } = await import('../../src/integrations/github-cli.js');
      vi.mocked(GitHubCLI.getCurrentRepo).mockResolvedValue(null);

      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Add feature',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Add feature',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      await expect(prGenerator.create(context)).rejects.toThrow(
        'Could not determine repository'
      );
    });

    it('should create PR with correct title and body', async () => {
      const { GitHubCLI } = await import('../../src/integrations/github-cli.js');
      vi.mocked(GitHubCLI.getCurrentRepo).mockResolvedValue('owner/repo');
      vi.mocked(GitHubCLI.createPullRequest).mockResolvedValue({
        number: 123,
        title: 'feat: Add feature',
        body: 'PR body',
        state: 'open',
        labels: [],
        author: 'airunx',
        url: 'https://github.com/owner/repo/pull/123',
        baseBranch: 'main',
        headBranch: 'feature-branch',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Add feature',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Add cool feature',
        branchName: 'feature-branch',
        fidelityLevel: 'standard',
        backend: 'claude-code',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      const result = await prGenerator.create(context, { skipLabels: true });

      expect(result.url).toBe('https://github.com/owner/repo/pull/123');
      expect(result.number).toBe(123);
      expect(result.updated).toBe(false);
      expect(GitHubCLI.createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          repo: 'owner/repo',
          title: expect.stringContaining('Add cool feature'),
          head: 'feature-branch',
        })
      );
    });

    it('should infer commit type from title', async () => {
      const { GitHubCLI } = await import('../../src/integrations/github-cli.js');
      vi.mocked(GitHubCLI.getCurrentRepo).mockResolvedValue('owner/repo');
      vi.mocked(GitHubCLI.createPullRequest).mockResolvedValue({
        number: 124,
        title: 'fix: Fix bug',
        body: 'PR body',
        state: 'open',
        labels: [],
        author: 'airunx',
        url: 'https://github.com/owner/repo/pull/124',
        baseBranch: 'main',
        headBranch: 'fix-branch',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Fix bug',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Fix authentication bug',
        taskDescription: 'There is a bug in the login flow',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      await prGenerator.create(context, { skipLabels: true });

      expect(GitHubCLI.createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringMatching(/^fix:/),
        })
      );
    });

    it('should detect docs commit type', async () => {
      const { GitHubCLI } = await import('../../src/integrations/github-cli.js');
      vi.mocked(GitHubCLI.getCurrentRepo).mockResolvedValue('owner/repo');
      vi.mocked(GitHubCLI.createPullRequest).mockResolvedValue({
        number: 125,
        title: 'docs: Update README',
        body: 'PR body',
        state: 'open',
        labels: [],
        author: 'airunx',
        url: 'https://github.com/owner/repo/pull/125',
        baseBranch: 'main',
        headBranch: 'docs-branch',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Update docs',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Update README documentation',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      await prGenerator.create(context, { skipLabels: true });

      expect(GitHubCLI.createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringMatching(/^docs:/),
        })
      );
    });

    it('should apply generated and extra labels', async () => {
      const { GitHubCLI } = await import('../../src/integrations/github-cli.js');
      vi.mocked(GitHubCLI.getCurrentRepo).mockResolvedValue('owner/repo');
      vi.mocked(GitHubCLI.createPullRequest).mockResolvedValue({
        number: 126,
        title: 'feat: Add feature',
        body: 'PR body',
        state: 'open',
        labels: [],
        author: 'airunx',
        url: 'https://github.com/owner/repo/pull/126',
        baseBranch: 'main',
        headBranch: 'feature-branch',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(GitHubCLI.applyLabels).mockResolvedValue(undefined);

      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Add feature',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Add feature',
        fidelityLevel: 'standard',
        backend: 'claude-code',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      const result = await prGenerator.create(context, {
        extraLabels: ['priority-high', 'needs-review'],
      });

      expect(result.labelsApplied).toBe(true);
      expect(GitHubCLI.applyLabels).toHaveBeenCalledWith(
        'owner/repo',
        126,
        expect.arrayContaining([
          'ai-generated',
          'backend-claude-code',
          'fidelity-standard',
          'priority-high',
          'needs-review',
        ])
      );
    });

    it('should detect existing PR and update instead of creating', async () => {
      const { GitHubCLI } = await import('../../src/integrations/github-cli.js');
      vi.mocked(GitHubCLI.getCurrentRepo).mockResolvedValue('owner/repo');
      vi.mocked(GitHubCLI.listPullRequests).mockResolvedValue([
        {
          number: 200,
          title: 'feat: Existing PR',
          body: 'Old body',
          state: 'open',
          labels: ['ai-generated'],
          author: 'airunx',
          url: 'https://github.com/owner/repo/pull/200',
          baseBranch: 'main',
          headBranch: 'feature-branch',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);
      vi.mocked(GitHubCLI.updatePullRequest).mockResolvedValue(undefined);

      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Add feature',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Add feature',
        branchName: 'feature-branch',
        fidelityLevel: 'standard',
        backend: 'claude-code',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      const result = await prGenerator.create(context, { skipLabels: true });

      expect(result.url).toBe('https://github.com/owner/repo/pull/200');
      expect(result.number).toBe(200);
      expect(result.updated).toBe(true);
      expect(GitHubCLI.createPullRequest).not.toHaveBeenCalled();
      expect(GitHubCLI.updatePullRequest).toHaveBeenCalledWith({
        repo: 'owner/repo',
        prNumber: 200,
        title: expect.stringContaining('Add feature'),
        body: expect.any(String),
      });
    });

    it('should apply labels when updating existing PR', async () => {
      const { GitHubCLI } = await import('../../src/integrations/github-cli.js');
      vi.mocked(GitHubCLI.getCurrentRepo).mockResolvedValue('owner/repo');
      vi.mocked(GitHubCLI.listPullRequests).mockResolvedValue([
        {
          number: 201,
          title: 'feat: Existing PR',
          body: 'Old body',
          state: 'open',
          labels: [],
          author: 'airunx',
          url: 'https://github.com/owner/repo/pull/201',
          baseBranch: 'main',
          headBranch: 'feature-branch',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);
      vi.mocked(GitHubCLI.updatePullRequest).mockResolvedValue(undefined);
      vi.mocked(GitHubCLI.applyLabels).mockResolvedValue(undefined);

      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Add feature',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Add feature',
        branchName: 'feature-branch',
        fidelityLevel: 'standard',
        backend: 'claude-code',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      const result = await prGenerator.create(context);

      expect(result.updated).toBe(true);
      expect(result.labelsApplied).toBe(true);
      expect(GitHubCLI.applyLabels).toHaveBeenCalledWith(
        'owner/repo',
        201,
        expect.arrayContaining(['ai-generated', 'backend-claude-code', 'fidelity-standard'])
      );
    });

    it('should create new PR when no existing PR found', async () => {
      const { GitHubCLI } = await import('../../src/integrations/github-cli.js');
      vi.mocked(GitHubCLI.getCurrentRepo).mockResolvedValue('owner/repo');
      vi.mocked(GitHubCLI.listPullRequests).mockResolvedValue([]);
      vi.mocked(GitHubCLI.createPullRequest).mockResolvedValue({
        number: 300,
        title: 'feat: New feature',
        body: 'PR body',
        state: 'open',
        labels: [],
        author: 'airunx',
        url: 'https://github.com/owner/repo/pull/300',
        baseBranch: 'main',
        headBranch: 'new-branch',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Add feature',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'New feature',
        branchName: 'new-branch',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      const result = await prGenerator.create(context, { skipLabels: true });

      expect(result.updated).toBe(false);
      expect(result.number).toBe(300);
      expect(GitHubCLI.createPullRequest).toHaveBeenCalled();
      expect(GitHubCLI.updatePullRequest).not.toHaveBeenCalled();
    });

    it('should gracefully handle listPullRequests failure', async () => {
      const { GitHubCLI } = await import('../../src/integrations/github-cli.js');
      vi.mocked(GitHubCLI.getCurrentRepo).mockResolvedValue('owner/repo');
      vi.mocked(GitHubCLI.listPullRequests).mockRejectedValue(new Error('Network error'));
      vi.mocked(GitHubCLI.createPullRequest).mockResolvedValue({
        number: 400,
        title: 'feat: Feature',
        body: 'PR body',
        state: 'open',
        labels: [],
        author: 'airunx',
        url: 'https://github.com/owner/repo/pull/400',
        baseBranch: 'main',
        headBranch: 'feature-branch',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Add feature',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Feature',
        branchName: 'feature-branch',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      // Should fallback to creating new PR when listPullRequests fails
      const result = await prGenerator.create(context, { skipLabels: true });

      expect(result.updated).toBe(false);
      expect(result.number).toBe(400);
      expect(GitHubCLI.createPullRequest).toHaveBeenCalled();
    });
  });

  describe('generateLabels with custom rules', () => {
    it('should use default labels when gh_pr_label_rules is null', async () => {
      const { GitHubCLI } = await import('../../src/integrations/github-cli.js');
      const { loadSettings } = await import('../../src/utils/settings.js');
      vi.mocked(loadSettings).mockReturnValue({
        gh_pr_title_rules: null,
        gh_pr_label_rules: null,
      } as ReturnType<typeof loadSettings>);

      vi.mocked(GitHubCLI.getCurrentRepo).mockResolvedValue('owner/repo');
      vi.mocked(GitHubCLI.createPullRequest).mockResolvedValue({
        number: 500,
        title: 'feat: Feature',
        body: 'PR body',
        state: 'open',
        labels: [],
        author: 'airunx',
        url: 'https://github.com/owner/repo/pull/500',
        baseBranch: 'main',
        headBranch: 'feature-branch',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(GitHubCLI.applyLabels).mockResolvedValue(undefined);

      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Add feature',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Feature',
        branchName: 'feature-branch',
        backend: 'claude-code',
        fidelityLevel: 'standard',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      await prGenerator.create(context);

      expect(GitHubCLI.applyLabels).toHaveBeenCalledWith(
        'owner/repo',
        500,
        expect.arrayContaining([
          'ai-generated',
          'backend-claude-code',
          'fidelity-standard',
        ])
      );
    });

    it('should use custom always labels from settings', async () => {
      const { GitHubCLI } = await import('../../src/integrations/github-cli.js');
      const { loadSettings } = await import('../../src/utils/settings.js');
      vi.mocked(loadSettings).mockReturnValue({
        gh_pr_title_rules: null,
        gh_pr_label_rules: {
          always: ['automated', 'bot-generated'],
          include_backend: true,
          include_fidelity: true,
        },
      } as ReturnType<typeof loadSettings>);

      // Create new instance AFTER mock setup so it picks up custom settings
      const prGenerator = new PRGenerator();

      vi.mocked(GitHubCLI.getCurrentRepo).mockResolvedValue('owner/repo');
      vi.mocked(GitHubCLI.listPullRequests).mockResolvedValue([]);
      vi.mocked(GitHubCLI.createPullRequest).mockResolvedValue({
        number: 501,
        title: 'feat: Feature',
        body: 'PR body',
        state: 'open',
        labels: [],
        author: 'airunx',
        url: 'https://github.com/owner/repo/pull/501',
        baseBranch: 'main',
        headBranch: 'feature-branch',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(GitHubCLI.applyLabels).mockResolvedValue(undefined);

      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Add feature',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Feature',
        branchName: 'feature-branch',
        backend: 'cursor',
        fidelityLevel: 'fast',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      await prGenerator.create(context);

      expect(GitHubCLI.applyLabels).toHaveBeenCalledWith(
        'owner/repo',
        501,
        expect.arrayContaining([
          'automated',
          'bot-generated',
          'backend-cursor',
          'fidelity-fast',
        ])
      );
      // Should NOT contain ai-generated when custom always is provided
      expect(GitHubCLI.applyLabels).not.toHaveBeenCalledWith(
        'owner/repo',
        501,
        expect.arrayContaining(['ai-generated'])
      );
    });

    it('should exclude backend label when include_backend is false', async () => {
      const { GitHubCLI } = await import('../../src/integrations/github-cli.js');
      const { loadSettings } = await import('../../src/utils/settings.js');
      vi.mocked(loadSettings).mockReturnValue({
        gh_pr_title_rules: null,
        gh_pr_label_rules: {
          always: ['ai-generated'],
          include_backend: false,
          include_fidelity: true,
        },
      } as ReturnType<typeof loadSettings>);

      // Create new instance AFTER mock setup so it picks up custom settings
      const prGenerator = new PRGenerator();

      vi.mocked(GitHubCLI.getCurrentRepo).mockResolvedValue('owner/repo');
      vi.mocked(GitHubCLI.listPullRequests).mockResolvedValue([]);
      vi.mocked(GitHubCLI.createPullRequest).mockResolvedValue({
        number: 502,
        title: 'feat: Feature',
        body: 'PR body',
        state: 'open',
        labels: [],
        author: 'airunx',
        url: 'https://github.com/owner/repo/pull/502',
        baseBranch: 'main',
        headBranch: 'feature-branch',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(GitHubCLI.applyLabels).mockResolvedValue(undefined);

      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Add feature',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Feature',
        branchName: 'feature-branch',
        backend: 'claude-code',
        fidelityLevel: 'standard',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      await prGenerator.create(context);

      const appliedLabels = vi.mocked(GitHubCLI.applyLabels).mock.calls[0][2];
      expect(appliedLabels).toContain('ai-generated');
      expect(appliedLabels).toContain('fidelity-standard');
      expect(appliedLabels).not.toContain('backend-claude-code');
    });

    it('should exclude fidelity label when include_fidelity is false', async () => {
      const { GitHubCLI } = await import('../../src/integrations/github-cli.js');
      const { loadSettings } = await import('../../src/utils/settings.js');
      vi.mocked(loadSettings).mockReturnValue({
        gh_pr_title_rules: null,
        gh_pr_label_rules: {
          always: ['ai-generated'],
          include_backend: true,
          include_fidelity: false,
        },
      } as ReturnType<typeof loadSettings>);

      // Create new instance AFTER mock setup so it picks up custom settings
      const prGenerator = new PRGenerator();

      vi.mocked(GitHubCLI.getCurrentRepo).mockResolvedValue('owner/repo');
      vi.mocked(GitHubCLI.listPullRequests).mockResolvedValue([]);
      vi.mocked(GitHubCLI.createPullRequest).mockResolvedValue({
        number: 503,
        title: 'feat: Feature',
        body: 'PR body',
        state: 'open',
        labels: [],
        author: 'airunx',
        url: 'https://github.com/owner/repo/pull/503',
        baseBranch: 'main',
        headBranch: 'feature-branch',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(GitHubCLI.applyLabels).mockResolvedValue(undefined);

      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Add feature',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Feature',
        branchName: 'feature-branch',
        backend: 'claude-code',
        fidelityLevel: 'standard',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      await prGenerator.create(context);

      const appliedLabels = vi.mocked(GitHubCLI.applyLabels).mock.calls[0][2];
      expect(appliedLabels).toContain('ai-generated');
      expect(appliedLabels).toContain('backend-claude-code');
      expect(appliedLabels).not.toContain('fidelity-standard');
    });

    it('should include custom labels from settings', async () => {
      const { GitHubCLI } = await import('../../src/integrations/github-cli.js');
      const { loadSettings } = await import('../../src/utils/settings.js');
      vi.mocked(loadSettings).mockReturnValue({
        gh_pr_title_rules: null,
        gh_pr_label_rules: {
          always: ['ai-generated'],
          include_backend: false,
          include_fidelity: false,
          custom: ['needs-review', 'priority-high'],
        },
      } as ReturnType<typeof loadSettings>);

      // Create new instance AFTER mock setup so it picks up custom settings
      const prGenerator = new PRGenerator();

      vi.mocked(GitHubCLI.getCurrentRepo).mockResolvedValue('owner/repo');
      vi.mocked(GitHubCLI.listPullRequests).mockResolvedValue([]);
      vi.mocked(GitHubCLI.createPullRequest).mockResolvedValue({
        number: 504,
        title: 'feat: Feature',
        body: 'PR body',
        state: 'open',
        labels: [],
        author: 'airunx',
        url: 'https://github.com/owner/repo/pull/504',
        baseBranch: 'main',
        headBranch: 'feature-branch',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(GitHubCLI.applyLabels).mockResolvedValue(undefined);

      const context: WorkflowContext = {
        id: 'test-workflow-123',
        input: 'Add feature',
        inputType: 'prompt',
        mode: 'pipeline',
        createdAt: new Date(),
        status: 'completed',
        taskTitle: 'Feature',
        branchName: 'feature-branch',
        backend: 'claude-code',
        fidelityLevel: 'standard',
        metrics: {
          tokensUsed: 1000,
          runtimeMs: 5000,
          totalTokens: 1000,
          totalRuntimeMs: 5000,
          totalCost: 0.02,
        },
      };

      await prGenerator.create(context);

      const appliedLabels = vi.mocked(GitHubCLI.applyLabels).mock.calls[0][2];
      expect(appliedLabels).toContain('ai-generated');
      expect(appliedLabels).toContain('needs-review');
      expect(appliedLabels).toContain('priority-high');
    });
  });
});
