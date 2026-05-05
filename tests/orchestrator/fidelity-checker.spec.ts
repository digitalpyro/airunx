/**
 * Tests for Fidelity Checker
 * Validates quality verification for implementations
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FidelityChecker } from '../../src/orchestrator/fidelity-checker.js';
import type { ExecutionResult } from '../../src/core/adapter-types.js';

describe('Fidelity Checker', () => {
  let fidelityChecker: FidelityChecker;

  beforeEach(() => {
    fidelityChecker = new FidelityChecker();
  });

  describe('Basic Checks', () => {
    it('should pass when verification disabled', async () => {
      const executionResult: ExecutionResult = {
        success: true,
        outputs: { file1: 'console.log("test")' },
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      const result = await fidelityChecker.check(executionResult, {
        enableVerification: false,
      });

      expect(result.passed).toBe(true);
    });

    it('should run verification when enabled', async () => {
      const executionResult: ExecutionResult = {
        success: true,
        outputs: { file1: 'const x = 1;' },
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      const result = await fidelityChecker.check(executionResult, {
        enableVerification: true,
      });

      // Should have verification result
      expect(result.verification).toBeDefined();
    });

    it('should fail when execution result has errors', async () => {
      const executionResult: ExecutionResult = {
        success: false,
        outputs: {},
        metrics: { tokensUsed: 0, duration: 0 },
        errors: [new Error('Execution failed')],
      };

      const result = await fidelityChecker.check(executionResult, {
        enableVerification: true,
      });

      expect(result.passed).toBe(false);
    });

    it('should build quality metrics from verification', async () => {
      const executionResult: ExecutionResult = {
        success: true,
        outputs: {
          files: [
            { path: 'test.ts', content: 'const x = 1;' },
          ],
        },
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      const result = await fidelityChecker.check(executionResult, {
        enableVerification: true,
      });

      expect(result.qualityMetrics).toBeDefined();
      // Syntax Validation check should be present with files
      expect(typeof result.qualityMetrics.typeCheckPassed).toBe('boolean');
      expect(typeof result.qualityMetrics.securityIssues).toBe('number');
    });
  });

  describe('Coverage Checks', () => {
    it('should pass when coverage meets minimum', async () => {
      const executionResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      // Mock coverage to return high value
      vi.spyOn(fidelityChecker as any, 'checkTestCoverage').mockResolvedValue(
        85
      );

      const result = await fidelityChecker.check(executionResult, {
        enableVerification: true,
        minCoverage: 80,
      });

      expect(result.coverage).toBe(85);
      expect(result.passed).toBe(true);
    });

    it('should fail when coverage below minimum', async () => {
      const executionResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      // Mock coverage to return low value
      vi.spyOn(fidelityChecker as any, 'checkTestCoverage').mockResolvedValue(
        60
      );

      const result = await fidelityChecker.check(executionResult, {
        enableVerification: true,
        minCoverage: 80,
      });

      expect(result.passed).toBe(false);
      expect(result.findings).toContainEqual(
        'Test coverage 60.0% is below minimum 80%'
      );
    });

    it('should handle undefined coverage gracefully', async () => {
      const executionResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      // Mock coverage to return undefined
      vi.spyOn(fidelityChecker as any, 'checkTestCoverage').mockResolvedValue(
        undefined
      );

      const result = await fidelityChecker.check(executionResult, {
        enableVerification: true,
        minCoverage: 80,
      });

      // Should not fail on undefined coverage
      expect(result.coverage).toBeUndefined();
    });
  });

  describe('Acceptance Criteria', () => {
    it('should check acceptance criteria with test commands', async () => {
      const executionResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      const acceptanceCriteria = [
        {
          description: 'Feature works correctly',
          required: true,
          testCommand: 'npm test',
        },
      ];

      // Mock test command to succeed
      vi.spyOn(fidelityChecker as any, 'checkAcceptanceCriteria').mockResolvedValue(
        new Map([[acceptanceCriteria[0], true]])
      );

      const result = await fidelityChecker.check(executionResult, {
        enableVerification: true,
        acceptanceCriteria,
      });

      expect(result.passed).toBe(true);
    });

    it('should fail when required criteria not met', async () => {
      const executionResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      const acceptanceCriteria = [
        {
          description: 'Feature works correctly',
          required: true,
          testCommand: 'npm test',
        },
      ];

      // Mock test command to fail
      vi.spyOn(fidelityChecker as any, 'checkAcceptanceCriteria').mockResolvedValue(
        new Map([[acceptanceCriteria[0], false]])
      );

      const result = await fidelityChecker.check(executionResult, {
        enableVerification: true,
        acceptanceCriteria,
      });

      expect(result.passed).toBe(false);
      expect(result.unmetCriteria).toContain('Feature works correctly');
    });

    it('should collect all unmet required criteria', async () => {
      const executionResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      const acceptanceCriteria = [
        {
          description: 'Criteria 1',
          required: true,
          testCommand: 'test1',
        },
        {
          description: 'Criteria 2',
          required: true,
          testCommand: 'test2',
        },
        {
          description: 'Criteria 3',
          required: false,
          testCommand: 'test3',
        },
      ];

      // Mock: criteria 1 passes, criteria 2 fails, criteria 3 fails (but optional)
      vi.spyOn(fidelityChecker as any, 'checkAcceptanceCriteria').mockResolvedValue(
        new Map([
          [acceptanceCriteria[0], true],
          [acceptanceCriteria[1], false],
          [acceptanceCriteria[2], false],
        ])
      );

      const result = await fidelityChecker.check(executionResult, {
        enableVerification: true,
        acceptanceCriteria,
      });

      expect(result.passed).toBe(false);
      expect(result.unmetCriteria).toHaveLength(1);
      expect(result.unmetCriteria).toContain('Criteria 2');
      expect(result.unmetCriteria).not.toContain('Criteria 3'); // Optional
    });
  });

  describe('Lint Checks', () => {
    it('should run lint checks', async () => {
      const result = await fidelityChecker.checkLint('/test/dir');

      // Will fail in test environment but shouldn't throw
      expect(typeof result).toBe('boolean');
    });
  });

  describe('Type Checks', () => {
    it('should run type checks', async () => {
      const result = await fidelityChecker.checkTypes('/test/dir');

      // Will fail in test environment but shouldn't throw
      expect(typeof result).toBe('boolean');
    });
  });

  describe('Error Handling', () => {
    it('should handle verification errors gracefully', async () => {
      const executionResult: ExecutionResult = {
        success: true,
        outputs: { file1: 'invalid code {{{' },
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      const result = await fidelityChecker.check(executionResult, {
        enableVerification: true,
      });

      // Should not throw, should return result with findings
      expect(result).toBeDefined();
      expect(result.passed).toBeDefined();
    });

    it('should collect findings from failed checks', async () => {
      const executionResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      // Mock multiple failures
      vi.spyOn(fidelityChecker as any, 'checkTestCoverage').mockResolvedValue(
        50
      );

      const result = await fidelityChecker.check(executionResult, {
        enableVerification: true,
        minCoverage: 80,
      });

      expect(result.findings.length).toBeGreaterThan(0);
    });
  });
});
