/**
 * Tests for Quality Gates
 * Validates configurable quality thresholds and enforcement
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { QualityGates } from '../../src/orchestrator/quality-gates.js';
import type { QualityMetrics } from '../../src/core/types.js';
import { existsSync } from 'fs';
import { writeFile, rm, mkdir } from 'fs/promises';
import path from 'path';

describe('Quality Gates', () => {
  const TEST_CONFIG_PATH = '.airunx-test/test-config.yml';
  const TEST_CONFIG_DIR = '.airunx-test';

  beforeEach(async () => {
    // Clean up test config
    if (existsSync(TEST_CONFIG_PATH)) {
      await rm(TEST_CONFIG_PATH);
    }
  });

  afterEach(async () => {
    // Clean up test config
    if (existsSync(TEST_CONFIG_PATH)) {
      await rm(TEST_CONFIG_PATH);
    }
  });

  describe('Configuration', () => {
    it('should use default configuration', () => {
      const gates = new QualityGates();
      const config = gates.getConfig();

      expect(config.minCoverage).toBe(80);
      expect(config.maxIterations).toBe(3);
      expect(config.requireLintPass).toBe(true);
      expect(config.requireTypeCheck).toBe(true);
      expect(config.blockOnSecurityIssues).toBe(true);
    });

    it('should accept custom configuration', () => {
      const gates = new QualityGates({
        minCoverage: 90,
        maxIterations: 5,
        requireLintPass: false,
      });

      const config = gates.getConfig();
      expect(config.minCoverage).toBe(90);
      expect(config.maxIterations).toBe(5);
      expect(config.requireLintPass).toBe(false);
    });

    it('should merge custom config with defaults', () => {
      const gates = new QualityGates({
        minCoverage: 90,
      });

      const config = gates.getConfig();
      expect(config.minCoverage).toBe(90);
      expect(config.requireLintPass).toBe(true); // Still default
    });

    it('should load configuration from YAML file', async () => {
      // Create test config directory
      if (!existsSync(TEST_CONFIG_DIR)) {
        await mkdir(TEST_CONFIG_DIR, { recursive: true });
      }

      const yamlContent = `
quality_gates:
  min_coverage: 85
  max_iterations: 4
  require_lint_pass: false
  require_type_check: true
  block_on_security_issues: false
`;

      await writeFile(TEST_CONFIG_PATH, yamlContent, 'utf-8');

      const gates = await QualityGates.loadFromFile(TEST_CONFIG_PATH);
      const config = gates.getConfig();

      expect(config.minCoverage).toBe(85);
      expect(config.maxIterations).toBe(4);
      expect(config.requireLintPass).toBe(false);
      expect(config.requireTypeCheck).toBe(true);
      expect(config.blockOnSecurityIssues).toBe(false);
    });

    it('should use defaults when config file does not exist', async () => {
      const gates = await QualityGates.loadFromFile('non-existent-config.yml');
      const config = gates.getConfig();

      expect(config.minCoverage).toBe(80);
    });

    it('should use defaults when config file is invalid', async () => {
      // Create test config directory
      if (!existsSync(TEST_CONFIG_DIR)) {
        await mkdir(TEST_CONFIG_DIR, { recursive: true });
      }

      await writeFile(TEST_CONFIG_PATH, 'invalid: yaml: content:', 'utf-8');

      const gates = await QualityGates.loadFromFile(TEST_CONFIG_PATH);
      const config = gates.getConfig();

      expect(config.minCoverage).toBe(80);
    });

    it('should use defaults when quality_gates section is missing', async () => {
      // Create test config directory
      if (!existsSync(TEST_CONFIG_DIR)) {
        await mkdir(TEST_CONFIG_DIR, { recursive: true });
      }

      const yamlContent = `
other_config:
  some_value: 123
`;

      await writeFile(TEST_CONFIG_PATH, yamlContent, 'utf-8');

      const gates = await QualityGates.loadFromFile(TEST_CONFIG_PATH);
      const config = gates.getConfig();

      expect(config.minCoverage).toBe(80);
    });
  });

  describe('Coverage Checks', () => {
    it('should pass when coverage meets minimum', () => {
      const gates = new QualityGates({ minCoverage: 80 });

      const metrics: QualityMetrics = {
        coverage: 85,
      };

      const result = gates.check(metrics);

      expect(result.passed).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    it('should fail when coverage below minimum', () => {
      const gates = new QualityGates({ minCoverage: 80 });

      const metrics: QualityMetrics = {
        coverage: 75,
      };

      const result = gates.check(metrics);

      expect(result.passed).toBe(false);
      expect(result.failures).toContain(
        'Test coverage 75.0% is below minimum 80%'
      );
    });

    it('should pass when coverage is undefined and minCoverage set', () => {
      const gates = new QualityGates({ minCoverage: 80 });

      const metrics: QualityMetrics = {};

      const result = gates.check(metrics);

      expect(result.passed).toBe(true);
    });

    it('should pass when minCoverage is undefined', () => {
      const gates = new QualityGates({ minCoverage: undefined });

      const metrics: QualityMetrics = {
        coverage: 50,
      };

      const result = gates.check(metrics);

      expect(result.passed).toBe(true);
    });
  });

  describe('Lint Checks', () => {
    it('should pass when lint passed', () => {
      const gates = new QualityGates({ requireLintPass: true });

      const metrics: QualityMetrics = {
        lintPassed: true,
      };

      const result = gates.check(metrics);

      expect(result.passed).toBe(true);
    });

    it('should fail when lint failed and required', () => {
      const gates = new QualityGates({ requireLintPass: true });

      const metrics: QualityMetrics = {
        lintPassed: false,
      };

      const result = gates.check(metrics);

      expect(result.passed).toBe(false);
      expect(result.failures).toContain('Lint checks failed');
    });

    it('should pass when lint failed but not required', () => {
      const gates = new QualityGates({ requireLintPass: false });

      const metrics: QualityMetrics = {
        lintPassed: false,
      };

      const result = gates.check(metrics);

      expect(result.passed).toBe(true);
    });
  });

  describe('Type Check', () => {
    it('should pass when type check passed', () => {
      const gates = new QualityGates({ requireTypeCheck: true });

      const metrics: QualityMetrics = {
        typeCheckPassed: true,
      };

      const result = gates.check(metrics);

      expect(result.passed).toBe(true);
    });

    it('should fail when type check failed and required', () => {
      const gates = new QualityGates({ requireTypeCheck: true });

      const metrics: QualityMetrics = {
        typeCheckPassed: false,
      };

      const result = gates.check(metrics);

      expect(result.passed).toBe(false);
      expect(result.failures).toContain('Type checks failed');
    });

    it('should pass when type check failed but not required', () => {
      const gates = new QualityGates({ requireTypeCheck: false });

      const metrics: QualityMetrics = {
        typeCheckPassed: false,
      };

      const result = gates.check(metrics);

      expect(result.passed).toBe(true);
    });
  });

  describe('Security Checks', () => {
    it('should pass when no security issues', () => {
      const gates = new QualityGates({ blockOnSecurityIssues: true });

      const metrics: QualityMetrics = {
        securityIssues: 0,
      };

      const result = gates.check(metrics);

      expect(result.passed).toBe(true);
    });

    it('should fail when security issues found and blocking enabled', () => {
      const gates = new QualityGates({ blockOnSecurityIssues: true });

      const metrics: QualityMetrics = {
        securityIssues: 3,
      };

      const result = gates.check(metrics);

      expect(result.passed).toBe(false);
      expect(result.failures).toContain('3 security issue(s) detected');
    });

    it('should pass when security issues found but blocking disabled', () => {
      const gates = new QualityGates({ blockOnSecurityIssues: false });

      const metrics: QualityMetrics = {
        securityIssues: 3,
      };

      const result = gates.check(metrics);

      expect(result.passed).toBe(true);
    });
  });

  describe('Skip Judge Flag', () => {
    it('should bypass all checks when skipJudge is true', () => {
      const gates = new QualityGates({
        minCoverage: 80,
        requireLintPass: true,
        requireTypeCheck: true,
        blockOnSecurityIssues: true,
      });

      const metrics: QualityMetrics = {
        coverage: 10,
        lintPassed: false,
        typeCheckPassed: false,
        securityIssues: 10,
      };

      const result = gates.check(metrics, true);

      expect(result.passed).toBe(true);
      expect(result.failures).toHaveLength(0);
      expect(result.warnings).toContain(
        'Quality gates skipped due to --skip-judge flag'
      );
    });
  });

  describe('Multiple Failures', () => {
    it('should report all failing checks', () => {
      const gates = new QualityGates({
        minCoverage: 80,
        requireLintPass: true,
        requireTypeCheck: true,
        blockOnSecurityIssues: true,
      });

      const metrics: QualityMetrics = {
        coverage: 50,
        lintPassed: false,
        typeCheckPassed: false,
        securityIssues: 2,
      };

      const result = gates.check(metrics);

      expect(result.passed).toBe(false);
      expect(result.failures).toHaveLength(4);
      expect(result.failures).toContain(
        'Test coverage 50.0% is below minimum 80%'
      );
      expect(result.failures).toContain('Lint checks failed');
      expect(result.failures).toContain('Type checks failed');
      expect(result.failures).toContain('2 security issue(s) detected');
    });
  });

  describe('Report Generation', () => {
    it('should generate report with all metrics', () => {
      const gates = new QualityGates();

      const metrics: QualityMetrics = {
        coverage: 85,
        lintPassed: true,
        typeCheckPassed: true,
        securityIssues: 0,
      };

      const gatesResult = gates.check(metrics);
      const report = gates.generateReport(metrics, gatesResult);

      expect(report).toContain('## Quality Report');
      expect(report).toContain('### Metrics');
      expect(report).toContain('✓ **Coverage:** 85.0% (min: 80%)');
      expect(report).toContain('✓ **Lint:** Passed');
      expect(report).toContain('✓ **Type Check:** Passed');
      expect(report).toContain('✓ **Security:** 0 issue(s)');
    });

    it('should show failures in report', () => {
      const gates = new QualityGates();

      const metrics: QualityMetrics = {
        coverage: 50,
        lintPassed: false,
      };

      const gatesResult = gates.check(metrics);
      const report = gates.generateReport(metrics, gatesResult);

      expect(report).toContain('### Failures');
      expect(report).toContain('✗ Test coverage 50.0% is below minimum 80%');
      expect(report).toContain('✗ Lint checks failed');
    });

    it('should show warnings in report', () => {
      const gates = new QualityGates();

      const metrics: QualityMetrics = {};

      const gatesResult = gates.check(metrics, true); // skipJudge=true
      const report = gates.generateReport(metrics, gatesResult);

      expect(report).toContain('### Warnings');
      expect(report).toContain('⚠ Quality gates skipped due to --skip-judge flag');
    });

    it('should use correct icons for passing and failing metrics', () => {
      const gates = new QualityGates();

      const metrics: QualityMetrics = {
        coverage: 90,
        lintPassed: false,
        typeCheckPassed: true,
        securityIssues: 1,
      };

      const gatesResult = gates.check(metrics);
      const report = gates.generateReport(metrics, gatesResult);

      expect(report).toContain('✓ **Coverage:**');
      expect(report).toContain('✗ **Lint:**');
      expect(report).toContain('✓ **Type Check:**');
      expect(report).toContain('✗ **Security:** 1 issue(s)');
    });
  });
});
