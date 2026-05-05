/**
 * Configuration Validator
 *
 * Validates configuration files for the AI CLI Swarm system.
 * Used by the doctor command to ensure AGENTS.md and pipelines.yaml are valid.
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import {
  RawPipelineConfigSchema,
  AGENT_ROLES,
  REQUIRED_PIPELINE_TYPES,
  type AgentRole,
} from '../core/types.js';
import { resolvePipelineInheritance } from './pipeline-inheritance.js';
import { createLogger } from './logger.js';
import { loadAgentsDefs } from './agents-schema.js';

const logger = createLogger('config-validator');

/**
 * Roles that may legitimately have no tools defined.
 * These agents coordinate or orchestrate other agents rather than using tools directly.
 */
const ROLES_ALLOWED_WITHOUT_TOOLS: AgentRole[] = ['orchestrator'];

/**
 * Validation result for a single check
 */
export interface ValidationCheck {
  name: string;
  passed: boolean;
  message: string;
  details?: string[];
}

/**
 * Overall validation result
 */
export interface ValidationResult {
  valid: boolean;
  checks: ValidationCheck[];
  summary: string;
}

/**
 * Validates the AGENTS.md configuration file
 */
export function validateAgentsConfig(filePath: string): ValidationResult {
  const checks: ValidationCheck[] = [];

  // Check 1: File exists
  if (!existsSync(filePath)) {
    checks.push({
      name: 'AGENTS.md exists',
      passed: false,
      message: 'File not found',
      details: [`Expected at: ${filePath}`],
    });
    return { valid: false, checks, summary: 'AGENTS.md file not found' };
  }
  checks.push({
    name: 'AGENTS.md exists',
    passed: true,
    message: 'File found',
  });

  // Load and parse the file ONCE
  const parseResult = loadAgentsDefs(filePath);

  // Check 2: File is readable and parseable
  if (!parseResult) {
    checks.push({
      name: 'AGENTS.md syntax',
      passed: false,
      message: 'Failed to read or parse file',
    });
    return { valid: false, checks, summary: 'AGENTS.md could not be parsed' };
  }

  // Check 2: Validate AGENTS.md syntax and structure
  const { validationIssues } = parseResult;
  const errors = validationIssues.filter((i) => i.severity === 'error');
  const warnings = validationIssues.filter((i) => i.severity === 'warning');
  const hasErrors = errors.length > 0;
  checks.push({
    name: 'AGENTS.md syntax',
    passed: !hasErrors,
    message: hasErrors
      ? `${errors.length} error(s), ${warnings.length} warning(s)`
      : 'Valid markdown structure',
    details: hasErrors ? errors.map((e) => e.message) : undefined,
  });

  // Check 3: All agent roles defined
  // Missing roles are a configuration error - all required roles must be explicitly defined
  const { missingRoles } = parseResult;
  const allRolesDefined = missingRoles.length === 0;
  checks.push({
    name: 'Agent roles complete',
    passed: allRolesDefined,
    message: allRolesDefined
      ? `All ${AGENT_ROLES.length} roles defined`
      : `Missing ${missingRoles.length} required role(s)`,
    details:
      missingRoles.length > 0
        ? [
            `Required roles not defined: ${missingRoles.join(', ')}`,
            'Add definitions for these roles to AGENTS.md',
          ]
        : undefined,
  });

  // Check 4: Agent definitions are complete (purpose/responsibilities)
  const incompleteAgents: string[] = [];
  const agentsWithNoTools: string[] = [];

  for (const [role, def] of parseResult.agents) {
    if (!def.purpose || def.responsibilities.length === 0) {
      incompleteAgents.push(role);
    }
    // An agent without tools has no capabilities - usually a configuration error,
    // but some agents might not need tools for certain operations
    if (def.tools.length === 0 && !ROLES_ALLOWED_WITHOUT_TOOLS.includes(role)) {
      agentsWithNoTools.push(role);
    }
  }

  checks.push({
    name: 'Agent definitions complete',
    passed: incompleteAgents.length === 0,
    message:
      incompleteAgents.length === 0
        ? 'All defined agents have purpose and responsibilities'
        : `${incompleteAgents.length} agents have incomplete definitions`,
    details:
      incompleteAgents.length > 0
        ? [`Incomplete: ${incompleteAgents.join(', ')}`]
        : undefined,
  });

  // Check 5: Agent tools defined (agents without tools have no capabilities)
  checks.push({
    name: 'Agent tools defined',
    passed: agentsWithNoTools.length === 0,
    message:
      agentsWithNoTools.length === 0
        ? 'All non-orchestrator agents have tools defined'
        : `${agentsWithNoTools.length} agent(s) have no tools defined`,
    details:
      agentsWithNoTools.length > 0
        ? [
            `Agents without tools: ${agentsWithNoTools.join(', ')}`,
            'Agents without tools will have no capabilities. Add "- **Tools**" to their definitions if needed.',
          ]
        : undefined,
  });

  const failedChecks = checks.filter((c) => !c.passed);
  return {
    valid: failedChecks.length === 0,
    checks,
    summary:
      failedChecks.length === 0
        ? 'AGENTS.md validation passed'
        : `AGENTS.md validation failed: ${failedChecks.length} issue(s)`,
  };
}

/**
 * Validates the pipelines.yaml configuration file
 */
export function validatePipelinesConfig(filePath: string): ValidationResult {
  const checks: ValidationCheck[] = [];

  // Check 1: File exists
  const fileExists = existsSync(filePath);
  checks.push({
    name: 'pipelines.yaml exists',
    passed: fileExists,
    message: fileExists ? 'File found' : 'File not found',
    details: fileExists ? undefined : [`Expected at: ${filePath}`],
  });

  if (!fileExists) {
    return {
      valid: false,
      checks,
      summary: 'pipelines.yaml file not found',
    };
  }

  // Check 2: Valid YAML syntax
  let parsedYaml: unknown;
  try {
    const content = readFileSync(filePath, 'utf-8');
    parsedYaml = parseYaml(content);
    checks.push({
      name: 'YAML syntax',
      passed: true,
      message: 'Valid YAML',
    });
  } catch (error) {
    checks.push({
      name: 'YAML syntax',
      passed: false,
      message: 'Invalid YAML syntax',
      details: [error instanceof Error ? error.message : String(error)],
    });
    return {
      valid: false,
      checks,
      summary: 'pipelines.yaml has invalid YAML syntax',
    };
  }

  // Check 3: Schema validation (parse raw + resolve inheritance)
  try {
    const rawConfig = RawPipelineConfigSchema.parse(parsedYaml);
    const validated = resolvePipelineInheritance(rawConfig);
    const pipelineNames = Object.keys(validated.pipelines);

    checks.push({
      name: 'Schema validation',
      passed: true,
      message: `Valid schema with ${pipelineNames.length} pipeline(s)`,
      details: [`Pipelines: ${pipelineNames.join(', ')}`],
    });

    // Note: Agent references are validated by Zod schema (AgentRoleSchema enum)
    // during PipelineConfigSchema.parse() above - no need for redundant check

    // Check 4: Required pipelines present
    const requiredPipelines = REQUIRED_PIPELINE_TYPES;
    const missingPipelines = requiredPipelines.filter(
      (p) => !pipelineNames.includes(p)
    );

    checks.push({
      name: 'Required pipelines',
      passed: missingPipelines.length === 0,
      message:
        missingPipelines.length === 0
          ? 'All required pipelines present'
          : `${missingPipelines.length} required pipeline(s) missing`,
      details:
        missingPipelines.length > 0
          ? [`Missing: ${missingPipelines.join(', ')}`]
          : undefined,
    });
  } catch (error) {
    let details: string[];
    if (error instanceof ZodError) {
      details = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
    } else {
      details = [error instanceof Error ? error.message : String(error)];
    }

    checks.push({
      name: 'Schema validation',
      passed: false,
      message: 'Schema validation failed',
      details,
    });
    return {
      valid: false,
      checks,
      summary: 'pipelines.yaml failed schema validation',
    };
  }

  const failedChecks = checks.filter((c) => !c.passed);
  return {
    valid: failedChecks.length === 0,
    checks,
    summary:
      failedChecks.length === 0
        ? 'pipelines.yaml validation passed'
        : `pipelines.yaml validation failed: ${failedChecks.length} issue(s)`,
  };
}

/**
 * Validates all configuration files
 */
export function validateAllConfigs(configDir: string): {
  valid: boolean;
  agentsResult: ValidationResult;
  pipelinesResult: ValidationResult;
  summary: string;
} {
  const agentsPath = path.join(configDir, 'AGENTS.md');
  const pipelinesPath = path.join(configDir, 'pipelines.yaml');

  logger.info(`Validating configuration in: ${configDir}`);

  const agentsResult = validateAgentsConfig(agentsPath);
  const pipelinesResult = validatePipelinesConfig(pipelinesPath);

  const valid = agentsResult.valid && pipelinesResult.valid;

  let summary: string;
  if (valid) {
    summary = 'All configuration files valid';
  } else {
    const issues: string[] = [];
    if (!agentsResult.valid) issues.push('AGENTS.md');
    if (!pipelinesResult.valid) issues.push('pipelines.yaml');
    summary = `Configuration issues in: ${issues.join(', ')}`;
  }

  return {
    valid,
    agentsResult,
    pipelinesResult,
    summary,
  };
}

/**
 * Formats a validation result for console output (plain text)
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];

  for (const check of result.checks) {
    const icon = check.passed ? '\u2713' : '\u2717';
    lines.push(`${icon} ${check.name}: ${check.message}`);
    if (check.details) {
      for (const detail of check.details) {
        lines.push(`  - ${detail}`);
      }
    }
  }

  lines.push('');
  lines.push(result.summary);

  return lines.join('\n');
}

/**
 * Reports validation result to console with chalk colors
 * Used by the doctor command to display validation status
 */
export function reportValidationResult(
  configName: string,
  validationResult: ValidationResult,
  chalk: {
    green: (s: string) => string;
    red: (s: string) => string;
    dim: (s: string) => string;
  }
): void {
  if (validationResult.valid) {
    console.log(chalk.green(`  ✓ ${configName} valid`));
    const passedChecks = validationResult.checks.filter((c) => c.passed);
    console.log(chalk.dim(`    ${passedChecks.length} checks passed`));
  } else {
    console.log(chalk.red(`  ✗ ${configName} has issues`));
    for (const check of validationResult.checks) {
      if (!check.passed) {
        console.log(chalk.red(`    - ${check.name}: ${check.message}`));
      }
    }
  }
}
