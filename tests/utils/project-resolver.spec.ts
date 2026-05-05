/**
 * Tests for Project Resolver utilities
 * Validates intelligent project detection chain for multi-project workflows
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseProjectFolders,
  resolveProject,
  getAvailableProjects,
  type ProjectFolder,
  type ResolveProjectOptions,
} from '../../src/utils/project-resolver.js';
import type { Settings, ResolvedSettings } from '../../src/utils/settings.js';

// Mock fs functions to return true/directory for all paths in tests
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
  };
});

// Helper to create minimal ResolvedSettings for testing
function createSettings(
  overrides: Partial<Settings> & { resolvedProjectPath?: string } = {}
): ResolvedSettings {
  const { resolvedProjectPath, ...settingsOverrides } = overrides;
  return {
    default_fidelity: 'standard',
    default_backend: 'claude-code',
    skip_version_check: false,
    disable_compound_engineering: false,
    ...settingsOverrides,
    // ResolvedSettings-specific fields
    _source: 'default',
    _sourceFile: '/mock/settings.json',
    resolvedPaths: {
      project: resolvedProjectPath,
    },
    resolvedToolConfigs: {},
  };
}

describe('Project Resolver', () => {
  describe('parseProjectFolders', () => {
    it('should return empty array when folders is undefined', () => {
      const settings = createSettings();
      const result = parseProjectFolders(settings);
      expect(result).toEqual([]);
    });

    it('should parse string paths into ProjectFolder objects', () => {
      const settings = createSettings({
        folders: ['/home/user/project-a', '/home/user/project-b'],
      });
      const result = parseProjectFolders(settings);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: 'project-a',
        path: '/home/user/project-a',
      });
      expect(result[1]).toEqual({
        name: 'project-b',
        path: '/home/user/project-b',
      });
    });

    it('should parse object entries with name and path', () => {
      const settings = createSettings({
        folders: [
          { name: 'My Project', path: '/home/user/my-project' },
          { name: 'Other', path: '/home/user/other-project' },
        ],
      });
      const result = parseProjectFolders(settings);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: 'My Project',
        path: '/home/user/my-project',
      });
      expect(result[1]).toEqual({
        name: 'Other',
        path: '/home/user/other-project',
      });
    });

    it('should use basename as name when object entry has no name', () => {
      const settings = createSettings({
        folders: [{ path: '/home/user/unnamed-project' }],
      });
      const result = parseProjectFolders(settings);
      expect(result[0]).toEqual({
        name: 'unnamed-project',
        path: '/home/user/unnamed-project',
      });
    });

    it('should handle mixed string and object entries', () => {
      const settings = createSettings({
        folders: [
          '/home/user/string-path',
          { name: 'Named Project', path: '/home/user/named' },
          { path: '/home/user/unnamed' },
        ],
      });
      const result = parseProjectFolders(settings);
      expect(result).toHaveLength(3);
      expect(result[0].name).toBe('string-path');
      expect(result[1].name).toBe('Named Project');
      expect(result[2].name).toBe('unnamed');
    });

    it('should resolve relative string paths from settings file location', () => {
      const settings: ResolvedSettings = {
        ...createSettings({
          folders: ['./relative-project', '../sibling-project'],
        }),
        _sourceFile: '/home/user/.airunx/settings.json',
      };
      const result = parseProjectFolders(settings);
      expect(result).toHaveLength(2);
      expect(result[0].path).toBe('/home/user/.airunx/relative-project');
      expect(result[1].path).toBe('/home/user/sibling-project');
    });

    it('should resolve relative object paths from settings file location', () => {
      const settings: ResolvedSettings = {
        ...createSettings({
          folders: [
            { name: 'My App', path: './projects/my-app' },
            { path: '../other/project' },
          ],
        }),
        _sourceFile: '/config/dir/settings.json',
      };
      const result = parseProjectFolders(settings);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: 'My App',
        path: '/config/dir/projects/my-app',
      });
      expect(result[1]).toEqual({
        name: 'project',
        path: '/config/other/project',
      });
    });

    it('should not modify absolute paths', () => {
      const settings: ResolvedSettings = {
        ...createSettings({
          folders: [
            '/absolute/path',
            { path: '/another/absolute' },
            './relative',
          ],
        }),
        _sourceFile: '/home/user/settings.json',
      };
      const result = parseProjectFolders(settings);
      expect(result[0].path).toBe('/absolute/path');
      expect(result[1].path).toBe('/another/absolute');
      expect(result[2].path).toBe('/home/user/relative');
    });

    it('should throw error on duplicate project names (same basename)', () => {
      const settings = createSettings({
        folders: ['/path/to/app', '/other/path/app'],
      });
      expect(() => parseProjectFolders(settings)).toThrow(
        /Duplicate project name 'app'/
      );
    });

    it('should throw error on duplicate project names (case-insensitive)', () => {
      const settings = createSettings({
        folders: [
          { name: 'MyApp', path: '/path/a' },
          { name: 'myapp', path: '/path/b' },
        ],
      });
      expect(() => parseProjectFolders(settings)).toThrow(
        /Duplicate project name 'myapp'/
      );
    });

    it('should throw error on duplicate project paths', () => {
      const settings = createSettings({
        folders: [
          { name: 'Project A', path: '/same/path' },
          { name: 'Project B', path: '/same/path' },
        ],
      });
      expect(() => parseProjectFolders(settings)).toThrow(
        /Duplicate project path '\/same\/path'/
      );
    });

    it('should throw error when project folder path does not exist', async () => {
      // Dynamically import fs to access the mock
      const fs = await import('fs');
      const existsSyncMock = vi.mocked(fs.existsSync);

      // Make existsSync return false for the non-existent path
      existsSyncMock.mockImplementation((path) => {
        return path !== '/nonexistent/path';
      });

      const settings = createSettings({
        folders: ['/nonexistent/path'],
      });

      expect(() => parseProjectFolders(settings)).toThrow(
        /Project folder path does not exist: \/nonexistent\/path/
      );

      // Restore default behavior
      existsSyncMock.mockImplementation(() => true);
    });

    it('should throw error when project folder path is not a directory', async () => {
      // Dynamically import fs to access the mock
      const fs = await import('fs');
      const statSyncMock = vi.mocked(fs.statSync);

      // Make statSync return isDirectory: false for the file path
      statSyncMock.mockImplementation((path) => {
        if (path === '/path/to/file.txt') {
          return { isDirectory: () => false } as ReturnType<typeof fs.statSync>;
        }
        return { isDirectory: () => true } as ReturnType<typeof fs.statSync>;
      });

      const settings = createSettings({
        folders: ['/path/to/file.txt'],
      });

      expect(() => parseProjectFolders(settings)).toThrow(
        /Project folder path is not a directory: \/path\/to\/file.txt/
      );

      // Restore default behavior
      statSyncMock.mockImplementation(
        () => ({ isDirectory: () => true }) as ReturnType<typeof fs.statSync>
      );
    });

    it('should allow same basename with different explicit names', () => {
      const settings = createSettings({
        folders: [
          { name: 'App Frontend', path: '/path/to/app' },
          { name: 'App Backend', path: '/other/path/app' },
        ],
      });
      const result = parseProjectFolders(settings);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('App Frontend');
      expect(result[1].name).toBe('App Backend');
    });
  });

  describe('resolveProject', () => {
    describe('Priority 1: CLI flag', () => {
      it('should resolve from CLI flag matching configured project name', () => {
        const settings = createSettings({
          folders: [
            { name: 'my-app', path: '/projects/my-app' },
            { name: 'other-app', path: '/projects/other-app' },
          ],
        });
        const result = resolveProject({
          cliFlag: 'my-app',
          cwd: '/somewhere/else',
          settings,
        });
        expect(result.source).toBe('cli-flag');
        expect(result.project.name).toBe('my-app');
        expect(result.project.path).toBe('/projects/my-app');
      });

      it('should resolve from CLI flag as absolute path when not matching projects', () => {
        const settings = createSettings();
        const result = resolveProject({
          cliFlag: '/custom/project/path',
          cwd: '/somewhere/else',
          settings,
        });
        expect(result.source).toBe('cli-flag');
        expect(result.project.name).toBe('path');
        expect(result.project.path).toBe('/custom/project/path');
      });

      it('should resolve from CLI flag as relative path from cwd', () => {
        const settings = createSettings();
        const result = resolveProject({
          cliFlag: 'relative/path',
          cwd: '/home/user',
          settings,
        });
        expect(result.source).toBe('cli-flag');
        expect(result.project.name).toBe('path');
        expect(result.project.path).toBe('/home/user/relative/path');
      });

      it('should match CLI flag case-insensitively', () => {
        const settings = createSettings({
          folders: [{ name: 'MyApp', path: '/projects/myapp' }],
        });
        const result = resolveProject({
          cliFlag: 'myapp',
          cwd: '/somewhere',
          settings,
        });
        expect(result.source).toBe('cli-flag');
        expect(result.project.name).toBe('MyApp');
      });

      it('should throw error when CLI flag matches multiple projects by basename', () => {
        const settings = createSettings({
          folders: [
            { name: 'Frontend App', path: '/path/to/app' },
            { name: 'Backend App', path: '/other/path/app' },
          ],
        });
        expect(() =>
          resolveProject({
            cliFlag: 'app',
            cwd: '/somewhere',
            settings,
          })
        ).toThrow(/Ambiguous project identifier 'app'/);
      });

      it('should throw error when CLI flag path does not exist', async () => {
        // Dynamically import fs to access the mock
        const fs = await import('fs');
        const existsSyncMock = vi.mocked(fs.existsSync);

        // Make existsSync return false for the non-existent path
        existsSyncMock.mockImplementation((path) => {
          return path !== '/nonexistent/project';
        });

        const settings = createSettings();

        expect(() =>
          resolveProject({
            cliFlag: '/nonexistent/project',
            cwd: '/somewhere',
            settings,
          })
        ).toThrow(
          /Project path provided via --project flag does not exist: \/nonexistent\/project/
        );

        // Restore default behavior
        existsSyncMock.mockImplementation(() => true);
      });

      it('should throw error when CLI flag path is not a directory', async () => {
        // Dynamically import fs to access the mock
        const fs = await import('fs');
        const statSyncMock = vi.mocked(fs.statSync);

        // Make statSync return isDirectory: false for the file path
        statSyncMock.mockImplementation((path) => {
          if (path === '/path/to/file.txt') {
            return {
              isDirectory: () => false,
            } as ReturnType<typeof fs.statSync>;
          }
          return { isDirectory: () => true } as ReturnType<typeof fs.statSync>;
        });

        const settings = createSettings();

        expect(() =>
          resolveProject({
            cliFlag: '/path/to/file.txt',
            cwd: '/somewhere',
            settings,
          })
        ).toThrow(
          /Project path provided via --project flag is not a directory: \/path\/to\/file.txt/
        );

        // Restore default behavior
        statSyncMock.mockImplementation(
          () => ({ isDirectory: () => true }) as ReturnType<typeof fs.statSync>
        );
      });

      it('should suggest close match when CLI flag is a typo', async () => {
        const fs = await import('fs');
        const existsSyncMock = vi.mocked(fs.existsSync);

        // Make existsSync return false for the typo path
        existsSyncMock.mockImplementation((path) => {
          return path !== '/somewhere/frontned';
        });

        const settings = createSettings({
          folders: [
            { name: 'frontend', path: '/projects/frontend' },
            { name: 'backend', path: '/projects/backend' },
          ],
        });

        expect(() =>
          resolveProject({
            cliFlag: 'frontned', // typo for "frontend"
            cwd: '/somewhere',
            settings,
          })
        ).toThrow(/Did you mean 'frontend'/);

        // Restore default behavior
        existsSyncMock.mockImplementation(() => true);
      });

      it('should suggest close match when path-like CLI flag has typo in basename', async () => {
        const fs = await import('fs');
        const existsSyncMock = vi.mocked(fs.existsSync);

        // Make existsSync return false for the typo path
        // Note: resolve() normalizes ./frontned to /somewhere/frontned
        existsSyncMock.mockImplementation((path) => {
          return path !== '/somewhere/frontned';
        });

        const settings = createSettings({
          folders: [
            { name: 'frontend', path: '/projects/frontend' },
            { name: 'backend', path: '/projects/backend' },
          ],
        });

        expect(() =>
          resolveProject({
            cliFlag: './frontned', // path-like with typo in basename
            cwd: '/somewhere',
            settings,
          })
        ).toThrow(/Did you mean 'frontend'/);

        // Restore default behavior
        existsSyncMock.mockImplementation(() => true);
      });
    });

    describe('Priority 2: Prompt analysis', () => {
      it('should detect project name from prompt', () => {
        const settings = createSettings({
          folders: [
            { name: 'frontend', path: '/projects/frontend' },
            { name: 'backend', path: '/projects/backend' },
          ],
        });
        const result = resolveProject({
          prompt: 'Fix the authentication bug in frontend',
          cwd: '/somewhere/else',
          settings,
        });
        expect(result.source).toBe('prompt');
        expect(result.project.name).toBe('frontend');
      });

      it('should detect hyphenated project names in prompt', () => {
        const settings = createSettings({
          folders: [
            { name: 'shared-libs', path: '/projects/shared-libs' },
            { name: 'my-api', path: '/projects/my-api' },
          ],
        });
        const result = resolveProject({
          prompt: 'Update the shared-libs dependency',
          cwd: '/somewhere/else',
          settings,
        });
        expect(result.source).toBe('prompt');
        expect(result.project.name).toBe('shared-libs');
      });

      it('should use word boundary matching to avoid false positives', () => {
        const settings = createSettings({
          folders: [
            { name: 'app', path: '/projects/app' },
            { name: 'webapp', path: '/projects/webapp' },
          ],
        });
        // "app" should match "app" but not "webapp"
        const result = resolveProject({
          prompt: 'Deploy the app to production',
          cwd: '/somewhere',
          settings,
        });
        expect(result.source).toBe('prompt');
        expect(result.project.name).toBe('app');
      });

      it('should fall through on ambiguous prompt matches', () => {
        const settings = createSettings({
          folders: [
            { name: 'api', path: '/projects/api' },
            { name: 'web', path: '/projects/web' },
          ],
          default_project_location: '/default/project',
          resolvedProjectPath: '/default/project',
        });
        // Both "api" and "web" mentioned
        const result = resolveProject({
          prompt: 'Connect the web client to the api endpoint',
          cwd: '/somewhere',
          settings,
        });
        // Should fall through to next priority (default in this case)
        expect(result.source).toBe('default');
      });

      it('should handle case-insensitive prompt matching', () => {
        const settings = createSettings({
          folders: [{ name: 'MyProject', path: '/projects/myproject' }],
        });
        const result = resolveProject({
          prompt: 'Update MYPROJECT configuration',
          cwd: '/somewhere',
          settings,
        });
        expect(result.source).toBe('prompt');
        expect(result.project.name).toBe('MyProject');
      });
    });

    describe('Priority 3: Current directory detection', () => {
      it('should detect when cwd is exactly a configured project', () => {
        const settings = createSettings({
          folders: [{ name: 'my-project', path: '/projects/my-project' }],
        });
        const result = resolveProject({
          cwd: '/projects/my-project',
          settings,
        });
        expect(result.source).toBe('cwd');
        expect(result.project.name).toBe('my-project');
      });

      it('should detect when cwd is inside a configured project', () => {
        const settings = createSettings({
          folders: [{ name: 'my-project', path: '/projects/my-project' }],
        });
        const result = resolveProject({
          cwd: '/projects/my-project/src/components',
          settings,
        });
        expect(result.source).toBe('cwd');
        expect(result.project.name).toBe('my-project');
      });

      it('should select the deepest matching project for nested paths', () => {
        const settings = createSettings({
          folders: [
            { name: 'monorepo', path: '/projects/monorepo' },
            { name: 'frontend', path: '/projects/monorepo/packages/frontend' },
          ],
        });
        const result = resolveProject({
          cwd: '/projects/monorepo/packages/frontend/src',
          settings,
        });
        expect(result.source).toBe('cwd');
        expect(result.project.name).toBe('frontend');
      });
    });

    describe('Priority 4: Default project', () => {
      it('should fall back to resolvedPaths.project (pre-resolved default_project_location)', () => {
        const settings = createSettings({
          default_project_location: '/default/project',
          resolvedProjectPath: '/default/project',
        });
        const result = resolveProject({
          cwd: '/somewhere/else',
          settings,
        });
        expect(result.source).toBe('default');
        expect(result.project.name).toBe('project');
        expect(result.project.path).toBe('/default/project');
      });

      it('should use pre-resolved path from settings (relative paths resolved by settings loader)', () => {
        // In real usage, loadSettings() resolves relative paths from the settings file location
        // Here we simulate that the relative path has already been resolved
        const settings = createSettings({
          default_project_location: 'relative/default',
          resolvedProjectPath: '/config/dir/relative/default', // Pre-resolved by settings loader
        });
        const result = resolveProject({
          cwd: '/home/user',
          settings,
        });
        expect(result.source).toBe('default');
        // Should use the pre-resolved path, not resolve from cwd
        expect(result.project.path).toBe('/config/dir/relative/default');
      });
    });

    describe('Priority 5: Fallback to cwd', () => {
      it('should fall back to cwd when no other options available', () => {
        const settings = createSettings();
        const result = resolveProject({
          cwd: '/current/working/directory',
          settings,
        });
        expect(result.source).toBe('fallback');
        expect(result.project.name).toBe('directory');
        expect(result.project.path).toBe('/current/working/directory');
      });
    });

    describe('Priority chain', () => {
      it('should prefer CLI flag over prompt detection', () => {
        const settings = createSettings({
          folders: [
            { name: 'frontend', path: '/projects/frontend' },
            { name: 'backend', path: '/projects/backend' },
          ],
        });
        const result = resolveProject({
          cliFlag: 'backend',
          prompt: 'Work on frontend',
          cwd: '/somewhere',
          settings,
        });
        expect(result.source).toBe('cli-flag');
        expect(result.project.name).toBe('backend');
      });

      it('should prefer prompt detection over cwd detection', () => {
        const settings = createSettings({
          folders: [
            { name: 'frontend', path: '/projects/frontend' },
            { name: 'backend', path: '/projects/backend' },
          ],
        });
        const result = resolveProject({
          prompt: 'Fix bug in frontend',
          cwd: '/projects/backend',
          settings,
        });
        expect(result.source).toBe('prompt');
        expect(result.project.name).toBe('frontend');
      });

      it('should prefer cwd detection over default', () => {
        const settings = createSettings({
          folders: [{ name: 'my-project', path: '/projects/my-project' }],
          default_project_location: '/default/project',
          resolvedProjectPath: '/default/project',
        });
        const result = resolveProject({
          cwd: '/projects/my-project/src',
          settings,
        });
        expect(result.source).toBe('cwd');
        expect(result.project.name).toBe('my-project');
      });
    });
  });

  describe('getAvailableProjects', () => {
    it('should return all configured project folders', () => {
      const settings = createSettings({
        folders: [
          { name: 'project-a', path: '/projects/a' },
          { name: 'project-b', path: '/projects/b' },
        ],
      });
      const result = getAvailableProjects(settings);
      expect(result).toHaveLength(2);
      expect(result.map((p) => p.name)).toContain('project-a');
      expect(result.map((p) => p.name)).toContain('project-b');
    });

    it('should include resolvedPaths.project if not already in folders', () => {
      const settings = createSettings({
        folders: [{ name: 'project-a', path: '/projects/a' }],
        default_project_location: '/default/project',
        resolvedProjectPath: '/default/project',
      });
      const result = getAvailableProjects(settings);
      expect(result).toHaveLength(2);
      expect(result.map((p) => p.path)).toContain('/default/project');
    });

    it('should not duplicate resolvedPaths.project if already in folders', () => {
      const settings = createSettings({
        folders: [{ name: 'default', path: '/default/project' }],
        default_project_location: '/default/project',
        resolvedProjectPath: '/default/project',
      });
      const result = getAvailableProjects(settings);
      expect(result).toHaveLength(1);
    });

    it('should return empty array with no configuration', () => {
      const settings = createSettings();
      const result = getAvailableProjects(settings);
      expect(result).toEqual([]);
    });
  });
});
