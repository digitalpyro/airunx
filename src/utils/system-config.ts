/**
 * System configuration loader and validator
 *
 * Configuration hierarchy (highest to lowest priority):
 * 1. CLI arguments
 * 2. Project-level: .airunx/config.yml
 * 3. Global user: ~/.airunx/config.yml
 * 4. Legacy: .agentos/config.yml (for backwards compatibility)
 * 5. Generated defaults
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { SystemConfig, BackendType } from '../core/adapter-types.js';
import {
  SystemConfigSchema,
  DEFAULT_FALLBACK_BACKEND,
} from '../core/adapter-types.js';
import type { AgentRole } from '../core/types.js';
import { AGENT_ROLES } from '../core/types.js';
import { handleConfigError } from './error-handlers.js';
import {
  DEFAULT_CLI_EXECUTABLES,
  DEFAULT_CLI_TIMEOUT_SECONDS,
  DEFAULT_API_KEY_ENV,
} from '../adapters/constants.js';
import {
  DEFAULT_FIDELITY_CONFIG,
  convertFidelityConfigToSnakeCase,
} from './fidelity-resolver.js';
import { createLogger } from './logger.js';
import {
  getProjectConfigDir,
  getGlobalConfigDir,
  getLegacyConfigDir,
} from './paths.js';

const logger = createLogger('system-config');

/**
 * Load system config with hierarchy support
 * Priority: explicit path → project → global → legacy → defaults
 */
export function loadSystemConfig(configPath?: string): SystemConfig {
  // If explicit path provided, fail fast if missing or invalid
  if (configPath) {
    const config = loadConfigFromPath(configPath);
    if (!config) {
      throw new Error(`Configuration file not found: ${configPath}`);
    }
    return config;
  }

  // Check project-level config (.airunx/config.yml)
  const projectPath = join(getProjectConfigDir(), 'config.yml');
  if (existsSync(projectPath)) {
    logger.debug(`Loading system config from project: ${projectPath}`);
    const config = loadConfigFromPath(projectPath);
    if (config) return config;
  }

  // Check global config (~/.airunx/config.yml)
  const globalPath = join(getGlobalConfigDir(), 'config.yml');
  if (existsSync(globalPath)) {
    logger.debug(`Loading system config from global: ${globalPath}`);
    const config = loadConfigFromPath(globalPath);
    if (config) return config;
  }

  // Check legacy config (.agentos/config.yml) for backwards compatibility
  const legacyPath = join(getLegacyConfigDir(), 'config.yml');
  if (existsSync(legacyPath)) {
    logger.debug(`Loading system config from legacy path: ${legacyPath}`);
    logger.warn(
      'Using legacy .agentos/config.yml - consider migrating to .airunx/config.yml'
    );
    const config = loadConfigFromPath(legacyPath);
    if (config) return config;
  }

  // Tier 5: Generate defaults (no config found at any location)
  logger.warn(
    `No config.yml found, using default configuration (backend: ${DEFAULT_FALLBACK_BACKEND})`
  );
  return generateDefaultConfig(DEFAULT_FALLBACK_BACKEND);
}

/**
 * Migrate legacy 'compound-engineering' backend references to 'claude-code'
 * This is needed because compound-engineering is no longer a separate backend type;
 * it's now automatically included when using claude-code.
 *
 * This function is pure - it creates a deep copy and doesn't mutate the input.
 */
function migrateLegacyConfig(config: unknown): unknown {
  if (!config || typeof config !== 'object') {
    return config;
  }

  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

  // Deep copy to avoid mutating the original object, making the function pure
  const newConfig = structuredClone(config) as Record<string, unknown>;
  let migrated = false;

  // Migrate fallback_backend
  if (newConfig.fallback_backend === 'compound-engineering') {
    newConfig.fallback_backend = 'claude-code';
    migrated = true;
  }

  // Migrate agent_routing
  if (isPlainObject(newConfig.agent_routing)) {
    for (const role of Object.keys(newConfig.agent_routing)) {
      if (newConfig.agent_routing[role] === 'compound-engineering') {
        newConfig.agent_routing[role] = 'claude-code';
        migrated = true;
      }
    }
  }

  // Migrate backends object keys (remove compound-engineering entry)
  if (isPlainObject(newConfig.backends)) {
    if ('compound-engineering' in newConfig.backends) {
      delete newConfig.backends['compound-engineering'];
      migrated = true;
    }
  }

  if (migrated) {
    logger.info(
      'Migrated legacy compound-engineering references to claude-code'
    );
  }

  return newConfig;
}

/**
 * Load config from a specific path
 */
function loadConfigFromPath(path: string): SystemConfig | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = readFileSync(path, 'utf-8');
    let parsed = parseYaml(content);

    // Migrate legacy compound-engineering references before validation
    parsed = migrateLegacyConfig(parsed);

    // Validate with Zod and return the validated, type-safe config
    return SystemConfigSchema.parse(parsed);
  } catch (error) {
    handleConfigError(error, 'system', path);
  }
}

/**
 * Save system config to .airunx/config.yml (or specified path)
 */
export function saveSystemConfig(
  config: SystemConfig,
  configPath?: string
): void {
  const defaultPath = join(getProjectConfigDir(), 'config.yml');
  const path = configPath || defaultPath;

  // Ensure directory exists
  const dir = join(path, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Validate before saving
  SystemConfigSchema.parse(config);

  // Convert to YAML and save
  const yaml = stringifyYaml(config);
  writeFileSync(path, yaml, 'utf-8');
}

/**
 * Generate default system config
 */
export function generateDefaultConfig(
  availableBackend: BackendType
): SystemConfig {
  // Programmatically generate agent_routing for all agent roles
  const agent_routing = Object.fromEntries(
    AGENT_ROLES.map((role) => [role, availableBackend])
  ) as Record<AgentRole, BackendType>;

  return {
    agent_routing,
    backends: {
      'claude-code': {
        type: 'cli',
        executable: DEFAULT_CLI_EXECUTABLES.CLAUDE_CODE,
        timeout: DEFAULT_CLI_TIMEOUT_SECONDS,
        verify_install: true,
      },
      cursor: {
        type: 'cli',
        executable: DEFAULT_CLI_EXECUTABLES.CURSOR,
        timeout: DEFAULT_CLI_TIMEOUT_SECONDS,
        verify_install: true,
        api_key_env: DEFAULT_API_KEY_ENV.cursor,
      },
      codex: {
        type: 'cli',
        executable: DEFAULT_CLI_EXECUTABLES.CODEX,
        timeout: DEFAULT_CLI_TIMEOUT_SECONDS,
        verify_install: true,
        api_key_env: DEFAULT_API_KEY_ENV.codex,
      },
    },
    fallback_backend: availableBackend,
    verify_on_start: true,
    cache_ttl_minutes: 5,
    execution_fidelity: convertFidelityConfigToSnakeCase(
      DEFAULT_FIDELITY_CONFIG
    ),
  };
}

/**
 * Validate system config
 */
export function validateSystemConfig(config: SystemConfig): {
  valid: boolean;
  errors: string[];
} {
  try {
    SystemConfigSchema.parse(config);
    return { valid: true, errors: [] };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        valid: false,
        errors: error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
      };
    }
    return {
      valid: false,
      errors: [String(error)],
    };
  }
}
