/**
 * Tool Registry for multi-language support
 *
 * Maps languages to their specific tool configurations for testing,
 * linting, formatting, and other development tasks.
 */

import {
  SupportedLanguage,
  ToolConfig,
  ToolType,
  SUPPORTED_LANGUAGES,
  TOOL_TYPES,
} from '../core/types.js';

/**
 * PHP tool configurations
 */
export const PHP_TOOLS: ToolConfig[] = [
  {
    language: 'php',
    toolType: 'linter',
    command: 'vendor/bin/phpcs',
    configFile: 'phpcs.xml',
    requiredFiles: ['vendor/bin/phpcs'],
  },
  {
    language: 'php',
    toolType: 'formatter',
    command: 'vendor/bin/phpcbf',
    configFile: 'phpcs.xml',
    requiredFiles: ['vendor/bin/phpcbf'],
  },
  {
    language: 'php',
    toolType: 'test_runner',
    command: 'vendor/bin/phpunit',
    configFile: 'phpunit.xml',
    requiredFiles: ['vendor/bin/phpunit'],
  },
  {
    language: 'php',
    toolType: 'coverage',
    command: 'vendor/bin/phpunit --coverage-clover coverage/clover.xml',
    configFile: 'phpunit.xml',
    requiredFiles: ['vendor/bin/phpunit'],
  },
  {
    language: 'php',
    toolType: 'security_scanner',
    command: 'vendor/bin/phpcs',
    configFile: 'phpcs.xml',
    requiredFiles: ['vendor/bin/phpcs'],
  },
];

/**
 * TypeScript tool configurations
 */
export const TYPESCRIPT_TOOLS: ToolConfig[] = [
  {
    language: 'typescript',
    toolType: 'linter',
    command: 'npx eslint',
    configFile: 'eslint.config.js',
    requiredFiles: ['node_modules/eslint'],
  },
  {
    language: 'typescript',
    toolType: 'type_checker',
    command: 'npx tsc --noEmit',
    configFile: 'tsconfig.json',
    requiredFiles: ['node_modules/typescript'],
  },
  {
    language: 'typescript',
    toolType: 'formatter',
    command: 'npx prettier --write',
    configFile: '.prettierrc',
    requiredFiles: ['node_modules/prettier'],
  },
  {
    language: 'typescript',
    toolType: 'test_runner',
    command: 'npx vitest run',
    configFile: 'vitest.config.ts',
    requiredFiles: ['node_modules/vitest'],
  },
  {
    language: 'typescript',
    toolType: 'coverage',
    command: 'npx vitest run --coverage',
    configFile: 'vitest.config.ts',
    requiredFiles: ['node_modules/vitest'],
  },
];

/**
 * JavaScript tool configurations (subset of TypeScript without type checker)
 */
export const JAVASCRIPT_TOOLS: ToolConfig[] = [
  {
    language: 'javascript',
    toolType: 'linter',
    command: 'npx eslint',
    configFile: 'eslint.config.js',
    requiredFiles: ['node_modules/eslint'],
  },
  {
    language: 'javascript',
    toolType: 'formatter',
    command: 'npx prettier --write',
    configFile: '.prettierrc',
    requiredFiles: ['node_modules/prettier'],
  },
  {
    language: 'javascript',
    toolType: 'test_runner',
    command: 'npx vitest run',
    configFile: 'vitest.config.js',
    requiredFiles: ['node_modules/vitest'],
  },
  {
    language: 'javascript',
    toolType: 'coverage',
    command: 'npx vitest run --coverage',
    configFile: 'vitest.config.js',
    requiredFiles: ['node_modules/vitest'],
  },
];

/**
 * Master tool registry mapping languages to their tools
 */
const TOOL_REGISTRY: Record<SupportedLanguage, ToolConfig[]> = {
  php: PHP_TOOLS,
  typescript: TYPESCRIPT_TOOLS,
  javascript: JAVASCRIPT_TOOLS,
};

/**
 * Gets all tool configurations for a specific language
 *
 * @param language - The programming language
 * @returns Array of tool configurations for that language
 */
export function getToolsForLanguage(language: SupportedLanguage): ToolConfig[] {
  return TOOL_REGISTRY[language] || [];
}

/**
 * Gets a specific tool configuration for a language
 *
 * @param language - The programming language
 * @param toolType - The type of tool (linter, test_runner, etc.)
 * @returns The tool configuration or undefined if not found
 */
export function getToolForLanguage(
  language: SupportedLanguage,
  toolType: ToolType
): ToolConfig | undefined {
  const tools = getToolsForLanguage(language);
  return tools.find((t) => t.toolType === toolType);
}

/**
 * Gets the command for a specific tool and language
 *
 * @param language - The programming language
 * @param toolType - The type of tool
 * @returns The command string or undefined if not found
 */
export function getToolCommand(
  language: SupportedLanguage,
  toolType: ToolType
): string | undefined {
  const tool = getToolForLanguage(language, toolType);
  return tool?.command;
}

/**
 * Gets the config file for a specific tool and language
 *
 * @param language - The programming language
 * @param toolType - The type of tool
 * @returns The config file path or undefined if not found
 */
export function getToolConfigFile(
  language: SupportedLanguage,
  toolType: ToolType
): string | undefined {
  const tool = getToolForLanguage(language, toolType);
  return tool?.configFile;
}

/**
 * Checks if a tool is available for a language
 *
 * @param language - The programming language
 * @param toolType - The type of tool
 * @returns true if the tool is configured for that language
 */
export function hasToolForLanguage(
  language: SupportedLanguage,
  toolType: ToolType
): boolean {
  return getToolForLanguage(language, toolType) !== undefined;
}

/**
 * Gets all supported languages from the registry
 */
export function getRegisteredLanguages(): SupportedLanguage[] {
  return [...SUPPORTED_LANGUAGES];
}

/**
 * Gets all tool types from the registry
 */
export function getRegisteredToolTypes(): ToolType[] {
  return [...TOOL_TYPES];
}

/**
 * Mapping from generic pipeline tool names to tool types
 * This allows pipelines to reference tools generically
 */
const GENERIC_TOOL_MAPPING: Record<string, ToolType> = {
  // Linting/static analysis
  eslint: 'linter',
  phpcs: 'linter',

  // Type checking
  typescript: 'type_checker',
  tsc: 'type_checker',

  // Testing
  vitest: 'test_runner',
  jest: 'test_runner',
  phpunit: 'test_runner',

  // Coverage
  coverage: 'coverage',

  // Formatting
  prettier: 'formatter',
  phpcbf: 'formatter',

  // Security
  security: 'security_scanner',
};

/**
 * Maps a generic tool name to its tool type
 *
 * @param genericName - Generic tool name from pipeline config
 * @returns The corresponding tool type or undefined
 */
export function mapGenericToolToType(
  genericName: string
): ToolType | undefined {
  return GENERIC_TOOL_MAPPING[genericName.toLowerCase()];
}

/**
 * Gets the language-specific command for a generic tool name
 *
 * @param language - The programming language
 * @param genericToolName - Generic tool name from pipeline
 * @returns The language-specific command or the original name if not found
 */
export function resolveGenericTool(
  language: SupportedLanguage,
  genericToolName: string
): string {
  const toolType = mapGenericToolToType(genericToolName);
  if (!toolType) {
    return genericToolName; // Return as-is if not a known generic tool
  }

  const command = getToolCommand(language, toolType);
  return command || genericToolName;
}
