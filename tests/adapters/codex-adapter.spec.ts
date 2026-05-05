/**
 * CodexAdapter tests
 * Validates CLI argument construction for OpenAI Codex CLI
 */

import * as path from 'path';
import { describe, it, expect, beforeEach } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex-adapter.js';
import type { ExecutionRequest } from '../../src/core/adapter-types.js';

// Create a test subclass to access protected methods
class TestableCodexAdapter extends CodexAdapter {
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

describe('CodexAdapter', () => {
  let adapter: TestableCodexAdapter;

  beforeEach(() => {
    adapter = new TestableCodexAdapter();
  });

  describe('buildCliArgs', () => {
    it('should include exec subcommand as first argument', () => {
      const request = createMockRequest({
        context: { workingDirectory: '/test/path' },
      });

      const args = adapter.testBuildCliArgs(request, 'test prompt');

      expect(args[0]).toBe('exec');
    });

    it('should use -C flag for working directory', () => {
      const request = createMockRequest({
        context: { workingDirectory: '/test/path' },
      });

      const args = adapter.testBuildCliArgs(request, 'test prompt');

      expect(args).toContain('-C');
      expect(args[args.indexOf('-C') + 1]).toBe('/test/path');
    });

    it('should include -- separator before prompt', () => {
      const request = createMockRequest({
        context: { workingDirectory: '/test/path' },
      });

      const args = adapter.testBuildCliArgs(request, 'test prompt');
      const separatorIndex = args.indexOf('--');

      expect(separatorIndex).toBeGreaterThan(0);
      expect(args[separatorIndex + 1]).toBe('test prompt');
    });

    it('should produce correct argument order: exec -C <path> [approval-flags] -- <prompt>', () => {
      const request = createMockRequest({
        context: { workingDirectory: '/test/path' },
      });

      const args = adapter.testBuildCliArgs(request, 'test prompt');

      // Default approval_mode is 'auto', which adds '--full-auto' flag
      // No --model flag when no explicit model override — let CLI use its own default
      expect(args).toEqual([
        'exec',
        '-C',
        '/test/path',
        '--json',
        '--full-auto',
        '--',
        'test prompt',
      ]);
    });

    it('should handle relative paths by normalizing to absolute', () => {
      const request = createMockRequest({
        context: { workingDirectory: './relative/path' },
      });

      const args = adapter.testBuildCliArgs(request, 'test prompt');
      const pathArg = args[args.indexOf('-C') + 1];

      expect(path.isAbsolute(pathArg)).toBe(true);
    });

    it('should fallback to process.cwd() when workingDirectory is undefined', () => {
      // @ts-expect-error Testing fallback for undefined workingDirectory, which the type disallows
      const request = createMockRequest({
        context: { workingDirectory: undefined },
      });

      const args = adapter.testBuildCliArgs(request, 'test prompt');
      const pathArg = args[args.indexOf('-C') + 1];

      expect(pathArg).toBe(process.cwd());
    });

    it('should handle prompts with special characters', () => {
      const request = createMockRequest({
        context: { workingDirectory: '/test/path' },
      });
      const specialPrompt = 'test with "quotes" and \'single quotes\' and $vars';

      const args = adapter.testBuildCliArgs(request, specialPrompt);

      expect(args[args.indexOf('--') + 1]).toBe(specialPrompt);
    });

    it('should handle paths with spaces by normalizing', () => {
      const request = createMockRequest({
        context: { workingDirectory: '/path/with spaces/test' },
      });

      const args = adapter.testBuildCliArgs(request, 'test prompt');
      const pathArg = args[args.indexOf('-C') + 1];

      expect(pathArg).toBe('/path/with spaces/test');
    });
  });

  describe('adapter properties', () => {
    it('should have name set to codex', () => {
      expect(adapter.name).toBe('codex');
    });

    it('should have type set to cli', () => {
      expect(adapter.type).toBe('cli');
    });
  });
});
