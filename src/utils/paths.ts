/**
 * Centralized path utilities for resolving project paths
 *
 * This module provides a single source of truth for resolving paths
 * relative to the package root, avoiding duplicated path resolution
 * logic throughout the codebase.
 */

import { dirname, join, resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

/**
 * Cached package root path to avoid repeated lookups
 */
let cachedPackageRoot: string | undefined;

/**
 * Get the package root directory by searching upward for package.json
 *
 * @param startDir - Directory to start searching from (defaults to current module's directory)
 * @returns Absolute path to the package root (falls back to relative path if package.json not found)
 */
export function getPackageRoot(startDir?: string): string {
  if (cachedPackageRoot) {
    return cachedPackageRoot;
  }

  // Default to the directory containing this module
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  let currentDir = startDir ?? __dirname;

  // Search upward for package.json
  const maxDepth = 10; // Prevent infinite loops
  for (let i = 0; i < maxDepth; i++) {
    const packageJsonPath = join(currentDir, 'package.json');
    if (existsSync(packageJsonPath)) {
      cachedPackageRoot = currentDir;
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached filesystem root
      break;
    }
    currentDir = parentDir;
  }

  // Fallback: use relative path from compiled location (dist/utils/)
  // This handles cases where package.json might not be found
  cachedPackageRoot = resolve(__dirname, '..', '..');
  return cachedPackageRoot;
}

/**
 * Get the package's default config directory
 *
 * @returns Absolute path to config/default directory
 */
export function getPackageDefaultDir(): string {
  return join(getPackageRoot(), 'config', 'default');
}

/**
 * Clear the cached package root (useful for testing)
 */
export function clearPackageRootCache(): void {
  cachedPackageRoot = undefined;
}

/**
 * Get the global user config directory (~/.airunx)
 *
 * @returns Absolute path to the global config directory
 */
export function getGlobalConfigDir(): string {
  return join(homedir(), '.airunx');
}

/**
 * Get the project config directory (.airunx in project root)
 *
 * @param projectDir - Optional project directory (defaults to cwd)
 * @returns Absolute path to the project config directory
 */
export function getProjectConfigDir(projectDir?: string): string {
  return join(projectDir || process.cwd(), '.airunx');
}

/**
 * Get the legacy config directory (.agentos for backwards compatibility)
 *
 * @returns Absolute path to the legacy config directory
 */
export function getLegacyConfigDir(): string {
  return join(process.cwd(), '.agentos');
}

/**
 * Cached package version to avoid repeated file reads
 */
let cachedPackageVersion: string | undefined;

/**
 * Get the package version from package.json
 *
 * @returns Package version string (e.g., "1.0.0")
 */
export function getPackageVersion(): string {
  if (cachedPackageVersion) {
    return cachedPackageVersion;
  }

  const packageJsonPath = join(getPackageRoot(), 'package.json');
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      version?: string;
    };
    const version = packageJson.version;
    if (!version) {
      throw new Error('version field is missing');
    }
    cachedPackageVersion = version;
    return version;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to read package version from ${packageJsonPath}: ${message}`
    );
  }
}

/**
 * Clear the cached package version (useful for testing)
 */
export function clearPackageVersionCache(): void {
  cachedPackageVersion = undefined;
}

/**
 * Resolve the path to AGENTS.md file
 *
 * Priority order:
 * 1. Explicit path provided by caller
 * 2. Path from settings.json (resolvedPaths.agents_md)
 * 3. Local .airunx/AGENTS.md
 * 4. Legacy .agents/AGENTS.md
 *
 * @param explicitPath - Optional explicit path to check first
 * @param settings - Optional settings object (to avoid circular imports)
 * @returns Absolute path to AGENTS.md or null if not found
 */
export function resolveAgentsMdPath(
  explicitPath?: string,
  settings?: { resolvedPaths?: { agents_md?: string } }
): string | null {
  // 1. Explicit path provided
  if (explicitPath) {
    const resolved = resolve(explicitPath);
    if (existsSync(resolved)) {
      return resolved;
    }
    return null;
  }

  // 2. Try to find via settings
  const settingsPath = settings?.resolvedPaths?.agents_md;
  if (settingsPath && existsSync(settingsPath)) {
    return settingsPath;
  }

  // 3. Check local .airunx/AGENTS.md
  const localPath = join(process.cwd(), '.airunx', 'AGENTS.md');
  if (existsSync(localPath)) {
    return localPath;
  }

  // 4. Check legacy .agents/AGENTS.md
  const legacyPath = join(process.cwd(), '.agents', 'AGENTS.md');
  if (existsSync(legacyPath)) {
    return legacyPath;
  }

  return null;
}
