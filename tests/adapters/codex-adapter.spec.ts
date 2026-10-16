/**
 * CodexAdapter tests
 * Validates CLI argument construction for OpenAI Codex CLI
 */

import * as path from 'path';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex-adapter.js';
import type {
  ExecutionRequest,
  ExecutionResult,
} from '../../src/core/adapter-types.js';

// Create a test subclass to access protected methods
class TestableCodexAdapter extends CodexAdapter {
  public testBuildCliArgs(request: ExecutionRequest, prompt: string): string[] {
    return this.buildCliArgs(request, prompt);
  }

  public setBackendModel(model: string): void {
    this.config = { ...this.config, model } as typeof this.config;
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

  describe('execute model fallback', () => {
    const baseExecute = Object.getPrototypeOf(CodexAdapter.prototype) as {
      execute: (request: ExecutionRequest) => Promise<ExecutionResult>;
    };

    const result = (success: boolean, stderr = ''): ExecutionResult => ({
      success,
      outputs: { stdout: success ? 'OK' : '', stderr },
      metrics: { tokensUsed: 0, duration: 0 },
      errors: [],
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('retries without --model when an older Codex CLI rejects a GPT-6 model', async () => {
      // Exact error text from Codex CLI 0.144.5 on a ChatGPT login
      const rejection =
        'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account."}}';
      const spy = vi
        .spyOn(baseExecute, 'execute')
        .mockResolvedValueOnce(result(false, rejection))
        .mockResolvedValueOnce(result(true));

      const outcome = await adapter.execute(
        createMockRequest({ agent: { preferredModel: 'gpt-6.1-sol' } })
      );

      expect(outcome.success).toBe(true);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[0][0].agent.preferredModel).toBe('gpt-6.1-sol');
      expect(spy.mock.calls[1][0].agent.preferredModel).toBeUndefined();
    });

    it('omits --model on retry even when the backend config sets a model', async () => {
      adapter.setBackendModel('gpt-6.1-sol');
      const spy = vi
        .spyOn(baseExecute, 'execute')
        .mockResolvedValueOnce(
          result(false, "The 'gpt-6.1-sol' model is not supported")
        )
        .mockResolvedValueOnce(result(true));

      await adapter.execute(createMockRequest());

      const firstArgs = adapter.testBuildCliArgs(spy.mock.calls[0][0], 'p');
      const retryArgs = adapter.testBuildCliArgs(spy.mock.calls[1][0], 'p');
      expect(firstArgs).toContain('--model');
      expect(retryArgs).not.toContain('--model');
    });

    it('does not retry on unrelated failures', async () => {
      const spy = vi
        .spyOn(baseExecute, 'execute')
        .mockResolvedValueOnce(result(false, 'network timeout'));

      const outcome = await adapter.execute(
        createMockRequest({ agent: { preferredModel: 'gpt-6.1-sol' } })
      );

      expect(outcome.success).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
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
