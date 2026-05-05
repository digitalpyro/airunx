/**
 * Adapter factory tests
 * Only subscription-based CLI providers are supported
 *
 * Note: compound-engineering is no longer a separate backend type.
 * Claude Code automatically includes Compound Engineering capabilities.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createAdapter,
  getAvailableAdapterTypes,
} from '../../src/adapters/index.js';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code-adapter.js';
import { CursorAdapter } from '../../src/adapters/cursor-adapter.js';
import { CodexAdapter } from '../../src/adapters/codex-adapter.js';
import { CompoundEngineeringAdapter } from '../../src/adapters/compound-engineering-adapter.js';
import type { ResolvedSettings } from '../../src/utils/settings.js';

/**
 * Factory function for creating type-safe mock settings
 */
const createMockSettings = (
  overrides: Partial<ResolvedSettings> = {}
): ResolvedSettings => ({
  disable_compound_engineering: false,
  default_fidelity: 'standard',
  default_backend: 'claude-code',
  skip_version_check: false,
  tool_configs: null,
  context_location: null,
  mcp_json_location: null,
  agents_md_location: null,
  pipelines_yaml_location: null,
  default_project_location: null,
  default_base_branch: null,
  _source: 'default',
  _sourceFile: 'mock/settings.json',
  resolvedPaths: {},
  resolvedToolConfigs: {},
  ...overrides,
});

// Mock the settings module
vi.mock('../../src/utils/settings.js', () => ({
  loadSettings: vi.fn(() => createMockSettings()),
}));

import { loadSettings } from '../../src/utils/settings.js';
const mockLoadSettings = vi.mocked(loadSettings);

describe('Adapter Factory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadSettings.mockReturnValue(createMockSettings());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createAdapter', () => {
    it('should create CompoundEngineeringAdapter for claude-code by default', () => {
      const adapter = createAdapter('claude-code');
      expect(adapter).toBeInstanceOf(CompoundEngineeringAdapter);
      expect(adapter.name).toBe('claude-code');
      expect(adapter.type).toBe('cli');
    });

    it('should create ClaudeCodeAdapter when disable_compound_engineering is true via injected settings', () => {
      // Use settings injection for cleaner testing without mocks
      const adapter = createAdapter('claude-code', {
        settings: createMockSettings({ disable_compound_engineering: true }),
      });
      expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
      expect(adapter.name).toBe('claude-code');
      expect(adapter.type).toBe('cli');
    });

    it('should create ClaudeCodeAdapter when disable_compound_engineering is true in loaded settings', () => {
      mockLoadSettings.mockReturnValue(
        createMockSettings({ disable_compound_engineering: true })
      );
      const adapter = createAdapter('claude-code');
      expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
      expect(adapter.name).toBe('claude-code');
      expect(adapter.type).toBe('cli');
      expect(mockLoadSettings).toHaveBeenCalledOnce();
    });

    it('should create ClaudeCodeAdapter when disableCompoundEngineering option is true', () => {
      const adapter = createAdapter('claude-code', {
        disableCompoundEngineering: true,
      });
      expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
      expect(adapter.name).toBe('claude-code');
      expect(adapter.type).toBe('cli');
    });

    it('should create CursorAdapter', () => {
      const adapter = createAdapter('cursor');
      expect(adapter).toBeInstanceOf(CursorAdapter);
      expect(adapter.name).toBe('cursor');
      expect(adapter.type).toBe('cli');
    });

    it('should create CodexAdapter', () => {
      const adapter = createAdapter('codex');
      expect(adapter).toBeInstanceOf(CodexAdapter);
      expect(adapter.name).toBe('codex');
      expect(adapter.type).toBe('cli');
    });

    it('should throw error for unknown backend', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => createAdapter('unknown' as any)).toThrow(
        'Unknown backend type'
      );
    });
  });

  describe('getAvailableAdapterTypes', () => {
    it('should return all adapter types (compound-engineering no longer separate)', () => {
      const types = getAvailableAdapterTypes();
      expect(types).toContain('claude-code');
      expect(types).toContain('cursor');
      expect(types).toContain('codex');
      expect(types).not.toContain('compound-engineering');
      expect(types).toHaveLength(3);
    });
  });
});
