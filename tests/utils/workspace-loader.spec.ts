/**
 * Tests for Workspace Loader utilities
 * Validates parsing of VSCode .code-workspace files
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseWorkspaceFolders } from '../../src/utils/workspace-loader.js';

// Mock fs.readFileSync
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(),
  };
});

import { readFileSync } from 'fs';

const mockedReadFileSync = vi.mocked(readFileSync);

describe('Workspace Loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseWorkspaceFolders', () => {
    it('should parse folders from workspace file', () => {
      const workspaceContent = JSON.stringify({
        folders: [
          { path: './project-a' },
          { path: './project-b', name: 'Project B' },
        ],
      });
      mockedReadFileSync.mockReturnValue(workspaceContent);

      const result = parseWorkspaceFolders('/home/user/my.code-workspace');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: 'project-a',
        path: '/home/user/project-a',
      });
      expect(result[1]).toEqual({
        name: 'Project B',
        path: '/home/user/project-b',
      });
    });

    it('should resolve relative paths from workspace file location', () => {
      const workspaceContent = JSON.stringify({
        folders: [{ path: '../sibling' }, { path: './child' }],
      });
      mockedReadFileSync.mockReturnValue(workspaceContent);

      const result = parseWorkspaceFolders(
        '/projects/workspace/my.code-workspace'
      );

      expect(result[0].path).toBe('/projects/sibling');
      expect(result[1].path).toBe('/projects/workspace/child');
    });

    it('should use basename as name when name is not provided', () => {
      const workspaceContent = JSON.stringify({
        folders: [{ path: '/absolute/path/to/my-project' }],
      });
      mockedReadFileSync.mockReturnValue(workspaceContent);

      const result = parseWorkspaceFolders('/home/user/my.code-workspace');

      expect(result[0].name).toBe('my-project');
    });

    it('should preserve explicit name from workspace file', () => {
      const workspaceContent = JSON.stringify({
        folders: [{ path: './src', name: 'Source Code' }],
      });
      mockedReadFileSync.mockReturnValue(workspaceContent);

      const result = parseWorkspaceFolders('/home/user/my.code-workspace');

      expect(result[0].name).toBe('Source Code');
    });

    it('should return empty array when folders is missing', () => {
      const workspaceContent = JSON.stringify({
        settings: { 'editor.fontSize': 14 },
      });
      mockedReadFileSync.mockReturnValue(workspaceContent);

      const result = parseWorkspaceFolders('/home/user/my.code-workspace');

      expect(result).toEqual([]);
    });

    it('should return empty array when folders is empty', () => {
      const workspaceContent = JSON.stringify({
        folders: [],
      });
      mockedReadFileSync.mockReturnValue(workspaceContent);

      const result = parseWorkspaceFolders('/home/user/my.code-workspace');

      expect(result).toEqual([]);
    });

    it('should throw on schema validation failure', () => {
      // JSONC parser is lenient, so test schema validation instead
      // Valid JSON but missing required 'path' field in folder
      mockedReadFileSync.mockReturnValue('{"folders": [{"name": "no-path"}]}');

      expect(() =>
        parseWorkspaceFolders('/home/user/my.code-workspace')
      ).toThrow();
    });

    it('should parse workspace files with trailing commas (JSONC)', () => {
      const workspaceContent = '{"folders": [{"path": "./src",}],}';
      mockedReadFileSync.mockReturnValue(workspaceContent);

      const result = parseWorkspaceFolders('/home/user/my.code-workspace');

      expect(result).toHaveLength(1);
      expect(result[0].path).toContain('src');
    });

    it('should parse workspace files with comments (JSONC)', () => {
      const workspaceContent = `{
        // Project folders
        "folders": [
          {"path": "./src"} // Main source
        ]
      }`;
      mockedReadFileSync.mockReturnValue(workspaceContent);

      const result = parseWorkspaceFolders('/home/user/my.code-workspace');

      expect(result).toHaveLength(1);
    });

    it('should handle absolute paths in workspace file', () => {
      const workspaceContent = JSON.stringify({
        folders: [{ path: '/absolute/path/project' }],
      });
      mockedReadFileSync.mockReturnValue(workspaceContent);

      const result = parseWorkspaceFolders('/home/user/my.code-workspace');

      expect(result[0].path).toBe('/absolute/path/project');
    });
  });
});
