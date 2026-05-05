/**
 * Interactive AGENTS.md Validator
 *
 * Provides interactive validation for AGENTS.md files with:
 * - Model validation with typo suggestions
 * - Interactive confirmation prompts for invalid values
 * - Auto-fix mode for CI/CD
 * - Cost warnings for expensive models
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import chalk from 'chalk';
import inquirer from 'inquirer';
import {
  parseAgentsMd,
  validateParsedAgents,
  getCommonModelAliases,
  type ParsedAgentsConfig,
} from './agents-schema.js';
import type { ValidationIssue, ValidationMode } from './file-validator.js';
import { createLogger } from './logger.js';

const logger = createLogger('agents-validator');

/**
 * Options for interactive validation
 */
export interface AgentsValidatorOptions {
  /** Enable interactive prompts (default: true) */
  interactive?: boolean;
  /** Automatically apply suggested fixes (default: false) */
  fix?: boolean;
  /** Show cost warnings for expensive models (default: true) */
  costWarnings?: boolean;
  /** Validation mode (default: 'strict') */
  mode?: ValidationMode;
  /** Output in JSON format (default: false) */
  json?: boolean;
}

/**
 * Result of interactive validation
 */
export interface AgentsValidationResult {
  valid: boolean;
  filePath: string;
  issues: ValidationIssue[];
  fixesApplied: string[];
  parsedConfig?: ParsedAgentsConfig;
}

/**
 * Fix action for an invalid model
 */
type ModelFixAction = 'fix' | 'keep' | 'cancel';

/**
 * Prompt user to fix an invalid model
 */
async function promptModelFix(
  agentRole: string,
  invalidModel: string,
  suggestedModel: string | null
): Promise<{ action: ModelFixAction; newValue?: string }> {
  const choices: Array<{ name: string; value: ModelFixAction }> = [];

  if (suggestedModel) {
    choices.push({
      name: `Fix to '${suggestedModel}' (recommended)`,
      value: 'fix',
    });
  }

  choices.push(
    {
      name: `Keep '${invalidModel}' and continue (may fail at runtime)`,
      value: 'keep',
    },
    {
      name: 'Cancel and edit manually',
      value: 'cancel',
    }
  );

  console.log(
    chalk.yellow(
      `\n⚠ Unknown model '${invalidModel}' for agent '${agentRole}'`
    )
  );
  if (suggestedModel) {
    console.log(chalk.cyan(`  💡 Did you mean '${suggestedModel}'?`));
  } else {
    console.log(
      chalk.dim(`  Valid models: ${getCommonModelAliases().join(', ')}`)
    );
  }

  const { action } = await inquirer.prompt<{ action: ModelFixAction }>([
    {
      type: 'list',
      name: 'action',
      message: 'How would you like to proceed?',
      choices,
    },
  ]);

  if (action === 'fix' && suggestedModel) {
    return { action, newValue: suggestedModel };
  }

  return { action };
}

/**
 * Apply a model fix to the AGENTS.md content
 * Uses lineNumber for precise targeting when available to handle duplicate agent roles
 */
function applyModelFix(
  content: string,
  agentRole: string,
  oldModel: string,
  newModel: string,
  agentLineNumber?: number
): string {
  const lines = content.split('\n');

  // Pattern to match Model line in any markdown variation (handles extra whitespace)
  const modelLinePattern = /^[-*]\s+\*?\*?\s*Model\s*\*?\*?:\s*(.+)$/i;

  if (agentLineNumber !== undefined) {
    // Use line-based targeting for precise replacement
    // The agentLineNumber is 1-indexed, convert to 0-indexed for array access
    const startIndex = agentLineNumber - 1;
    // Scan forward from agent header to find the Model line within this agent's section
    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];

      // Stop if we hit the next agent section
      if (i > startIndex && line.startsWith('### ')) {
        break;
      }

      const match = line.match(modelLinePattern);
      if (match) {
        // Strip comments before comparing (e.g., "sonnet # comment" -> "sonnet")
        const modelValueWithoutComment = match[1].trim().split('#')[0].trim();
        if (modelValueWithoutComment.toLowerCase() === oldModel.toLowerCase()) {
          // Replace only the old model value, preserving comments and surrounding text
          lines[i] = line.replace(
            new RegExp(`(?<![\\w-])${escapeRegex(oldModel)}(?![\\w-])`, 'i'),
            newModel
          );
          return lines.join('\n');
        }
      }
    }
  }

  // Fallback: skip fix if line number is missing to avoid incorrect modifications
  // with duplicate agent roles. Log warning for debugging.
  logger.warn(
    `Cannot apply model fix for '${agentRole}': line number not available. ` +
      `Skipping to avoid potential incorrect modification with duplicate roles.`
  );
  return content;
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validate AGENTS.md file with interactive confirmation
 */
export async function validateAgentsMdWithConfirmation(
  filePath: string,
  options: AgentsValidatorOptions = {}
): Promise<AgentsValidationResult> {
  const {
    interactive = true,
    fix = false,
    costWarnings = true,
    mode = 'strict',
    json = false,
  } = options;

  const result: AgentsValidationResult = {
    valid: true,
    filePath,
    issues: [],
    fixesApplied: [],
  };

  // Check file exists
  if (!existsSync(filePath)) {
    result.valid = false;
    result.issues.push({
      severity: 'error',
      path: filePath,
      message: 'AGENTS.md file not found',
      suggestion: 'Run "airunx init" to create a default AGENTS.md',
    });
    return result;
  }

  // Read and parse content
  let content = readFileSync(filePath, 'utf-8');
  let parsed = parseAgentsMd(content);
  result.parsedConfig = parsed;

  // Get validation issues
  let issues = validateParsedAgents(parsed, mode);

  // Filter cost warnings if disabled
  if (!costWarnings) {
    issues = issues.filter(
      (issue) => !(issue.severity === 'info' && issue.path.endsWith('.model'))
    );
  }

  // Separate model issues for interactive handling
  const modelIssues = issues.filter(
    (issue) =>
      issue.path.endsWith('.model') &&
      (issue.severity === 'error' || issue.severity === 'warning') &&
      issue.message.includes('Unknown model')
  );

  const otherIssues = issues.filter(
    (issue) =>
      !(
        issue.path.endsWith('.model') &&
        (issue.severity === 'error' || issue.severity === 'warning') &&
        issue.message.includes('Unknown model')
      )
  );

  // Handle model issues interactively or with auto-fix
  for (const issue of modelIssues) {
    // Extract agent role from path (e.g., "agents.orchestrator.model" -> "orchestrator")
    const pathParts = issue.path.split('.');
    const agentRole = pathParts[1];
    const invalidModel = issue.value as string;

    // Find suggested fix from structured field
    const suggestedModel = issue.suggestedValue || null;

    if (fix && suggestedModel) {
      // Auto-fix mode: apply the suggestion
      // Use lineNumber for precise targeting (handles duplicate agent roles)
      content = applyModelFix(
        content,
        agentRole,
        invalidModel,
        suggestedModel,
        issue.lineNumber
      );
      result.fixesApplied.push(
        `Fixed model for '${agentRole}': '${invalidModel}' → '${suggestedModel}'`
      );
      logger.info(
        `Auto-fixed model for ${agentRole}: ${invalidModel} → ${suggestedModel}`
      );
    } else if (interactive && !json) {
      // Interactive mode: prompt user
      const { action, newValue } = await promptModelFix(
        agentRole,
        invalidModel,
        suggestedModel
      );

      if (action === 'cancel') {
        console.log(chalk.yellow('\nValidation cancelled.'));
        result.valid = false;
        result.issues = issues;
        return result;
      }

      if (action === 'fix' && newValue) {
        // Use lineNumber for precise targeting (handles duplicate agent roles)
        content = applyModelFix(
          content,
          agentRole,
          invalidModel,
          newValue,
          issue.lineNumber
        );
        result.fixesApplied.push(
          `Fixed model for '${agentRole}': '${invalidModel}' → '${newValue}'`
        );
      } else {
        // User chose to keep invalid value - add to issues
        result.issues.push(issue);
      }
    } else {
      // Non-interactive mode: just collect the issue
      result.issues.push(issue);
    }
  }

  // Add other issues
  result.issues.push(...otherIssues);

  // Write fixes if any were applied
  if (result.fixesApplied.length > 0) {
    // Create timestamped backup before modifying the file
    const backupPath = `${filePath}.bak.${Date.now()}`;
    copyFileSync(filePath, backupPath);

    writeFileSync(filePath, content, 'utf-8');

    if (!json) {
      console.log(chalk.dim(`\n  Backup saved to: ${backupPath}`));
      console.log(chalk.green('\n✓ Applied fixes:'));
      for (const fix of result.fixesApplied) {
        console.log(chalk.green(`  • ${fix}`));
      }
    }

    // Re-parse and validate to get updated state
    parsed = parseAgentsMd(content);
    result.parsedConfig = parsed;
    issues = validateParsedAgents(parsed, mode);
    result.issues = issues.filter(
      (issue) =>
        costWarnings ||
        !(issue.severity === 'info' && issue.path.endsWith('.model'))
    );
  }

  // Determine overall validity
  result.valid = !result.issues.some((issue) => issue.severity === 'error');

  return result;
}

/**
 * Format validation result for console output
 */
export function formatAgentsValidationResult(
  result: AgentsValidationResult
): void {
  const statusIcon = result.valid ? chalk.green('✓') : chalk.red('✗');
  console.log(`\n${statusIcon} ${result.filePath}`);

  if (result.issues.length === 0) {
    console.log(chalk.green('  No issues found'));
    return;
  }

  // Group issues by severity
  const errors = result.issues.filter((i) => i.severity === 'error');
  const warnings = result.issues.filter((i) => i.severity === 'warning');
  const infos = result.issues.filter((i) => i.severity === 'info');

  if (errors.length > 0) {
    console.log(chalk.red(`\n  Errors (${errors.length}):`));
    for (const issue of errors) {
      console.log(chalk.red(`    ✗ [${issue.path}] ${issue.message}`));
      if (issue.suggestion) {
        console.log(chalk.cyan(`      💡 ${issue.suggestion}`));
      }
    }
  }

  if (warnings.length > 0) {
    console.log(chalk.yellow(`\n  Warnings (${warnings.length}):`));
    for (const issue of warnings) {
      console.log(chalk.yellow(`    ⚠ [${issue.path}] ${issue.message}`));
      if (issue.suggestion) {
        console.log(chalk.cyan(`      💡 ${issue.suggestion}`));
      }
    }
  }

  if (infos.length > 0) {
    console.log(chalk.blue(`\n  Info (${infos.length}):`));
    for (const issue of infos) {
      console.log(chalk.blue(`    ℹ [${issue.path}] ${issue.message}`));
      if (issue.suggestion) {
        console.log(chalk.dim(`      💡 ${issue.suggestion}`));
      }
    }
  }
}

/**
 * Format validation result as JSON
 */
export function formatAgentsValidationResultJson(
  result: AgentsValidationResult
): string {
  return JSON.stringify(
    {
      valid: result.valid,
      filePath: result.filePath,
      fixesApplied: result.fixesApplied,
      summary: {
        errors: result.issues.filter((i) => i.severity === 'error').length,
        warnings: result.issues.filter((i) => i.severity === 'warning').length,
        info: result.issues.filter((i) => i.severity === 'info').length,
      },
      issues: result.issues.map((issue) => ({
        severity: issue.severity,
        path: issue.path,
        message: issue.message,
        value: issue.value,
        suggestion: issue.suggestion,
      })),
    },
    null,
    2
  );
}
