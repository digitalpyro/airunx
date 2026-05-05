/**
 * PRD (Product Requirements Document) resolver
 *
 * Resolves PRD sources from various locations:
 * - Local file paths (absolute or relative)
 * - HTTP/HTTPS URLs
 * - GitHub blob URLs (converted to raw URLs)
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { isAbsolute } from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('prd-resolver');

export type PRDSourceType = 'local' | 'url' | 'github';

export interface PRDSource {
  type: PRDSourceType;
  path: string;
  content: string;
}

export class PRDResolverError extends Error {
  constructor(
    message: string,
    public readonly source: string
  ) {
    super(message);
    this.name = 'PRDResolverError';
  }
}

/**
 * Default timeout for remote PRD fetching (30 seconds)
 */
const DEFAULT_FETCH_TIMEOUT_MS = 30000;

/**
 * Resolve a PRD from a path or URL
 *
 * @param prdPath - Local file path or HTTP URL to the PRD
 * @param timeoutMs - Timeout for remote fetches (default: 30s)
 * @returns Resolved PRD source with content
 * @throws PRDResolverError if the PRD cannot be resolved
 */
export async function resolvePRD(
  prdPath: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<PRDSource> {
  logger.debug(`Resolving PRD from: ${prdPath}`);

  // HTTP/HTTPS URL
  if (prdPath.startsWith('http://') || prdPath.startsWith('https://')) {
    // Check if it's a GitHub blob URL
    if (prdPath.includes('github.com') && prdPath.includes('/blob/')) {
      return resolveGitHubPRD(prdPath, timeoutMs);
    }
    return resolveRemotePRD(prdPath, timeoutMs);
  }

  // Local file
  return resolveLocalPRD(prdPath);
}

/**
 * Resolve a local PRD file
 * @param prdPath - Must be an absolute path (caller is responsible for resolution)
 */
async function resolveLocalPRD(prdPath: string): Promise<PRDSource> {
  // Enforce absolute path - caller (run.ts) is responsible for resolving relative paths
  if (!isAbsolute(prdPath)) {
    throw new PRDResolverError(`Path must be absolute: ${prdPath}`, prdPath);
  }

  const absolutePath = prdPath;

  logger.debug(`Resolving local PRD: ${absolutePath}`);

  if (!existsSync(absolutePath)) {
    throw new PRDResolverError(`PRD file not found: ${absolutePath}`, prdPath);
  }

  try {
    const content = await readFile(absolutePath, 'utf-8');
    logger.debug(`Successfully loaded local PRD (${content.length} bytes)`);

    return {
      type: 'local',
      path: absolutePath,
      content,
    };
  } catch (error) {
    throw new PRDResolverError(
      `Failed to read PRD file: ${(error as Error).message}`,
      prdPath
    );
  }
}

/**
 * Resolve a remote PRD from an HTTP URL
 */
async function resolveRemotePRD(
  url: string,
  timeoutMs: number
): Promise<PRDSource> {
  logger.debug(`Fetching remote PRD: ${url}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new PRDResolverError(
        `Failed to fetch PRD: HTTP ${response.status} ${response.statusText}`,
        url
      );
    }

    const content = await response.text();
    logger.debug(`Successfully fetched remote PRD (${content.length} bytes)`);

    return {
      type: 'url',
      path: url,
      content,
    };
  } catch (error) {
    if (error instanceof PRDResolverError) throw error;

    if ((error as Error).name === 'AbortError') {
      throw new PRDResolverError(
        `PRD fetch timed out after ${timeoutMs}ms`,
        url
      );
    }

    throw new PRDResolverError(
      `Network error fetching PRD: ${(error as Error).message}`,
      url
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve a GitHub blob URL by converting to raw URL
 *
 * GitHub blob URLs like:
 *   https://github.com/user/repo/blob/main/docs/prd.md
 *
 * Are converted to raw URLs like:
 *   https://raw.githubusercontent.com/user/repo/main/docs/prd.md
 */
async function resolveGitHubPRD(
  url: string,
  timeoutMs: number
): Promise<PRDSource> {
  logger.debug(`Converting GitHub blob URL to raw URL: ${url}`);

  // Convert blob URL to raw URL
  const rawUrl = url
    .replace('github.com', 'raw.githubusercontent.com')
    .replace('/blob/', '/');

  logger.debug(`Raw URL: ${rawUrl}`);

  try {
    const result = await resolveRemotePRD(rawUrl, timeoutMs);
    // Override the type to indicate it came from GitHub
    return {
      ...result,
      type: 'github',
      path: url, // Keep original URL for reference
    };
  } catch (error) {
    // Re-throw with original URL for clarity
    if (error instanceof PRDResolverError) {
      // Strip redundant prefix to avoid "Failed to fetch GitHub PRD: Failed to fetch PRD: ..."
      const reason = error.message.replace(/^Failed to fetch PRD: /, '');
      throw new PRDResolverError(`Failed to fetch GitHub PRD: ${reason}`, url);
    }
    throw error;
  }
}

/**
 * Check if a string looks like a PRD path or URL
 *
 * @param input - Input string to check
 * @returns true if the input looks like a PRD path/URL
 */
export function isPRDPath(input: string): boolean {
  // HTTP URLs
  if (input.startsWith('http://') || input.startsWith('https://')) {
    return true;
  }

  // File paths ending in common PRD extensions
  const prdExtensions = ['.md', '.markdown', '.txt', '.prd'];
  const lowerInput = input.toLowerCase();
  return prdExtensions.some((ext) => lowerInput.endsWith(ext));
}
