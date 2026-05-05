/**
 * Tests for Settings utilities
 * Validates hierarchical settings loading and path resolution
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock modules before importing the module under test
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

// Import after mocks are set up
import {
  loadSettings,
  getDefaultAgentsMd,
  getDefaultPipelinesYaml,
  hasGlobalConfig,
  hasProjectConfig,
  getConfigLocations,
  SettingsSchema,
  clearSettingsCache,
} from '../../src/utils/settings.js';

describe('Settings Utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear the settings cache before each test to ensure isolation
    clearSettingsCache();
    // Default: no files exist
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    clearSettingsCache();
  });

  describe('SettingsSchema', () => {
    it('should validate minimal settings', () => {
      const settings = {};
      const result = SettingsSchema.parse(settings);
      expect(result.default_fidelity).toBe('standard');
      expect(result.default_backend).toBe('claude-code');
    });

    it('should validate full settings', () => {
      const settings = {
        context_location: './context.md',
        mcp_json_location: './mcp.json',
        agents_md_location: './AGENTS.md',
        pipelines_yaml_location: './pipelines.yaml',
        default_project_location: './project',
        default_fidelity: 'thorough',
        default_backend: 'cursor',
      };
      const result = SettingsSchema.parse(settings);
      expect(result.default_fidelity).toBe('thorough');
      expect(result.default_backend).toBe('cursor');
      expect(result.agents_md_location).toBe('./AGENTS.md');
    });

    it('should allow null values for path fields', () => {
      const settings = {
        context_location: null,
        mcp_json_location: null,
        agents_md_location: null,
      };
      const result = SettingsSchema.parse(settings);
      expect(result.context_location).toBeNull();
      expect(result.mcp_json_location).toBeNull();
    });

    it('should reject invalid fidelity levels', () => {
      const settings = {
        default_fidelity: 'invalid',
      };
      expect(() => SettingsSchema.parse(settings)).toThrow();
    });

    it('should reject invalid backend types', () => {
      const settings = {
        default_backend: 'invalid',
      };
      expect(() => SettingsSchema.parse(settings)).toThrow();
    });

    it('should default approval_mode to auto', () => {
      const settings = {};
      const result = SettingsSchema.parse(settings);
      expect(result.approval_mode).toBe('auto');
    });

    it('should accept valid approval_mode values', () => {
      const settings = { approval_mode: 'manual' };
      const result = SettingsSchema.parse(settings);
      expect(result.approval_mode).toBe('manual');
    });

    it('should accept yolo approval_mode', () => {
      const settings = { approval_mode: 'yolo' };
      const result = SettingsSchema.parse(settings);
      expect(result.approval_mode).toBe('yolo');
    });

    it('should reject invalid approval_mode values', () => {
      const settings = { approval_mode: 'invalid' };
      expect(() => SettingsSchema.parse(settings)).toThrow();
    });

    // Note: execution_fidelity and backends are now configured in config.yml
    // See system-config.ts for these settings
  });

  describe('loadSettings', () => {
    it('should return defaults when no settings files exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = loadSettings();

      expect(result.default_fidelity).toBe('standard');
      expect(result.default_backend).toBe('claude-code');
      expect(result._source).toBe('default');
    });

    it('should load and merge global settings', () => {
      const globalSettings = {
        default_fidelity: 'thorough',
        agents_md_location: './my-agents.md',
      };

      vi.mocked(fs.existsSync).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        return pathStr.includes('.airunx/settings.json') && pathStr.includes('/mock/home');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(globalSettings));

      const result = loadSettings();

      expect(result.default_fidelity).toBe('thorough');
      expect(result._source).toBe('global');
    });

    it('should prioritize project settings over global', () => {
      const globalSettings = {
        default_fidelity: 'thorough',
        default_backend: 'cursor',
      };
      const projectSettings = {
        default_fidelity: 'fast',
        default_backend: 'cursor',
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        if (pathStr.includes('/mock/home')) {
          return JSON.stringify(globalSettings);
        }
        return JSON.stringify(projectSettings);
      });

      const result = loadSettings();

      // Project fidelity should override global
      expect(result.default_fidelity).toBe('fast');
      // Project backend preserved
      expect(result.default_backend).toBe('cursor');
      expect(result._source).toBe('project');
    });

    it('should use defaults when project settings omit optional fields', () => {
      const projectSettings = {
        agents_md_location: './custom.md',
        // Omit default_fidelity and default_backend
      };

      vi.mocked(fs.existsSync).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        return pathStr.endsWith('settings.json') && !pathStr.includes('/mock/home');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(projectSettings));

      const result = loadSettings();

      // Zod defaults should apply
      expect(result.default_fidelity).toBe('standard');
      expect(result.default_backend).toBe('claude-code');
      expect(result.agents_md_location).toBe('./custom.md');
    });

    it('should resolve relative paths from settings file location', () => {
      const projectSettings = {
        agents_md_location: './custom/AGENTS.md',
        pipelines_yaml_location: '../shared/pipelines.yaml',
      };

      vi.mocked(fs.existsSync).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        return pathStr.endsWith('settings.json') && !pathStr.includes('/mock/home');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(projectSettings));

      const result = loadSettings();

      expect(result.resolvedPaths.agents_md).toContain('custom/AGENTS.md');
      expect(result.resolvedPaths.pipelines_yaml).toContain('shared/pipelines.yaml');
    });

    it('should use absolute paths as-is', () => {
      const projectSettings = {
        agents_md_location: '/absolute/path/AGENTS.md',
      };

      vi.mocked(fs.existsSync).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        return pathStr.endsWith('settings.json') && !pathStr.includes('/mock/home');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(projectSettings));

      const result = loadSettings();

      expect(result.resolvedPaths.agents_md).toBe('/absolute/path/AGENTS.md');
    });

    it('should fall back to global AGENTS.md if project does not specify', () => {
      vi.mocked(fs.existsSync).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        // Global AGENTS.md exists
        if (pathStr === '/mock/home/.airunx/AGENTS.md') return true;
        return false;
      });

      const result = loadSettings();

      expect(result.resolvedPaths.agents_md).toBe('/mock/home/.airunx/AGENTS.md');
    });

    it('should fall back to global pipelines.yaml if project does not specify', () => {
      vi.mocked(fs.existsSync).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        // Global pipelines.yaml exists
        if (pathStr === '/mock/home/.airunx/pipelines.yaml') return true;
        return false;
      });

      const result = loadSettings();

      expect(result.resolvedPaths.pipelines_yaml).toBe('/mock/home/.airunx/pipelines.yaml');
    });

    it('should handle null values clearing parent settings', () => {
      const globalSettings = {
        agents_md_location: './global-agents.md',
      };
      const projectSettings = {
        agents_md_location: null,
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        if (pathStr.includes('/mock/home')) {
          return JSON.stringify(globalSettings);
        }
        return JSON.stringify(projectSettings);
      });

      const result = loadSettings();

      // Null should clear the global setting
      expect(result.agents_md_location).toBeNull();
    });

    it('should handle malformed settings files gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('{ invalid json }');

      // Should not throw, should return defaults
      const result = loadSettings();
      expect(result.default_fidelity).toBe('standard');
    });
  });

  describe('getDefaultAgentsMd', () => {
    it('should return default AGENTS.md content when file exists', () => {
      const mockContent = '# Default Agents Configuration';
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(mockContent);

      const result = getDefaultAgentsMd();

      expect(result).toBe(mockContent);
    });

    it('should throw when default AGENTS.md does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(() => getDefaultAgentsMd()).toThrow('Default AGENTS.md not found in package');
    });
  });

  describe('getDefaultPipelinesYaml', () => {
    it('should return default pipelines.yaml content when file exists', () => {
      const mockContent = 'pipelines:\n  standard:\n    stages: []';
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(mockContent);

      const result = getDefaultPipelinesYaml();

      expect(result).toBe(mockContent);
    });

    it('should throw when default pipelines.yaml does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(() => getDefaultPipelinesYaml()).toThrow('Default pipelines.yaml not found in package');
    });
  });

  describe('hasGlobalConfig', () => {
    it('should return true when global settings.json exists', () => {
      vi.mocked(fs.existsSync).mockImplementation((filePath) => {
        return String(filePath).includes('/mock/home/.airunx/settings.json');
      });

      expect(hasGlobalConfig()).toBe(true);
    });

    it('should return false when global settings.json does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(hasGlobalConfig()).toBe(false);
    });
  });

  describe('hasProjectConfig', () => {
    it('should return true when project settings.json exists', () => {
      vi.mocked(fs.existsSync).mockImplementation((filePath) => {
        return String(filePath).endsWith('.airunx/settings.json') &&
               !String(filePath).includes('/mock/home');
      });

      expect(hasProjectConfig()).toBe(true);
    });

    it('should return false when project settings.json does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(hasProjectConfig()).toBe(false);
    });

    it('should check custom project directory', () => {
      vi.mocked(fs.existsSync).mockImplementation((filePath) => {
        return String(filePath) === '/custom/project/.airunx/settings.json';
      });

      expect(hasProjectConfig('/custom/project')).toBe(true);
    });
  });

  describe('getConfigLocations', () => {
    it('should return all config locations', () => {
      const locations = getConfigLocations();

      expect(locations.packageDefault).toContain('config/default/settings.json');
      expect(locations.global).toBe('/mock/home/.airunx/settings.json');
      expect(locations.project).toContain('.airunx/settings.json');
    });

    it('should use custom project directory', () => {
      const locations = getConfigLocations('/custom/project');

      expect(locations.project).toBe('/custom/project/.airunx/settings.json');
    });
  });

  // Note: deep merge tests for backends and execution_fidelity removed
  // These settings are now configured in config.yml (see system-config.ts)
});
