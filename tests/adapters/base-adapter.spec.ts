/**
 * BaseAdapter tests
 * Validates prompt construction and agent restrictions
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BaseAdapter } from '../../src/adapters/base-adapter.js';
import { DEFAULT_AGENT_CONFIGS } from '../../src/orchestrator/agent-defaults.js';
import type {
  ExecutionRequest,
  ExecutionResult,
  AgentDef,
  ProjectContext,
  BackendAvailability,
} from '../../src/core/adapter-types.js';

// Create a concrete test subclass since BaseAdapter is abstract
class TestableBaseAdapter extends BaseAdapter {
  name = 'test' as const;
  type = 'cli' as const;

  async execute(_request: ExecutionRequest): Promise<ExecutionResult> {
    return {
      success: true,
      outputs: { analysis: 'test' },
      metrics: { tokensUsed: 0, duration: 0, cost: 0 },
      errors: [],
    };
  }

  async isAvailable(): Promise<BackendAvailability> {
    return { available: true };
  }

  // Expose protected method for testing
  public testBuildPrompt(
    agent: AgentDef,
    task: string,
    context: ProjectContext
  ): string {
    return this.buildPrompt(agent, task, context);
  }
}

/**
 * Factory function for creating type-safe mock agent definitions
 */
const createMockAgent = (overrides: Partial<AgentDef> = {}): AgentDef => ({
  role: 'developer',
  capabilities: ['code'],
  contextRequired: ['codebase'],
  ...overrides,
});

/**
 * Factory function for creating type-safe mock project contexts
 */
const createMockContext = (
  overrides: Partial<ProjectContext> = {}
): ProjectContext => ({
  workingDirectory: '/test/path',
  ...overrides,
});

describe('BaseAdapter', () => {
  let adapter: TestableBaseAdapter;

  beforeEach(() => {
    adapter = new TestableBaseAdapter();
  });

  describe('buildPrompt restrictions', () => {
    it('should include RESTRICTIONS for non-orchestrator agents', () => {
      const agent = createMockAgent({ role: 'developer' });
      const context = createMockContext();

      const prompt = adapter.testBuildPrompt(agent, 'implement feature', context);

      expect(prompt).toContain('## RESTRICTIONS');
      expect(prompt).toContain('git commit, git push, git add');
      expect(prompt).toContain('gh pr create');
    });

    it('should NOT include RESTRICTIONS for orchestrator agent', () => {
      const agent = createMockAgent({ role: 'orchestrator' });
      const context = createMockContext();

      const prompt = adapter.testBuildPrompt(agent, 'coordinate workflow', context);

      expect(prompt).not.toContain('## RESTRICTIONS');
      expect(prompt).not.toContain('MUST NOT run');
    });

    it('should include read-only allowed commands for non-orchestrator agents', () => {
      const agent = createMockAgent({ role: 'code-reviewer' });
      const context = createMockContext();

      const prompt = adapter.testBuildPrompt(agent, 'review code', context);

      expect(prompt).toContain('git status, git diff, git log');
      expect(prompt).toContain('gh pr view, gh issue view');
    });

    it('should include restrictions for all non-orchestrator roles', () => {
      // Dynamically get roles from DEFAULT_AGENT_CONFIGS to ensure test stays in sync
      const roles = Object.keys(DEFAULT_AGENT_CONFIGS).filter(
        (role) => role !== 'orchestrator'
      );

      for (const role of roles) {
        const agent = createMockAgent({ role: role as AgentDef['role'] });
        const context = createMockContext();

        const prompt = adapter.testBuildPrompt(agent, 'test task', context);

        expect(prompt).toContain('## RESTRICTIONS');
      }
    });
  });

  describe('buildPrompt basic functionality', () => {
    it('should include agent role in prompt', () => {
      const agent = createMockAgent({ role: 'developer' });
      const context = createMockContext();

      const prompt = adapter.testBuildPrompt(agent, 'test task', context);

      expect(prompt).toContain('You are the developer agent');
      expect(prompt).toContain('Role: developer');
    });

    it('should include task in prompt', () => {
      const agent = createMockAgent();
      const context = createMockContext();

      const prompt = adapter.testBuildPrompt(agent, 'implement the feature', context);

      expect(prompt).toContain('Task: implement the feature');
    });

    it('should include working directory in context', () => {
      const agent = createMockAgent();
      const context = createMockContext({ workingDirectory: '/my/project' });

      const prompt = adapter.testBuildPrompt(agent, 'test', context);

      expect(prompt).toContain('Working Directory: /my/project');
    });

    it('should include git branch when provided', () => {
      const agent = createMockAgent();
      const context = createMockContext({ gitBranch: 'feature/my-branch' });

      const prompt = adapter.testBuildPrompt(agent, 'test', context);

      expect(prompt).toContain('Git Branch: feature/my-branch');
    });

    it('should include system prompt when provided', () => {
      const agent = createMockAgent({
        systemPrompt: 'You are a security expert.',
      });
      const context = createMockContext();

      const prompt = adapter.testBuildPrompt(agent, 'test', context);

      expect(prompt).toContain('You are a security expert.');
    });

    it('should include capabilities in prompt', () => {
      const agent = createMockAgent({
        capabilities: ['code_analysis', 'refactoring'],
      });
      const context = createMockContext();

      const prompt = adapter.testBuildPrompt(agent, 'test', context);

      expect(prompt).toContain('Capabilities: code_analysis, refactoring');
    });
  });
});
