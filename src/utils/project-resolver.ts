/**
 * Project Resolver - Intelligent project detection for multi-project workflows
 *
 * Detection priority:
 * 1. CLI flag (--project): Explicit selection
 * 2. Prompt analysis: Extract project name from work prompt
 * 3. Current directory: Check if cwd is within a configured project
 * 4. Default project: Fall back to default_project_location
 * 5. Current working directory: Last resort fallback to process.cwd()
 */

import { basename, resolve, isAbsolute, dirname } from 'path';
import { existsSync, statSync } from 'fs';
import type { ResolvedSettings } from './settings.js';
import { createLogger } from './logger.js';

const logger = createLogger('project-resolver');

/**
 * Normalized project folder with name and path
 */
export interface ProjectFolder {
  name: string;
  path: string;
}

/**
 * Options for project resolution
 */
export interface ResolveProjectOptions {
  /** Explicit project from --project CLI flag */
  cliFlag?: string;
  /** Work prompt to analyze for project mentions */
  prompt?: string;
  /** Current working directory */
  cwd: string;
  /** Loaded settings (must be ResolvedSettings with pre-resolved paths) */
  settings: ResolvedSettings;
}

/**
 * Result of project resolution
 */
export interface ResolvedProject {
  /** Resolved project info */
  project: ProjectFolder;
  /** How the project was resolved */
  source: 'cli-flag' | 'prompt' | 'cwd' | 'default' | 'fallback';
}

/**
 * Parse folders from settings into normalized ProjectFolder array
 * Handles both string paths and {name, path} objects
 * Resolves relative paths from the settings file location
 * Throws error on duplicate project names (fail fast)
 */
export function parseProjectFolders(
  settings: ResolvedSettings
): ProjectFolder[] {
  const foldersConfig = settings.folders;
  if (!foldersConfig) {
    return [];
  }

  // Resolve relative paths from the settings file directory
  const baseDir = dirname(settings._sourceFile);

  const folders = foldersConfig.map((entry) => {
    const path = typeof entry === 'string' ? entry : entry.path;
    const name = typeof entry === 'object' ? entry.name : undefined;
    const resolvedPath = isAbsolute(path) ? path : resolve(baseDir, path);

    // Validate path exists and is a directory (fail fast on invalid configuration)
    if (!existsSync(resolvedPath)) {
      throw new Error(
        `Project folder path does not exist: ${resolvedPath} (from settings file ${settings._sourceFile})`
      );
    }
    if (!statSync(resolvedPath).isDirectory()) {
      throw new Error(
        `Project folder path is not a directory: ${resolvedPath} ` +
          `(from settings file ${settings._sourceFile})`
      );
    }

    return {
      name: name || basename(resolvedPath),
      path: resolvedPath,
    };
  });

  // Check for duplicate names and paths, throw error on duplicates (fail fast)
  const seenNames = new Set<string>();
  const seenPaths = new Set<string>();
  for (const folder of folders) {
    const lowerName = folder.name.toLowerCase();
    if (seenNames.has(lowerName)) {
      throw new Error(
        `Duplicate project name '${folder.name}' (case-insensitive) in folders. ` +
          `Use explicit { name, path } objects to give unique names.`
      );
    }
    seenNames.add(lowerName);

    if (seenPaths.has(folder.path)) {
      throw new Error(
        `Duplicate project path '${folder.path}' in folders. ` +
          `Each project must have a unique path.`
      );
    }
    seenPaths.add(folder.path);
  }

  return folders;
}

/**
 * Find all projects matching by name or path
 * Returns array of matches for ambiguity detection
 */
function findMatchesByNameOrPath(
  identifier: string,
  folders: ProjectFolder[]
): ProjectFolder[] {
  const lowerIdentifier = identifier.toLowerCase();

  // First try exact name match (case-insensitive)
  const nameMatches = folders.filter(
    (f) => f.name.toLowerCase() === lowerIdentifier
  );
  if (nameMatches.length > 0) return nameMatches;

  // Then try full path match
  // Note: Relative paths are resolved against process.cwd() as this function
  // is called with CLI --project flag which should be relative to where user runs the command.
  // For paths relative to settings file location, use the settings loader instead.
  const normalizedId = isAbsolute(identifier)
    ? identifier
    : resolve(process.cwd(), identifier);

  const pathMatches = folders.filter((f) => f.path === normalizedId);
  if (pathMatches.length > 0) return pathMatches;

  // Try basename match (e.g., "my-app" matches "/home/user/my-app")
  return folders.filter(
    (f) => basename(f.path).toLowerCase() === lowerIdentifier
  );
}

/**
 * Check if a character is part of a project identifier (for boundary detection)
 * Includes alphanumeric, hyphens, underscores, and dots - common in project names
 * This prevents false positives where "api" would match in "api.v2" or "frontend-api"
 */
function isProjectIdentifierChar(char: string | undefined): boolean {
  // Allow alphanumeric, hyphens, underscores, and dots - common in project names
  return !!char && /[a-z0-9_.-]/i.test(char);
}

/**
 * Calculate Levenshtein distance between two strings
 * Used for "Did you mean?" suggestions
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1 // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Find closest matching project name for "Did you mean?" suggestions
 * Returns the closest match if within threshold, otherwise undefined
 */
function findClosestProjectMatch(
  input: string,
  folders: ProjectFolder[]
): string | undefined {
  if (folders.length === 0) return undefined;

  const lowerInput = input.toLowerCase();
  let closestMatch: string | undefined;
  let minDistance = Infinity;

  // Threshold: max 2 edits for short names, max 3 for longer names
  const maxDistance = input.length <= 5 ? 2 : 3;

  for (const folder of folders) {
    const distance = levenshteinDistance(lowerInput, folder.name.toLowerCase());
    if (distance < minDistance && distance <= maxDistance) {
      minDistance = distance;
      closestMatch = folder.name;
    }
  }

  return closestMatch;
}

/**
 * Detect project names mentioned in a prompt using manual boundary checking
 * This handles project names with hyphens and other non-word characters
 * that regex \b word boundaries fail to match correctly
 */
function detectFromPrompt(
  prompt: string,
  folders: ProjectFolder[]
): ProjectFolder[] {
  const lowerPrompt = prompt.toLowerCase();
  return folders.filter((folder) => {
    const lowerName = folder.name.toLowerCase();
    // Skip empty names and very short names to avoid false positives (e.g., 'a' matching article 'a')
    if (!lowerName || lowerName.length < 2) {
      return false;
    }

    let fromIndex = 0;
    while (fromIndex < lowerPrompt.length) {
      const i = lowerPrompt.indexOf(lowerName, fromIndex);
      if (i === -1) {
        return false; // Not found in the rest of the string
      }

      // Check characters before and after the match to ensure it's a whole word
      const prevChar = lowerPrompt[i - 1];
      const nextChar = lowerPrompt[i + lowerName.length];

      if (
        !isProjectIdentifierChar(prevChar) &&
        !isProjectIdentifierChar(nextChar)
      ) {
        return true; // Found a valid whole-word match
      }

      // If not a whole word, continue searching from the next character
      fromIndex = i + 1;
    }
    return false;
  });
}

/**
 * Check if cwd is within any configured project folder
 */
function detectFromCwd(
  cwd: string,
  folders: ProjectFolder[]
): ProjectFolder | null {
  // Normalize cwd
  const normalizedCwd = resolve(cwd);

  // Find the deepest matching project (most specific)
  let bestMatch: ProjectFolder | null = null;
  let bestMatchLength = 0;

  for (const folder of folders) {
    // folder.path is already absolute from parseProjectFolders
    if (
      normalizedCwd === folder.path ||
      normalizedCwd.startsWith(folder.path + '/')
    ) {
      if (folder.path.length > bestMatchLength) {
        bestMatch = folder;
        bestMatchLength = folder.path.length;
      }
    }
  }

  return bestMatch;
}

/**
 * Resolve which project to use based on detection chain
 *
 * Priority:
 * 1. CLI flag (--project): Explicit selection
 * 2. Prompt analysis: Extract project name from work prompt
 * 3. Current directory: Check if cwd is within a configured project
 * 4. Default project: Fall back to default_project_location
 * 5. Current working directory: Last resort fallback to process.cwd()
 */
export function resolveProject(
  options: ResolveProjectOptions
): ResolvedProject {
  const folders = parseProjectFolders(options.settings);

  // Priority 1: CLI flag
  if (options.cliFlag) {
    const matches = findMatchesByNameOrPath(options.cliFlag, folders);

    if (matches.length > 1) {
      // Fail fast on ambiguous CLI flag
      throw new Error(
        `Ambiguous project identifier '${options.cliFlag}' matches multiple projects: ` +
          `${matches.map((m) => `${m.name} (${m.path})`).join(', ')}. ` +
          `Use a more specific name or the full path.`
      );
    }

    if (matches.length === 1) {
      logger.debug(`Project resolved from CLI flag: ${matches[0].name}`);
      return { project: matches[0], source: 'cli-flag' };
    }

    // If CLI flag doesn't match known projects, treat it as a path
    const resolvedPath = isAbsolute(options.cliFlag)
      ? options.cliFlag
      : resolve(options.cwd, options.cliFlag);

    // Validate path exists and is a directory (fail fast on invalid CLI input)
    if (!existsSync(resolvedPath)) {
      // Check for close matches to provide helpful "Did you mean?" suggestion
      // Try both the full flag and its basename for path-like inputs (e.g., ./frontned)
      const suggestion =
        findClosestProjectMatch(options.cliFlag, folders) ||
        findClosestProjectMatch(basename(options.cliFlag), folders);
      const suggestionText = suggestion ? ` Did you mean '${suggestion}'?` : '';
      throw new Error(
        `Project path provided via --project flag does not exist: ${options.cliFlag}.${suggestionText}`
      );
    }
    if (!statSync(resolvedPath).isDirectory()) {
      throw new Error(
        `Project path provided via --project flag is not a directory: ${options.cliFlag}`
      );
    }

    logger.debug(`Using CLI flag as path: ${resolvedPath}`);
    return {
      project: {
        name: basename(resolvedPath),
        path: resolvedPath,
      },
      source: 'cli-flag',
    };
  }

  // Priority 2: Prompt analysis
  if (options.prompt && folders.length > 0) {
    const matches = detectFromPrompt(options.prompt, folders);
    if (matches.length === 1) {
      logger.debug(`Project resolved from prompt: ${matches[0].name}`);
      return { project: matches[0], source: 'prompt' };
    }
    if (matches.length > 1) {
      // Log ambiguity but don't throw - let higher layers handle it
      logger.warn(
        `Ambiguous project match in prompt. Matches: ${matches.map((m) => m.name).join(', ')}`
      );
      // Continue to next priority rather than throwing
    }
  }

  // Priority 3: Current directory
  if (folders.length > 0) {
    const cwdMatch = detectFromCwd(options.cwd, folders);
    if (cwdMatch) {
      logger.debug(`Project resolved from cwd: ${cwdMatch.name}`);
      return { project: cwdMatch, source: 'cwd' };
    }
  }

  // Priority 4: Default project location
  // Use pre-resolved path from settings to ensure consistent resolution
  // relative to the settings file location (not cwd)
  if (options.settings.resolvedPaths.project) {
    const defaultPath = options.settings.resolvedPaths.project;

    logger.debug(`Using default project location: ${defaultPath}`);
    return {
      project: {
        name: basename(defaultPath),
        path: defaultPath,
      },
      source: 'default',
    };
  }

  // Priority 5: Package directory (cwd)
  logger.debug(`Falling back to cwd: ${options.cwd}`);
  return {
    project: {
      name: basename(options.cwd),
      path: options.cwd,
    },
    source: 'fallback',
  };
}

/**
 * Get list of all configured projects for display
 * Uses ResolvedSettings to ensure paths are absolute and comparable
 */
export function getAvailableProjects(
  settings: ResolvedSettings
): ProjectFolder[] {
  const folders = parseProjectFolders(settings);

  // Include default_project_location if not already in folders
  // Use pre-resolved path for reliable comparison with absolute paths
  if (settings.resolvedPaths.project) {
    const defaultPath = settings.resolvedPaths.project;
    const exists = folders.some((f) => f.path === defaultPath);
    if (!exists) {
      folders.push({
        name: basename(defaultPath),
        path: defaultPath,
      });
    }
  }

  return folders;
}
