/**
 * Init command tests
 * Tests initCommand input validation, error paths, dotenv handling,
 * and the non-interactive helper functions (path validation, workspace discovery, etc.)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

// Suppress console output
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const exitSpy = vi
  .spyOn(process, 'exit')
  .mockImplementation((() => {}) as never);

// Mock ora spinner
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

// Mock inquirer to prevent interactive prompts
vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn().mockResolvedValue({
      confirmReset: false,
      defaultBackend: 'claude-code',
      defaultFidelity: 'standard',
      contextSource: 'skip',
    }),
  },
}));

// Mock banner
vi.mock('../../../src/utils/banner.js', () => ({
  displayBanner: vi.fn(),
  getPackageVersion: vi.fn().mockReturnValue('0.1.2'),
}));

// Mock paths
vi.mock('../../../src/utils/paths.js', () => ({
  getPackageDefaultDir: vi
    .fn()
    .mockReturnValue('/tmp/test-package/config/default'),
  getPackageVersion: vi.fn().mockReturnValue('0.1.2'),
  resolveAgentsMdPath: vi.fn().mockReturnValue(null),
}));

// Mock settings
vi.mock('../../../src/utils/settings.js', () => ({
  loadSettings: vi.fn().mockReturnValue({
    default_backend: 'claude-code',
    folders: [],
  }),
  expandPath: vi.fn((p: string) => p),
  clearSettingsCache: vi.fn(),
}));

// Mock system config
vi.mock('../../../src/utils/system-config.js', () => ({
  generateDefaultConfig: vi.fn().mockReturnValue('# generated config'),
  saveSystemConfig: vi.fn(),
}));

// Mock backend validator
vi.mock('../../../src/adapters/backend-validator.js', () => ({
  BackendValidator: vi.fn().mockImplementation(() => ({
    validateBackends: vi.fn().mockResolvedValue({
      'claude-code': { available: true, version: '2.0.0' },
      cursor: { available: false },
      codex: { available: false },
    }),
  })),
}));

vi.mock('../../../src/adapters/constants.js', () => ({
  toDisplayName: vi.fn((name: string) => name),
}));

vi.mock('../../../src/utils/error-handlers.js', () => ({
  handleCommandError: vi.fn(),
}));

vi.mock('../../../src/utils/display-hierarchy.js', () => ({
  displayConfigHierarchy: vi.fn(),
}));

vi.mock('../../../src/utils/agents-validator.js', () => ({
  validateAgentsMdWithConfirmation: vi.fn().mockResolvedValue({ valid: true }),
  formatAgentsValidationResult: vi.fn(),
}));

vi.mock('../../../src/utils/fidelity-resolver.js', () => ({
  getAllFidelityCostEstimates: vi.fn().mockReturnValue({}),
  FIDELITY_DESCRIPTIONS: {
    fast: 'Fast',
    standard: 'Standard',
    thorough: 'Thorough',
    ultra: 'Ultra',
  },
  FIDELITY_USE_CASES: {
    fast: 'Quick iterations',
    standard: 'Most features',
    thorough: 'Critical features',
    ultra: 'Mission critical',
  },
}));

vi.mock('../../../src/utils/workspace-loader.js', () => ({
  parseWorkspaceFolders: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/utils/json-utils.js', () => ({
  parseJsonc: vi.fn((content: string) => JSON.parse(content)),
}));

import { initCommand } from '../../../src/cli/commands/init.js';

let tmpDir: string;
let origCwd: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'init-test-'));
  origCwd = process.cwd();
  exitSpy.mockClear();
  vi.clearAllMocks();
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('initCommand', () => {
  describe('--dotenv validation', () => {
    it('should exit(1) when dotenv file does not exist', async () => {
      process.chdir(tmpDir);

      await initCommand({ dotenv: join(tmpDir, 'nonexistent.env') });

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should exit(1) when dotenv path is a directory', async () => {
      const dirPath = join(tmpDir, 'envdir');
      mkdirSync(dirPath);
      process.chdir(tmpDir);

      await initCommand({ dotenv: dirPath });

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should load dotenv file when it exists', async () => {
      const envPath = join(tmpDir, 'test.env');
      writeFileSync(envPath, 'TEST_VAR=hello');
      process.chdir(tmpDir);

      await initCommand({ dotenv: envPath });

      // Should not have exited for dotenv error
      const errorCalls = vi
        .mocked(console.error)
        .mock.calls.flat()
        .join(' ');
      expect(errorCalls).not.toContain('Environment file not found');
    });
  });

  describe('--reset flag', () => {
    it('should prompt for confirmation when reset is true', async () => {
      process.chdir(tmpDir);
      const inquirer = await import('inquirer');

      await initCommand({ reset: true });

      expect(inquirer.default.prompt).toHaveBeenCalled();
    });

    it('should not delete state when user cancels reset', async () => {
      process.chdir(tmpDir);
      const statePath = join(tmpDir, '.airunx-state');
      mkdirSync(statePath, { recursive: true });
      writeFileSync(join(statePath, 'test.json'), '{}');

      const inquirer = await import('inquirer');
      vi.mocked(inquirer.default.prompt).mockResolvedValueOnce({
        confirmReset: false,
      });

      await initCommand({ reset: true });

      // State directory should still exist
      expect(existsSync(statePath)).toBe(true);
    });
  });

  describe('no backends available', () => {
    it('should exit(1) when no backends are available', async () => {
      process.chdir(tmpDir);

      const { BackendValidator } = await import(
        '../../../src/adapters/backend-validator.js'
      );
      vi.mocked(BackendValidator).mockImplementationOnce(
        () =>
          ({
            validateBackends: vi.fn().mockResolvedValue({
              'claude-code': { available: false },
              cursor: { available: false },
              codex: { available: false },
            }),
          }) as never
      );

      await initCommand({});

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('--from-workspace validation', () => {
    it('should exit(1) when workspace file does not exist', async () => {
      process.chdir(tmpDir);

      await initCommand({ fromWorkspace: join(tmpDir, 'nonexistent.code-workspace') });

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
