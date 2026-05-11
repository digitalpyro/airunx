/**
 * Quality Gates - Configurable quality thresholds
 * Load and enforce quality gates from configuration
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import YAML from 'yaml';
import type { QualityMetrics } from '../core/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('quality-gates');

/**
 * Quality gates configuration
 */
export interface QualityGatesConfig {
  minCoverage?: number;
  maxIterations?: number;
  requireLintPass?: boolean;
  requireTypeCheck?: boolean;
  blockOnSecurityIssues?: boolean;
}

/**
 * Quality gates result
 */
export interface QualityGatesResult {
  passed: boolean;
  failures: string[];
  warnings: string[];
}

/**
 * Default quality gates
 */
const DEFAULT_QUALITY_GATES: QualityGatesConfig = {
  minCoverage: 80,
  maxIterations: 3,
  requireLintPass: true,
  requireTypeCheck: true,
  blockOnSecurityIssues: true,
};

/**
 * Quality Gates class
 */
export class QualityGates {
  private config: QualityGatesConfig;

  constructor(config?: QualityGatesConfig) {
    this.config = { ...DEFAULT_QUALITY_GATES, ...config };
  }

  /**
   * Load quality gates from config file
   */
  static async loadFromFile(
    configPath: string = '.airunx/config.yml'
  ): Promise<QualityGates> {
    if (!existsSync(configPath)) {
      logger.info(`Config file not found: ${configPath}, using defaults`);
      return new QualityGates();
    }

    try {
      const content = await readFile(configPath, 'utf-8');
      const config = YAML.parse(content);

      if (config.quality_gates) {
        const gatesConfig: QualityGatesConfig = {
          minCoverage: config.quality_gates.min_coverage,
          maxIterations: config.quality_gates.max_iterations,
          requireLintPass: config.quality_gates.require_lint_pass,
          requireTypeCheck: config.quality_gates.require_type_check,
          blockOnSecurityIssues: config.quality_gates.block_on_security_issues,
        };

        logger.info('Loaded quality gates from config');
        return new QualityGates(gatesConfig);
      }

      logger.info('No quality_gates section in config, using defaults');
      return new QualityGates();
    } catch (error) {
      logger.warn(
        'Failed to load quality gates config, using defaults:',
        error
      );
      return new QualityGates();
    }
  }

  /**
   * Check quality metrics against gates
   */
  check(
    metrics: QualityMetrics,
    skipJudge: boolean = false
  ): QualityGatesResult {
    logger.info('Checking quality gates');

    const failures: string[] = [];
    const warnings: string[] = [];

    if (skipJudge) {
      logger.info('Skipping quality gates (--skip-judge flag)');
      return {
        passed: true,
        failures: [],
        warnings: ['Quality gates skipped due to --skip-judge flag'],
      };
    }

    // Check coverage
    if (
      this.config.minCoverage !== undefined &&
      metrics.coverage !== undefined &&
      metrics.coverage < this.config.minCoverage
    ) {
      const message = `Test coverage ${metrics.coverage.toFixed(1)}% is below minimum ${this.config.minCoverage}%`;
      failures.push(message);
      logger.warn(message);
    }

    // Check lint
    if (this.config.requireLintPass && metrics.lintPassed === false) {
      const message = 'Lint checks failed';
      failures.push(message);
      logger.warn(message);
    }

    // Check type checking
    if (this.config.requireTypeCheck && metrics.typeCheckPassed === false) {
      const message = 'Type checks failed';
      failures.push(message);
      logger.warn(message);
    }

    // Check security issues
    if (
      this.config.blockOnSecurityIssues &&
      metrics.securityIssues !== undefined &&
      metrics.securityIssues > 0
    ) {
      const message = `${metrics.securityIssues} security issue(s) detected`;
      failures.push(message);
      logger.warn(message);
    }

    const passed = failures.length === 0;

    if (passed) {
      logger.info('All quality gates passed');
    } else {
      logger.warn(`Quality gates failed: ${failures.length} failure(s)`);
    }

    return {
      passed,
      failures,
      warnings,
    };
  }

  /**
   * Generate quality report
   */
  generateReport(
    metrics: QualityMetrics,
    gatesResult: QualityGatesResult
  ): string {
    let report = '## Quality Report\n\n';

    report += '### Metrics\n\n';

    if (metrics.coverage !== undefined) {
      const coverageIcon =
        this.config.minCoverage && metrics.coverage >= this.config.minCoverage
          ? '✓'
          : '✗';
      report += `- ${coverageIcon} **Coverage:** ${metrics.coverage.toFixed(1)}%`;
      if (this.config.minCoverage) {
        report += ` (min: ${this.config.minCoverage}%)`;
      }
      report += '\n';
    }

    if (metrics.lintPassed !== undefined) {
      const lintIcon = metrics.lintPassed ? '✓' : '✗';
      report += `- ${lintIcon} **Lint:** ${metrics.lintPassed ? 'Passed' : 'Failed'}\n`;
    }

    if (metrics.typeCheckPassed !== undefined) {
      const typeIcon = metrics.typeCheckPassed ? '✓' : '✗';
      report += `- ${typeIcon} **Type Check:** ${metrics.typeCheckPassed ? 'Passed' : 'Failed'}\n`;
    }

    if (metrics.securityIssues !== undefined) {
      const securityIcon = metrics.securityIssues === 0 ? '✓' : '✗';
      report += `- ${securityIcon} **Security:** ${metrics.securityIssues} issue(s)\n`;
    }

    if (gatesResult.failures.length > 0) {
      report += '\n### Failures\n\n';
      gatesResult.failures.forEach((failure) => {
        report += `- ✗ ${failure}\n`;
      });
    }

    if (gatesResult.warnings.length > 0) {
      report += '\n### Warnings\n\n';
      gatesResult.warnings.forEach((warning) => {
        report += `- ⚠ ${warning}\n`;
      });
    }

    report += '\n';

    return report;
  }

  /**
   * Get quality gates configuration
   */
  getConfig(): QualityGatesConfig {
    return { ...this.config };
  }
}
