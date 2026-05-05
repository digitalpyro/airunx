/**
 * Tests for PRD Resolver
 * Validates resolution of PRD sources from local files, URLs, and GitHub
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import {
  resolvePRD,
  isPRDPath,
  PRDResolverError,
} from '../../src/parsers/prd-resolver.js';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

describe('PRD Resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('resolvePRD - Local Files', () => {
    it('should resolve absolute local path', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue('# PRD Content\n\nThis is a test PRD.');

      const result = await resolvePRD('/absolute/path/prd.md');

      expect(result.type).toBe('local');
      expect(result.path).toBe('/absolute/path/prd.md');
      expect(result.content).toBe('# PRD Content\n\nThis is a test PRD.');
    });

    it('should throw PRDResolverError for relative paths', async () => {
      // Relative paths are not allowed - caller must resolve to absolute first
      await expect(resolvePRD('./docs/prd.md')).rejects.toThrow(PRDResolverError);
      await expect(resolvePRD('./docs/prd.md')).rejects.toThrow('Path must be absolute');
    });

    it('should throw PRDResolverError for non-existent local file', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      await expect(resolvePRD('/absolute/missing.md')).rejects.toThrow(PRDResolverError);
      await expect(resolvePRD('/absolute/missing.md')).rejects.toThrow('PRD file not found');
    });

    it('should throw PRDResolverError when file read fails', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockRejectedValue(new Error('Permission denied'));

      await expect(resolvePRD('/absolute/protected.md')).rejects.toThrow(PRDResolverError);
      await expect(resolvePRD('/absolute/protected.md')).rejects.toThrow('Failed to read PRD file');
    });
  });

  describe('resolvePRD - Remote URLs', () => {
    it('should fetch from HTTP URL', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('# Remote PRD Content'),
      });
      global.fetch = mockFetch;

      const result = await resolvePRD('https://example.com/prd.md');

      expect(result.type).toBe('url');
      expect(result.path).toBe('https://example.com/prd.md');
      expect(result.content).toBe('# Remote PRD Content');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/prd.md',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('should throw PRDResolverError for failed HTTP response', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(resolvePRD('https://example.com/missing.md')).rejects.toThrow(
        PRDResolverError
      );
      await expect(resolvePRD('https://example.com/missing.md')).rejects.toThrow(
        'HTTP 404 Not Found'
      );
    });

    it('should throw PRDResolverError on network error', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      await expect(resolvePRD('https://example.com/prd.md')).rejects.toThrow(
        PRDResolverError
      );
      await expect(resolvePRD('https://example.com/prd.md')).rejects.toThrow(
        'Network error'
      );
    });

    it('should handle timeout', async () => {
      // Create a fetch that simulates abort behavior
      global.fetch = vi.fn().mockImplementation((url, options) => {
        return new Promise((resolve, reject) => {
          // Listen for abort signal
          options?.signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      });

      // Use a very short timeout
      await expect(resolvePRD('https://example.com/slow.md', 10)).rejects.toThrow(
        PRDResolverError
      );
      await expect(resolvePRD('https://example.com/slow.md', 10)).rejects.toThrow(
        'timed out'
      );
    }, 1000);
  });

  describe('resolvePRD - GitHub URLs', () => {
    it('should convert GitHub blob URL to raw URL', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('# GitHub PRD'),
      });
      global.fetch = mockFetch;

      const result = await resolvePRD(
        'https://github.com/user/repo/blob/main/docs/prd.md'
      );

      expect(result.type).toBe('github');
      // Original URL is preserved in path for reference
      expect(result.path).toBe('https://github.com/user/repo/blob/main/docs/prd.md');
      expect(result.content).toBe('# GitHub PRD');

      // Verify the raw URL was fetched
      expect(mockFetch).toHaveBeenCalledWith(
        'https://raw.githubusercontent.com/user/repo/main/docs/prd.md',
        expect.any(Object)
      );
    });

    it('should handle various GitHub blob URL formats', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('# Content'),
      });
      global.fetch = mockFetch;

      // With branch
      await resolvePRD('https://github.com/org/repo/blob/develop/feature.md');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://raw.githubusercontent.com/org/repo/develop/feature.md',
        expect.any(Object)
      );

      // With commit SHA
      mockFetch.mockClear();
      await resolvePRD(
        'https://github.com/org/repo/blob/abc123def/path/to/file.md'
      );
      expect(mockFetch).toHaveBeenCalledWith(
        'https://raw.githubusercontent.com/org/repo/abc123def/path/to/file.md',
        expect.any(Object)
      );
    });

    it('should throw PRDResolverError for failed GitHub fetch', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(
        resolvePRD('https://github.com/user/repo/blob/main/missing.md')
      ).rejects.toThrow(PRDResolverError);
      await expect(
        resolvePRD('https://github.com/user/repo/blob/main/missing.md')
      ).rejects.toThrow('Failed to fetch GitHub PRD');
    });
  });

  describe('isPRDPath', () => {
    it('should recognize HTTP URLs', () => {
      expect(isPRDPath('http://example.com/prd')).toBe(true);
      expect(isPRDPath('https://example.com/prd.md')).toBe(true);
    });

    it('should recognize markdown files', () => {
      expect(isPRDPath('document.md')).toBe(true);
      expect(isPRDPath('path/to/feature.markdown')).toBe(true);
    });

    it('should recognize text files', () => {
      expect(isPRDPath('requirements.txt')).toBe(true);
    });

    it('should recognize .prd extension', () => {
      expect(isPRDPath('feature.prd')).toBe(true);
    });

    it('should reject non-PRD paths', () => {
      expect(isPRDPath('script.js')).toBe(false);
      expect(isPRDPath('config.json')).toBe(false);
      expect(isPRDPath('image.png')).toBe(false);
    });
  });

  describe('PRDResolverError', () => {
    it('should include source in error', () => {
      const error = new PRDResolverError('Test error', '/path/to/file.md');

      expect(error.message).toBe('Test error');
      expect(error.source).toBe('/path/to/file.md');
      expect(error.name).toBe('PRDResolverError');
    });
  });
});
