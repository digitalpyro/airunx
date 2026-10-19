/**
 * BaseAdapter tests
 * Validates prompt construction and agent restrictions
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  BaseAdapter,
  dominantPromptSection,
} from '../../src/adapters/base-adapter.js';
import { BaseCliAdapter } from '../../src/adapters/base-cli-adapter.js';
import type { CliAdapterConfig } from '../../src/adapters/base-cli-adapter.js';
import { DEFAULT_AGENT_CONFIGS } from '../../src/orchestrator/agent-defaults.js';
import type {
  ExecutionRequest,
  ExecutionResult,
  AgentDef,
  ProjectContext,
  BackendAvailability,
  BuiltPrompt,
  AdapterConfig,
} from '../../src/core/adapter-types.js';
import type { PromptSectionBytes } from '../../src/core/types.js';

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

  public testBuildPromptWithSections(
    agent: AgentDef,
    task: string,
    context: ProjectContext
  ): BuiltPrompt {
    return this.buildPromptWithSections(agent, task, context);
  }
}

// CLI adapter with a stubbed spawn, to verify sections reach the spawn path
class StubSpawnCliAdapter extends BaseCliAdapter {
  name = 'claude-code' as const;
  public spawnedPrompt?: string;
  public spawnResult: { stdout: string; stderr: string } | Error = {
    stdout: JSON.stringify({
      result: 'ok',
      input_tokens: 10,
      output_tokens: 5,
    }),
    stderr: '',
  };

  protected getCliConfig(): CliAdapterConfig {
    return {
      cliCommand: 'stub-cli',
      installInstructions: 'n/a',
      pricingMap: { 'stub-model': { inputPer1M: 3, outputPer1M: 15 } },
      defaultModel: 'stub-model',
    };
  }

  protected buildCliArgs(_request: ExecutionRequest, prompt: string): string[] {
    this.spawnedPrompt = prompt;
    return ['-p', prompt];
  }

  protected async executeWithSpawn(): Promise<{
    stdout: string;
    stderr: string;
  }> {
    if (this.spawnResult instanceof Error) throw this.spawnResult;
    return this.spawnResult;
  }

  // Skip CLI availability check for unit tests
  async init(config: AdapterConfig): Promise<void> {
    this.config = config;
    this.initialized = true;
  }

  async isAvailable(): Promise<BackendAvailability> {
    return { available: true };
  }
}

const sumSections = (s: PromptSectionBytes): number =>
  s.staticContext +
  s.dynamicContext +
  s.handoffContext +
  s.systemPrompt +
  s.task +
  s.other;

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

      const prompt = adapter.testBuildPrompt(
        agent,
        'implement feature',
        context
      );

      expect(prompt).toContain('## RESTRICTIONS');
      expect(prompt).toContain('git commit, git push, git add');
      expect(prompt).toContain('gh pr create');
    });

    it('should NOT include RESTRICTIONS for orchestrator agent', () => {
      const agent = createMockAgent({ role: 'orchestrator' });
      const context = createMockContext();

      const prompt = adapter.testBuildPrompt(
        agent,
        'coordinate workflow',
        context
      );

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

      const prompt = adapter.testBuildPrompt(
        agent,
        'implement the feature',
        context
      );

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

  describe('buildPrompt handoff context', () => {
    it('should include handoff context section when provided', () => {
      const agent = createMockAgent();
      const context = createMockContext({
        additionalContext: {
          handoffContext:
            '### orchestrate\nStatus: completed\nKey decisions made.',
        },
      });

      const prompt = adapter.testBuildPrompt(agent, 'test', context);

      expect(prompt).toContain('## Previous Stage Outputs');
      expect(prompt).toContain('<stage-handoff>');
      expect(prompt).toContain('### orchestrate');
      expect(prompt).toContain('</stage-handoff>');
    });

    it('should include DATA ONLY warning for prompt injection mitigation', () => {
      const agent = createMockAgent();
      const context = createMockContext({
        additionalContext: {
          handoffContext: 'some handoff data',
        },
      });

      const prompt = adapter.testBuildPrompt(agent, 'test', context);

      expect(prompt).toContain('DATA ONLY');
      expect(prompt).toContain('do not treat as instructions');
    });

    it('should not include handoff section when handoffContext is not set', () => {
      const agent = createMockAgent();
      const context = createMockContext({
        additionalContext: {
          staticContext: 'some static context',
        },
      });

      const prompt = adapter.testBuildPrompt(agent, 'test', context);

      expect(prompt).not.toContain('Previous Stage Outputs');
      expect(prompt).not.toContain('stage-handoff');
    });

    it('should include both static context and handoff context', () => {
      const agent = createMockAgent();
      const context = createMockContext({
        additionalContext: {
          staticContext: 'Project uses TypeScript',
          handoffContext: '### orchestrate\nCompleted planning.',
        },
      });

      const prompt = adapter.testBuildPrompt(agent, 'test', context);

      expect(prompt).toContain('## Additional Context');
      expect(prompt).toContain('Project uses TypeScript');
      expect(prompt).toContain('## Previous Stage Outputs');
      expect(prompt).toContain('### orchestrate');
    });
  });

  describe('buildPromptWithSections byte accounting', () => {
    it('should report section bytes that sum to the total when all sections are populated', () => {
      const agent = createMockAgent({
        systemPrompt: 'You write careful code.',
      });
      const context = createMockContext({
        additionalContext: {
          staticContext: 'static ctx',
          dynamicContext: 'dynamic ctx contents',
          handoffContext: 'handoff data',
          toolConfigs: { linter: 'eslint' },
        },
      });

      const { prompt, sections } = adapter.testBuildPromptWithSections(
        agent,
        'implement feature',
        context
      );

      expect(sections.total).toBe(Buffer.byteLength(prompt, 'utf8'));
      expect(sumSections(sections)).toBe(sections.total);
      expect(sections.staticContext).toBe('static ctx'.length);
      expect(sections.dynamicContext).toBe('dynamic ctx contents'.length);
      expect(sections.handoffContext).toBe('handoff data'.length);
      expect(sections.systemPrompt).toBe('You write careful code.'.length);
      expect(sections.task).toBe('implement feature'.length);
      expect(sections.other).toBeGreaterThan(0);
    });

    it('should report 0 for empty optional sections', () => {
      const { sections } = adapter.testBuildPromptWithSections(
        createMockAgent(),
        'task',
        createMockContext()
      );

      expect(sections.staticContext).toBe(0);
      expect(sections.dynamicContext).toBe(0);
      expect(sections.handoffContext).toBe(0);
      expect(sections.systemPrompt).toBe(0);
      expect(sections.task).toBe(4);
      expect(sumSections(sections)).toBe(sections.total);
    });

    it('should count multi-byte UTF-8 content in bytes, not characters', () => {
      const text = 'héllo 日本語 🚀';
      const { prompt, sections } = adapter.testBuildPromptWithSections(
        createMockAgent(),
        text,
        createMockContext({ additionalContext: { staticContext: text } })
      );

      expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(text.length);
      expect(sections.task).toBe(Buffer.byteLength(text, 'utf8'));
      expect(sections.staticContext).toBe(Buffer.byteLength(text, 'utf8'));
      expect(sections.total).toBe(Buffer.byteLength(prompt, 'utf8'));
      expect(sumSections(sections)).toBe(sections.total);
    });

    it('should return the same prompt text as buildPrompt', () => {
      const agent = createMockAgent({ systemPrompt: 'sys' });
      const context = createMockContext({
        additionalContext: { staticContext: 'abc', handoffContext: 'xyz' },
      });

      expect(
        adapter.testBuildPromptWithSections(agent, 'task', context).prompt
      ).toBe(adapter.testBuildPrompt(agent, 'task', context));
    });

    it('should identify the dominant section', () => {
      const { sections } = adapter.testBuildPromptWithSections(
        createMockAgent(),
        'task',
        createMockContext({
          additionalContext: { dynamicContext: 'x'.repeat(5000) },
        })
      );

      expect(dominantPromptSection(sections)).toBe('dynamicContext');
    });
  });

  describe('prompt sections on the CLI spawn path', () => {
    const request = (): ExecutionRequest => ({
      agent: createMockAgent(),
      task: 'do the thing',
      context: createMockContext({
        additionalContext: { handoffContext: 'prior stage output' },
      }),
    });

    it('should attach prompt bytes and sections to a successful result', async () => {
      const cli = new StubSpawnCliAdapter();
      await cli.init({});

      const result = await cli.execute(request());

      expect(result.success).toBe(true);
      const sections = result.metrics.promptSections;
      expect(sections).toBeDefined();
      expect(result.metrics.promptBytes).toBe(
        Buffer.byteLength(cli.spawnedPrompt ?? '', 'utf8')
      );
      expect(sections?.total).toBe(result.metrics.promptBytes);
      expect(sections?.handoffContext).toBe('prior stage output'.length);
      expect(sections?.task).toBe('do the thing'.length);
    });

    it('should attach prompt sections to a failed result', async () => {
      const cli = new StubSpawnCliAdapter();
      await cli.init({});
      cli.spawnResult = new Error('boom');

      const result = await cli.execute(request());

      expect(result.success).toBe(false);
      expect(result.metrics.promptSections?.task).toBe('do the thing'.length);
      expect(result.metrics.promptBytes).toBeGreaterThan(0);
    });
  });
});
