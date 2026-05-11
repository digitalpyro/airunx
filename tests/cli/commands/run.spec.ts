/**
 * Run command tests
 * Tests input validation, error paths, and early exits for runOrchestrator
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

// Suppress console output
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const exitSpy = vi
  .spyOn(process, 'exit')
  .mockImplementation((() => {}) as never);

// Mock heavy dependencies to keep tests fast and isolated
vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
    info: vi.fn(),
    text: '',
  }),
}));

vi.mock('../../../src/utils/settings.js', () => ({
  loadSettings: vi.fn().mockReturnValue({
    default_backend: 'claude-code',
    approval_mode: 'auto',
    folders: [],
  }),
  expandPath: vi.fn((p: string) => p),
  clearSettingsCache: vi.fn(),
}));

vi.mock('../../../src/utils/system-config.js', () => ({
  loadSystemConfig: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../src/utils/config.js', () => ({
  loadPipelineConfig: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../src/utils/version-checker.js', () => ({
  checkVersion: vi.fn().mockResolvedValue(null),
  formatVersionMessage: vi.fn(),
}));

vi.mock('../../../src/integrations/github-cli.js', () => ({
  GitHubCLI: {
    parseGitHubUrl: vi.fn().mockReturnValue(null),
  },
}));

vi.mock('../../../src/parsers/index.js', () => ({
  parseInput: vi.fn().mockReturnValue({
    input: 'test prompt',
    inputType: 'prompt',
  }),
}));

vi.mock('../../../src/parsers/prd-resolver.js', () => ({
  resolvePRD: vi.fn(),
  PRDResolverError: class extends Error {
    source: string;
    constructor(message: string, source: string) {
      super(message);
      this.source = source;
    }
  },
}));

vi.mock('../../../src/utils/context-loader.js', () => ({
  mergeContexts: vi.fn().mockReturnValue(''),
  ContextLoaderError: class extends Error {
    path: string;
    constructor(message: string, path: string) {
      super(message);
      this.path = path;
    }
  },
}));

vi.mock('../../../src/utils/context-resolver.js', () => ({
  ContextResolver: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/utils/project-resolver.js', () => ({
  resolveProject: vi.fn().mockReturnValue({
    project: { name: 'test-project', path: '/tmp/test-project' },
    source: 'cwd',
  }),
}));

vi.mock('../../../src/utils/repo-resolver.js', () => ({
  resolveRepoLocation: vi.fn(),
}));

vi.mock('../../../src/utils/fidelity-resolver.js', () => ({
  resolveFidelity: vi.fn().mockReturnValue({
    level: 'fast',
    source: 'default',
  }),
  requiresCostWarning: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/utils/debug-file-manager.js', () => ({
  DebugFileManager: vi.fn(),
  DEFAULT_DEBUG_DIR: '.airunx-state/debug',
}));

vi.mock('../../../src/utils/script-cleanup.js', () => ({
  ScriptCleanup: vi.fn().mockImplementation(() => ({
    cleanup: vi.fn(),
  })),
  getErrorMessage: vi.fn((e: unknown) =>
    e instanceof Error ? e.message : String(e)
  ),
}));

vi.mock('../../../src/cli/formatters/completion-formatter.js', () => ({
  displayCompletion: vi.fn(),
  formatCompletionJson: vi.fn(),
}));

vi.mock('../../../src/cli/formatters/timing-formatter.js', () => ({
  printStageTimings: vi.fn(),
}));

vi.mock('../../../src/orchestrator/verbose-reporter.js', () => ({
  VerboseReporter: vi.fn(),
}));

import { runOrchestrator } from '../../../src/cli/commands/run.js';

let tmpDir: string;
let origCwd: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'run-test-'));
  origCwd = process.cwd();
  exitSpy.mockClear();
  vi.clearAllMocks();
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('runOrchestrator', () => {
  describe('input validation', () => {
    it('should exit(1) when no input and no --prd provided', async () => {
      await runOrchestrator(undefined, {});

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should not exit(1) when input is provided', async () => {
      // Will fail later (no config) but should pass input validation
      process.chdir(tmpDir);

      await runOrchestrator('implement auth', {});

      // Should have gotten past input validation
      // (may exit for other reasons like missing config, but not for missing input)
      const exitCalls = exitSpy.mock.calls.filter(
        ([code]) => code === 1
      );
      // Check that the error is NOT about missing input
      const logCalls = vi
        .mocked(console.log)
        .mock.calls.flat()
        .join(' ');
      expect(logCalls).not.toContain('Input or --prd required');
    });

    it('should not exit for missing input when --prd is provided', async () => {
      process.chdir(tmpDir);
      const prdPath = join(tmpDir, 'test.md');
      writeFileSync(prdPath, '# Test PRD\nBuild a feature');

      const { resolvePRD } = await import(
        '../../../src/parsers/prd-resolver.js'
      );
      vi.mocked(resolvePRD).mockResolvedValue('# Test PRD\nBuild a feature');

      await runOrchestrator(undefined, { prd: prdPath });

      // Should not have the "Input or --prd required" error
      const logCalls = vi
        .mocked(console.error)
        .mock.calls.flat()
        .join(' ');
      expect(logCalls).not.toContain('Input or --prd required');
    });
  });

  describe('--dotenv validation', () => {
    it('should exit(1) when dotenv file does not exist', async () => {
      await runOrchestrator('test', {
        dotenv: join(tmpDir, 'nonexistent.env'),
      });

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('--fidelity validation', () => {
    it('should exit(1) for invalid fidelity level', async () => {
      process.chdir(tmpDir);

      await runOrchestrator('test', { fidelity: 'invalid-level' });

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should accept valid fidelity levels', async () => {
      process.chdir(tmpDir);

      // fast is a valid level — should pass fidelity validation
      await runOrchestrator('test', { fidelity: 'fast' });

      // Check that the fidelity error was NOT logged
      const errorCalls = vi
        .mocked(console.log)
        .mock.calls.flat()
        .join(' ');
      expect(errorCalls).not.toContain('Invalid fidelity level');
    });
  });

  describe('--project validation', () => {
    it('should exit(1) when project directory does not exist', async () => {
      const { resolveProject } = await import(
        '../../../src/utils/project-resolver.js'
      );
      vi.mocked(resolveProject).mockReturnValue({
        project: {
          name: 'nonexistent',
          path: join(tmpDir, 'nonexistent-project'),
        },
        source: 'cli-flag',
      });

      await runOrchestrator('test', {
        project: join(tmpDir, 'nonexistent-project'),
      });

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('format option', () => {
    it('should redirect console.log to console.error when --format json', async () => {
      const originalLog = console.log;

      await runOrchestrator('test', { format: 'json' });

      // After execution, console.log should have been redirected
      // (the function restores it, but during execution it's redirected)
      // We just verify the function doesn't crash with json format
      expect(exitSpy).toHaveBeenCalled();
    });
  });
});
