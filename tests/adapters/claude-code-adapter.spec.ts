/**
 * ClaudeCodeAdapter tests
 * Validates CLI argument construction for Claude Code CLI
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code-adapter.js';
import {
  AGENT_DISALLOWED_TOOLS,
  ORCHESTRATOR_DISALLOWED_TOOLS,
} from '../../src/adapters/constants.js';
import { AgentRoleSchema } from '../../src/core/types.js';
import type { ExecutionRequest } from '../../src/core/adapter-types.js';

// Create a test subclass to access protected methods
class TestableClaudeCodeAdapter extends ClaudeCodeAdapter {
  public testBuildCliArgs(request: ExecutionRequest, prompt: string): string[] {
    return this.buildCliArgs(request, prompt);
  }
}

/**
 * Factory function for creating type-safe mock execution requests
 * Uses destructuring to separate nested objects for proper deep merging
 */
const createMockRequest = (
  overrides: Partial<ExecutionRequest> = {}
): ExecutionRequest => {
  const baseRequest: ExecutionRequest = {
    agent: {
      role: 'developer',
      capabilities: [],
      contextRequired: [],
    },
    task: 'test task',
    context: {
      workingDirectory: '/test/path',
    },
  };

  const { agent, context, ...rest } = overrides;

  return {
    ...baseRequest,
    ...rest,
    agent: { ...baseRequest.agent, ...agent },
    context: { ...baseRequest.context, ...context },
  };
};

describe('ClaudeCodeAdapter', () => {
  let adapter: TestableClaudeCodeAdapter;

  beforeEach(() => {
    adapter = new TestableClaudeCodeAdapter();
  });

  describe('buildCliArgs', () => {
    it('should include -p flag for print mode', () => {
      const request = createMockRequest();
      const args = adapter.testBuildCliArgs(request, 'test prompt');

      expect(args).toContain('-p');
    });

    it('should include --output-format json', () => {
      const request = createMockRequest();
      const args = adapter.testBuildCliArgs(request, 'test prompt');

      expect(args).toContain('--output-format');
      expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    });

    it('should include --no-session-persistence', () => {
      const request = createMockRequest();
      const args = adapter.testBuildCliArgs(request, 'test prompt');

      expect(args).toContain('--no-session-persistence');
    });

    it('should place prompt as the last argument', () => {
      const request = createMockRequest();
      const prompt = 'test prompt';
      const args = adapter.testBuildCliArgs(request, prompt);

      expect(args[args.length - 1]).toBe(prompt);
    });

    it('should handle prompts with special characters', () => {
      const request = createMockRequest();
      const specialPrompt =
        'test with "quotes" and \'single quotes\' and $vars';
      const args = adapter.testBuildCliArgs(request, specialPrompt);

      expect(args[args.length - 1]).toBe(specialPrompt);
    });
  });

  describe('disallowed tools for non-orchestrator agents', () => {
    // Dynamically derive non-orchestrator roles from the schema
    const nonOrchestratorRoles = AgentRoleSchema.options.filter(
      (role) => role !== 'orchestrator'
    );

    it.each(nonOrchestratorRoles)(
      'adds --disallowedTools for non-orchestrator role: %s',
      (role) => {
        const request = createMockRequest({ agent: { role } });
        const args = adapter.testBuildCliArgs(request, 'test prompt');

        expect(args).toContain('--disallowedTools');
        const toolsIndex = args.indexOf('--disallowedTools');
        expect(args[toolsIndex + 1]).toBe(AGENT_DISALLOWED_TOOLS.join(','));
      }
    );

    it('adds ORCHESTRATOR_DISALLOWED_TOOLS for orchestrator role', () => {
      const request = createMockRequest({ agent: { role: 'orchestrator' } });
      const args = adapter.testBuildCliArgs(request, 'test prompt');

      expect(args).toContain('--disallowedTools');
      const toolsIndex = args.indexOf('--disallowedTools');
      expect(args[toolsIndex + 1]).toBe(
        ORCHESTRATOR_DISALLOWED_TOOLS.join(',')
      );
    });
  });

  describe('adapter properties', () => {
    it('should have name set to claude-code', () => {
      expect(adapter.name).toBe('claude-code');
    });

    it('should have type set to cli', () => {
      expect(adapter.type).toBe('cli');
    });
  });
});
