/**
 * Tests for Dynamic Context Resolver
 * Validates parsing of @mentions and dynamic file loading
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { stat, readFile, readdir } from 'fs/promises';
import type { Stats, Dirent } from 'fs';
import {
  ContextResolver,
  createContextResolver,
  resolveContextReferences,
} from '../../src/utils/context-resolver.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

/**
 * Helper to create mock Stats object for files
 */
function createFileStat(size: number = 100): Partial<Stats> {
  return {
    isDirectory: () => false,
    isFile: () => true,
    size,
  };
}

/**
 * Helper to create mock Stats object for directories
 */
function createDirStat(): Partial<Stats> {
  return {
    isDirectory: () => true,
    isFile: () => false,
    size: 0,
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

describe('Context Resolver', () => {
  let resolver: ContextResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = new ContextResolver('/test/project');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseReferences', () => {
    it('should parse @file: references', () => {
      const text = 'Check the config in @file:src/utils/config.ts for details';
      const refs = resolver.parseReferences(text);

      expect(refs).toHaveLength(1);
      expect(refs[0].type).toBe('file');
      expect(refs[0].path).toBe('src/utils/config.ts');
      expect(refs[0].absolutePath).toBe('/test/project/src/utils/config.ts');
    });

    it('should parse @folder: references', () => {
      const text = 'Review the files in @folder:src/utils';
      const refs = resolver.parseReferences(text);

      expect(refs).toHaveLength(1);
      expect(refs[0].type).toBe('folder');
      expect(refs[0].path).toBe('src/utils');
    });

    it('should parse shorthand @path references', () => {
      const text = 'Look at @src/utils/config.ts and @src/core/types.ts';
      const refs = resolver.parseReferences(text);

      expect(refs).toHaveLength(2);
      expect(refs[0].type).toBe('file'); // Has .ts extension
      expect(refs[0].path).toBe('src/utils/config.ts');
      expect(refs[1].path).toBe('src/core/types.ts');
    });

    it('should infer folder type for paths without extension', () => {
      const text = 'Check @src/utils for utilities';
      const refs = resolver.parseReferences(text);

      expect(refs).toHaveLength(1);
      expect(refs[0].type).toBe('folder');
      expect(refs[0].path).toBe('src/utils');
    });

    it('should skip URLs', () => {
      const text = 'Visit @https://example.com or @http://localhost:3000';
      const refs = resolver.parseReferences(text);

      expect(refs).toHaveLength(0);
    });

    it('should skip likely usernames/mentions', () => {
      const text = 'Thanks @user and @team for the help';
      const refs = resolver.parseReferences(text);

      expect(refs).toHaveLength(0);
    });

    it('should handle multiple references', () => {
      const text = `
        Check @src/utils/config.ts for config,
        @file:src/core/types.ts for types,
        and @folder:src/adapters for adapters.
      `;
      const refs = resolver.parseReferences(text);

      expect(refs).toHaveLength(3);
    });

    it('should deduplicate references', () => {
      const text = 'Look at @src/config.ts and then @src/config.ts again';
      const refs = resolver.parseReferences(text);

      expect(refs).toHaveLength(1);
    });

    it('should handle absolute paths', () => {
      const text = 'Check @/absolute/path/file.ts';
      const refs = resolver.parseReferences(text);

      expect(refs).toHaveLength(1);
      expect(refs[0].absolutePath).toBe('/absolute/path/file.ts');
    });
  });

  describe('resolve', () => {
    it('should resolve file references', async () => {
      const text = 'Check @src/utils/config.ts';

      vi.mocked(stat).mockResolvedValue(createFileStat() as Stats);
      vi.mocked(readFile).mockResolvedValue('// Config file content');

      const result = await resolver.resolve(text);

      expect(result.references).toHaveLength(1);
      expect(result.resolved).toHaveLength(1);
      expect(result.resolved[0].content).toBe('// Config file content');
      expect(result.context).toContain('# @src/utils/config.ts');
    });

    it('should resolve folder references', async () => {
      const text = 'Check @folder:src/utils';

      vi.mocked(stat).mockResolvedValue(createDirStat() as Stats);
      vi.mocked(readdir).mockResolvedValue([
        createFileDirent('config.ts'),
        createFileDirent('logger.ts'),
      ] as Dirent[]);
      vi.mocked(readFile)
        .mockResolvedValueOnce('// Config content')
        .mockResolvedValueOnce('// Logger content');

      const result = await resolver.resolve(text);

      expect(result.resolved).toHaveLength(1);
      expect(result.resolved[0].content).toContain('config.ts');
      expect(result.resolved[0].content).toContain('logger.ts');
    });

    it('should handle failed resolutions gracefully', async () => {
      const text = 'Check @src/nonexistent.ts';

      vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));

      const result = await resolver.resolve(text);

      expect(result.resolved).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].reference.path).toBe('src/nonexistent.ts');
    });

    it('should return empty result for text without references', async () => {
      const text = 'No references here';
      const result = await resolver.resolve(text);

      expect(result.references).toHaveLength(0);
      expect(result.resolved).toHaveLength(0);
      expect(result.context).toBe('');
    });

    it('should combine multiple resolved files into context', async () => {
      const text = 'Check @src/a.ts and @src/b.ts';

      vi.mocked(stat).mockResolvedValue(createFileStat() as Stats);
      vi.mocked(readFile)
        .mockResolvedValueOnce('// File A')
        .mockResolvedValueOnce('// File B');

      const result = await resolver.resolve(text);

      expect(result.resolved).toHaveLength(2);
      expect(result.context).toContain('# @src/a.ts');
      expect(result.context).toContain('# @src/b.ts');
      expect(result.context).toContain('---'); // Separator
    });
  });

  describe('caching', () => {
    it('should cache resolved content', async () => {
      const text = 'Check @src/config.ts';

      vi.mocked(stat).mockResolvedValue(createFileStat() as Stats);
      vi.mocked(readFile).mockResolvedValue('// Config content');

      // First resolve
      const result1 = await resolver.resolve(text);
      expect(result1.resolved[0].fromCache).toBe(false);

      // Second resolve should be cached
      const result2 = await resolver.resolve(text);
      expect(result2.resolved[0].fromCache).toBe(true);

      // readFile should only be called once
      expect(readFile).toHaveBeenCalledTimes(1);
    });

    it('should clear cache on demand', async () => {
      const text = 'Check @src/config.ts';

      vi.mocked(stat).mockResolvedValue(createFileStat() as Stats);
      vi.mocked(readFile).mockResolvedValue('// Config content');

      await resolver.resolve(text);
      expect(resolver.getCacheStats().size).toBe(1);

      resolver.clearCache();
      expect(resolver.getCacheStats().size).toBe(0);
    });

    it('should provide cache statistics', async () => {
      const text = 'Check @src/a.ts and @src/b.ts';

      vi.mocked(stat).mockResolvedValue(createFileStat() as Stats);
      vi.mocked(readFile).mockResolvedValue('// Content');

      await resolver.resolve(text);

      const stats = resolver.getCacheStats();
      expect(stats.size).toBe(2);
      expect(stats.keys).toContain('/test/project/src/a.ts');
      expect(stats.keys).toContain('/test/project/src/b.ts');
    });
  });

  describe('file size limits', () => {
    it('should reject files over 1MB', async () => {
      const text = 'Check @src/huge.ts';

      vi.mocked(stat).mockResolvedValue(createFileStat(2 * 1024 * 1024) as Stats);

      const result = await resolver.resolve(text);

      expect(result.resolved).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].error).toContain('too large');
    });
  });

  describe('createContextResolver', () => {
    it('should create resolver with default working directory', () => {
      const resolver = createContextResolver();
      expect(resolver).toBeInstanceOf(ContextResolver);
    });

    it('should create resolver with custom working directory', () => {
      const resolver = createContextResolver('/custom/path');
      expect(resolver).toBeInstanceOf(ContextResolver);
    });
  });

  describe('resolveContextReferences convenience function', () => {
    it('should resolve references from text', async () => {
      vi.mocked(stat).mockResolvedValue(createFileStat() as Stats);
      vi.mocked(readFile).mockResolvedValue('// Content');

      const result = await resolveContextReferences(
        'Check @src/config.ts',
        '/test/project'
      );

      expect(result.resolved).toHaveLength(1);
    });
  });
});
