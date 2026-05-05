/**
 * Validate command - validate configuration files against their schemas
 *
 * Supports:
 * - Validating individual files
 * - Validating all project configuration files
 * - Lenient mode for warnings instead of errors
 * - JSON output for CI/CD integration
 */

import chalk from 'chalk';
import ora from 'ora';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import {
  validateFile,
  validateProjectConfig,
  type ValidationResult,
  type ConfigFileType,
  KNOWN_ENUMS,
} from '../../utils/file-validator.js';
import { handleCommandError } from '../../utils/error-handlers.js';
import { createLogger } from '../../utils/logger.js';
import { getGlobalConfigDir } from '../../utils/paths.js';

const logger = createLogger('validate');

/**
 * Options for the validate command
 */
export interface ValidateOptions {
  /** Run in lenient mode (warnings instead of errors) */
  lenient?: boolean;
  /** Output in JSON format */
  json?: boolean;
  /** Validate all project config files */
  all?: boolean;
  /** Include global config files */
  global?: boolean;
  /** Specific file type to validate as */
  type?: ConfigFileType;
}

/**
 * Format a single validation result for console output
 */
function formatResultForConsole(result: ValidationResult): void {
  const statusIcon = result.valid ? chalk.green('✓') : chalk.red('✗');
  const fileTypeLabel = chalk.dim(`(${result.fileType})`);

  console.log(`\n${statusIcon} ${result.filePath} ${fileTypeLabel}`);

  if (result.issues.length === 0) {
    console.log(chalk.green('  No issues found'));
    return;
  }

  for (const issue of result.issues) {
    let icon: string;
    let colorFn: typeof chalk.red;

    switch (issue.severity) {
      case 'error':
        icon = chalk.red('✗');
        colorFn = chalk.red;
        break;
      case 'warning':
        icon = chalk.yellow('⚠');
        colorFn = chalk.yellow;
        break;
      default:
        icon = chalk.blue('ℹ');
        colorFn = chalk.blue;
    }

    console.log(`  ${icon} ${colorFn(`[${issue.path}]`)} ${issue.message}`);

    if (issue.value !== undefined) {
      console.log(chalk.dim(`      Value: ${JSON.stringify(issue.value)}`));
    }

    if (issue.suggestion) {
      console.log(chalk.cyan(`      💡 ${issue.suggestion}`));
    }
  }
}

/**
 * Summarize validation results using single-pass reduce for efficiency
 */
function summarizeResults(results: ValidationResult[]): {
  total: number;
  valid: number;
  invalid: number;
  errors: number;
  warnings: number;
} {
  return results.reduce(
    (acc, result) => {
      acc.total++;
      result.valid ? acc.valid++ : acc.invalid++;
      result.issues.forEach((issue) => {
        if (issue.severity === 'error') acc.errors++;
        if (issue.severity === 'warning') acc.warnings++;
      });
      return acc;
    },
    { total: 0, valid: 0, invalid: 0, errors: 0, warnings: 0 }
  );
}

/**
 * Main validate command handler
 */
export async function validateCommand(
  files: string[],
  options: ValidateOptions
): Promise<void> {
  const spinner = ora('Validating configuration files...').start();

  try {
    const mode = options.lenient ? 'lenient' : 'strict';
    const results: ValidationResult[] = [];

    // Track whether we validated anything (for default behavior)
    let validatedSomething = false;

    // Helper to validate project configuration files (deduplicates against already validated files)
    const runProjectValidation = (): void => {
      spinner.text = 'Validating project configuration files...';
      const projectDir = process.cwd();
      const projectResults = validateProjectConfig(projectDir, { mode });
      // Filter out files that have already been validated to prevent duplicates
      const existingPaths = new Set(results.map((r) => r.filePath));
      results.push(
        ...projectResults.filter((r) => !existingPaths.has(r.filePath))
      );
      validatedSomething = true;
    };

    // Validate specific files if provided
    if (files.length > 0) {
      for (const filePath of files) {
        spinner.text = `Validating ${filePath}...`;
        const resolvedPath = resolve(filePath);
        results.push(
          validateFile(resolvedPath, { mode, fileType: options.type })
        );
      }
      validatedSomething = true;
    }

    // Validate project config if --all is specified
    if (options.all) {
      runProjectValidation();
    }

    // Validate global config if --global is specified
    if (options.global) {
      spinner.text = 'Validating global configuration files...';
      const globalDir = getGlobalConfigDir();

      const globalFiles = [
        { path: join(globalDir, 'settings.json'), type: 'settings' as const },
        {
          path: join(globalDir, 'config.yml'),
          type: 'system-config' as const,
        },
        {
          path: join(globalDir, 'pipelines.yaml'),
          type: 'pipelines' as const,
        },
        { path: join(globalDir, 'AGENTS.md'), type: 'agents' as const },
      ];

      for (const { path, type } of globalFiles) {
        if (existsSync(path)) {
          results.push(validateFile(path, { mode, fileType: type }));
        }
      }
      validatedSomething = true;
    }

    // Default behavior: if no files or flags provided, validate project config
    if (!validatedSomething) {
      runProjectValidation();
    }

    spinner.stop();

    // Output results
    if (options.json) {
      // JSON output for CI/CD
      const summary = summarizeResults(results);
      console.log(
        JSON.stringify(
          {
            success: summary.invalid === 0,
            summary,
            results: results.map((r) => ({
              file: r.filePath,
              type: r.fileType,
              valid: r.valid,
              issues: r.issues,
            })),
          },
          null,
          2
        )
      );
    } else {
      // Console output
      console.log(chalk.bold.blue('\n🔍 Configuration Validation Results\n'));

      if (results.length === 0) {
        console.log(chalk.yellow('No configuration files found to validate.'));
        console.log(
          chalk.dim('Run "airunx init" to create project configuration.\n')
        );
        return;
      }

      for (const result of results) {
        formatResultForConsole(result);
      }

      // Summary
      const summary = summarizeResults(results);
      console.log(chalk.bold('\n📋 Summary:'));
      console.log(`  Files validated: ${summary.total}`);
      console.log(chalk.green(`  Valid: ${summary.valid}`));

      if (summary.invalid > 0) {
        console.log(chalk.red(`  Invalid: ${summary.invalid}`));
      }

      if (summary.errors > 0) {
        console.log(chalk.red(`  Errors: ${summary.errors}`));
      }

      if (summary.warnings > 0) {
        console.log(chalk.yellow(`  Warnings: ${summary.warnings}`));
      }

      console.log();

      // Exit code based on validation results
      if (summary.invalid > 0) {
        console.log(
          chalk.red('Validation failed. Fix the errors above and try again.\n')
        );
        process.exit(1);
      } else if (summary.warnings > 0) {
        console.log(
          chalk.yellow(
            'Validation passed with warnings. Consider addressing them.\n'
          )
        );
      } else {
        console.log(chalk.green('All configuration files are valid!\n'));
      }
    }
  } catch (error) {
    spinner.stop();
    handleCommandError(error, logger, 'Validation');
    process.exit(1);
  }
}

/**
 * Generate schema documentation for a file type
 */
export function showSchemaHelp(fileType?: ConfigFileType): void {
  console.log(chalk.bold.blue('\n📖 Configuration File Schemas\n'));

  const schemas: Record<
    ConfigFileType,
    { file: string; description: string; keys: string[] }
  > = {
    settings: {
      file: 'settings.json',
      description: 'Project and user settings',
      keys: [
        'context_location - Path to context file',
        'mcp_json_location - Path to MCP config',
        'agents_md_location - Path to AGENTS.md',
        'pipelines_yaml_location - Path to pipelines.yaml',
        'default_project_location - Default project directory',
        `default_fidelity - Default execution fidelity (${KNOWN_ENUMS.fidelityLevels.join('|')})`,
        `default_backend - Default backend (${KNOWN_ENUMS.backendTypes.join('|')})`,
        'skip_version_check - Skip version update checks',
        'default_base_branch - Default git base branch',
      ],
    },
    pipelines: {
      file: 'pipelines.yaml',
      description: 'Pipeline workflow definitions',
      keys: [
        'pipelines.<name>.name - Pipeline display name',
        'pipelines.<name>.description - Pipeline description',
        'pipelines.<name>.default_fidelity - Default fidelity for stages',
        'pipelines.<name>.stages[].name - Stage name',
        `pipelines.<name>.stages[].agent - Agent role (${KNOWN_ENUMS.agentRoles.slice(0, 3).join('|')}|...)`,
        'pipelines.<name>.stages[].tools - List of tools available',
        'pipelines.<name>.stages[].fidelity - Stage fidelity override',
        'pipelines.<name>.stages[].optional - Whether stage is optional',
      ],
    },
    agents: {
      file: 'AGENTS.md',
      description: 'Agent role definitions in Markdown format',
      keys: [
        '### <role-name> - Define an agent role',
        '- **Purpose**: - Agent purpose description',
        '- **Responsibilities**: - Comma-separated responsibilities',
        '- **Tools**: - Comma-separated available tools',
        '## Pipeline Flow - Optional pipeline visualization',
        '## Conventions - Project conventions',
      ],
    },
    'system-config': {
      file: 'config.yml',
      description: 'System configuration for backends and fidelity',
      keys: [
        'agent_routing.<role> - Backend for each agent role',
        'backends.<name>.type - Backend type (cli)',
        'backends.<name>.executable - CLI executable name',
        'backends.<name>.timeout - Execution timeout in seconds',
        'fallback_backend - Default backend when not specified',
        'verify_on_start - Verify backends on startup',
        'cache_ttl_minutes - Cache TTL for backend checks',
        'execution_fidelity.default_level - Default fidelity level',
        'execution_fidelity.levels.<level> - Fidelity parameters',
      ],
    },
    unknown: {
      file: 'unknown',
      description: 'File type could not be determined',
      keys: [],
    },
  };

  if (fileType && fileType !== 'unknown') {
    const schema = schemas[fileType];
    console.log(chalk.bold(`${schema.file}`));
    console.log(chalk.dim(schema.description));
    console.log();

    for (const key of schema.keys) {
      console.log(`  • ${key}`);
    }
    console.log();
  } else {
    for (const [type, schema] of Object.entries(schemas)) {
      if (type === 'unknown') continue;

      console.log(chalk.bold(`${schema.file}`));
      console.log(chalk.dim(schema.description));
      console.log();

      for (const key of schema.keys) {
        console.log(`  • ${key}`);
      }
      console.log();
    }
  }
}
