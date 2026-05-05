/**
 * Path resolution utilities
 *
 * Centralized utilities for resolving paths relative to project directories.
 * Handles various path types: absolute paths, relative paths, and URLs.
 */

import { resolve, isAbsolute } from 'path';

/**
 * Resolve a path relative to a base directory
 *
 * Handles three cases:
 * - Absolute paths: returned as-is
 * - URLs (http/https): returned as-is
 * - Relative paths: resolved relative to baseDir
 *
 * @param path - Path to resolve (can be undefined/null)
 * @param baseDir - Base directory for relative path resolution
 * @returns Resolved path or undefined if input is falsy
 */
export function resolvePathRelativeToDir(
  path: string | undefined | null,
  baseDir: string
): string | undefined {
  if (!path) {
    return undefined;
  }

  // Absolute paths and URLs are returned as-is
  if (
    isAbsolute(path) ||
    path.startsWith('http://') ||
    path.startsWith('https://')
  ) {
    return path;
  }

  // Relative paths are resolved against baseDir
  return resolve(baseDir, path);
}
