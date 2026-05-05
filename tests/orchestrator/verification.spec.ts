/**
 * Verification tests
 */

import { describe, it, expect } from 'vitest';
import {
  verifyExecutionResult,
  getSecurityPatternsForLanguage,
} from '../../src/orchestrator/verification.js';
import type { ExecutionResult } from '../../src/core/adapter-types.js';

describe('Verification', () => {
  const baseResult: ExecutionResult = {
    success: true,
    outputs: {
      analysis: 'Test analysis',
      files: [],
      recommendations: [],
    },
    metrics: {
      tokensUsed: 100,
      cost: 0.01,
      duration: 1000,
    },
    errors: [],
  };

  describe('verifyExecutionResult', () => {
    it('should pass verification for successful result with no issues', async () => {
      const result = await verifyExecutionResult(baseResult);

      expect(result.passed).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
      expect(result.checks.length).toBeGreaterThan(0);
    });

    it('should fail when execution success is false', async () => {
      const failedResult: ExecutionResult = {
        ...baseResult,
        success: false,
      };

      const result = await verifyExecutionResult(failedResult);

      expect(result.passed).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors).toContain('Execution did not complete successfully');
    });

    it('should detect execution errors', async () => {
      const resultWithErrors: ExecutionResult = {
        ...baseResult,
        success: false,
        errors: [new Error('Test error 1'), new Error('Test error 2')],
      };

      const result = await verifyExecutionResult(resultWithErrors);

      expect(result.passed).toBe(false);
      expect(result.errors).toContain('Execution had 2 error(s)');
    });
  });

  describe('Syntax Validation', () => {
    it('should pass for balanced braces', async () => {
      const resultWithFiles: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          files: [
            {
              path: 'test.ts',
              action: 'update',
              content: 'function test() { return { foo: "bar" }; }',
            },
          ],
        },
      };

      const result = await verifyExecutionResult(resultWithFiles);

      expect(result.passed).toBe(true);
      const syntaxCheck = result.checks.find(
        (c) => c.name === 'Syntax Validation'
      );
      expect(syntaxCheck?.passed).toBe(true);
    });

    it('should detect unbalanced braces', async () => {
      const resultWithFiles: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          files: [
            {
              path: 'test.ts',
              action: 'update',
              content: 'function test() { return { foo: "bar" }; ',
            },
          ],
        },
      };

      const result = await verifyExecutionResult(resultWithFiles);

      expect(result.passed).toBe(false);
      expect(result.errors.some((e) => e.includes('Unbalanced'))).toBe(true);
    });

    it('should detect unbalanced brackets', async () => {
      const resultWithFiles: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          files: [
            {
              path: 'test.ts',
              action: 'update',
              content: 'const arr = [1, 2, 3;',
            },
          ],
        },
      };

      const result = await verifyExecutionResult(resultWithFiles);

      expect(result.passed).toBe(false);
      expect(result.errors.some((e) => e.includes('Unbalanced'))).toBe(true);
    });

    it('should detect unbalanced parentheses', async () => {
      const resultWithFiles: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          files: [
            {
              path: 'test.ts',
              action: 'update',
              content: 'function test( { return true; }',
            },
          ],
        },
      };

      const result = await verifyExecutionResult(resultWithFiles);

      expect(result.passed).toBe(false);
      expect(result.errors.some((e) => e.includes('Unbalanced'))).toBe(true);
    });

    it('should skip syntax check when disabled', async () => {
      const resultWithFiles: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          files: [
            {
              path: 'test.ts',
              action: 'update',
              content: 'function test() { ',
            },
          ],
        },
      };

      const result = await verifyExecutionResult(resultWithFiles, {
        enableSyntaxCheck: false,
      });

      const syntaxCheck = result.checks.find(
        (c) => c.name === 'Syntax Validation'
      );
      expect(syntaxCheck).toBeUndefined();
    });
  });

  describe('Security Validation', () => {
    describe('JavaScript/TypeScript patterns', () => {
      it('should detect eval() usage as critical', async () => {
        const resultWithFiles: ExecutionResult = {
          ...baseResult,
          outputs: {
            ...baseResult.outputs,
            files: [
              {
                path: 'test.js',
                action: 'update',
                content: 'const result = eval("1 + 1");',
              },
            ],
          },
        };

        const result = await verifyExecutionResult(resultWithFiles);

        // eval() is critical severity - should result in errors
        expect(result.passed).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        const securityCheck = result.checks.find((c) => c.name === 'Security Validation');
        expect(securityCheck?.passed).toBe(false);
        expect(securityCheck?.severity).toBe('error');
      });

      it('should detect new Function() usage as critical', async () => {
        const resultWithFiles: ExecutionResult = {
          ...baseResult,
          outputs: {
            ...baseResult.outputs,
            files: [
              {
                path: 'test.js',
                action: 'update',
                content: 'const fn = new Function("a", "return a + 1");',
              },
            ],
          },
        };

        const result = await verifyExecutionResult(resultWithFiles);

        // new Function() is critical severity - should result in errors
        expect(result.passed).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        const securityCheck = result.checks.find((c) => c.name === 'Security Validation');
        expect(securityCheck?.passed).toBe(false);
        expect(securityCheck?.severity).toBe('error');
      });

      it('should detect dangerouslySetInnerHTML as warning', async () => {
        const resultWithFiles: ExecutionResult = {
          ...baseResult,
          outputs: {
            ...baseResult.outputs,
            files: [
              {
                path: 'test.tsx',
                action: 'update',
                content: '<div dangerouslySetInnerHTML={{ __html: html }} />',
              },
            ],
          },
        };

        const result = await verifyExecutionResult(resultWithFiles);

        // dangerouslySetInnerHTML is warning severity - should result in warnings
        expect(result.passed).toBe(true); // Warnings don't fail verification
        expect(result.warnings.length).toBeGreaterThan(0);
        const securityCheck = result.checks.find((c) => c.name === 'Security Validation');
        expect(securityCheck?.passed).toBe(false);
        expect(securityCheck?.severity).toBe('warning');
      });
    });

    // PHP patterns removed — this is a TypeScript/JS CLI tool

    describe('Secret detection', () => {
      it('should detect AWS access keys', async () => {
        const resultWithFiles: ExecutionResult = {
          ...baseResult,
          outputs: {
            ...baseResult.outputs,
            files: [
              {
                path: 'config.js',
                action: 'update',
                content: 'const key = "AKIAIOSFODNN7EXAMPLE";',
              },
            ],
          },
        };

        const result = await verifyExecutionResult(resultWithFiles);

        expect(result.errors.some((e) => e.includes('AWS access key'))).toBe(
          true
        );
      });

      it('should detect GitHub tokens', async () => {
        const resultWithFiles: ExecutionResult = {
          ...baseResult,
          outputs: {
            ...baseResult.outputs,
            files: [
              {
                path: 'config.js',
                action: 'update',
                content: 'const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";',
              },
            ],
          },
        };

        const result = await verifyExecutionResult(resultWithFiles);

        expect(
          result.errors.some((e) => e.includes('GitHub personal access token'))
        ).toBe(true);
      });

      it('should detect Slack tokens', async () => {
        const resultWithFiles: ExecutionResult = {
          ...baseResult,
          outputs: {
            ...baseResult.outputs,
            files: [
              {
                path: 'config.js',
                action: 'update',
                content: 'const token = "xoxb-1234567890-abcdefg";',
              },
            ],
          },
        };

        const result = await verifyExecutionResult(resultWithFiles);

        expect(result.errors.some((e) => e.includes('Slack token'))).toBe(true);
      });

      it('should detect hardcoded API keys with common prefixes', async () => {
        const resultWithFiles: ExecutionResult = {
          ...baseResult,
          outputs: {
            ...baseResult.outputs,
            files: [
              {
                path: 'config.js',
                action: 'update',
                content: 'const apiKey = "sk-1234567890abcdefghijklmnopqrstuvwxyz";',
              },
            ],
          },
        };

        const result = await verifyExecutionResult(resultWithFiles);

        expect(result.errors.some((e) => e.includes('API key'))).toBe(true);
      });

      it('should skip lines with nosec comments (// style)', async () => {
        const resultWithFiles: ExecutionResult = {
          ...baseResult,
          outputs: {
            ...baseResult.outputs,
            files: [
              {
                path: 'test.js',
                action: 'update',
                content: 'const key = "sk-test1234567890abcdefghijklmnop"; // nosec',
              },
            ],
          },
        };

        const result = await verifyExecutionResult(resultWithFiles);

        expect(result.errors.some((e) => e.includes('API key'))).toBe(false);
      });

      it('should skip lines with nosec comments (# style)', async () => {
        const resultWithFiles: ExecutionResult = {
          ...baseResult,
          outputs: {
            ...baseResult.outputs,
            files: [
              {
                path: 'test.py',
                action: 'update',
                content: 'api_key = "sk-test1234567890abcdefghijklmnop"  # nosec',
              },
            ],
          },
        };

        const result = await verifyExecutionResult(resultWithFiles);

        expect(result.errors.some((e) => e.includes('API key'))).toBe(false);
      });
    });

    describe('General', () => {
      it('should skip security check when disabled', async () => {
        const resultWithFiles: ExecutionResult = {
          ...baseResult,
          outputs: {
            ...baseResult.outputs,
            files: [
              {
                path: 'test.js',
                action: 'update',
                content: 'eval("dangerous code");',
              },
            ],
          },
        };

        const result = await verifyExecutionResult(resultWithFiles, {
          enableSecurityCheck: false,
        });

        const securityCheck = result.checks.find(
          (c) => c.name === 'Security Validation'
        );
        expect(securityCheck).toBeUndefined();
      });
    });
  });

  describe('getSecurityPatternsForLanguage', () => {
    it('should return JS patterns when no language specified', () => {
      const patterns = getSecurityPatternsForLanguage();

      // Should include JS patterns only (PHP removed)
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns.some((p) => p.name.includes('eval'))).toBe(true);
    });

    it('should return JavaScript patterns for JavaScript language', () => {
      const patterns = getSecurityPatternsForLanguage('javascript');

      // Should include JS-specific patterns
      expect(patterns.some((p) => p.name.includes('dangerouslySetInnerHTML'))).toBe(true);
      expect(patterns.some((p) => p.name.includes('innerHTML'))).toBe(true);
    });

    it('should return TypeScript patterns for TypeScript language', () => {
      const patterns = getSecurityPatternsForLanguage('typescript');

      // Should include TS-specific patterns (shared with JS)
      expect(patterns.some((p) => p.name.includes('eval'))).toBe(true);
      expect(patterns.some((p) => p.name.includes('new Function'))).toBe(true);
    });

    it('should return empty for unrecognized language', () => {
      const patterns = getSecurityPatternsForLanguage('php');

      // PHP patterns removed — no JS patterns match PHP language
      expect(patterns).toHaveLength(0);
    });
  });

  describe('Quality Validation', () => {
    it('should detect TODO comments', async () => {
      const resultWithFiles: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          files: [
            {
              path: 'test.ts',
              action: 'update',
              content: '// TODO: Implement this feature',
            },
          ],
        },
      };

      const result = await verifyExecutionResult(resultWithFiles);

      expect(result.warnings.some((w) => w.includes('TODO/FIXME'))).toBe(true);
    });

    it('should detect FIXME comments', async () => {
      const resultWithFiles: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          files: [
            {
              path: 'test.ts',
              action: 'update',
              content: '// FIXME: This is broken',
            },
          ],
        },
      };

      const result = await verifyExecutionResult(resultWithFiles);

      expect(result.warnings.some((w) => w.includes('TODO/FIXME'))).toBe(true);
    });

    it('should detect XXX comments', async () => {
      const resultWithFiles: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          files: [
            {
              path: 'test.ts',
              action: 'update',
              content: '// XXX: Needs attention',
            },
          ],
        },
      };

      const result = await verifyExecutionResult(resultWithFiles);

      expect(result.warnings.some((w) => w.includes('TODO/FIXME'))).toBe(true);
    });

    it('should detect HACK comments', async () => {
      const resultWithFiles: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          files: [
            {
              path: 'test.ts',
              action: 'update',
              content: '// HACK: Quick fix',
            },
          ],
        },
      };

      const result = await verifyExecutionResult(resultWithFiles);

      expect(result.warnings.some((w) => w.includes('TODO/FIXME'))).toBe(true);
    });

    it('should detect console.log statements', async () => {
      const resultWithFiles: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          files: [
            {
              path: 'test.js',
              action: 'update',
              content: 'console.log("debug output");',
            },
          ],
        },
      };

      const result = await verifyExecutionResult(resultWithFiles);

      expect(result.warnings.some((w) => w.includes('console.log'))).toBe(
        true
      );
    });

    it('should pass when no quality issues found', async () => {
      const resultWithFiles: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          files: [
            {
              path: 'test.ts',
              action: 'update',
              content: 'function clean() { return true; }',
            },
          ],
        },
      };

      const result = await verifyExecutionResult(resultWithFiles);

      const qualityCheck = result.checks.find(
        (c) => c.name === 'Quality Validation'
      );
      expect(qualityCheck?.passed).toBe(true);
    });

    it('should skip quality check when disabled', async () => {
      const resultWithFiles: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          files: [
            {
              path: 'test.js',
              action: 'update',
              content: '// TODO: test\nconsole.log("test");',
            },
          ],
        },
      };

      const result = await verifyExecutionResult(resultWithFiles, {
        enableQualityCheck: false,
      });

      const qualityCheck = result.checks.find(
        (c) => c.name === 'Quality Validation'
      );
      expect(qualityCheck).toBeUndefined();
    });

    it('should handle files with no content gracefully', async () => {
      const resultWithFiles: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          files: [
            {
              path: 'test.ts',
              action: 'update',
            },
          ],
        },
      };

      const result = await verifyExecutionResult(resultWithFiles);

      expect(result.passed).toBe(true);
    });
  });

  describe('Completion Validation', () => {
    it('should detect incomplete indicators', async () => {
      const resultWithIncomplete: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          analysis: 'This is incomplete and needs more work',
        },
      };

      const result = await verifyExecutionResult(resultWithIncomplete);

      expect(result.warnings.some((w) => w.includes('incomplete'))).toBe(true);
    });

    it('should detect ellipsis as incomplete indicator', async () => {
      const resultWithEllipsis: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          analysis: 'The implementation is...',
        },
      };

      const result = await verifyExecutionResult(resultWithEllipsis);

      expect(result.warnings.some((w) => w.includes('incomplete'))).toBe(true);
    });

    it('should detect "to be continued" indicator', async () => {
      const resultWithTBC: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          analysis: 'Part 1 complete. To be continued in next iteration.',
        },
      };

      const result = await verifyExecutionResult(resultWithTBC);

      expect(result.warnings.some((w) => w.includes('incomplete'))).toBe(true);
    });

    it('should detect "work in progress" indicator', async () => {
      const resultWithWIP: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          analysis: 'This is a work in progress',
        },
      };

      const result = await verifyExecutionResult(resultWithWIP);

      expect(result.warnings.some((w) => w.includes('incomplete'))).toBe(true);
    });

    it('should detect "not implemented" indicator', async () => {
      const resultWithNI: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          analysis: 'Some features are not implemented yet',
        },
      };

      const result = await verifyExecutionResult(resultWithNI);

      expect(result.warnings.some((w) => w.includes('incomplete'))).toBe(true);
    });

    it('should pass for complete execution', async () => {
      const resultComplete: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          analysis: 'Implementation is fully complete and ready',
        },
      };

      const result = await verifyExecutionResult(resultComplete);

      const completionCheck = result.checks.find(
        (c) => c.name === 'Completion Validation'
      );
      expect(completionCheck?.passed).toBe(true);
    });

    it('should skip completion check when disabled', async () => {
      const resultWithIncomplete: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          analysis: 'This is incomplete',
        },
      };

      const result = await verifyExecutionResult(resultWithIncomplete, {
        enableCompletionCheck: false,
      });

      const completionCheck = result.checks.find(
        (c) => c.name === 'Completion Validation'
      );
      expect(completionCheck).toBeUndefined();
    });
  });

  describe('Combined Validation', () => {
    it('should run all enabled checks by default', async () => {
      const result = await verifyExecutionResult(baseResult);

      expect(result.checks.length).toBeGreaterThanOrEqual(2);
      expect(result.checks.some((c) => c.name === 'Basic Success')).toBe(true);
      expect(result.checks.some((c) => c.name === 'Error Count')).toBe(true);
    });

    it('should handle multiple errors correctly', async () => {
      const resultWithIssues: ExecutionResult = {
        ...baseResult,
        success: false,
        outputs: {
          ...baseResult.outputs,
          analysis: 'This is incomplete',
          files: [
            {
              path: 'test.js',
              action: 'update',
              content: 'eval("test"); // TODO: fix',
            },
          ],
        },
        errors: [new Error('Test error')],
      };

      const result = await verifyExecutionResult(resultWithIssues);

      expect(result.passed).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should separate errors and warnings correctly', async () => {
      const resultWithBoth: ExecutionResult = {
        ...baseResult,
        success: false,
        outputs: {
          ...baseResult.outputs,
          analysis: 'Complete',
          files: [
            {
              path: 'test.js',
              action: 'update',
              content: 'function test() { console.log("test"); }',
            },
          ],
        },
      };

      const result = await verifyExecutionResult(resultWithBoth);

      expect(result.passed).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should handle empty files array', async () => {
      const resultNoFiles: ExecutionResult = {
        ...baseResult,
        outputs: {
          ...baseResult.outputs,
          files: [],
        },
      };

      const result = await verifyExecutionResult(resultNoFiles);

      expect(result.passed).toBe(true);
    });
  });
});
