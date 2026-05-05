/**
 * Configurable File Validator
 *
 * Validates configuration files (settings.json, pipelines.yaml, AGENTS.md, config.yml)
 * against their schemas with support for:
 * - Strict mode: throws errors on invalid data
 * - Lenient mode: collects warnings for invalid data, allowing partial validation
 * - Enum validation with helpful suggestions
 * - File type detection and appropriate schema selection
 */

import { existsSync, readFileSync } from 'fs';
import { basename, extname, join } from 'path';
import { z } from 'zod';
import { parse as parseYaml, YAMLError } from 'yaml';
import { createLogger } from './logger.js';
import { SettingsSchema } from './settings.js';
import {
  PipelineConfigSchema,
  AGENT_ROLES,
  EXECUTION_FIDELITY_LEVELS,
} from '../core/types.js';
import { SystemConfigSchema, BACKEND_TYPES } from '../core/adapter-types.js';
import { getClosestMatch } from './string-utils.js';
import {
  parseAgentsMd,
  validateParsedAgents,
  type ParsedAgentsConfig,
} from './agents-schema.js';
import { parseJsonc } from './json-utils.js';

const logger = createLogger('file-validator');

/**
 * Minimum content length for AGENTS.md to be considered meaningful
 */
const MIN_AGENTS_MD_CONTENT_LENGTH = 50;

/**
 * Validation severity levels
 */
export type ValidationSeverity = 'error' | 'warning' | 'info';

/**
 * A single validation issue
 */
export interface ValidationIssue {
  severity: ValidationSeverity;
  path: string;
  message: string;
  value?: unknown;
  suggestion?: string;
  /** Suggested fix value for automated or interactive fixing */
  suggestedValue?: string;
  /** Line number in source file (1-indexed) for precise fix targeting */
  lineNumber?: number;
}

/**
 * Result of validating a file
 */
export interface ValidationResult {
  valid: boolean;
  filePath: string;
  fileType: ConfigFileType;
  issues: ValidationIssue[];
  data?: unknown;
}

/**
 * Supported configuration file types (excluding 'unknown')
 */
export const CONFIG_FILE_TYPES = [
  'settings',
  'pipelines',
  'agents',
  'system-config',
] as const;

/**
 * Supported configuration file types
 */
export type ConfigFileType = (typeof CONFIG_FILE_TYPES)[number] | 'unknown';

/**
 * Validation mode
 * - strict: throws on first error
 * - lenient: collects all issues as warnings where possible
 */
export type ValidationMode = 'strict' | 'lenient';

/**
 * Options for file validation
 */
export interface ValidateFileOptions {
  mode?: ValidationMode;
  fileType?: ConfigFileType;
}

/**
 * Known enum values for validation suggestions
 */
export const KNOWN_ENUMS = {
  agentRoles: AGENT_ROLES,
  fidelityLevels: EXECUTION_FIDELITY_LEVELS,
  backendTypes: BACKEND_TYPES,
  inputTypes: ['github', 'prd', 'prompt'] as const,
  workflowStatuses: [
    'initializing',
    'running',
    'paused',
    'completed',
    'failed',
  ] as const,
} as const;

/**
 * Detect file type from filename and extension
 * Uses exact filename matching first to avoid ambiguity
 */
export function detectFileType(filePath: string): ConfigFileType {
  const name = basename(filePath).toLowerCase();
  const ext = extname(filePath).toLowerCase();

  // Check exact filenames first for unambiguous detection
  if (name === 'settings.json') {
    return 'settings';
  }
  if (name === 'pipelines.yaml' || name === 'pipelines.yml') {
    return 'pipelines';
  }
  if (name === 'agents.md') {
    return 'agents';
  }
  if (name === 'config.yml' || name === 'config.yaml') {
    return 'system-config';
  }

  // Fallback based on extension for non-standard filenames
  if (ext === '.json') return 'settings';
  if (ext === '.yaml' || ext === '.yml') return 'pipelines';
  if (ext === '.md') return 'agents';

  return 'unknown';
}

/**
 * Get the schema for a file type
 */
function getSchemaForFileType(fileType: ConfigFileType): z.ZodSchema | null {
  switch (fileType) {
    case 'settings':
      return SettingsSchema;
    case 'pipelines':
      return PipelineConfigSchema;
    case 'system-config':
      return SystemConfigSchema;
    case 'agents':
      // AGENTS.md uses custom parsing, not Zod
      return null;
    default:
      return null;
  }
}

/**
 * Parse file content based on file type
 */
function parseFileContent(
  content: string,
  fileType: ConfigFileType,
  filePath: string
): { data: unknown; parseError?: ValidationIssue } {
  try {
    switch (fileType) {
      case 'settings':
        return { data: parseJsonc(content) };
      case 'pipelines':
      case 'system-config':
        return { data: parseYaml(content) };
      case 'agents':
        // Return raw content for markdown
        return { data: content };
      default: {
        // Try JSON/JSONC first, then YAML
        // Note: parseJsonc returns undefined for invalid content instead of throwing
        const jsonData = parseJsonc(content);
        if (jsonData !== undefined) {
          return { data: jsonData };
        }
        // Fallback to YAML if JSON/JSONC parsing fails
        return { data: parseYaml(content) };
      }
    }
  } catch (error) {
    const message =
      error instanceof YAMLError
        ? `YAML parse error: ${error.message}`
        : error instanceof SyntaxError
          ? `JSON parse error: ${error.message}`
          : `Parse error: ${String(error)}`;

    return {
      data: null,
      parseError: {
        severity: 'error',
        path: filePath,
        message,
      },
    };
  }
}

/**
 * Convert Zod errors to ValidationIssues
 */
function zodErrorToIssues(
  error: z.ZodError,
  mode: ValidationMode
): ValidationIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    let suggestion: string | undefined;

    // Add suggestions for enum errors
    if (issue.code === z.ZodIssueCode.invalid_enum_value) {
      const received = issue.received as string;
      const options = issue.options as string[];

      const closest = getClosestMatch(received, options);
      if (closest) {
        suggestion = `Did you mean '${closest}'?`;
      } else {
        suggestion = `Valid values: ${options.join(', ')}`;
      }
    }

    return {
      severity: mode === 'lenient' ? 'warning' : 'error',
      path: path || '(root)',
      message: issue.message,
      value: 'received' in issue ? issue.received : undefined,
      suggestion,
    } satisfies ValidationIssue;
  });
}

/**
 * Core validation logic shared between validateFile and validateContent
 * Handles schema validation after content has been parsed
 */
function validateParsedData(
  data: unknown,
  content: string,
  fileType: ConfigFileType,
  mode: ValidationMode,
  result: ValidationResult
): void {
  // Handle AGENTS.md separately (uses markdown parsing, not Zod)
  if (fileType === 'agents') {
    const { issues: agentIssues, parsedData } = validateAgentsMd(content, mode);
    result.issues.push(...agentIssues);
    result.valid = !agentIssues.some((i) => i.severity === 'error');
    result.data = parsedData;
    return;
  }

  // Get schema and validate
  const schema = getSchemaForFileType(fileType);
  if (!schema) {
    result.issues.push({
      severity: 'info',
      path: result.filePath,
      message: `No schema available for file type '${fileType}'`,
    });
    return;
  }

  // Validate with Zod
  const parseResult = schema.safeParse(data);
  if (!parseResult.success) {
    const zodIssues = zodErrorToIssues(parseResult.error, mode);
    result.issues.push(...zodIssues);
    result.valid =
      mode === 'lenient'
        ? !zodIssues.some((i) => i.severity === 'error')
        : false;
    // Clear data on parse failure to prevent unsafe type assertions downstream
    result.data = undefined;
  } else {
    // Use the validated/transformed data from Zod (includes defaults, transforms)
    result.data = parseResult.data;
  }
}

/**
 * Result of validating AGENTS.md content
 */
export interface AgentsMdValidationResult {
  issues: ValidationIssue[];
  parsedData: ParsedAgentsConfig;
}

/**
 * Validate AGENTS.md file content
 *
 * Delegates to the agents-schema module for parsing and validation,
 * adding file-level checks for structure and content.
 * Returns both the validation issues and the parsed data to avoid redundant parsing.
 */
export function validateAgentsMd(
  content: string,
  mode: ValidationMode = 'strict'
): AgentsMdValidationResult {
  const issues: ValidationIssue[] = [];

  // Use the dedicated AGENTS.md parser and validator
  const parsedData = parseAgentsMd(content);
  const agentIssues = validateParsedAgents(parsedData, mode);
  issues.push(...agentIssues);

  // Additional file-level checks

  // Check for required sections
  const requiredSections = ['## Agent Roles'];
  for (const section of requiredSections) {
    if (!content.includes(section)) {
      issues.push({
        severity: 'warning',
        path: 'structure',
        message: `Missing recommended section: '${section}'`,
        suggestion: 'Add this section to improve agent configuration clarity',
      });
    }
  }

  // Check for minimum content
  if (content.trim().length < MIN_AGENTS_MD_CONTENT_LENGTH) {
    issues.push({
      severity: 'warning',
      path: 'content',
      message: 'AGENTS.md content is very short',
      suggestion: 'Consider adding more detailed agent role descriptions',
    });
  }

  // Log defined roles for info
  if (parsedData.agents.length > 0) {
    const roleNames = parsedData.agents.map((a) => a.role);
    logger.debug(
      `Found ${roleNames.length} agent roles defined: ${roleNames.join(', ')}`
    );
  }

  return { issues, parsedData };
}

/**
 * Validate a configuration file
 */
export function validateFile(
  filePath: string,
  options: ValidateFileOptions = {}
): ValidationResult {
  const { mode = 'strict', fileType: explicitType } = options;
  const fileType = explicitType || detectFileType(filePath);

  const result: ValidationResult = {
    valid: true,
    filePath,
    fileType,
    issues: [],
  };

  // Check file exists
  if (!existsSync(filePath)) {
    result.valid = false;
    result.issues.push({
      severity: 'error',
      path: filePath,
      message: 'File not found',
    });
    return result;
  }

  // Read file content
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (error) {
    result.valid = false;
    result.issues.push({
      severity: 'error',
      path: filePath,
      message: `Failed to read file: ${String(error)}`,
    });
    return result;
  }

  // Check for empty files
  if (!content.trim()) {
    result.issues.push({
      severity: 'warning',
      path: filePath,
      message: 'File is empty',
    });
    return result;
  }

  // Parse content
  const { data, parseError } = parseFileContent(content, fileType, filePath);
  if (parseError) {
    result.valid = false;
    result.issues.push(parseError);
    return result;
  }

  result.data = data;

  // Validate the parsed data
  validateParsedData(data, content, fileType, mode, result);

  return result;
}

/**
 * Validate file content directly (without reading from disk)
 */
export function validateContent(
  content: string,
  fileType: ConfigFileType,
  options: Omit<ValidateFileOptions, 'fileType'> = {}
): ValidationResult {
  const { mode = 'strict' } = options;

  const result: ValidationResult = {
    valid: true,
    filePath: '<content>',
    fileType,
    issues: [],
  };

  // Check for empty content
  if (!content.trim()) {
    result.issues.push({
      severity: 'warning',
      path: '<content>',
      message: 'Content is empty',
    });
    return result;
  }

  // Parse content
  const { data, parseError } = parseFileContent(content, fileType, '<content>');
  if (parseError) {
    result.valid = false;
    result.issues.push(parseError);
    return result;
  }

  result.data = data;

  // Validate the parsed data
  validateParsedData(data, content, fileType, mode, result);

  return result;
}

/**
 * Validate multiple configuration files
 */
export function validateFiles(
  filePaths: string[],
  options: ValidateFileOptions = {}
): ValidationResult[] {
  return filePaths.map((filePath) => validateFile(filePath, options));
}

/**
 * Validate all configuration files in a project directory
 */
export function validateProjectConfig(
  projectDir: string,
  options: ValidateFileOptions = {}
): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Check .airunx directory configs
  const configFiles = [
    {
      path: join(projectDir, '.airunx', 'settings.json'),
      type: 'settings' as const,
    },
    {
      path: join(projectDir, '.airunx', 'config.yml'),
      type: 'system-config' as const,
    },
    {
      path: join(projectDir, '.airunx', 'pipelines.yaml'),
      type: 'pipelines' as const,
    },
    { path: join(projectDir, '.airunx', 'AGENTS.md'), type: 'agents' as const },
  ];

  // Also check legacy directories
  const legacyFiles = [
    {
      path: join(projectDir, '.agents', 'pipelines.yaml'),
      type: 'pipelines' as const,
    },
    { path: join(projectDir, '.agents', 'AGENTS.md'), type: 'agents' as const },
    {
      path: join(projectDir, '.agentos', 'config.yml'),
      type: 'system-config' as const,
    },
  ];

  for (const { path, type } of [...configFiles, ...legacyFiles]) {
    if (existsSync(path)) {
      results.push(validateFile(path, { ...options, fileType: type }));
    }
  }

  return results;
}

/**
 * Format validation results for programmatic/library use
 *
 * Returns a plain text formatted string suitable for logging or display.
 * For CLI usage with colors, see formatResultForConsole in commands/validate.ts.
 */
export function formatValidationResults(results: ValidationResult[]): string {
  const lines: string[] = [];

  for (const result of results) {
    const statusIcon = result.valid ? '✓' : '✗';

    lines.push(`${statusIcon} ${result.filePath} (${result.fileType})`);

    if (result.issues.length > 0) {
      for (const issue of result.issues) {
        const icon =
          issue.severity === 'error'
            ? '  ✗'
            : issue.severity === 'warning'
              ? '  ⚠'
              : '  ℹ';

        lines.push(`${icon} [${issue.path}] ${issue.message}`);
        if (issue.suggestion) {
          lines.push(`      ${issue.suggestion}`);
        }
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check if an enum value is valid
 */
export function isValidEnumValue<T extends string>(
  value: string,
  validValues: readonly T[]
): value is T {
  return validValues.includes(value as T);
}

/**
 * Validate an enum value with suggestion
 */
export function validateEnumValue<T extends string>(
  value: string,
  validValues: readonly T[],
  fieldName: string
): ValidationIssue | null {
  if (isValidEnumValue(value, validValues)) {
    return null;
  }

  const closest = getClosestMatch(value, validValues);
  return {
    severity: 'warning',
    path: fieldName,
    message: `Invalid value '${value}'`,
    value,
    suggestion: closest
      ? `Did you mean '${closest}'? Valid values: ${validValues.join(', ')}`
      : `Valid values: ${validValues.join(', ')}`,
  };
}
