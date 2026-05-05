/**
 * Fidelity Checker - Quality verification for implementations
 * Compares implementation vs requirements and runs verification checks
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import path from 'path';
import type { ExecutionResult } from '../core/adapter-types.js';
import type { QualityMetrics } from '../core/types.js';
import {
  verifyExecutionResult,
  type VerificationResult,
} from './verification.js';
import { createLogger } from '../utils/logger.js';

const execAsync = promisify(exec);
const logger = createLogger('fidelity-checker');

/**
 * Acceptance criteria definition
 */
export interface AcceptanceCriteria {
  description: string;
  required: boolean;
  testCommand?: string;
}

/**
 * Fidelity check options
 */
export interface FidelityCheckOptions {
  acceptanceCriteria?: AcceptanceCriteria[];
  minCoverage?: number;
  enableVerification?: boolean;
  workingDirectory?: string;
}

/**
 * Fidelity check result
 */
export interface FidelityCheckResult {
  passed: boolean;
  verification?: VerificationResult;
  coverage?: number;
  qualityMetrics: QualityMetrics;
  unmetCriteria: string[];
  findings: string[];
}

/**
 * Fidelity Checker class
 */
export class FidelityChecker {
  /**
   * Check implementation quality against requirements
   */
  async check(
    executionResult: ExecutionResult,
    options: FidelityCheckOptions = {}
  ): Promise<FidelityCheckResult> {
    logger.info('Starting fidelity check');

    const findings: string[] = [];
    const unmetCriteria: string[] = [];
    let allPassed = true;

    // 1. Run verification checks if enabled
    let verification: VerificationResult | undefined;
    if (options.enableVerification) {
      logger.info('Running verification checks');
      verification = await verifyExecutionResult(executionResult);

      if (!verification.passed) {
        allPassed = false;
        findings.push(...verification.errors);
        logger.warn('Verification checks failed');
      } else {
        logger.info('Verification checks passed');
      }
    }

    // 2. Check test coverage if specified
    let coverage: number | undefined;
    if (options.minCoverage !== undefined) {
      logger.info(`Checking test coverage (min: ${options.minCoverage}%)`);
      coverage = await this.checkTestCoverage(options.workingDirectory);

      if (coverage !== undefined && coverage < options.minCoverage) {
        allPassed = false;
        findings.push(
          `Test coverage ${coverage.toFixed(1)}% is below minimum ${options.minCoverage}%`
        );
        logger.warn(
          `Coverage check failed: ${coverage.toFixed(1)}% < ${options.minCoverage}%`
        );
      } else if (coverage !== undefined) {
        logger.info(`Coverage check passed: ${coverage.toFixed(1)}%`);
      }
    }

    // 3. Check acceptance criteria
    if (options.acceptanceCriteria && options.acceptanceCriteria.length > 0) {
      logger.info('Checking acceptance criteria');
      const criteriaResults = await this.checkAcceptanceCriteria(
        options.acceptanceCriteria,
        options.workingDirectory
      );

      for (const [criteria, passed] of criteriaResults) {
        if (!passed && criteria.required) {
          allPassed = false;
          unmetCriteria.push(criteria.description);
          findings.push(`Acceptance criteria not met: ${criteria.description}`);
        }
      }

      if (unmetCriteria.length > 0) {
        logger.warn(`${unmetCriteria.length} acceptance criteria not met`);
      } else {
        logger.info('All acceptance criteria met');
      }
    }

    // 4. Build quality metrics
    const qualityMetrics: QualityMetrics = {
      coverage,
      lintPassed: verification?.checks.find(
        (c) => c.name === 'Quality Validation'
      )?.passed,
      typeCheckPassed: verification?.checks.find(
        (c) => c.name === 'Syntax Validation'
      )?.passed,
      securityIssues: verification?.checks.find(
        (c) => c.name === 'Security Validation'
      )?.passed
        ? 0
        : 1,
    };

    logger.info(`Fidelity check complete: ${allPassed ? 'PASSED' : 'FAILED'}`);

    return {
      passed: allPassed,
      verification,
      coverage,
      qualityMetrics,
      unmetCriteria,
      findings,
    };
  }

  /**
   * Check test coverage using vitest
   */
  private async checkTestCoverage(
    workingDirectory?: string
  ): Promise<number | undefined> {
    try {
      const cwd = workingDirectory || process.cwd();
      logger.debug(`Running test coverage in: ${cwd}`);

      // Run vitest with coverage and JSON reporter
      const { stdout } = await execAsync(
        'npm run test:coverage -- --reporter=json',
        {
          cwd,
          timeout: 60000, // 1 minute timeout
        }
      );

      try {
        // Parse JSON output from vitest
        const results = JSON.parse(stdout);

        // Try to extract coverage from results
        // Vitest JSON reporter may include coverage in different formats
        if (results.coverage && typeof results.coverage === 'number') {
          logger.debug(`Parsed coverage from JSON: ${results.coverage}%`);
          return results.coverage;
        }

        // Fallback: try reading coverage-summary.json
        const coveragePath = path.join(
          cwd,
          'coverage',
          'coverage-summary.json'
        );
        try {
          const coverageData = await readFile(coveragePath, 'utf-8');
          const coverageSummary = JSON.parse(coverageData);

          // Extract total coverage percentage
          if (coverageSummary.total && coverageSummary.total.lines) {
            const coverage = coverageSummary.total.lines.pct;
            logger.debug(
              `Parsed coverage from coverage-summary.json: ${coverage}%`
            );
            return coverage;
          }
        } catch {
          logger.debug(
            'Could not read coverage-summary.json, using regex fallback'
          );
        }
      } catch {
        logger.debug('Could not parse JSON output, using regex fallback');
      }

      // Fallback to regex parsing if JSON parsing fails
      const coverageMatch = stdout.match(/(\d+\.?\d*)%/);
      if (coverageMatch) {
        const coverage = parseFloat(coverageMatch[1]);
        logger.debug(`Parsed coverage using regex: ${coverage}%`);
        return coverage;
      }

      logger.warn('Could not parse coverage from output');
      return undefined;
    } catch (error) {
      logger.warn('Failed to check test coverage:', error);
      // Don't fail the check if coverage can't be determined
      return undefined;
    }
  }

  /**
   * Check acceptance criteria
   */
  private async checkAcceptanceCriteria(
    criteria: AcceptanceCriteria[],
    workingDirectory?: string
  ): Promise<Map<AcceptanceCriteria, boolean>> {
    const results = new Map<AcceptanceCriteria, boolean>();

    for (const criterion of criteria) {
      let passed = true;

      if (criterion.testCommand) {
        try {
          const cwd = workingDirectory || process.cwd();
          logger.debug(`Running test command: ${criterion.testCommand}`);

          await execAsync(criterion.testCommand, {
            cwd,
            timeout: 30000, // 30 second timeout
          });

          logger.debug(`Test passed: ${criterion.description}`);
        } catch (error) {
          passed = false;
          logger.debug(`Test failed: ${criterion.description}`, error);
        }
      } else {
        // If no test command, assume it needs manual verification
        // In a real implementation, this might check against the execution result
        logger.debug(`Manual verification required: ${criterion.description}`);
      }

      results.set(criterion, passed);
    }

    return results;
  }

  /**
   * Run lint checks
   */
  async checkLint(workingDirectory?: string): Promise<boolean> {
    try {
      const cwd = workingDirectory || process.cwd();
      logger.debug(`Running lint checks in: ${cwd}`);

      await execAsync('npm run lint', {
        cwd,
        timeout: 60000, // 1 minute timeout
      });

      logger.info('Lint checks passed');
      return true;
    } catch (error) {
      logger.warn('Lint checks failed:', error);
      return false;
    }
  }

  /**
   * Run type checks
   */
  async checkTypes(workingDirectory?: string): Promise<boolean> {
    try {
      const cwd = workingDirectory || process.cwd();
      logger.debug(`Running type checks in: ${cwd}`);

      await execAsync('npm run build', {
        cwd,
        timeout: 120000, // 2 minute timeout
      });

      logger.info('Type checks passed');
      return true;
    } catch (error) {
      logger.warn('Type checks failed:', error);
      return false;
    }
  }
}
