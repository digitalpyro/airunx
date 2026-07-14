/**
 * CursorAdapter tests
 * Validates CLI argument construction for the Cursor CLI
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CursorAdapter } from '../../src/adapters/cursor-adapter.js';
import { DEFAULT_MODELS } from '../../src/adapters/constants.js';
import type { ExecutionRequest } from '../../src/core/adapter-types.js';

// Create a test subclass to access protected methods
class TestableCursorAdapter extends CursorAdapter {
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

describe('CursorAdapter', () => {
  let adapter: TestableCursorAdapter;

  beforeEach(() => {
    adapter = new TestableCursorAdapter();
  });

  describe('buildCliArgs', () => {
    it('should default --model to DEFAULT_MODELS.OPENAI when no preferred model is set', () => {
      const request = createMockRequest();

      const args = adapter.testBuildCliArgs(request, 'test prompt');

      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe(DEFAULT_MODELS.OPENAI);
      expect(args[args.indexOf('--model') + 1]).toBe('gpt-5.6-terra');
    });

    it('should use the agent preferred model when set', () => {
      const request = createMockRequest({
        agent: {
          role: 'developer',
          capabilities: [],
          contextRequired: [],
          preferredModel: 'gpt-5.6-luna',
        },
      });

      const args = adapter.testBuildCliArgs(request, 'test prompt');

      expect(args[args.indexOf('--model') + 1]).toBe('gpt-5.6-luna');
    });

    it('should pass the prompt via -p', () => {
      const request = createMockRequest();

      const args = adapter.testBuildCliArgs(request, 'test prompt');

      expect(args).toContain('-p');
      expect(args[args.indexOf('-p') + 1]).toBe('test prompt');
    });
  });
});
