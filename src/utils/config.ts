import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { PipelineConfig } from '../core/types.js';
import { RawPipelineConfigSchema } from '../core/types.js';
import { handleConfigError } from './error-handlers.js';
import {
  loadSettings,
  getDefaultAgentsMd,
  getDefaultPipelinesYaml,
} from './settings.js';
import { validateContent, type ValidationResult } from './file-validator.js';
import type { ParsedAgentsConfig } from './agents-schema.js';
import { createLogger } from './logger.js';
import { resolvePipelineInheritance } from './pipeline-inheritance.js';

const logger = createLogger('config');

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  CURSOR_API_KEY: z.string().optional(),
  DEBUG: z.string().optional(),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

export function validateEnv(): EnvConfig {
  return EnvSchema.parse(process.env);
}

/**
 * Load pipeline config using settings hierarchy
 * Priority: CLI arg → explicit settings path → project paths (.airunx, .agentos, .agents) → implicit fallbacks
 *
 * This function delegates to loadPipelineConfigWithSource to ensure consistent
 * behavior across all commands (run, doctor, etc.)
 */
export function loadPipelineConfig(configPath?: string): PipelineConfig {
  // 1. CLI argument - fail fast if provided but not found
  if (configPath) {
    if (!existsSync(configPath)) {
      throw new Error(
        `Pipeline config file not found at specified path: ${configPath}`
      );
    }
    // We've verified the file exists, so loadPipelineFromPath will not return null
    return loadPipelineFromPath(configPath)!;
  }

  const settings = loadSettings();

  // 2. Explicit path from settings.json (if user specified pipelines_yaml_location)
  if (settings.pipelines_yaml_location) {
    // If an explicit path is provided, we honor it. If it's invalid, we don't fall back.
    const resolvedPath = settings.resolvedPaths.pipelines_yaml!;
    const config = loadPipelineFromPath(resolvedPath);
    if (config === null) {
      throw new Error(
        `Pipeline config file not found at specified path from settings.json: ${resolvedPath}`
      );
    }
    return config;
  }

  // 3. Use the unified loading logic that checks all project paths
  // This ensures consistency between loadPipelineConfig and loadPipelineConfigWithSource
  const result = loadPipelineConfigWithSource();
  if (result) {
    return result.config;
  }

  // Final fallback: parse package default content directly
  try {
    const defaultContent = getDefaultPipelinesYaml();
    const parsedYaml = parseYaml(defaultContent);
    const rawConfig = RawPipelineConfigSchema.parse(parsedYaml);
    return resolvePipelineInheritance(rawConfig);
  } catch (error) {
    // handleConfigError always throws (returns never), so no return needed
    handleConfigError(error, 'pipeline', 'package default');
  }
}

function loadPipelineFromPath(path: string): PipelineConfig | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const parsedYaml = parseYaml(content);
    // Parse as raw config (allows stages_inherit)
    const rawConfig = RawPipelineConfigSchema.parse(parsedYaml);
    // Resolve inheritance to get final config
    return resolvePipelineInheritance(rawConfig);
  } catch (error) {
    // handleConfigError always throws (returns never)
    handleConfigError(error, 'pipeline', path);
  }
}

/**
 * Result of loading pipeline config with source information
 */
export interface PipelineConfigResult {
  config: PipelineConfig;
  sourcePath: string;
  pipelineCount: number;
}

/**
 * Load pipeline config with source path information
 * Useful for diagnostics (doctor command) to show where config was loaded from
 * Returns null if no valid config found (allows caller to handle gracefully)
 */
export function loadPipelineConfigWithSource(): PipelineConfigResult | null {
  const settings = loadSettings();

  // Priority order for checking configs
  const configSources: Array<{ path: string; label: string }> = [];

  // 1. Explicit path from settings.json
  if (
    settings.pipelines_yaml_location &&
    settings.resolvedPaths.pipelines_yaml
  ) {
    configSources.push({
      path: settings.resolvedPaths.pipelines_yaml,
      label: 'settings.json',
    });
  }

  // 2. Project-specific config (.airunx directory)
  configSources.push({
    path: join(process.cwd(), '.airunx', 'pipelines.yaml'),
    label: 'project',
  });

  // 3. Global/package default from settings
  if (settings.resolvedPaths.pipelines_yaml) {
    configSources.push({
      path: settings.resolvedPaths.pipelines_yaml,
      label: 'default',
    });
  }

  // Try each source in order
  for (const source of configSources) {
    if (existsSync(source.path)) {
      try {
        const content = readFileSync(source.path, 'utf-8');
        const parsedYaml = parseYaml(content);
        const rawConfig = RawPipelineConfigSchema.parse(parsedYaml);
        const config = resolvePipelineInheritance(rawConfig);
        return {
          config,
          sourcePath: source.path,
          pipelineCount: Object.keys(config.pipelines).length,
        };
      } catch {
        // Continue to next source if this one fails
        continue;
      }
    }
  }

  // Final fallback: package default content
  try {
    const defaultContent = getDefaultPipelinesYaml();
    const parsedYaml = parseYaml(defaultContent);
    const rawConfig = RawPipelineConfigSchema.parse(parsedYaml);
    const config = resolvePipelineInheritance(rawConfig);
    return {
      config,
      sourcePath: 'package default',
      pipelineCount: Object.keys(config.pipelines).length,
    };
  } catch {
    return null;
  }
}

/**
 * Load agents config using settings hierarchy
 * Priority: CLI arg → explicit settings path → legacy .agents/AGENTS.md → implicit fallbacks
 */
export function loadAgentsConfig(configPath?: string): string {
  // 1. CLI argument - fail fast if provided but not found
  if (configPath) {
    if (existsSync(configPath)) {
      return readFileSync(configPath, 'utf-8');
    }
    throw new Error(
      `Configuration file not found at the specified path: ${configPath}`
    );
  }

  const settings = loadSettings();

  // 2. Explicit path from settings.json (if user specified agents_md_location)
  if (settings.agents_md_location) {
    const resolvedPath = settings.resolvedPaths.agents_md!;
    if (existsSync(resolvedPath)) {
      return readFileSync(resolvedPath, 'utf-8');
    }
    // Explicit path was provided but not found - fail fast
    throw new Error(
      `Agents config file not found at specified path from settings.json: ${resolvedPath}`
    );
  }

  // 3. Legacy fallback: .agents/AGENTS.md
  const legacyPath = join(process.cwd(), '.agents', 'AGENTS.md');
  if (existsSync(legacyPath)) {
    return readFileSync(legacyPath, 'utf-8');
  }

  // 4. Implicit fallbacks from settings (global file or package default)
  const resolvedPath = settings.resolvedPaths.agents_md;
  if (resolvedPath && existsSync(resolvedPath)) {
    return readFileSync(resolvedPath, 'utf-8');
  }

  // Final fallback: use package default directly
  return getDefaultAgentsMd();
}

/**
 * Log validation warnings to the logger
 * Used by both agents and pipeline config loading in lenient mode
 */
function logValidationWarnings(
  validation: ValidationResult,
  configName: string
): void {
  for (const issue of validation.issues) {
    if (issue.severity === 'warning') {
      logger.warn(`[${configName}] ${issue.path}: ${issue.message}`);
      if (issue.suggestion) {
        logger.warn(`  Suggestion: ${issue.suggestion}`);
      }
    }
  }
}

/**
 * Load and validate agents config with optional warnings
 * Returns both the raw content and validation results
 * Uses validateContent to centralize validation logic
 */
export function loadAgentsConfigWithValidation(
  configPath?: string,
  options: { lenient?: boolean } = {}
): {
  content: string;
  parsed: ParsedAgentsConfig;
  validation: ValidationResult;
} {
  const content = loadAgentsConfig(configPath);
  const mode = options.lenient ? 'lenient' : 'strict';

  // Use centralized validation from file-validator
  // validateContent now returns parsed data via validateAgentsMd
  const validation = validateContent(content, 'agents', { mode });

  // Log warnings in lenient mode
  if (options.lenient) {
    logValidationWarnings(validation, 'AGENTS.md');
  }

  // The parsed data comes directly from the validation result
  const parsed = validation.data as ParsedAgentsConfig;

  return { content, parsed, validation };
}

/**
 * Load and parse the default pipeline configuration from package defaults
 */
function loadDefaultPipelineConfig(): PipelineConfig {
  const defaultContent = getDefaultPipelinesYaml();
  const parsedYaml = parseYaml(defaultContent);
  const rawConfig = RawPipelineConfigSchema.parse(parsedYaml);
  return resolvePipelineInheritance(rawConfig);
}

/**
 * Load and validate pipeline config with warnings support
 *
 * Optimized to read and parse the file only once, using validateContent
 * for both validation and data extraction.
 */
export function loadPipelineConfigWithValidation(
  configPath?: string,
  options: { lenient?: boolean } = {}
): { config: PipelineConfig; validation: ValidationResult } {
  const settings = loadSettings();
  const resolvedPath =
    configPath || settings.resolvedPaths.pipelines_yaml || '<default>';

  let validation: ValidationResult;
  let config: PipelineConfig;

  if (resolvedPath !== '<default>' && existsSync(resolvedPath)) {
    // Read file once and validate - validateContent parses and validates
    const content = readFileSync(resolvedPath, 'utf-8');
    validation = validateContent(content, 'pipelines', {
      mode: options.lenient ? 'lenient' : 'strict',
    });

    if (!validation.valid && !options.lenient) {
      // In strict mode, throw on validation errors
      const errors = validation.issues
        .filter((i) => i.severity === 'error')
        .map((i) => `${i.path}: ${i.message}`)
        .join('; ');
      throw new Error(`Pipeline config validation failed: ${errors}`);
    }

    // In lenient mode with validation issues, data may be undefined
    // Fall back to default config if validated data is not available
    if (validation.data) {
      config = validation.data as PipelineConfig;
    } else {
      // Validation failed but we're in lenient mode - use default config
      logger.warn(
        '[pipelines.yaml] Using default config due to validation errors'
      );
      config = loadDefaultPipelineConfig();
    }
  } else {
    // For default content, parse once and create passing validation
    config = loadDefaultPipelineConfig();

    validation = {
      valid: true,
      filePath: resolvedPath,
      fileType: 'pipelines',
      issues: [],
      data: config,
    };
  }

  // Log warnings in lenient mode
  if (options.lenient) {
    logValidationWarnings(validation, 'pipelines.yaml');
  }

  return { config, validation };
}
