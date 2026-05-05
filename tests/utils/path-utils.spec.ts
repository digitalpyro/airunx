/**
 * Tests for Path Utils
 * Validates path resolution utilities
 */

import { describe, it, expect } from 'vitest';
import { resolvePathRelativeToDir } from '../../src/utils/path-utils.js';

describe('Path Utils', () => {
  describe('resolvePathRelativeToDir', () => {
    it('should return undefined for null path', () => {
      const result = resolvePathRelativeToDir(null, '/project');
      expect(result).toBeUndefined();
    });

    it('should return undefined for undefined path', () => {
      const result = resolvePathRelativeToDir(undefined, '/project');
      expect(result).toBeUndefined();
    });

    it('should return undefined for empty string path', () => {
      const result = resolvePathRelativeToDir('', '/project');
      expect(result).toBeUndefined();
    });

    it('should return absolute path as-is', () => {
      const result = resolvePathRelativeToDir('/absolute/path.md', '/project');
      expect(result).toBe('/absolute/path.md');
    });

    it('should return HTTP URL as-is', () => {
      const result = resolvePathRelativeToDir(
        'http://example.com/path.md',
        '/project'
      );
      expect(result).toBe('http://example.com/path.md');
    });

    it('should return HTTPS URL as-is', () => {
      const result = resolvePathRelativeToDir(
        'https://example.com/path.md',
        '/project'
      );
      expect(result).toBe('https://example.com/path.md');
    });

    it('should resolve relative path against base directory', () => {
      const result = resolvePathRelativeToDir('./docs/spec.md', '/project');
      expect(result).toBe('/project/docs/spec.md');
    });

    it('should resolve parent-relative path against base directory', () => {
      const result = resolvePathRelativeToDir('../other/spec.md', '/project/src');
      expect(result).toBe('/project/other/spec.md');
    });

    it('should resolve bare filename against base directory', () => {
      const result = resolvePathRelativeToDir('spec.md', '/project');
      expect(result).toBe('/project/spec.md');
    });
  });
});
