/**
 * Tests for Context Loader
 * Validates loading and merging of context files (both files and directories)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { readFile, stat, readdir } from 'fs/promises';
import type { Stats, Dirent } from 'fs';
import {
  loadContext,
  loadContextWithSources,
  mergeContexts,
  ContextLoaderError,
} from '../../src/utils/context-loader.js';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn(),
}));

/**
 * Helper to create mock Stats object for files
 */
function createFileStat(): Partial<Stats> {
  return {
    isDirectory: () => false,
    isFile: () => true,
  };
}

/**
 * Helper to create mock Stats object for directories
 */
function createDirStat(): Partial<Stats> {
  return {
    isDirectory: () => true,
    isFile: () => false,
  };
}

/**
 * Helper to create mock Dirent for files
 */
function createFileDirent(name: string): Partial<Dirent> {
  return {
    name,
    isDirectory: () => false,
    isFile: () => true,
  };
}

/**
 * Helper to create mock Dirent for directories
 */
function createDirDirent(name: string): Partial<Dirent> {
  return {
    name,
    isDirectory: () => true,
    isFile: () => false,
  };
}

describe('Context Loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loadContext', () => {
    it('should return empty string for null path', async () => {
      const result = await loadContext(null);
      expect(result).toBe('');
    });

    it('should return empty string for undefined path', async () => {
      const result = await loadContext(undefined);
      expect(result).toBe('');
    });

    it('should load context from absolute file path', async () => {
      vi.mocked(stat).mockResolvedValue(createFileStat() as Stats);
      vi.mocked(readFile).mockResolvedValue('# Project Context\n\nThis is context.');

      const result = await loadContext('/absolute/path/context.md');

      expect(result).toBe('# Project Context\n\nThis is context.');
      expect(readFile).toHaveBeenCalledWith('/absolute/path/context.md', 'utf-8');
    });

    it('should throw ContextLoaderError for relative paths', async () => {
      // Relative paths are not allowed - caller must resolve to absolute first
      await expect(loadContext('./context.md')).rejects.toThrow(ContextLoaderError);
      await expect(loadContext('./context.md')).rejects.toThrow('Path must be absolute');
    });

    it('should throw ContextLoaderError for non-existent file', async () => {
      vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));

      await expect(loadContext('/absolute/missing.md')).rejects.toThrow(ContextLoaderError);
      await expect(loadContext('/absolute/missing.md')).rejects.toThrow('Context path not found');
    });

    it('should throw ContextLoaderError when file read fails', async () => {
      vi.mocked(stat).mockResolvedValue(createFileStat() as Stats);
      vi.mocked(readFile).mockRejectedValue(new Error('Permission denied'));

      await expect(loadContext('/absolute/protected.md')).rejects.toThrow(ContextLoaderError);
      await expect(loadContext('/absolute/protected.md')).rejects.toThrow('Failed to read context file');
    });
  });

  describe('loadContextWithSources (directory support)', () => {
    it('should load context from directory with multiple files', async () => {
      vi.mocked(stat).mockResolvedValue(createDirStat() as Stats);
      vi.mocked(readdir).mockResolvedValue([
        createFileDirent('a.md'),
        createFileDirent('b.txt'),
        createFileDirent('c.json'), // Should be ignored
      ] as Dirent[]);
      vi.mocked(readFile)
        .mockResolvedValueOnce('Content A')
        .mockResolvedValueOnce('Content B');

      const result = await loadContextWithSources('/context/dir');

      expect(result.sources).toHaveLength(2);
      expect(result.content).toContain('# File: a.md');
      expect(result.content).toContain('Content A');
      expect(result.content).toContain('# File: b.txt');
      expect(result.content).toContain('Content B');
    });

    it('should ignore node_modules and .git directories', async () => {
      vi.mocked(stat).mockResolvedValue(createDirStat() as Stats);
      vi.mocked(readdir).mockResolvedValue([
        createDirDirent('node_modules'),
        createDirDirent('.git'),
        createFileDirent('context.md'),
      ] as Dirent[]);
      vi.mocked(readFile).mockResolvedValue('Valid content');

      const result = await loadContextWithSources('/project');

      expect(result.sources).toHaveLength(1);
      expect(result.content).toContain('Valid content');
    });

    it('should handle empty directory', async () => {
      vi.mocked(stat).mockResolvedValue(createDirStat() as Stats);
      vi.mocked(readdir).mockResolvedValue([]);

      const result = await loadContextWithSources('/empty/dir');

      expect(result.sources).toHaveLength(0);
      expect(result.content).toBe('');
    });

    it('should skip unreadable files with warning', async () => {
      vi.mocked(stat).mockResolvedValue(createDirStat() as Stats);
      vi.mocked(readdir).mockResolvedValue([
        createFileDirent('readable.md'),
        createFileDirent('unreadable.md'),
      ] as Dirent[]);
      vi.mocked(readFile)
        .mockResolvedValueOnce('Readable content')
        .mockRejectedValueOnce(new Error('Permission denied'));

      const result = await loadContextWithSources('/mixed/dir');

      expect(result.sources).toHaveLength(1);
      expect(result.content).toContain('Readable content');
    });
  });

  describe('mergeContexts', () => {
    it('should return empty context when no paths provided', async () => {
      const result = await mergeContexts(null, null);

      expect(result.combined).toBe('');
      expect(result.sources).toHaveLength(0);
    });

    it('should create file directive for project context path', async () => {
      vi.mocked(stat).mockResolvedValue(createFileStat() as Stats);

      const result = await mergeContexts('/project/context.md', null);

      expect(result.combined).toContain('Context file: `/project/context.md`');
      expect(result.combined).toContain('Read this file');
      expect(result.sources).toEqual(['/project/context.md']);
    });

    it('should create file directive for runtime context path', async () => {
      vi.mocked(stat).mockResolvedValue(createFileStat() as Stats);

      const result = await mergeContexts(null, '/runtime/context.md');

      expect(result.combined).toContain('Context file: `/runtime/context.md`');
      expect(result.sources).toEqual(['/runtime/context.md']);
    });

    it('should create directives for both paths', async () => {
      vi.mocked(stat).mockResolvedValue(createFileStat() as Stats);

      const result = await mergeContexts('/project/context.md', '/runtime/context.md');

      expect(result.combined).toContain('/project/context.md');
      expect(result.combined).toContain('/runtime/context.md');
      expect(result.sources).toEqual(['/project/context.md', '/runtime/context.md']);
    });

    it('should silently ignore missing project context', async () => {
      vi.mocked(stat).mockImplementation(async (path) => {
        if (path === '/runtime/context.md') {
          return createFileStat() as Stats;
        }
        throw new Error('ENOENT');
      });

      const result = await mergeContexts('/missing/project.md', '/runtime/context.md');

      expect(result.combined).toContain('/runtime/context.md');
      expect(result.combined).not.toContain('/missing/project.md');
      expect(result.sources).toEqual(['/runtime/context.md']);
    });

    it('should throw when runtime context is required but missing', async () => {
      vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));

      await expect(
        mergeContexts(null, '/missing/runtime.md', { requireRuntimeContext: true })
      ).rejects.toThrow(ContextLoaderError);
    });

    it('should silently ignore missing runtime context when not required', async () => {
      vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));

      const result = await mergeContexts(null, '/missing/runtime.md', {
        requireRuntimeContext: false,
      });

      expect(result.combined).toBe('');
      expect(result.sources).toHaveLength(0);
    });

    it('should create directory directive for directory context', async () => {
      vi.mocked(stat).mockReset();
      vi.mocked(stat).mockImplementation(async (path) => {
        if (path === '/project/context.md') return createFileStat() as Stats;
        if (path === '/runtime/dir') return createDirStat() as Stats;
        throw new Error('ENOENT');
      });

      const result = await mergeContexts('/project/context.md', '/runtime/dir');

      expect(result.combined).toContain('Context file: `/project/context.md`');
      expect(result.combined).toContain('Context directory: `/runtime/dir`');
      expect(result.combined).toContain('Read the index file');
      expect(result.sources).toEqual(['/project/context.md', '/runtime/dir']);
    });
  });

  describe('mergeContexts — no eager loading', () => {
    it('should not read any file content', async () => {
      vi.mocked(stat).mockResolvedValue(createFileStat() as Stats);

      await mergeContexts('/project/context.md', null);

      // readFile should NOT be called — agent reads files on demand
      expect(readFile).not.toHaveBeenCalled();
    });

    it('should not resolve @mentions (agent handles this)', async () => {
      vi.mocked(stat).mockResolvedValue(createFileStat() as Stats);

      const result = await mergeContexts('/project/context.md', null);

      expect(result.resolvedReferences).toHaveLength(0);
      expect(result.failedReferences).toHaveLength(0);
    });
  });

  describe('ContextLoaderError', () => {
    it('should include path in error', () => {
      const error = new ContextLoaderError('Test error', '/path/to/context.md');

      expect(error.message).toBe('Test error');
      expect(error.path).toBe('/path/to/context.md');
      expect(error.name).toBe('ContextLoaderError');
    });
  });
});
