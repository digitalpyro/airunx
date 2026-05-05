import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  detectProjectLanguage,
  detectProjectLanguageWithDetails,
  validatePHPProject,
  isPHPProject,
  isTypeScriptProject,
  isJavaScriptProject,
  getSupportedLanguages,
  isLanguageSupported,
} from '../../src/tools/language-detector.js';

describe('Language Detector', () => {
  let testDir: string;

  beforeEach(() => {
    // Create a unique test directory
    testDir = join(tmpdir(), `language-detector-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('detectProjectLanguage', () => {
    it('should detect PHP project by composer.json', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const result = detectProjectLanguage(testDir);

      expect(result).toBe('php');
    });

    it('should detect TypeScript project by tsconfig.json', () => {
      writeFileSync(join(testDir, 'tsconfig.json'), '{}');

      const result = detectProjectLanguage(testDir);

      expect(result).toBe('typescript');
    });

    it('should detect JavaScript project by package.json (without tsconfig)', () => {
      writeFileSync(join(testDir, 'package.json'), '{}');

      const result = detectProjectLanguage(testDir);

      expect(result).toBe('javascript');
    });

    it('should return null for empty directory', () => {
      const result = detectProjectLanguage(testDir);

      expect(result).toBeNull();
    });

    it('should prioritize higher priority markers', () => {
      // Both composer.json (PHP, priority 100) and package.json (JS, priority 90)
      writeFileSync(join(testDir, 'composer.json'), '{}');
      writeFileSync(join(testDir, 'package.json'), '{}');

      const result = detectProjectLanguage(testDir);

      expect(result).toBe('php');
    });

    it('should detect Laravel project by artisan file', () => {
      writeFileSync(join(testDir, 'artisan'), '#!/usr/bin/env php');

      const result = detectProjectLanguage(testDir);

      expect(result).toBe('php');
    });
  });

  describe('detectProjectLanguageWithDetails', () => {
    it('should return high confidence for primary markers', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const result = detectProjectLanguageWithDetails(testDir);

      expect(result.language).toBe('php');
      expect(result.confidence).toBe('high');
      expect(result.detectedBy).toBe('marker');
      expect(result.markerFile).toBe('composer.json');
    });

    it('should return medium confidence for secondary markers', () => {
      writeFileSync(join(testDir, 'package.json'), '{}');

      const result = detectProjectLanguageWithDetails(testDir);

      expect(result.language).toBe('javascript');
      expect(result.confidence).toBe('medium');
      expect(result.detectedBy).toBe('marker');
    });

    it('should fall back to extension analysis when no markers found', () => {
      // Create PHP files without composer.json
      mkdirSync(join(testDir, 'src'), { recursive: true });
      for (let i = 0; i < 15; i++) {
        writeFileSync(join(testDir, 'src', `file${i}.php`), '<?php');
      }

      const result = detectProjectLanguageWithDetails(testDir);

      expect(result.language).toBe('php');
      expect(result.detectedBy).toBe('extension');
    });

    it('should return none when nothing detected', () => {
      const result = detectProjectLanguageWithDetails(testDir);

      expect(result.language).toBeNull();
      expect(result.confidence).toBe('low');
      expect(result.detectedBy).toBe('none');
    });
  });

  describe('validatePHPProject', () => {
    it('should validate complete PHP project', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');
      mkdirSync(join(testDir, 'vendor'), { recursive: true });
      writeFileSync(join(testDir, 'vendor', 'autoload.php'), '<?php');

      const result = validatePHPProject(testDir);

      expect(result.valid).toBe(true);
      expect(result.hasComposer).toBe(true);
      expect(result.hasVendor).toBe(true);
      expect(result.hasAutoload).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it('should detect missing composer.json', () => {
      const result = validatePHPProject(testDir);

      expect(result.valid).toBe(false);
      expect(result.hasComposer).toBe(false);
      expect(result.missing).toContain('composer.json');
      expect(result.suggestions).toContain(
        'Run "composer init" to create composer.json'
      );
    });

    it('should detect missing vendor/autoload.php', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      const result = validatePHPProject(testDir);

      expect(result.valid).toBe(false);
      expect(result.hasComposer).toBe(true);
      expect(result.hasAutoload).toBe(false);
      expect(result.missing).toContain('vendor/autoload.php');
      expect(result.suggestions).toContain(
        'Run "composer install" to install dependencies'
      );
    });
  });

  describe('isPHPProject', () => {
    it('should return true when composer.json exists', () => {
      writeFileSync(join(testDir, 'composer.json'), '{}');

      expect(isPHPProject(testDir)).toBe(true);
    });

    it('should return false when composer.json does not exist', () => {
      expect(isPHPProject(testDir)).toBe(false);
    });
  });

  describe('isTypeScriptProject', () => {
    it('should return true when tsconfig.json exists', () => {
      writeFileSync(join(testDir, 'tsconfig.json'), '{}');

      expect(isTypeScriptProject(testDir)).toBe(true);
    });

    it('should return false when tsconfig.json does not exist', () => {
      expect(isTypeScriptProject(testDir)).toBe(false);
    });
  });

  describe('isJavaScriptProject', () => {
    it('should return true when package.json exists without tsconfig', () => {
      writeFileSync(join(testDir, 'package.json'), '{}');

      expect(isJavaScriptProject(testDir)).toBe(true);
    });

    it('should return false when tsconfig.json also exists', () => {
      writeFileSync(join(testDir, 'package.json'), '{}');
      writeFileSync(join(testDir, 'tsconfig.json'), '{}');

      expect(isJavaScriptProject(testDir)).toBe(false);
    });

    it('should return false when package.json does not exist', () => {
      expect(isJavaScriptProject(testDir)).toBe(false);
    });
  });

  describe('getSupportedLanguages', () => {
    it('should return all supported languages', () => {
      const languages = getSupportedLanguages();

      expect(languages).toContain('typescript');
      expect(languages).toContain('javascript');
      expect(languages).toContain('php');
      expect(languages).toHaveLength(3);
    });
  });

  describe('isLanguageSupported', () => {
    it('should return true for supported languages', () => {
      expect(isLanguageSupported('php')).toBe(true);
      expect(isLanguageSupported('typescript')).toBe(true);
      expect(isLanguageSupported('javascript')).toBe(true);
    });

    it('should return false for unsupported languages', () => {
      expect(isLanguageSupported('python')).toBe(false);
      expect(isLanguageSupported('ruby')).toBe(false);
      expect(isLanguageSupported('go')).toBe(false);
      expect(isLanguageSupported('cobol')).toBe(false);
    });
  });

  describe('extension-based detection', () => {
    it('should detect TypeScript by .ts files', () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      for (let i = 0; i < 15; i++) {
        writeFileSync(join(testDir, 'src', `file${i}.ts`), '');
      }

      const result = detectProjectLanguageWithDetails(testDir);

      expect(result.language).toBe('typescript');
      expect(result.detectedBy).toBe('extension');
    });

    it('should skip node_modules directory', () => {
      mkdirSync(join(testDir, 'node_modules', 'package'), { recursive: true });
      for (let i = 0; i < 100; i++) {
        writeFileSync(
          join(testDir, 'node_modules', 'package', `file${i}.js`),
          ''
        );
      }

      // No source files outside node_modules
      const result = detectProjectLanguageWithDetails(testDir);

      expect(result.language).toBeNull();
    });

    it('should skip vendor directory', () => {
      mkdirSync(join(testDir, 'vendor', 'package'), { recursive: true });
      for (let i = 0; i < 100; i++) {
        writeFileSync(join(testDir, 'vendor', 'package', `file${i}.php`), '');
      }

      // No source files outside vendor
      const result = detectProjectLanguageWithDetails(testDir);

      expect(result.language).toBeNull();
    });
  });
});
