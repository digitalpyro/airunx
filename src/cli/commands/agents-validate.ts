/**
 * Agents-validate command - Interactive AGENTS.md validation
 *
 * Provides interactive validation for AGENTS.md files with:
 * - Model validation with typo suggestions
 * - Interactive confirmation prompts for invalid values
 * - Auto-fix mode for CI/CD
 * - Cost warnings for expensive models
 */

import chalk from 'chalk';
import ora from 'ora';
import {
  validateAgentsMdWithConfirmation,
  formatAgentsValidationResult,
  formatAgentsValidationResultJson,
  type AgentsValidatorOptions,
} from '../../utils/agents-validator.js';
import { getCommonModelAliases } from '../../utils/agents-schema.js';
import { handleCommandError } from '../../utils/error-handlers.js';
import { createLogger } from '../../utils/logger.js';
import { loadSettings } from '../../utils/settings.js';
import { resolveAgentsMdPath } from '../../utils/paths.js';

const logger = createLogger('agents-validate');

/**
 * Options for the agents-validate command
 */
export interface AgentsValidateCommandOptions {
  /** Run in non-interactive mode (no prompts) */
  nonInteractive?: boolean;
  /** Automatically apply suggested fixes */
  fix?: boolean;
  /** Show cost warnings for expensive models */
  costWarnings?: boolean;
  /** Run in lenient mode (warnings instead of errors) */
  lenient?: boolean;
  /** Output in JSON format */
  json?: boolean;
}

/**
 * Main agents-validate command handler
 */
export async function agentsValidateCommand(
  filePath?: string,
  options: AgentsValidateCommandOptions = {}
): Promise<void> {
  const spinner = options.json ? null : ora('Locating AGENTS.md...').start();

  try {
    // Resolve AGENTS.md path using shared utility
    const settings = loadSettings();
    const agentsPath = resolveAgentsMdPath(filePath, settings);

    if (!agentsPath) {
      spinner?.stop();
      // Provide specific error message based on whether explicit path was given
      const errorMessage = filePath
        ? `AGENTS.md file not found at specified path: ${filePath}`
        : 'AGENTS.md file not found';

      if (options.json) {
        console.log(
          JSON.stringify({
            valid: false,
            error: errorMessage,
            suggestion:
              'Run "airunx init" to create a default AGENTS.md or specify a path',
          })
        );
      } else {
        if (filePath) {
          // Explicit path was given but not found
          console.log(
            chalk.red(
              `\n✗ AGENTS.md file not found at specified path: ${filePath}\n`
            )
          );
        } else {
          // Auto-detection failed
          console.log(chalk.red('\n✗ AGENTS.md file not found\n'));
          console.log(
            chalk.dim(
              '  Searched: .airunx/AGENTS.md, .agents/AGENTS.md, settings.json path\n'
            )
          );
        }
        console.log(
          chalk.cyan('  💡 Run "airunx init" to create a default AGENTS.md\n')
        );
      }
      process.exit(1);
    }

    if (spinner) {
      spinner.text = `Validating ${agentsPath}...`;
    }

    // Build validator options
    const validatorOptions: AgentsValidatorOptions = {
      interactive: !options.nonInteractive,
      fix: options.fix,
      costWarnings: options.costWarnings ?? true,
      mode: options.lenient ? 'lenient' : 'strict',
      json: options.json,
    };

    spinner?.stop();

    // Run validation
    const result = await validateAgentsMdWithConfirmation(
      agentsPath,
      validatorOptions
    );

    // Output results
    if (options.json) {
      console.log(formatAgentsValidationResultJson(result));
    } else {
      console.log(chalk.bold.blue('\n🔍 AGENTS.md Validation Results'));
      formatAgentsValidationResult(result);

      // Summary - count all severities in single pass
      const { errorCount, warningCount, infoCount } = result.issues.reduce(
        (counts, issue) => {
          if (issue.severity === 'error') counts.errorCount++;
          else if (issue.severity === 'warning') counts.warningCount++;
          else if (issue.severity === 'info') counts.infoCount++;
          return counts;
        },
        { errorCount: 0, warningCount: 0, infoCount: 0 }
      );

      console.log(chalk.bold('\n📋 Summary:'));
      if (result.fixesApplied.length > 0) {
        console.log(
          chalk.green(`  Fixes applied: ${result.fixesApplied.length}`)
        );
      }
      if (errorCount > 0) {
        console.log(chalk.red(`  Errors: ${errorCount}`));
      }
      if (warningCount > 0) {
        console.log(chalk.yellow(`  Warnings: ${warningCount}`));
      }
      if (infoCount > 0) {
        console.log(chalk.blue(`  Info: ${infoCount}`));
      }
      if (errorCount === 0 && warningCount === 0 && infoCount === 0) {
        console.log(chalk.green('  All checks passed!'));
      }

      console.log();

      if (!result.valid) {
        console.log(
          chalk.red('Validation failed. Fix the errors above and try again.\n')
        );
        console.log(
          chalk.dim('  Tip: Use --fix to automatically apply suggested fixes\n')
        );
      } else if (warningCount > 0) {
        console.log(
          chalk.yellow(
            'Validation passed with warnings. Consider addressing them.\n'
          )
        );
      } else {
        console.log(chalk.green('AGENTS.md is valid!\n'));
      }
    }

    // Exit with appropriate code
    if (!result.valid) {
      process.exit(1);
    }
  } catch (error) {
    spinner?.stop();
    handleCommandError(error, logger, 'Agents validation');
    process.exit(1);
  }
}

/**
 * Show help for agents-validate command
 */
export function showAgentsValidateHelp(): void {
  console.log(chalk.bold.blue('\n📖 AGENTS.md Validation Help\n'));

  console.log(chalk.bold('Usage:'));
  console.log('  airunx agents-validate [path] [options]\n');

  console.log(chalk.bold('Arguments:'));
  console.log('  path      Path to AGENTS.md file (optional, auto-detected)\n');

  console.log(chalk.bold('Options:'));
  console.log('  --fix              Automatically apply suggested fixes');
  console.log('  --non-interactive  Run without prompts (for CI/CD)');
  console.log(
    '  --no-cost-warnings Disable cost warnings for expensive models'
  );
  console.log(
    '  --lenient          Use lenient mode (warnings instead of errors)'
  );
  console.log('  --json             Output results in JSON format\n');

  console.log(chalk.bold('Examples:'));
  console.log('  airunx agents-validate');
  console.log('  airunx agents-validate ./custom/AGENTS.md');
  console.log('  airunx agents-validate --fix');
  console.log('  airunx agents-validate --non-interactive --json\n');

  console.log(chalk.bold('Valid Models:'));
  console.log(`  ${getCommonModelAliases().join(', ')}\n`);
}
