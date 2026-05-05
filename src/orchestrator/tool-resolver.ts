/**
 * Tool Resolver for dynamic tool resolution in pipelines
 *
 * Resolves generic tool references in pipeline configurations to
 * language-specific commands based on the detected project language.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { SupportedLanguage, ToolType, ToolConfig } from '../core/types.js';
import {
  detectProjectLanguage,
  detectProjectLanguageWithDetails,
} from '../tools/language-detector.js';
import {
  getToolsForLanguage,
  getToolForLanguage,
  mapGenericToolToType,
} from '../tools/tool-registry.js';
import { loadSettings, ResolvedToolConfigs } from '../utils/settings.js';

/**
 * Error codes for structured error handling in tool resolution
 */
export type ToolResolutionErrorCode =
  | 'LANGUAGE_NOT_DETECTED'
  | 'TOOL_NOT_CONFIGURED'
  | 'REQUIREMENTS_NOT_MET';

/**
 * Result of tool resolution
 */
export interface ToolResolutionResult {
  success: boolean;
  command?: string;
  toolType?: ToolType;
  configFile?: string;
  error?: string;
  errorCode?: ToolResolutionErrorCode;
  language?: SupportedLanguage;
}

/**
 * Options for tool resolution
 */
export interface ToolResolutionOptions {
  /** Override automatic language detection */
  language?: SupportedLanguage;
  /** Project root directory (defaults to cwd) */
  projectRoot?: string;
  /** Check if required files exist before resolving */
  validateRequirements?: boolean;
}

/**
 * Cache for resolved tools to avoid repeated filesystem operations
 */
const toolResolutionCache = new Map<string, ToolResolutionResult>();

/**
 * Maps tool types to their corresponding settings config key
 */
const TOOL_TYPE_TO_CONFIG_KEY: Record<ToolType, keyof ResolvedToolConfigs> = {
  linter: 'linter_config',
  type_checker: 'type_checker_config',
  test_runner: 'test_runner_config',
  coverage: 'coverage_config',
  formatter: 'formatter_config',
  security_scanner: 'security_scanner_config',
};

/**
 * Gets the config override path for a tool type from settings
 */
function getConfigOverride(
  toolType: ToolType,
  projectRoot: string
): string | undefined {
  const settings = loadSettings(projectRoot);
  const configKey = TOOL_TYPE_TO_CONFIG_KEY[toolType];
  return settings.resolvedToolConfigs[configKey];
}

/**
 * Clears the tool resolution cache
 */
export function clearToolResolutionCache(): void {
  toolResolutionCache.clear();
}

/**
 * Resolves a generic tool name to a language-specific command
 *
 * @param genericToolName - Generic tool name from pipeline config (e.g., 'eslint', 'vitest')
 * @param options - Resolution options
 * @returns Tool resolution result with command or error
 */
export function resolveTool(
  genericToolName: string,
  options: ToolResolutionOptions = {}
): ToolResolutionResult {
  const projectRoot = options.projectRoot || process.cwd();
  const cacheKey = `${projectRoot}:${genericToolName}:${options.language || 'auto'}`;

  // Check cache first
  if (toolResolutionCache.has(cacheKey)) {
    return toolResolutionCache.get(cacheKey)!;
  }

  // Detect or use provided language
  const language = options.language || detectProjectLanguage(projectRoot);

  if (!language) {
    const result: ToolResolutionResult = {
      success: false,
      error: `Unable to detect project language. No marker files found in ${projectRoot}`,
      errorCode: 'LANGUAGE_NOT_DETECTED',
    };
    toolResolutionCache.set(cacheKey, result);
    return result;
  }

  // Map generic tool name to tool type
  const toolType = mapGenericToolToType(genericToolName);

  if (!toolType) {
    // Not a known generic tool - return as-is (might be a custom tool)
    const result: ToolResolutionResult = {
      success: true,
      command: genericToolName,
      language,
    };
    toolResolutionCache.set(cacheKey, result);
    return result;
  }

  // Get the language-specific tool config
  const toolConfig = getToolForLanguage(language, toolType);

  if (!toolConfig) {
    const result: ToolResolutionResult = {
      success: false,
      error: `No ${toolType} tool configured for ${language}`,
      errorCode: 'TOOL_NOT_CONFIGURED',
      language,
      toolType,
    };
    toolResolutionCache.set(cacheKey, result);
    return result;
  }

  // Validate requirements if requested
  if (options.validateRequirements && toolConfig.requiredFiles) {
    const missingFiles = toolConfig.requiredFiles.filter(
      (file) => !existsSync(join(projectRoot, file))
    );

    if (missingFiles.length > 0) {
      const result: ToolResolutionResult = {
        success: false,
        error: `Missing required files for ${toolConfig.command}: ${missingFiles.join(', ')}`,
        errorCode: 'REQUIREMENTS_NOT_MET',
        language,
        toolType,
        configFile: toolConfig.configFile,
      };
      toolResolutionCache.set(cacheKey, result);
      return result;
    }
  }

  // Check for config file override from settings
  const configOverride = getConfigOverride(toolType, projectRoot);
  const finalConfigFile = configOverride || toolConfig.configFile;

  const result: ToolResolutionResult = {
    success: true,
    command: toolConfig.command,
    toolType,
    configFile: finalConfigFile,
    language,
  };

  toolResolutionCache.set(cacheKey, result);
  return result;
}

/**
 * Resolves multiple tools at once
 *
 * @param genericToolNames - Array of generic tool names
 * @param options - Resolution options
 * @returns Array of resolution results
 */
export function resolveTools(
  genericToolNames: string[],
  options: ToolResolutionOptions = {}
): ToolResolutionResult[] {
  return genericToolNames.map((name) => resolveTool(name, options));
}

/**
 * Resolves all available tools for a project
 *
 * @param options - Resolution options
 * @returns Map of tool types to their resolution results
 */
export function resolveAllTools(
  options: ToolResolutionOptions = {}
): Map<ToolType, ToolResolutionResult> {
  const projectRoot = options.projectRoot || process.cwd();
  const language = options.language || detectProjectLanguage(projectRoot);
  const results = new Map<ToolType, ToolResolutionResult>();

  if (!language) {
    return results;
  }

  const tools = getToolsForLanguage(language);

  for (const tool of tools) {
    const result = resolveTool(tool.toolType, { ...options, language });
    results.set(tool.toolType, result);
  }

  return results;
}

/**
 * Gets the resolved command for a tool, or returns the original if not resolvable
 *
 * @param genericToolName - Generic tool name
 * @param options - Resolution options
 * @returns The resolved command or original name
 */
export function getResolvedCommand(
  genericToolName: string,
  options: ToolResolutionOptions = {}
): string {
  const result = resolveTool(genericToolName, options);
  return result.command || genericToolName;
}

/**
 * Checks if a tool is available for the detected project language
 *
 * @param genericToolName - Generic tool name
 * @param options - Resolution options
 * @returns true if the tool can be resolved
 */
export function isToolAvailable(
  genericToolName: string,
  options: ToolResolutionOptions = {}
): boolean {
  const result = resolveTool(genericToolName, options);
  return result.success;
}

/**
 * Gets tool information for the current project
 *
 * @param projectRoot - Project root directory
 * @returns Object with project language and available tools
 */
export function getProjectToolInfo(projectRoot: string = process.cwd()): {
  language: SupportedLanguage | null;
  languageConfidence: 'high' | 'medium' | 'low';
  detectionMethod: 'marker' | 'extension' | 'none';
  availableTools: ToolConfig[];
  markerFile?: string;
} {
  const detection = detectProjectLanguageWithDetails(projectRoot);

  if (!detection.language) {
    return {
      language: null,
      languageConfidence: 'low',
      detectionMethod: 'none',
      availableTools: [],
    };
  }

  return {
    language: detection.language,
    languageConfidence: detection.confidence,
    detectionMethod: detection.detectedBy,
    availableTools: getToolsForLanguage(detection.language),
    markerFile: detection.markerFile,
  };
}

/**
 * Transforms an array of generic tool names to language-specific commands
 *
 * Used to transform pipeline stage tool references.
 *
 * @param tools - Array of generic tool names from pipeline config
 * @param options - Resolution options
 * @returns Array of resolved commands (preserves order)
 */
export function transformPipelineTools(
  tools: string[],
  options: ToolResolutionOptions = {}
): string[] {
  return tools.map((tool) => getResolvedCommand(tool, options));
}

/**
 * Validates that all required tools are available for a pipeline
 *
 * @param tools - Array of generic tool names from pipeline config
 * @param options - Resolution options
 * @returns Validation result with any missing tools
 */
export function validatePipelineTools(
  tools: string[],
  options: ToolResolutionOptions = {}
): {
  valid: boolean;
  missing: string[];
  errors: string[];
} {
  const missing: string[] = [];
  const errors: string[] = [];

  for (const tool of tools) {
    // Only validate requirements if explicitly requested
    const result = resolveTool(tool, options);

    if (!result.success) {
      if (result.errorCode === 'TOOL_NOT_CONFIGURED') {
        missing.push(tool);
      }
      errors.push(result.error || `Failed to resolve tool: ${tool}`);
    }
  }

  return {
    valid: missing.length === 0 && errors.length === 0,
    missing,
    errors,
  };
}
