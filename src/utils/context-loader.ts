/**
 * Unified Context System
 *
 * Loads context files from various sources, resolves @mentions, and merges
 * everything for agent use. This is the single entry point for all context.
 *
 * Context sources (all are parsed for @mentions):
 * - Project context: From .ai/context.md or settings.context_location
 * - Runtime context: From --context CLI flag (file or directory)
 * - Task/prompt text: Passed through for @mention resolution
 *
 * @mention patterns supported:
 * - @file:path/to/file.ts - Load specific file
 * - @folder:path/to/dir - Load all files in directory
 * - @path/to/file.ts - Shorthand (infers type from extension)
 *
 * When a directory is provided, all .md and .txt files are loaded recursively
 * up to a max depth of 3 levels.
 */

import { readFile, stat, readdir } from 'fs/promises';
import { isAbsolute, join, relative, extname } from 'path';
import { createLogger } from './logger.js';
import { ContextResolver } from './context-resolver.js';

const logger = createLogger('context-loader');

export interface MergedContext {
  /** Context from project configuration */
  projectContext: string;
  /** Context from runtime --context flag */
  runtimeContext: string;
  /** Combined context for agent use (includes resolved @mentions) */
  combined: string;
  /** Paths of loaded context files (static sources) */
  sources: string[];
  /** Paths of dynamically resolved @mention files */
  resolvedReferences: string[];
  /** @mentions that failed to resolve */
  failedReferences: Array<{ path: string; error: string }>;
}

export class ContextLoaderError extends Error {
  constructor(
    message: string,
    public readonly path: string
  ) {
    super(message);
    this.name = 'ContextLoaderError';
  }
}

/**
 * Default max depth for directory traversal (shared with context-resolver)
 */
export const DEFAULT_MAX_DEPTH = 3;

/**
 * File extensions to include when loading context from directories
 */
const CONTEXT_FILE_EXTENSIONS = ['.md', '.txt'];

/**
 * Directories to ignore when traversing
 */
export const DEFAULT_IGNORED_DIRECTORIES = [
  'node_modules',
  '.git',
  '.worktrees',
];

/**
 * Options for collecting files from a directory
 */
export interface CollectFilesOptions {
  /** File extensions to include (e.g., ['.md', '.txt']) */
  extensions: string[];
  /** Directory names to ignore */
  ignoredDirs: string[];
  /** Maximum traversal depth */
  maxDepth: number;
}

/**
 * Recursively collect files from a directory (parallelized for performance)
 * Shared utility used by both context-loader and context-resolver
 */
export async function collectFilesFromDirectory(
  dirPath: string,
  options: CollectFilesOptions,
  currentDepth: number = 0
): Promise<string[]> {
  if (currentDepth >= options.maxDepth) return [];

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    logger.warn(
      `Could not read directory ${dirPath}: ${(error as Error).message}`
    );
    return [];
  }

  // Sort for consistent ordering
  entries.sort((a, b) => a.name.localeCompare(b.name));

  // Process entries in parallel for better performance
  const filePromises = entries.map(async (entry) => {
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (!options.ignoredDirs.includes(entry.name)) {
        return collectFilesFromDirectory(fullPath, options, currentDepth + 1);
      }
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (options.extensions.includes(ext)) {
        return [fullPath];
      }
    }
    return [];
  });

  const nestedFiles = await Promise.all(filePromises);
  return nestedFiles.flat();
}

/**
 * Result of loading context from a path (file or directory)
 */
export interface LoadContextResult {
  /** Combined content from all loaded files */
  content: string;
  /** Paths of all loaded source files */
  sources: string[];
}

/**
 * Load context from a file or directory path
 *
 * If the path is a directory, all .md and .txt files are loaded recursively
 * up to a max depth of 3 levels.
 *
 * @param contextPath - Path to context file or directory (must be absolute)
 * @returns Context content and list of source files
 * @throws ContextLoaderError if path is specified but not found, or if path is relative
 */
export async function loadContext(
  contextPath: string | null | undefined
): Promise<string> {
  const result = await loadContextWithSources(contextPath);
  return result.content;
}

/**
 * Load context from a file or directory path, returning both content and source paths
 *
 * @param contextPath - Path to context file or directory (must be absolute)
 * @returns Context content and list of source files
 * @throws ContextLoaderError if path is specified but not found, or if path is relative
 */
export async function loadContextWithSources(
  contextPath: string | null | undefined
): Promise<LoadContextResult> {
  if (!contextPath) {
    return { content: '', sources: [] };
  }

  // Enforce absolute path - caller (run.ts) is responsible for resolving relative paths
  if (!isAbsolute(contextPath)) {
    throw new ContextLoaderError(
      `Path must be absolute: ${contextPath}`,
      contextPath
    );
  }

  logger.debug(`Loading context from: ${contextPath}`);

  // Check if path exists
  let pathStat;
  try {
    pathStat = await stat(contextPath);
  } catch (error) {
    // Provide specific error for permission denied vs not found
    const errCode =
      error instanceof Error
        ? (error as Error & { code?: string }).code
        : undefined;
    const message =
      errCode === 'EACCES'
        ? `Permission denied for context path: ${contextPath}`
        : `Context path not found: ${contextPath}`;
    throw new ContextLoaderError(message, contextPath);
  }

  // Handle directory
  if (pathStat.isDirectory()) {
    return loadContextDirectory(contextPath);
  }

  // Handle file
  try {
    const content = await readFile(contextPath, 'utf-8');
    logger.debug(
      `Loaded context (${content.length} bytes) from: ${contextPath}`
    );
    return { content, sources: [contextPath] };
  } catch (error) {
    throw new ContextLoaderError(
      `Failed to read context file: ${(error as Error).message}`,
      contextPath
    );
  }
}

/**
 * Load context from a directory, recursively loading all .md and .txt files
 *
 * @param dirPath - Absolute path to directory
 * @param maxDepth - Maximum depth to traverse (default: 3)
 * @returns Combined context content and list of source files
 */
async function loadContextDirectory(
  dirPath: string,
  maxDepth: number = DEFAULT_MAX_DEPTH
): Promise<LoadContextResult> {
  // Use shared utility to collect files
  const files = await collectFilesFromDirectory(dirPath, {
    extensions: CONTEXT_FILE_EXTENSIONS,
    ignoredDirs: DEFAULT_IGNORED_DIRECTORIES,
    maxDepth,
  });

  // Load content from each file in parallel for better performance
  const fileReadPromises = files.map(async (fullPath) => {
    try {
      const content = await readFile(fullPath, 'utf-8');
      const relativePath = relative(dirPath, fullPath);
      logger.debug(`Loaded context file: ${fullPath}`);
      return {
        content: `## File: ${relativePath}\n\n${content}`,
        source: fullPath,
      };
    } catch (error) {
      logger.warn(
        `Could not read context file: ${fullPath} - ${(error as Error).message}`
      );
      return null;
    }
  });

  const results = await Promise.all(fileReadPromises);
  const contents: string[] = [];
  const sources: string[] = [];
  for (const result of results) {
    if (result) {
      contents.push(result.content);
      sources.push(result.source);
    }
  }

  const combinedContent = contents.join('\n\n---\n\n');

  logger.debug(
    `Loaded ${sources.length} context file(s) from directory: ${dirPath}`
  );

  return {
    content: combinedContent,
    sources,
  };
}

/**
 * Load context from a path, returning empty result if not found
 * (silent failure for optional context)
 *
 * @param contextPath - Path to context file or directory
 * @returns Context content and sources, or empty result
 */
async function loadContextSilentWithSources(
  contextPath: string | null | undefined
): Promise<LoadContextResult> {
  if (!contextPath) {
    return { content: '', sources: [] };
  }

  try {
    return await loadContextWithSources(contextPath);
  } catch {
    logger.debug(`Optional context not found at: ${contextPath}`);
    return { content: '', sources: [] };
  }
}

/**
 * Options for merging contexts
 */
export interface MergeContextOptions {
  /** If true, throw error when runtime context is not found */
  requireRuntimeContext?: boolean;
  /** Working directory for resolving @mentions (defaults to cwd) */
  workingDirectory?: string;
  /** If true, resolve @mentions in loaded content (default: true) */
  resolveReferences?: boolean;
  /** Shared ContextResolver instance for cache efficiency across workflow */
  contextResolver?: ContextResolver;
}

/**
 * Merge project and runtime context files with @mention resolution
 *
 * This is the unified entry point for all context loading. It:
 * 1. Loads static context from project and runtime paths
 * 2. Parses ALL loaded content for @mentions
 * 3. Resolves those @mentions to load additional files
 * 4. Returns combined context ready for agent consumption
 *
 * @param projectContextPath - Path to project context file or directory (optional)
 * @param runtimeContextPath - Path to runtime context file or directory from --context flag
 * @param options - Options for context loading and @mention resolution
 * @returns Merged context with sources and resolved references
 */
export async function mergeContexts(
  projectContextPath: string | null | undefined,
  runtimeContextPath: string | null | undefined,
  options: MergeContextOptions = {}
): Promise<MergedContext> {
  const {
    requireRuntimeContext = true,
    workingDirectory = process.cwd(),
    resolveReferences = true,
    contextResolver,
  } = options;
  const sources: string[] = [];

  // Load project context (silent failure - optional)
  const projectResult = await loadContextSilentWithSources(projectContextPath);
  const projectContext = projectResult.content;
  sources.push(...projectResult.sources);

  // Load runtime context
  let runtimeContext = '';
  if (runtimeContextPath) {
    try {
      const runtimeResult = await loadContextWithSources(runtimeContextPath);
      runtimeContext = runtimeResult.content;
      sources.push(...runtimeResult.sources);
    } catch (error) {
      // Runtime context was explicitly requested, so throw if not found
      if (requireRuntimeContext) {
        throw error;
      }
      logger.debug(
        `Optional runtime context not found at: ${runtimeContextPath}`
      );
    }
  }

  // Merge static contexts
  const parts = [projectContext, runtimeContext].filter(Boolean);
  let staticCombined: string;

  if (parts.length === 0) {
    staticCombined = '';
  } else if (parts.length === 1) {
    staticCombined = parts[0];
  } else {
    // Add separator between contexts
    staticCombined = parts.join('\n\n---\n\n# Additional Runtime Context\n\n');
  }

  // Resolve @mentions in the combined static context
  let resolvedReferences: string[] = [];
  let failedReferences: Array<{ path: string; error: string }> = [];
  let combined = staticCombined;

  if (resolveReferences && staticCombined) {
    // Use provided resolver for cache sharing, or create new one
    const resolver = contextResolver ?? new ContextResolver(workingDirectory);
    const resolveResult = await resolver.resolve(staticCombined);

    if (resolveResult.resolved.length > 0) {
      resolvedReferences = resolveResult.resolved.map((r) => r.reference.path);
      logger.info(
        `Resolved ${resolveResult.resolved.length} @mention(s) in context`
      );

      // Append resolved content to combined context
      combined =
        staticCombined +
        '\n\n---\n\n# Resolved @mentions\n\n' +
        resolveResult.context;
    }

    if (resolveResult.failed.length > 0) {
      failedReferences = resolveResult.failed.map((f) => ({
        path: f.reference.path,
        error: f.error,
      }));
      logger.warn(
        `Failed to resolve ${resolveResult.failed.length} @mention(s): ${failedReferences.map((f) => f.path).join(', ')}`
      );
    }
  }

  logger.debug(
    `Merged ${sources.length} static source(s), ${resolvedReferences.length} @mention(s) (${combined.length} bytes total)`
  );

  return {
    projectContext,
    runtimeContext,
    combined,
    sources,
    resolvedReferences,
    failedReferences,
  };
}
