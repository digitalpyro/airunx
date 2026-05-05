import { describe, it, expect } from 'vitest';
import {
  getToolsForLanguage,
  getToolForLanguage,
  getToolCommand,
  getToolConfigFile,
  hasToolForLanguage,
  getRegisteredLanguages,
  getRegisteredToolTypes,
  mapGenericToolToType,
  resolveGenericTool,
  PHP_TOOLS,
  TYPESCRIPT_TOOLS,
  JAVASCRIPT_TOOLS,
} from '../../src/tools/tool-registry.js';

describe('Tool Registry', () => {
  describe('getToolsForLanguage', () => {
    it('should return PHP tools for php language', () => {
      const tools = getToolsForLanguage('php');

      expect(tools).toEqual(PHP_TOOLS);
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.every((t) => t.language === 'php')).toBe(true);
    });

    it('should return TypeScript tools for typescript language', () => {
      const tools = getToolsForLanguage('typescript');

      expect(tools).toEqual(TYPESCRIPT_TOOLS);
      expect(tools.every((t) => t.language === 'typescript')).toBe(true);
    });

    it('should return JavaScript tools for javascript language', () => {
      const tools = getToolsForLanguage('javascript');

      expect(tools).toEqual(JAVASCRIPT_TOOLS);
      expect(tools.every((t) => t.language === 'javascript')).toBe(true);
    });
  });

  describe('getToolForLanguage', () => {
    it('should return PHP linter tool', () => {
      const tool = getToolForLanguage('php', 'linter');

      expect(tool).toBeDefined();
      expect(tool?.language).toBe('php');
      expect(tool?.toolType).toBe('linter');
      expect(tool?.command).toContain('phpcs');
    });

    it('should return PHP test runner tool', () => {
      const tool = getToolForLanguage('php', 'test_runner');

      expect(tool).toBeDefined();
      expect(tool?.language).toBe('php');
      expect(tool?.toolType).toBe('test_runner');
      expect(tool?.command).toContain('phpunit');
    });

    it('should return undefined for non-existent tool', () => {
      const tool = getToolForLanguage('php', 'type_checker');

      expect(tool).toBeUndefined();
    });

    it('should return TypeScript type checker', () => {
      const tool = getToolForLanguage('typescript', 'type_checker');

      expect(tool).toBeDefined();
      expect(tool?.toolType).toBe('type_checker');
      expect(tool?.command).toContain('tsc');
    });
  });

  describe('getToolCommand', () => {
    it('should return PHP linter command', () => {
      const command = getToolCommand('php', 'linter');

      expect(command).toBe('vendor/bin/phpcs');
    });

    it('should return PHP test runner command', () => {
      const command = getToolCommand('php', 'test_runner');

      expect(command).toBe('vendor/bin/phpunit');
    });

    it('should return PHP coverage command', () => {
      const command = getToolCommand('php', 'coverage');

      expect(command).toBe(
        'vendor/bin/phpunit --coverage-clover coverage/clover.xml'
      );
    });

    it('should return undefined for non-existent tool', () => {
      const command = getToolCommand('php', 'type_checker');

      expect(command).toBeUndefined();
    });

    it('should return TypeScript linter command', () => {
      const command = getToolCommand('typescript', 'linter');

      expect(command).toBe('npx eslint');
    });
  });

  describe('getToolConfigFile', () => {
    it('should return phpcs.xml for PHP linter', () => {
      const configFile = getToolConfigFile('php', 'linter');

      expect(configFile).toBe('phpcs.xml');
    });

    it('should return phpunit.xml for PHP test runner', () => {
      const configFile = getToolConfigFile('php', 'test_runner');

      expect(configFile).toBe('phpunit.xml');
    });

    it('should return tsconfig.json for TypeScript type checker', () => {
      const configFile = getToolConfigFile('typescript', 'type_checker');

      expect(configFile).toBe('tsconfig.json');
    });

    it('should return undefined for non-existent tool', () => {
      const configFile = getToolConfigFile('php', 'type_checker');

      expect(configFile).toBeUndefined();
    });
  });

  describe('hasToolForLanguage', () => {
    it('should return true for PHP linter', () => {
      expect(hasToolForLanguage('php', 'linter')).toBe(true);
    });

    it('should return true for PHP test runner', () => {
      expect(hasToolForLanguage('php', 'test_runner')).toBe(true);
    });

    it('should return false for PHP type checker (not supported)', () => {
      expect(hasToolForLanguage('php', 'type_checker')).toBe(false);
    });

    it('should return true for TypeScript type checker', () => {
      expect(hasToolForLanguage('typescript', 'type_checker')).toBe(true);
    });

    it('should return false for JavaScript type checker', () => {
      expect(hasToolForLanguage('javascript', 'type_checker')).toBe(false);
    });
  });

  describe('getRegisteredLanguages', () => {
    it('should return all registered languages', () => {
      const languages = getRegisteredLanguages();

      expect(languages).toContain('php');
      expect(languages).toContain('typescript');
      expect(languages).toContain('javascript');
      expect(languages).toHaveLength(3);
    });
  });

  describe('getRegisteredToolTypes', () => {
    it('should return all registered tool types', () => {
      const toolTypes = getRegisteredToolTypes();

      expect(toolTypes).toContain('linter');
      expect(toolTypes).toContain('type_checker');
      expect(toolTypes).toContain('test_runner');
      expect(toolTypes).toContain('coverage');
      expect(toolTypes).toContain('formatter');
      expect(toolTypes).toContain('security_scanner');
    });
  });

  describe('mapGenericToolToType', () => {
    it('should map eslint to linter', () => {
      expect(mapGenericToolToType('eslint')).toBe('linter');
    });

    it('should map phpcs to linter', () => {
      expect(mapGenericToolToType('phpcs')).toBe('linter');
    });

    it('should map typescript to type_checker', () => {
      expect(mapGenericToolToType('typescript')).toBe('type_checker');
    });

    it('should map vitest to test_runner', () => {
      expect(mapGenericToolToType('vitest')).toBe('test_runner');
    });

    it('should map phpunit to test_runner', () => {
      expect(mapGenericToolToType('phpunit')).toBe('test_runner');
    });

    it('should map coverage to coverage', () => {
      expect(mapGenericToolToType('coverage')).toBe('coverage');
    });

    it('should return undefined for unknown tool', () => {
      expect(mapGenericToolToType('unknown-tool')).toBeUndefined();
    });

    it('should be case insensitive', () => {
      expect(mapGenericToolToType('ESLint')).toBe('linter');
      expect(mapGenericToolToType('PHPCS')).toBe('linter');
    });
  });

  describe('resolveGenericTool', () => {
    it('should resolve eslint to PHP linter command', () => {
      const command = resolveGenericTool('php', 'eslint');

      expect(command).toBe('vendor/bin/phpcs');
    });

    it('should resolve vitest to PHP test runner command', () => {
      const command = resolveGenericTool('php', 'vitest');

      expect(command).toBe('vendor/bin/phpunit');
    });

    it('should resolve phpcs to TypeScript linter command', () => {
      const command = resolveGenericTool('typescript', 'phpcs');

      expect(command).toBe('npx eslint');
    });

    it('should return original name for unknown tools', () => {
      const command = resolveGenericTool('php', 'custom-tool');

      expect(command).toBe('custom-tool');
    });

    it('should resolve coverage to language-specific command', () => {
      const phpCommand = resolveGenericTool('php', 'coverage');
      const tsCommand = resolveGenericTool('typescript', 'coverage');

      expect(phpCommand).toContain('phpunit');
      expect(tsCommand).toContain('vitest');
    });
  });

  describe('PHP_TOOLS', () => {
    it('should have linter tool', () => {
      const linter = PHP_TOOLS.find((t) => t.toolType === 'linter');

      expect(linter).toBeDefined();
      expect(linter?.command).toContain('phpcs');
      expect(linter?.configFile).toBe('phpcs.xml');
    });

    it('should have formatter tool', () => {
      const formatter = PHP_TOOLS.find((t) => t.toolType === 'formatter');

      expect(formatter).toBeDefined();
      expect(formatter?.command).toContain('phpcbf');
    });

    it('should have test_runner tool', () => {
      const testRunner = PHP_TOOLS.find((t) => t.toolType === 'test_runner');

      expect(testRunner).toBeDefined();
      expect(testRunner?.command).toContain('phpunit');
      expect(testRunner?.configFile).toBe('phpunit.xml');
    });

    it('should have coverage tool', () => {
      const coverage = PHP_TOOLS.find((t) => t.toolType === 'coverage');

      expect(coverage).toBeDefined();
      expect(coverage?.command).toContain('coverage-clover');
    });

    it('should have security_scanner tool', () => {
      const security = PHP_TOOLS.find((t) => t.toolType === 'security_scanner');

      expect(security).toBeDefined();
      expect(security?.command).toContain('phpcs');
    });

    it('should have required files for tools', () => {
      const linter = PHP_TOOLS.find((t) => t.toolType === 'linter');

      expect(linter?.requiredFiles).toContain('vendor/bin/phpcs');
    });
  });

  describe('TYPESCRIPT_TOOLS', () => {
    it('should have type_checker tool', () => {
      const typeChecker = TYPESCRIPT_TOOLS.find(
        (t) => t.toolType === 'type_checker'
      );

      expect(typeChecker).toBeDefined();
      expect(typeChecker?.command).toContain('tsc');
      expect(typeChecker?.configFile).toBe('tsconfig.json');
    });

    it('should have test_runner tool', () => {
      const testRunner = TYPESCRIPT_TOOLS.find(
        (t) => t.toolType === 'test_runner'
      );

      expect(testRunner).toBeDefined();
      expect(testRunner?.command).toContain('vitest');
    });
  });
});
