/**
 * Settings loader with hierarchical configuration support
 *
 * Configuration hierarchy (highest to lowest priority):
 * 1. CLI arguments
 * 2. Project-level: .airunx/settings.json
 * 3. Global user: ~/.airunx/settings.json
 * 4. Package defaults: config/default/settings.json
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve, isAbsolute } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import { createLogger } from './logger.js';
import {
  EXECUTION_FIDELITY_LEVELS,
  ApprovalModeSchema,
} from '../core/types.js';
import { BACKEND_TYPES } from '../core/adapter-types.js';
import {
  getPackageDefaultDir,
  getGlobalConfigDir,
  getProjectConfigDir,
} from './paths.js';
import { parseJsonc } from './json-utils.js';

const logger = createLogger('settings');

/**
 * Execution fidelity level - uses single source of truth from core/types.ts
 */
export const FidelityLevelSchema = z.enum(EXECUTION_FIDELITY_LEVELS);
export type FidelityLevel = z.infer<typeof FidelityLevelSchema>;

/**
 * Backend type - uses single source of truth from core/adapter-types.ts
 */
export const BackendTypeSchema = z.enum(BACKEND_TYPES);
export type BackendType = z.infer<typeof BackendTypeSchema>;

/**
 * Tool config overrides schema
 * Allows projects to specify custom config file paths for each tool type
 */
export const ToolConfigsSchema = z
  .object({
    linter_config: z.string().nullable().optional(),
    type_checker_config: z.string().nullable().optional(),
    test_runner_config: z.string().nullable().optional(),
    coverage_config: z.string().nullable().optional(),
    formatter_config: z.string().nullable().optional(),
    security_scanner_config: z.string().nullable().optional(),
    /** Output directory for generated documentation (default: ./docs) */
    docs_location: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

export type ToolConfigs = z.infer<typeof ToolConfigsSchema>;

/**
 * Main settings schema
 * Note: backends and execution_fidelity are configured in config.yml (see system-config.ts)
 * to maintain a single source of truth for these settings.
 */
/**
 * Schema for project folder entries (string path or object with name/path)
 */
const ProjectFolderSchema = z.union([
  z.string().min(1),
  z.object({
    name: z.string().min(1).optional(),
    path: z.string().min(1),
  }),
]);

/**
 * PR title rules schema - maps commit types to keyword arrays
 */
export const PRTitleRulesSchema = z
  .record(
    z.string(),
    z.union([z.array(z.string()), z.string()]) // Values can be keyword arrays or string (for 'default')
  )
  .nullable()
  .optional();

export type PRTitleRules = z.infer<typeof PRTitleRulesSchema>;

/**
 * PR label rules schema - controls automatic label generation
 */
export const PRLabelRulesSchema = z
  .object({
    always: z.array(z.string()).optional(),
    include_backend: z.boolean().optional(),
    include_fidelity: z.boolean().optional(),
    custom: z.array(z.string()).optional(),
  })
  .nullable()
  .optional();

export type PRLabelRules = z.infer<typeof PRLabelRulesSchema>;

export const SettingsSchema = z.object({
  context_location: z.string().nullable().optional(),
  mcp_json_location: z.string().nullable().optional(),
  agents_md_location: z.string().nullable().optional(),
  pipelines_yaml_location: z.string().nullable().optional(),
  default_project_location: z.string().nullable().optional(),
  /** Array of project folders for multi-project support (VSCode workspace compatible) */
  folders: z.array(ProjectFolderSchema).optional(),
  default_fidelity: FidelityLevelSchema.optional().default('standard'),
  default_backend: BackendTypeSchema.optional().default('claude-code'),
  /** Skip checking if AIRunX is up-to-date with remote repository */
  skip_version_check: z.boolean().optional().default(false),
  /** Default base branch for git worktrees (e.g., 'main', 'master', 'develop') */
  default_base_branch: z.string().nullable().optional(),
  /** Skip syncing source branch with remote before worktree creation */
  skip_sync: z.boolean().optional().default(false),
  /** Override default tool configuration paths */
  tool_configs: ToolConfigsSchema,
  /** Disable Compound Engineering sub-agent delegation (use raw Claude Code) */
  disable_compound_engineering: z.boolean().optional().default(false),
  /** Approval mode for CLI adapters (controls permission prompts) */
  approval_mode: ApprovalModeSchema.optional().default('auto'),
  /** Custom PR title type inference rules */
  gh_pr_title_rules: PRTitleRulesSchema,
  /** Custom PR label generation rules */
  gh_pr_label_rules: PRLabelRulesSchema,
  /** Enable verbose progress reporting during workflow execution */
  verbose_progress: z.boolean().optional().default(true),
  /** Include airunx signature badge in PR descriptions */
  airunx_signature: z.boolean().optional().default(true),
  /** Directory for cloning repos when not found locally (server deployments) */
  workspace_location: z.string().nullable().optional(),
  /** Explicit path to .env file for environment loading */
  env_file_location: z.string().nullable().optional(),
  /**
   * Poll GitHub Actions after PR creation and iterate on CI failures
   * (up to 3 attempts). Requires workflows in the repo; no-ops otherwise.
   * When false, PRs can be marked complete with failing CI.
   */
  ci_verification_gate: z.boolean().optional().default(false),
  /** Mark completed checkboxes on source GitHub issues after pipeline completion */
  mark_issue_checkboxes: z.boolean().optional().default(true),
});

export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Resolved tool config paths
 */
export interface ResolvedToolConfigs {
  linter_config?: string;
  type_checker_config?: string;
  test_runner_config?: string;
  coverage_config?: string;
  formatter_config?: string;
  security_scanner_config?: string;
  docs_location?: string;
}

/**
 * Resolved settings with absolute paths
 */
export interface ResolvedSettings extends Settings {
  _source: 'default' | 'global' | 'project';
  _sourceFile: string;
  resolvedPaths: {
    context?: string;
    mcp_json?: string;
    agents_md?: string;
    pipelines_yaml?: string;
    project?: string;
    workspace?: string;
    env_file?: string;
  };
  resolvedToolConfigs: ResolvedToolConfigs;
}

/**
 * Expand home directory (~/) in a path
 */
export function expandPath(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/**
 * Resolve a path relative to a base directory
 * Uses expandPath for ~/ expansion to avoid duplication
 */
function resolvePath(
  path: string | null | undefined,
  baseDir: string
): string | undefined {
  const expandedPath = expandPath(path);
  if (!expandedPath) return undefined;
  return isAbsolute(expandedPath)
    ? expandedPath
    : resolve(baseDir, expandedPath);
}

/**
 * Load settings from a specific file
 */
function loadSettingsFile(filePath: string): Settings | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    // Treat empty or whitespace-only files as non-existent (no warning)
    if (!content.trim()) {
      return null;
    }
    const parsed = parseJsonc(content);
    return SettingsSchema.parse(parsed);
  } catch (error) {
    logger.warn(`Failed to load settings from ${filePath}:`, error);
    return null;
  }
}

/**
 * Deep merge two objects recursively (source overrides target)
 */
function mergeSettings(target: object, source: object): object {
  const result: Record<string, unknown> = { ...target };

  for (const key of Object.keys(source)) {
    const sourceValue = (source as Record<string, unknown>)[key];
    if (sourceValue === undefined) continue;

    const targetValue = (result as Record<string, unknown>)[key];

    if (sourceValue === null) {
      // Explicit null clears the value
      result[key] = null;
    } else if (
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      sourceValue !== null &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue) &&
      targetValue !== null
    ) {
      // Recursively deep merge nested objects
      result[key] = mergeSettings(targetValue, sourceValue);
    } else {
      result[key] = sourceValue;
    }
  }

  return result;
}

/**
 * Cache for memoized settings to avoid redundant file I/O
 */
const settingsCache = new Map<string, ResolvedSettings>();

/**
 * Load settings with full hierarchy resolution (memoized)
 *
 * @param projectDir - Optional project directory (defaults to cwd)
 * @returns Resolved settings with absolute paths
 */
export function loadSettings(projectDir?: string): ResolvedSettings {
  const cacheKey = projectDir ?? process.cwd();

  // Return cached settings if available
  const cached = settingsCache.get(cacheKey);
  if (cached) {
    logger.debug(`Using cached settings for: ${cacheKey}`);
    return cached;
  }
  const packageDefaultDir = getPackageDefaultDir();
  const globalConfigDir = getGlobalConfigDir();
  const projectConfigDir = getProjectConfigDir(projectDir);

  // Load from each level
  const defaultSettings = loadSettingsFile(
    join(packageDefaultDir, 'settings.json')
  );
  const globalSettings = loadSettingsFile(
    join(globalConfigDir, 'settings.json')
  );
  const projectSettings = loadSettingsFile(
    join(projectConfigDir, 'settings.json')
  );

  // Start with defaults
  let settings: Settings = defaultSettings || {
    default_fidelity: 'standard',
    default_backend: 'claude-code',
    skip_version_check: false,
    skip_sync: false,
    disable_compound_engineering: false,
    approval_mode: 'auto',
    verbose_progress: true,
    airunx_signature: true,
    ci_verification_gate: false,
    mark_issue_checkboxes: true,
  };
  let source: 'default' | 'global' | 'project' = 'default';
  let sourceFile = join(packageDefaultDir, 'settings.json');
  let baseDir = packageDefaultDir;

  // Merge global settings
  if (globalSettings) {
    settings = mergeSettings(settings, globalSettings) as Settings;
    source = 'global';
    sourceFile = join(globalConfigDir, 'settings.json');
    baseDir = globalConfigDir;
  }

  // Merge project settings (highest priority)
  if (projectSettings) {
    settings = mergeSettings(settings, projectSettings) as Settings;
    source = 'project';
    sourceFile = join(projectConfigDir, 'settings.json');
    baseDir = projectConfigDir;
  }

  // Resolve paths relative to the most specific settings file
  const resolvedPaths: {
    context?: string;
    mcp_json?: string;
    agents_md?: string;
    pipelines_yaml?: string;
    project?: string;
    workspace?: string;
    env_file?: string;
  } = {
    context: resolvePath(settings.context_location, baseDir),
    mcp_json: resolvePath(settings.mcp_json_location, baseDir),
    agents_md: resolvePath(settings.agents_md_location, baseDir),
    pipelines_yaml: resolvePath(settings.pipelines_yaml_location, baseDir),
    project: resolvePath(settings.default_project_location, baseDir),
    workspace: resolvePath(
      settings.workspace_location ?? '~/.airunx/repos',
      baseDir
    ),
    env_file: resolvePath(settings.env_file_location, baseDir),
  };

  // Security: restrict env_file_location to project-scoped paths.
  // For project settings, baseDir is .airunx/ — allow parent (project root) too.
  if (resolvedPaths.env_file) {
    const resolvedEnv = resolve(resolvedPaths.env_file);
    const projectRoot =
      source === 'project' ? resolve(baseDir, '..') : resolve(baseDir);
    if (
      !resolvedEnv.startsWith(projectRoot + '/') &&
      resolvedEnv !== projectRoot
    ) {
      logger.warn(
        `env_file_location "${settings.env_file_location}" resolves outside project root. Ignoring for security.`
      );
      resolvedPaths.env_file = undefined;
    }
  }

  // Helper to resolve implicit paths with hierarchy: settings path → global → package default
  const resolveImplicitPath = (
    key: 'agents_md' | 'pipelines_yaml',
    filename: string
  ): void => {
    if (!resolvedPaths[key]) {
      const globalPath = join(globalConfigDir, filename);
      if (existsSync(globalPath)) {
        resolvedPaths[key] = globalPath;
        logger.debug(`Using global ${filename}: ${globalPath}`);
      } else {
        resolvedPaths[key] = join(packageDefaultDir, filename);
        logger.debug(
          `Using package default ${filename}: ${resolvedPaths[key]}`
        );
      }
    }
  };

  resolveImplicitPath('agents_md', 'AGENTS.md');
  resolveImplicitPath('pipelines_yaml', 'pipelines.yaml');

  // Resolve tool config paths relative to the most specific settings file
  const resolvedToolConfigs: ResolvedToolConfigs = {};
  if (settings.tool_configs) {
    const tc = settings.tool_configs;
    const toolConfigKeys = [
      'linter_config',
      'type_checker_config',
      'test_runner_config',
      'coverage_config',
      'formatter_config',
      'security_scanner_config',
      'docs_location',
    ] as const;

    for (const key of toolConfigKeys) {
      const configPath = tc[key];
      if (configPath) {
        resolvedToolConfigs[key] = resolvePath(configPath, baseDir);
      }
    }
  }

  logger.debug(`Loaded settings from ${source}: ${sourceFile}`);

  const resolvedSettings: ResolvedSettings = {
    ...settings,
    _source: source,
    _sourceFile: sourceFile,
    resolvedPaths,
    resolvedToolConfigs,
  };

  // Cache the result
  settingsCache.set(cacheKey, resolvedSettings);

  return resolvedSettings;
}

/**
 * Clear the settings cache (useful for testing or when settings files change)
 */
export function clearSettingsCache(): void {
  settingsCache.clear();
  logger.debug('Settings cache cleared');
}

/**
 * Get the default AGENTS.md content
 */
export function getDefaultAgentsMd(): string {
  const defaultPath = join(getPackageDefaultDir(), 'AGENTS.md');
  if (existsSync(defaultPath)) {
    return readFileSync(defaultPath, 'utf-8');
  }
  throw new Error('Default AGENTS.md not found in package');
}

/**
 * Get the default pipelines.yaml content
 */
export function getDefaultPipelinesYaml(): string {
  const defaultPath = join(getPackageDefaultDir(), 'pipelines.yaml');
  if (existsSync(defaultPath)) {
    return readFileSync(defaultPath, 'utf-8');
  }
  throw new Error('Default pipelines.yaml not found in package');
}

/**
 * Check if global config directory exists
 */
export function hasGlobalConfig(): boolean {
  return existsSync(join(getGlobalConfigDir(), 'settings.json'));
}

/**
 * Check if project config directory exists
 */
export function hasProjectConfig(projectDir?: string): boolean {
  return existsSync(join(getProjectConfigDir(projectDir), 'settings.json'));
}

/**
 * Get all config locations for display
 */
export function getConfigLocations(projectDir?: string): {
  packageDefault: string;
  global: string;
  project: string;
} {
  return {
    packageDefault: join(getPackageDefaultDir(), 'settings.json'),
    global: join(getGlobalConfigDir(), 'settings.json'),
    project: join(getProjectConfigDir(projectDir), 'settings.json'),
  };
}
