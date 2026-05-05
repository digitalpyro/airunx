/**
 * Language detection for multi-language project support
 *
 * Detects the primary programming language of a project based on
 * manifest files and file extensions.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { SupportedLanguage, SUPPORTED_LANGUAGES } from '../core/types.js';

/**
 * Marker file that indicates a specific language
 */
interface LanguageMarker {
  file: string;
  language: SupportedLanguage;
  priority: number;
}

/**
 * File extension to language mapping
 */
interface ExtensionMapping {
  extension: string;
  language: SupportedLanguage;
}

/**
 * Language markers ordered by priority (highest first)
 * These are manifest/config files that definitively indicate a language
 */
const LANGUAGE_MARKERS: LanguageMarker[] = [
  // PHP markers
  { file: 'composer.json', language: 'php', priority: 100 },
  { file: 'artisan', language: 'php', priority: 95 }, // Laravel

  // TypeScript/JavaScript markers
  { file: 'tsconfig.json', language: 'typescript', priority: 100 },
  { file: 'package.json', language: 'javascript', priority: 90 },
];

/**
 * File extension mappings for fallback detection
 */
const EXTENSION_MAPPINGS: ExtensionMapping[] = [
  { extension: '.php', language: 'php' },
  { extension: '.ts', language: 'typescript' },
  { extension: '.tsx', language: 'typescript' },
  { extension: '.js', language: 'javascript' },
  { extension: '.jsx', language: 'javascript' },
  { extension: '.mjs', language: 'javascript' },
  { extension: '.cjs', language: 'javascript' },
];

/**
 * Result of language detection
 */
export interface LanguageDetectionResult {
  language: SupportedLanguage | null;
  confidence: 'high' | 'medium' | 'low';
  detectedBy: 'marker' | 'extension' | 'none';
  markerFile?: string;
}

/**
 * Detects the primary programming language of a project
 *
 * @param projectRoot - Root directory of the project to analyze
 * @returns The detected language or null if unable to detect
 */
export function detectProjectLanguage(
  projectRoot: string
): SupportedLanguage | null {
  const result = detectProjectLanguageWithDetails(projectRoot);
  return result.language;
}

/**
 * Detects the primary programming language with detailed results
 *
 * @param projectRoot - Root directory of the project to analyze
 * @returns Detection result with language, confidence, and method
 */
export function detectProjectLanguageWithDetails(
  projectRoot: string
): LanguageDetectionResult {
  // First, try marker files (highest confidence)
  const markerResult = detectByMarkerFiles(projectRoot);
  if (markerResult.language) {
    return markerResult;
  }

  // Fallback to extension analysis (lower confidence)
  const extensionResult = detectByExtensions(projectRoot);
  if (extensionResult.language) {
    return extensionResult;
  }

  return {
    language: null,
    confidence: 'low',
    detectedBy: 'none',
  };
}

/**
 * Detect language by checking for marker files
 */
function detectByMarkerFiles(projectRoot: string): LanguageDetectionResult {
  // Sort markers by priority (highest first)
  const sortedMarkers = [...LANGUAGE_MARKERS].sort(
    (a, b) => b.priority - a.priority
  );

  for (const marker of sortedMarkers) {
    const markerPath = join(projectRoot, marker.file);
    if (existsSync(markerPath)) {
      return {
        language: marker.language,
        confidence: marker.priority >= 95 ? 'high' : 'medium',
        detectedBy: 'marker',
        markerFile: marker.file,
      };
    }
  }

  return {
    language: null,
    confidence: 'low',
    detectedBy: 'none',
  };
}

/**
 * Detect language by analyzing file extensions in the project
 */
function detectByExtensions(projectRoot: string): LanguageDetectionResult {
  const extensionCounts = new Map<SupportedLanguage, number>();

  try {
    countExtensionsRecursive(projectRoot, extensionCounts, 0, 3);
  } catch {
    // If we can't read the directory, return no detection
    return {
      language: null,
      confidence: 'low',
      detectedBy: 'none',
    };
  }

  if (extensionCounts.size === 0) {
    return {
      language: null,
      confidence: 'low',
      detectedBy: 'none',
    };
  }

  // Find the language with the most files
  let maxCount = 0;
  let detectedLanguage: SupportedLanguage | null = null;

  for (const [language, count] of extensionCounts) {
    if (count > maxCount) {
      maxCount = count;
      detectedLanguage = language;
    }
  }

  return {
    language: detectedLanguage,
    confidence: maxCount >= 10 ? 'medium' : 'low',
    detectedBy: 'extension',
  };
}

/**
 * Recursively count file extensions up to a maximum depth
 */
function countExtensionsRecursive(
  dir: string,
  counts: Map<SupportedLanguage, number>,
  currentDepth: number,
  maxDepth: number
): void {
  if (currentDepth > maxDepth) return;

  // Skip common non-source directories
  const skipDirs = [
    'node_modules',
    'vendor',
    '.git',
    'dist',
    'build',
    '__pycache__',
    '.venv',
    'venv',
  ];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (skipDirs.includes(entry)) continue;

    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        countExtensionsRecursive(fullPath, counts, currentDepth + 1, maxDepth);
      } else if (stat.isFile()) {
        const ext = extname(entry).toLowerCase();
        const mapping = EXTENSION_MAPPINGS.find((m) => m.extension === ext);
        if (mapping) {
          const current = counts.get(mapping.language) || 0;
          counts.set(mapping.language, current + 1);
        }
      }
    } catch {
      // Skip files we can't stat
    }
  }
}

/**
 * PHP project validation result
 */
export interface PHPProjectValidation {
  valid: boolean;
  hasComposer: boolean;
  hasVendor: boolean;
  hasAutoload: boolean;
  missing: string[];
  suggestions: string[];
}

/**
 * Validates that a PHP project has the required structure
 *
 * @param projectRoot - Root directory of the PHP project
 * @returns Validation result with details about what's present/missing
 */
export function validatePHPProject(projectRoot: string): PHPProjectValidation {
  const hasComposer = existsSync(join(projectRoot, 'composer.json'));
  const hasVendor = existsSync(join(projectRoot, 'vendor'));
  const hasAutoload = existsSync(join(projectRoot, 'vendor', 'autoload.php'));

  const missing: string[] = [];
  const suggestions: string[] = [];

  if (!hasComposer) {
    missing.push('composer.json');
    suggestions.push('Run "composer init" to create composer.json');
  }

  if (!hasVendor || !hasAutoload) {
    if (hasComposer) {
      missing.push('vendor/autoload.php');
      suggestions.push('Run "composer install" to install dependencies');
    }
  }

  return {
    valid: hasComposer && hasAutoload,
    hasComposer,
    hasVendor,
    hasAutoload,
    missing,
    suggestions,
  };
}

/**
 * Checks if a directory is a PHP project
 */
export function isPHPProject(projectRoot: string): boolean {
  return existsSync(join(projectRoot, 'composer.json'));
}

/**
 * Checks if a directory is a TypeScript project
 */
export function isTypeScriptProject(projectRoot: string): boolean {
  return existsSync(join(projectRoot, 'tsconfig.json'));
}

/**
 * Checks if a directory is a JavaScript project (without TypeScript)
 */
export function isJavaScriptProject(projectRoot: string): boolean {
  return (
    existsSync(join(projectRoot, 'package.json')) &&
    !existsSync(join(projectRoot, 'tsconfig.json'))
  );
}

/**
 * Gets all supported languages
 */
export function getSupportedLanguages(): readonly SupportedLanguage[] {
  return SUPPORTED_LANGUAGES;
}

/**
 * Checks if a language is supported
 */
export function isLanguageSupported(language: string): boolean {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(language);
}
