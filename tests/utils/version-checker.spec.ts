/**
 * Tests for Version Checker
 * Validates npm-based version checking functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { checkVersion, formatVersionMessage } from '../../src/utils/version-checker.js';
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';

// Mock child_process
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

// Mock paths module to return a predictable package root
vi.mock('../../src/utils/paths.js', () => ({
  getPackageRoot: vi.fn(() => '/test/airunx'),
}));

describe('Version Checker', () => {
  let mockExecFile: ReturnType<typeof vi.fn>;
  let mockReadFile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockExecFile = vi.mocked(execFile);
    mockReadFile = vi.mocked(readFile);
    vi.clearAllMocks();
  });

  describe('checkVersion', () => {
    it('should return up-to-date when current version matches npm', async () => {
      // Mock reading package.json
      mockReadFile.mockResolvedValue(JSON.stringify({ version: '1.2.3' }));

      // Mock npm view returning same version
      mockExecFile.mockImplementation((_cmd, args, _opts, callback: unknown) => {
        const argArray = args as string[];
        const cb = callback as (err: Error | null, result: object) => void;

        if (argArray[0] === 'view' && argArray[1] === 'airunx') {
          cb(null, { stdout: '1.2.3\n', stderr: '' });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      });

      const result = await checkVersion();

      expect(result.success).toBe(true);
      expect(result.isUpToDate).toBe(true);
      expect(result.currentVersion).toBe('1.2.3');
      expect(result.latestVersion).toBe('1.2.3');
    });

    it('should return not up-to-date when behind npm version', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ version: '1.0.0' }));

      mockExecFile.mockImplementation((_cmd, args, _opts, callback: unknown) => {
        const argArray = args as string[];
        const cb = callback as (err: Error | null, result: object) => void;

        if (argArray[0] === 'view' && argArray[1] === 'airunx') {
          cb(null, { stdout: '2.0.0\n', stderr: '' });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      });

      const result = await checkVersion();

      expect(result.success).toBe(true);
      expect(result.isUpToDate).toBe(false);
      expect(result.currentVersion).toBe('1.0.0');
      expect(result.latestVersion).toBe('2.0.0');
    });

    it('should return up-to-date when ahead of npm version', async () => {
      // Local dev version ahead of published
      mockReadFile.mockResolvedValue(JSON.stringify({ version: '2.0.0' }));

      mockExecFile.mockImplementation((_cmd, args, _opts, callback: unknown) => {
        const argArray = args as string[];
        const cb = callback as (err: Error | null, result: object) => void;

        if (argArray[0] === 'view' && argArray[1] === 'airunx') {
          cb(null, { stdout: '1.5.0\n', stderr: '' });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      });

      const result = await checkVersion();

      expect(result.success).toBe(true);
      expect(result.isUpToDate).toBe(true);
    });

    it('should handle npm view failure gracefully', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ version: '1.0.0' }));

      mockExecFile.mockImplementation((_cmd, _args, _opts, callback: unknown) => {
        const cb = callback as (err: Error | null, result: object) => void;
        cb(new Error('npm view failed'), { stdout: '', stderr: '' });
      });

      const result = await checkVersion();

      // Should succeed and assume up-to-date when can't check npm
      expect(result.success).toBe(true);
      expect(result.isUpToDate).toBe(true);
      expect(result.currentVersion).toBe('1.0.0');
      expect(result.latestVersion).toBeUndefined();
    });

    it('should handle package.json read failure', async () => {
      mockReadFile.mockRejectedValue(new Error('file not found'));

      const result = await checkVersion();

      expect(result.success).toBe(false);
      expect(result.isUpToDate).toBe(true); // Default to up-to-date on error
      expect(result.error).toContain('file not found');
    });

    it('should handle package not yet published on npm', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ version: '1.0.0' }));

      mockExecFile.mockImplementation((_cmd, _args, _opts, callback: unknown) => {
        const cb = callback as (err: Error | null, result: object) => void;
        cb(new Error('npm ERR! 404'), { stdout: '', stderr: '' });
      });

      const result = await checkVersion();

      // Package not on npm yet - assume up-to-date
      expect(result.success).toBe(true);
      expect(result.isUpToDate).toBe(true);
      expect(result.currentVersion).toBe('1.0.0');
    });

    it('should compare minor versions correctly', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ version: '1.2.0' }));

      mockExecFile.mockImplementation((_cmd, args, _opts, callback: unknown) => {
        const argArray = args as string[];
        const cb = callback as (err: Error | null, result: object) => void;

        if (argArray[0] === 'view' && argArray[1] === 'airunx') {
          cb(null, { stdout: '1.3.0\n', stderr: '' });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      });

      const result = await checkVersion();

      expect(result.isUpToDate).toBe(false);
    });

    it('should compare patch versions correctly', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ version: '1.2.3' }));

      mockExecFile.mockImplementation((_cmd, args, _opts, callback: unknown) => {
        const argArray = args as string[];
        const cb = callback as (err: Error | null, result: object) => void;

        if (argArray[0] === 'view' && argArray[1] === 'airunx') {
          cb(null, { stdout: '1.2.5\n', stderr: '' });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      });

      const result = await checkVersion();

      expect(result.isUpToDate).toBe(false);
    });
  });

  describe('formatVersionMessage', () => {
    it('should return null when up-to-date', () => {
      const result = formatVersionMessage({
        success: true,
        isUpToDate: true,
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
      });

      expect(result).toBeNull();
    });

    it('should return null when check failed', () => {
      const result = formatVersionMessage({
        success: false,
        isUpToDate: true,
        error: 'some error',
      });

      expect(result).toBeNull();
    });

    it('should format message when behind npm version', () => {
      const result = formatVersionMessage({
        success: true,
        isUpToDate: false,
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
      });

      expect(result).not.toBeNull();
      expect(result).toContain('A new version of AIRunX is available: 2.0.0');
      expect(result).toContain('current: 1.0.0');
      expect(result).toContain('npm update -g airunx');
      expect(result).toContain('--skip-version-check');
    });

    it('should include skip flag instruction', () => {
      const result = formatVersionMessage({
        success: true,
        isUpToDate: false,
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
      });

      expect(result).toContain('Use --skip-version-check to disable this warning.');
    });
  });
});
