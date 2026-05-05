/**
 * Tests for display-hierarchy utility
 * Validates configuration hierarchy display formatting
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';

// Mock modules before importing the module under test
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

// Import after mocks are set up
import { displayConfigHierarchy } from '../../src/utils/display-hierarchy.js';
import type { ResolvedSettings } from '../../src/utils/settings.js';

// Create mock settings that satisfy ResolvedSettings interface
function createMockSettings(
  overrides: Partial<ResolvedSettings> = {}
): ResolvedSettings {
  return {
    default_fidelity: 'standard',
    default_backend: 'claude-code',
    skip_version_check: false,
    disable_compound_engineering: false,
    _source: 'project',
    _sourceFile: '/mock/project/.airunx/settings.json',
    resolvedPaths: {},
    resolvedToolConfigs: {},
    ...overrides,
  };
}

describe('displayConfigHierarchy', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Default: no files exist
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('displays all three config levels', () => {
    displayConfigHierarchy(createMockSettings());

    const allOutput = consoleSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(allOutput).toContain('Project:');
    expect(allOutput).toContain('Global:');
    expect(allOutput).toContain('Default:');
  });

  it('shows existence indicators when showExistence is true', () => {
    // Project config exists, others don't
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return String(path).includes('.airunx/settings.json');
    });

    displayConfigHierarchy(createMockSettings(), { showExistence: true });

    const allOutput = consoleSpy.mock.calls.map((call) => call[0]).join('\n');
    // Should contain check mark for existing config
    expect(allOutput).toContain('✓');
    // Should contain X for non-existing configs
    expect(allOutput).toContain('✗');
  });

  it('shows default project when configured', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    displayConfigHierarchy(
      createMockSettings({
        default_project_location: '/path/to/my-project',
      })
    );

    const allOutput = consoleSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(allOutput).toContain('Default Project');
    expect(allOutput).toContain('/path/to/my-project');
    expect(allOutput).toContain('✓ exists');
  });

  it('shows path not found for non-existent default project', () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      // Config files exist, but the project path doesn't
      return String(path).includes('settings.json');
    });

    displayConfigHierarchy(
      createMockSettings({
        default_project_location: '/nonexistent/project',
      })
    );

    const allOutput = consoleSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(allOutput).toContain('Default Project');
    expect(allOutput).toContain('✗ path not found');
  });

  it('does not show default project when not configured', () => {
    displayConfigHierarchy(createMockSettings());

    const allOutput = consoleSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(allOutput).not.toContain('Default Project');
  });

  it('shows project folders when configured with object format', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    displayConfigHierarchy(
      createMockSettings({
        folders: [
          { name: 'frontend', path: '/path/to/frontend' },
          { name: 'backend', path: '/path/to/backend' },
        ],
      })
    );

    const allOutput = consoleSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(allOutput).toContain('Project Folders: 2 configured');
    expect(allOutput).toContain('frontend');
    expect(allOutput).toContain('backend');
    expect(allOutput).toContain('/path/to/frontend');
    expect(allOutput).toContain('/path/to/backend');
  });

  it('shows project folders when configured with string format', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    displayConfigHierarchy(
      createMockSettings({
        folders: ['/path/to/project1', '/path/to/project2'],
      })
    );

    const allOutput = consoleSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(allOutput).toContain('Project Folders: 2 configured');
    expect(allOutput).toContain('/path/to/project1');
    expect(allOutput).toContain('/path/to/project2');
  });

  it('shows existence indicators for project folders', () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      // First folder exists, second doesn't
      return String(path).includes('frontend');
    });

    displayConfigHierarchy(
      createMockSettings({
        folders: [
          { name: 'frontend', path: '/path/to/frontend' },
          { name: 'backend', path: '/path/to/backend' },
        ],
      })
    );

    const allOutput = consoleSpy.mock.calls.map((call) => call[0]).join('\n');
    // Frontend exists
    expect(allOutput).toMatch(/frontend.*✓/);
    // Backend doesn't exist
    expect(allOutput).toMatch(/backend.*✗/);
  });

  it('does not show project folders when not configured', () => {
    displayConfigHierarchy(createMockSettings());

    const allOutput = consoleSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(allOutput).not.toContain('Project Folders');
  });

  it('does not show project folders when array is empty', () => {
    displayConfigHierarchy(
      createMockSettings({
        folders: [],
      })
    );

    const allOutput = consoleSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(allOutput).not.toContain('Project Folders');
  });

  it('respects showProjects option when false', () => {
    displayConfigHierarchy(
      createMockSettings({
        default_project_location: '/path/to/project',
        folders: [{ name: 'test', path: '/path/to/test' }],
      }),
      { showProjects: false }
    );

    const allOutput = consoleSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(allOutput).not.toContain('Default Project');
    expect(allOutput).not.toContain('Project Folders');
  });

  it('shows Configuration Hierarchy header', () => {
    displayConfigHierarchy(createMockSettings());

    const allOutput = consoleSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(allOutput).toContain('Configuration Hierarchy');
    expect(allOutput).toContain('Priority (highest to lowest)');
  });

  describe('projectDir option', () => {
    // Helper functions to reduce duplication
    const getConsoleOutput = () =>
      consoleSpy.mock.calls.map((call) => call[0]).join('\n');
    const getExpectedPath = (dir: string) => `${dir}/.airunx/settings.json`;
    // Escape special regex characters in paths for robust matching
    const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const getProjectLineRegex = (path: string) =>
      new RegExp(`1\\. Project:.*${escapeRegExp(path)}`);
    const getGlobalLineRegex = (path: string) =>
      new RegExp(`2\\. Global:.*${escapeRegExp(path)}`);

    it('uses provided projectDir for project config path', () => {
      const customProjectDir = '/custom/user/project';
      displayConfigHierarchy(createMockSettings(), {
        projectDir: customProjectDir,
      });

      const allOutput = getConsoleOutput();
      const expectedPath = getExpectedPath(customProjectDir);
      expect(allOutput).toMatch(getProjectLineRegex(expectedPath));
    });

    it('does not show package installation path when projectDir is provided', () => {
      const userProjectDir = '/home/user/my-app';
      displayConfigHierarchy(createMockSettings(), {
        projectDir: userProjectDir,
      });

      const allOutput = getConsoleOutput();
      const expectedPath = getExpectedPath(userProjectDir);
      expect(allOutput).toMatch(getProjectLineRegex(expectedPath));
      expect(allOutput).not.toContain('node_modules');
    });

    it('shows correct paths for all hierarchy levels with custom projectDir', () => {
      const userProjectDir = '/home/user/workspace/my-project';
      displayConfigHierarchy(createMockSettings(), {
        projectDir: userProjectDir,
      });

      const allOutput = getConsoleOutput();
      expect(allOutput).toContain('1. Project:');
      expect(allOutput).toContain('2. Global:');
      expect(allOutput).toContain('3. Default:');

      const expectedProjectPath = getExpectedPath(userProjectDir);
      expect(allOutput).toMatch(getProjectLineRegex(expectedProjectPath));

      const expectedGlobalPath = getExpectedPath('/mock/home');
      expect(allOutput).toMatch(getGlobalLineRegex(expectedGlobalPath));
    });
  });
});
