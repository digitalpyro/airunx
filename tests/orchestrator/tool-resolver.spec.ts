import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveTool,
  resolveTools,
  resolveAllTools,
  getResolvedCommand,
  isToolAvailable,
  getProjectToolInfo,
  transformPipelineTools,
  validatePipelineTools,
  clearToolResolutionCache,
} from '../../src/orchestrator/tool-resolver.js';

describe('Tool Resolver', () => {
  let testDir: string;

  beforeEach(() => {
    // Create a unique test directory
    testDir = join(tmpdir(), `tool-resolver-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    clearToolResolutionCache();
  });

  afterEach(() => {
    // Clean up test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    clearToolResolutionCache();
  });

  describe('resolveTool', () => {
    it('should resolve eslint to PHP linter in PHP project', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const result = resolveTool('eslint', { projectRoot: testDir });

      expect(result.success).toBe(true);
      expect(result.language).toBe('php');
      expect(result.toolType).toBe('linter');
      expect(result.command).toContain('phpcs');
    });

    it('should resolve vitest to PHPUnit in PHP project', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const result = resolveTool('vitest', { projectRoot: testDir });

      expect(result.success).toBe(true);
      expect(result.language).toBe('php');
      expect(result.toolType).toBe('test_runner');
      expect(result.command).toContain('phpunit');
    });

    it('should resolve eslint to eslint in TypeScript project', () => {
      writeFileSync(join(testDir, 'tsconfig.json'), '{}');

      const result = resolveTool('eslint', { projectRoot: testDir });

      expect(result.success).toBe(true);
      expect(result.language).toBe('typescript');
      expect(result.toolType).toBe('linter');
      expect(result.command).toContain('eslint');
    });

    it('should fail when no language detected', () => {
      const result = resolveTool('eslint', { projectRoot: testDir });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unable to detect project language');
    });

    it('should respect language override', () => {
      // Even with composer.json, should use specified language
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const result = resolveTool('eslint', {
        projectRoot: testDir,
        language: 'typescript',
      });

      expect(result.success).toBe(true);
      expect(result.language).toBe('typescript');
      expect(result.command).toContain('eslint');
    });

    it('should return unknown tools as-is', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const result = resolveTool('custom-tool', { projectRoot: testDir });

      expect(result.success).toBe(true);
      expect(result.command).toBe('custom-tool');
    });

    it('should include config file in result', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const result = resolveTool('phpunit', { projectRoot: testDir });

      expect(result.success).toBe(true);
      expect(result.configFile).toBe('phpunit.xml');
    });

    it('should validate required files when option is set', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const result = resolveTool('phpcs', {
        projectRoot: testDir,
        validateRequirements: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing required files');
    });

    it('should pass validation when required files exist', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');
      mkdirSync(join(testDir, 'vendor', 'bin'), { recursive: true });
      writeFileSync(join(testDir, 'vendor', 'bin', 'phpunit'), '');

      const result = resolveTool('phpunit', {
        projectRoot: testDir,
        validateRequirements: true,
      });

      expect(result.success).toBe(true);
    });

    it('should use cache for repeated calls', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const result1 = resolveTool('eslint', { projectRoot: testDir });
      const result2 = resolveTool('eslint', { projectRoot: testDir });

      expect(result1).toEqual(result2);
    });
  });

  describe('resolveTools', () => {
    it('should resolve multiple tools', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const results = resolveTools(['eslint', 'vitest', 'coverage'], {
        projectRoot: testDir,
      });

      expect(results).toHaveLength(3);
      expect(results[0].toolType).toBe('linter');
      expect(results[1].toolType).toBe('test_runner');
      expect(results[2].toolType).toBe('coverage');
    });
  });

  describe('resolveAllTools', () => {
    it('should resolve all tools for PHP project', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const results = resolveAllTools({ projectRoot: testDir });

      expect(results.has('linter')).toBe(true);
      expect(results.has('test_runner')).toBe(true);
      expect(results.has('coverage')).toBe(true);
      expect(results.has('formatter')).toBe(true);
    });

    it('should return empty map when no language detected', () => {
      const results = resolveAllTools({ projectRoot: testDir });

      expect(results.size).toBe(0);
    });
  });

  describe('getResolvedCommand', () => {
    it('should return resolved command for known tool', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const command = getResolvedCommand('eslint', { projectRoot: testDir });

      expect(command).toContain('phpcs');
    });

    it('should return original name for unknown tool', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const command = getResolvedCommand('my-custom-tool', {
        projectRoot: testDir,
      });

      expect(command).toBe('my-custom-tool');
    });

    it('should return original name when language not detected', () => {
      const command = getResolvedCommand('eslint', { projectRoot: testDir });

      expect(command).toBe('eslint');
    });
  });

  describe('isToolAvailable', () => {
    it('should return true for available tool', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const available = isToolAvailable('eslint', { projectRoot: testDir });

      expect(available).toBe(true);
    });

    it('should return false when language not detected', () => {
      const available = isToolAvailable('eslint', { projectRoot: testDir });

      expect(available).toBe(false);
    });

    it('should return true for unknown tools (pass-through)', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const available = isToolAvailable('custom-tool', { projectRoot: testDir });

      expect(available).toBe(true);
    });
  });

  describe('getProjectToolInfo', () => {
    it('should return PHP project info', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const info = getProjectToolInfo(testDir);

      expect(info.language).toBe('php');
      expect(info.languageConfidence).toBe('high');
      expect(info.detectionMethod).toBe('marker');
      expect(info.markerFile).toBe('composer.json');
      expect(info.availableTools.length).toBeGreaterThan(0);
    });

    it('should return null language for empty directory', () => {
      const info = getProjectToolInfo(testDir);

      expect(info.language).toBeNull();
      expect(info.availableTools).toHaveLength(0);
    });
  });

  describe('transformPipelineTools', () => {
    it('should transform pipeline tools to PHP commands', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const transformed = transformPipelineTools(
        ['eslint', 'typescript', 'vitest'],
        { projectRoot: testDir }
      );

      expect(transformed[0]).toContain('phpcs');
      expect(transformed[2]).toContain('phpunit');
    });

    it('should preserve unknown tools', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const transformed = transformPipelineTools(
        ['eslint', 'custom-tool', 'vitest'],
        { projectRoot: testDir }
      );

      expect(transformed[1]).toBe('custom-tool');
    });

    it('should transform to TypeScript tools in TS project', () => {
      writeFileSync(join(testDir, 'tsconfig.json'), '{}');

      const transformed = transformPipelineTools(['phpcs', 'phpunit'], {
        projectRoot: testDir,
      });

      expect(transformed[0]).toContain('eslint');
      expect(transformed[1]).toContain('vitest');
    });
  });

  describe('validatePipelineTools', () => {
    it('should validate available tools', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const validation = validatePipelineTools(['eslint', 'vitest'], {
        projectRoot: testDir,
      });

      expect(validation.valid).toBe(true);
      expect(validation.missing).toHaveLength(0);
      expect(validation.errors).toHaveLength(0);
    });

    it('should report missing tools when validation enabled', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const validation = validatePipelineTools(['eslint', 'vitest'], {
        projectRoot: testDir,
        validateRequirements: true,
      });

      // Tools are configured but required files are missing
      expect(validation.errors.length).toBeGreaterThan(0);
    });

    it('should handle unknown tools as valid', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const validation = validatePipelineTools(['custom-tool'], {
        projectRoot: testDir,
      });

      expect(validation.valid).toBe(true);
    });
  });

  describe('clearToolResolutionCache', () => {
    it('should clear the cache', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      // First call - populate cache
      resolveTool('eslint', { projectRoot: testDir });

      // Clear cache
      clearToolResolutionCache();

      // Remove the marker file
      rmSync(join(testDir, 'composer.json'));

      // Second call - should fail because no marker
      const result = resolveTool('eslint', { projectRoot: testDir });

      expect(result.success).toBe(false);
    });
  });
});
