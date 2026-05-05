/**
 * Verification hooks for fidelity-aware execution
 * Provides additional validation checks when enable_verification is true
 */

import { extname } from 'path';
import type { ExecutionResult } from '../core/adapter-types.js';
import { createLogger } from '../utils/logger.js';
import { SupportedLanguage } from '../core/types.js';

const logger = createLogger('verification');

/**
 * Verification result
 */
export interface VerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
  errors: string[];
  warnings: string[];
}

/**
 * Individual verification check result
 */
export interface VerificationCheck {
  name: string;
  passed: boolean;
  message?: string;
  severity: 'error' | 'warning' | 'info';
}

/**
 * Verification options
 */
export interface VerificationOptions {
  enableSyntaxCheck?: boolean;
  enableSecurityCheck?: boolean;
  enableQualityCheck?: boolean;
  enableCompletionCheck?: boolean;
  /** Override language detection for security patterns */
  language?: SupportedLanguage;
}

/**
 * Security pattern definition
 */
interface SecurityPattern {
  pattern: RegExp;
  name: string;
  severity: 'critical' | 'warning';
  languages?: SupportedLanguage[];
}

/**
 * JavaScript/TypeScript security patterns
 */
const JS_SECURITY_PATTERNS: SecurityPattern[] = [
  {
    pattern: /eval\s*\(/g,
    name: 'eval() - Code execution vulnerability',
    severity: 'critical',
    languages: ['javascript', 'typescript'],
  },
  {
    pattern: /new\s+Function\s*\(/g,
    name: 'new Function() - Code execution vulnerability',
    severity: 'critical',
    languages: ['javascript', 'typescript'],
  },
  {
    pattern: /dangerouslySetInnerHTML/g,
    name: 'dangerouslySetInnerHTML - XSS vulnerability',
    severity: 'warning',
    languages: ['javascript', 'typescript'],
  },
  {
    pattern: /document\.write\s*\(/g,
    name: 'document.write() - DOM manipulation risk',
    severity: 'warning',
    languages: ['javascript', 'typescript'],
  },
  {
    pattern: /innerHTML\s*=/g,
    name: 'innerHTML assignment - XSS vulnerability',
    severity: 'warning',
    languages: ['javascript', 'typescript'],
  },
  {
    pattern: /\.html\s*\(\s*[^)]*\$\{/g,
    name: 'jQuery .html() with template literal - XSS risk',
    severity: 'warning',
    languages: ['javascript', 'typescript'],
  },
];

/**
 * Gets security patterns for a specific language or all if not specified
 */
export function getSecurityPatternsForLanguage(
  language?: SupportedLanguage
): SecurityPattern[] {
  if (!language) {
    return [...JS_SECURITY_PATTERNS];
  }

  return JS_SECURITY_PATTERNS.filter(
    (p) => !p.languages || p.languages.includes(language)
  );
}

/**
 * Verify execution result with comprehensive checks
 */
export async function verifyExecutionResult(
  result: ExecutionResult,
  options: VerificationOptions = {}
): Promise<VerificationResult> {
  logger.info('Starting execution result verification');

  const checks: VerificationCheck[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  // Default to all checks enabled
  const {
    enableSyntaxCheck = true,
    enableSecurityCheck = true,
    enableQualityCheck = true,
    enableCompletionCheck = true,
  } = options;

  // Check 1: Basic success check
  checks.push({
    name: 'Basic Success',
    passed: result.success,
    message: result.success
      ? 'Execution completed successfully'
      : 'Execution failed',
    severity: result.success ? 'info' : 'error',
  });

  if (!result.success) {
    errors.push('Execution did not complete successfully');
  }

  // Check 2: Error count
  const hasErrors = result.errors && result.errors.length > 0;
  checks.push({
    name: 'Error Count',
    passed: !hasErrors,
    message: hasErrors
      ? `Found ${result.errors.length} error(s)`
      : 'No errors found',
    severity: hasErrors ? 'error' : 'info',
  });

  if (hasErrors) {
    errors.push(`Execution had ${result.errors.length} error(s)`);
    result.errors.forEach((err) => {
      errors.push(err.message);
    });
  }

  // Check 3: Syntax validation (if enabled and files present)
  if (
    enableSyntaxCheck &&
    result.outputs.files &&
    result.outputs.files.length > 0
  ) {
    const syntaxCheck = await verifySyntax(result);
    checks.push(syntaxCheck);
    if (!syntaxCheck.passed) {
      errors.push(syntaxCheck.message || 'Syntax validation failed');
    }
  }

  // Check 4: Security validation (if enabled)
  if (enableSecurityCheck) {
    const securityCheck = verifySecurityIssues(result, options.language);
    checks.push(securityCheck);
    if (!securityCheck.passed && securityCheck.severity === 'error') {
      errors.push(securityCheck.message || 'Security validation failed');
    } else if (!securityCheck.passed && securityCheck.severity === 'warning') {
      warnings.push(
        securityCheck.message || 'Potential security issues detected'
      );
    }
  }

  // Check 5: Quality validation (if enabled)
  if (enableQualityCheck) {
    const qualityCheck = verifyQuality(result);
    checks.push(qualityCheck);
    if (!qualityCheck.passed && qualityCheck.severity === 'warning') {
      warnings.push(qualityCheck.message || 'Quality concerns detected');
    }
  }

  // Check 6: Completion validation (if enabled)
  if (enableCompletionCheck) {
    const completionCheck = verifyCompletion(result);
    checks.push(completionCheck);
    if (!completionCheck.passed) {
      warnings.push(completionCheck.message || 'Incomplete execution detected');
    }
  }

  const passed = errors.length === 0;

  logger.info(
    `Verification complete: ${passed ? 'PASSED' : 'FAILED'} ` +
      `(${errors.length} errors, ${warnings.length} warnings)`
  );

  return {
    passed,
    checks,
    errors,
    warnings,
  };
}

/**
 * Verify syntax of generated files
 */
async function verifySyntax(
  result: ExecutionResult
): Promise<VerificationCheck> {
  // Simplified syntax check - in a real implementation, this would use
  // language-specific parsers (TypeScript compiler, ESLint, etc.)

  const files = result.outputs.files || [];
  const syntaxIssues: string[] = [];

  for (const file of files) {
    if (!file.content) continue;

    // Basic checks for common syntax issues
    const content = file.content;

    // Check for unbalanced braces/brackets/parentheses
    const openBraces = (content.match(/{/g) || []).length;
    const closeBraces = (content.match(/}/g) || []).length;
    const openBrackets = (content.match(/\[/g) || []).length;
    const closeBrackets = (content.match(/]/g) || []).length;
    const openParens = (content.match(/\(/g) || []).length;
    const closeParens = (content.match(/\)/g) || []).length;

    if (
      openBraces !== closeBraces ||
      openBrackets !== closeBrackets ||
      openParens !== closeParens
    ) {
      syntaxIssues.push(
        `Unbalanced braces/brackets/parentheses in ${file.path}`
      );
    }
  }

  if (syntaxIssues.length > 0) {
    return {
      name: 'Syntax Validation',
      passed: false,
      message: syntaxIssues.join('\n'),
      severity: 'error',
    };
  }

  return {
    name: 'Syntax Validation',
    passed: true,
    message: 'Syntax checks passed',
    severity: 'info',
  };
}

/**
 * Verify for potential security issues
 *
 * @param result - Execution result to verify
 * @param language - Optional language for targeted security checks
 */
function verifySecurityIssues(
  result: ExecutionResult,
  language?: SupportedLanguage
): VerificationCheck {
  const files = result.outputs.files || [];
  const securityIssues: string[] = [];
  let hasCritical = false;

  // Get language-specific security patterns
  const securityPatterns = getSecurityPatternsForLanguage(language);

  for (const file of files) {
    if (!file.content) continue;

    // Detect file language from extension if not specified
    const fileLanguage = language || detectFileLanguage(file.path);
    const patternsToCheck = fileLanguage
      ? securityPatterns.filter(
          (p) => !p.languages || p.languages.includes(fileLanguage)
        )
      : securityPatterns;

    // Check line-by-line to support // nosec comments
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip lines with nosec comment
      if (/(?:\/\/|#)\s*nosec/.test(line)) continue;

      for (const { pattern, name, severity } of patternsToCheck) {
        // Reset pattern lastIndex for global patterns
        pattern.lastIndex = 0;

        if (pattern.test(line)) {
          securityIssues.push(
            `[${severity.toUpperCase()}] ${name} in ${file.path} on line ${i + 1}`
          );
          if (severity === 'critical') {
            hasCritical = true;
          }
        }
      }
    }
  }

  // Check for hardcoded secrets with refined patterns to reduce false positives
  // TODO: Future improvements:
  //   - Exclude test files (*.test.*, *.spec.*, __tests__/*)
  //   - Consider integrating a dedicated secret-scanning library for production use

  // More specific patterns targeting actual secret formats
  const secretPatterns: Array<{ pattern: RegExp; name: string }> = [
    // API keys with common prefixes (sk-, pk-, key_, etc.) and high entropy
    {
      pattern:
        /(?:api[_-]?key|apikey)\s*[=:]\s*['"`]?(?:sk-|pk-|key_)[a-zA-Z0-9_-]{20,}['"`]?/i,
      name: 'API key with prefix',
    },
    // AWS keys
    { pattern: /(?:AKIA|A3T)[A-Z0-9]{16,}/, name: 'AWS access key' },
    // Generic high-entropy secrets (exclude common test values)
    {
      pattern:
        /(?:secret|token|password)\s*[=:]\s*['"`]?(?!test|example|dummy|placeholder|your-|xxx)[a-zA-Z0-9_-]{32,}['"`]?/i,
      name: 'High-entropy secret',
    },
    // GitHub tokens
    { pattern: /ghp_[a-zA-Z0-9]{36}/, name: 'GitHub personal access token' },
    // Slack tokens
    { pattern: /xox[baprs]-[a-zA-Z0-9-]+/, name: 'Slack token' },
  ];

  for (const file of files) {
    if (!file.content) continue;

    // Skip lines with nosec comment
    const lines = file.content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip if line has nosec comment
      if (/(?:\/\/|#)\s*nosec/.test(line)) continue;

      for (const { pattern, name } of secretPatterns) {
        if (pattern.test(line)) {
          securityIssues.push(
            `Potential hardcoded ${name} detected in ${file.path}:${i + 1}`
          );
        }
      }
    }
  }

  if (securityIssues.length > 0) {
    // Determine severity based on whether critical issues or secrets were found
    const hasSecrets = securityIssues.some((issue) =>
      issue.includes('hardcoded')
    );
    return {
      name: 'Security Validation',
      passed: false,
      message: securityIssues.join('\n'),
      severity: hasCritical || hasSecrets ? 'error' : 'warning',
    };
  }

  return {
    name: 'Security Validation',
    passed: true,
    message: 'No obvious security issues detected',
    severity: 'info',
  };
}

/**
 * Detect language from file extension
 */
function detectFileLanguage(filePath: string): SupportedLanguage | undefined {
  const ext = extname(filePath.toLowerCase());

  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    default:
      return undefined;
  }
}

/**
 * Verify code quality
 */
function verifyQuality(result: ExecutionResult): VerificationCheck {
  const files = result.outputs.files || [];
  const qualityIssues: string[] = [];

  if (files.length === 0) {
    return {
      name: 'Quality Validation',
      passed: true,
      message: 'No files to check',
      severity: 'info',
    };
  }

  // Basic quality checks
  for (const file of files) {
    if (!file.content) continue;

    // Check for TODO/FIXME comments (warning)
    if (/TODO|FIXME|XXX|HACK/i.test(file.content)) {
      qualityIssues.push(`Found TODO/FIXME comments in ${file.path}`);
    }

    // Check for console.log (warning for production code)
    if (/console\.log/i.test(file.content)) {
      qualityIssues.push(`Found console.log statements in ${file.path}`);
    }
  }

  if (qualityIssues.length > 0) {
    return {
      name: 'Quality Validation',
      passed: false,
      message: qualityIssues.join('\n'),
      severity: 'warning',
    };
  }

  return {
    name: 'Quality Validation',
    passed: true,
    message: 'Quality checks passed',
    severity: 'info',
  };
}

/**
 * Verify execution completion
 */
function verifyCompletion(result: ExecutionResult): VerificationCheck {
  const analysis = result.outputs.analysis || '';

  // Check for incomplete indicators
  const incompletePatterns = [
    /incomplete/i,
    /\.\.\./,
    /to be continued/i,
    /work in progress/i,
    /not implemented/i,
  ];

  for (const pattern of incompletePatterns) {
    if (pattern.test(analysis)) {
      return {
        name: 'Completion Validation',
        passed: false,
        message: 'Execution appears to be incomplete',
        severity: 'warning',
      };
    }
  }

  return {
    name: 'Completion Validation',
    passed: true,
    message: 'Execution appears complete',
    severity: 'info',
  };
}
