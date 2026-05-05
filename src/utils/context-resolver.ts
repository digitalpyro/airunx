/**
 * Dynamic Context Resolver
 *
 * Parses prompts and agent outputs for @file and @folder references,
 * dynamically loading referenced content. Similar to Cursor's @ mention system.
 *
 * Supported patterns:
 * - @file:path/to/file.ts - Load specific file
 * - @folder:path/to/dir - Load all .md/.txt files in directory
 * - @src/utils/config.ts - Shorthand for @file:
 *
 * Caches loaded content to avoid redundant file reads.
 */

import { readFile, stat } from 'fs/promises';
import { join, isAbsolute, relative, extname } from 'path';
import { createLogger } from './logger.js';
import {
  DEFAULT_MAX_DEPTH,
  collectFilesFromDirectory,
} from './context-loader.js';

const logger = createLogger('context-resolver');

/**
 * Reference types that can be parsed from prompts
 */
export type ReferenceType = 'file' | 'folder';

/**
 * A parsed reference from a prompt
 */
export interface ParsedReference {
  /** The raw match string (e.g., "@src/utils/config.ts") */
  raw: string;
  /** Reference type */
  type: ReferenceType;
  /** Path to the file or folder */
  path: string;
  /** Absolute path resolved from working directory */
  absolutePath: string;
}

/**
 * Result of resolving a reference
 */
export interface ResolvedContent {
  /** The parsed reference */
  reference: ParsedReference;
  /** Loaded content */
  content: string;
  /** Whether the content was loaded from cache */
  fromCache: boolean;
}

/**
 * Result of resolving all references in a prompt
 */
export interface ResolveResult {
  /** Original prompt/text */
  original: string;
  /** All parsed references */
  references: ParsedReference[];
  /** Successfully resolved content */
  resolved: ResolvedContent[];
  /** References that failed to resolve */
  failed: Array<{ reference: ParsedReference; error: string }>;
  /** Combined context from all resolved files */
  context: string;
}

/**
 * File extensions to include when loading folders
 */
const CONTEXT_EXTENSIONS = [
  '.md',
  '.txt',
  '.ts',
  '.js',
  '.tsx',
  '.jsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
];

/**
 * Directories to skip when loading folders
 */
const IGNORED_DIRS = [
  'node_modules',
  '.git',
  '.worktrees',
  'dist',
  'build',
  '__pycache__',
];

/**
 * Max file size to load (1MB)
 */
const MAX_FILE_SIZE = 1024 * 1024;

/**
 * Dynamic Context Resolver
 *
 * Parses prompts for @mentions and dynamically loads referenced files.
 */
export class ContextResolver {
  private workingDirectory: string;
  private cache: Map<string, { content: string; timestamp: number }>;
  private cacheTTLMs: number;

  constructor(
    workingDirectory: string = process.cwd(),
    options: { cacheTTLMs?: number } = {}
  ) {
    this.workingDirectory = workingDirectory;
    this.cache = new Map();
    this.cacheTTLMs = options.cacheTTLMs ?? 60000; // 1 minute default
  }

  /**
   * Parse a prompt/text for @references
   *
   * Supported formats:
   * - @file:path/to/file.ts
   * - @folder:path/to/dir
   * - @path/to/file.ts (shorthand, infers type from path)
   */
  parseReferences(text: string): ParsedReference[] {
    const references: ParsedReference[] = [];
    const seen = new Set<string>();

    // Pattern: @file:path or @folder:path or @path (shorthand)
    // Matches: @file:src/utils.ts, @folder:src/utils, @src/utils/config.ts
    const pattern = /@(?:(file|folder):)?([^\s,;:'"()[\]{}]+)/g;

    let match;
    while ((match = pattern.exec(text)) !== null) {
      let [raw, explicitType, path] = match;

      // Trim trailing punctuation that's likely not part of the path
      // e.g., "(@file.ts)" -> "file.ts", "@file.ts, it's important" -> "file.ts"
      path = path.replace(/[.,!?)\]}]+$/, '');

      // Skip if already seen (avoid duplicates)
      if (seen.has(path)) continue;
      seen.add(path);

      // Skip common false positives (URLs, usernames, short paths, etc.)
      if (this.isLikelyFalsePositive(path)) continue;

      // Determine type: explicit > inferred from extension
      let type: ReferenceType;
      if (explicitType) {
        type = explicitType as ReferenceType;
      } else {
        // Infer from path - if has extension, it's a file
        type = extname(path) ? 'file' : 'folder';
      }

      // Resolve absolute path
      const absolutePath = isAbsolute(path)
        ? path
        : join(this.workingDirectory, path);

      references.push({
        raw,
        type,
        path,
        absolutePath,
      });
    }

    return references;
  }

  /**
   * Known extensionless files that should NOT be filtered as usernames
   */
  private static readonly KNOWN_EXTENSIONLESS_FILES = new Set([
    'Makefile',
    'Dockerfile',
    'Vagrantfile',
    'Gemfile',
    'Brewfile',
    'Procfile',
    'Rakefile',
    'README',
    'LICENSE',
    'CHANGELOG',
    'CONTRIBUTING',
    'AUTHORS',
    'CODEOWNERS',
  ]);

  /**
   * Check if a path is likely a false positive
   */
  private isLikelyFalsePositive(path: string): boolean {
    // Skip very short paths (likely mentions like @user)
    if (path.length < 3) return true;

    // Skip paths that look like usernames/handles, but allow known extensionless files
    // Usernames are typically: short, no slashes, alphanumeric with underscores/hyphens
    const looksLikeUsername =
      /^[a-z][a-z0-9_-]*$/i.test(path) && // case-insensitive username pattern
      path.length < 15 && // short
      !path.includes('/'); // no path separators

    if (
      looksLikeUsername &&
      !ContextResolver.KNOWN_EXTENSIONLESS_FILES.has(path)
    ) {
      return true;
    }

    // Skip paths that start with common non-file prefixes
    const falsePositivePrefixes = ['http', 'mailto', 'tel', 'data:'];
    if (falsePositivePrefixes.some((p) => path.startsWith(p))) return true;

    return false;
  }

  /**
   * Resolve all @references in a prompt and load their content
   */
  async resolve(text: string): Promise<ResolveResult> {
    const references = this.parseReferences(text);
    const resolved: ResolvedContent[] = [];
    const failed: Array<{ reference: ParsedReference; error: string }> = [];

    for (const ref of references) {
      try {
        const result = await this.loadReference(ref);
        resolved.push(result);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        failed.push({ reference: ref, error: errorMessage });
        logger.debug(`Failed to resolve ${ref.raw}: ${errorMessage}`);
      }
    }

    // Build combined context
    const contextParts: string[] = [];
    for (const item of resolved) {
      const header = `# @${item.reference.path}`;
      contextParts.push(`${header}\n\n${item.content}`);
    }

    return {
      original: text,
      references,
      resolved,
      failed,
      context: contextParts.join('\n\n---\n\n'),
    };
  }

  /**
   * Load content for a single reference
   */
  private async loadReference(ref: ParsedReference): Promise<ResolvedContent> {
    // Check cache first
    const cached = this.getFromCache(ref.absolutePath);
    if (cached) {
      return {
        reference: ref,
        content: cached,
        fromCache: true,
      };
    }

    // Load based on type
    let content: string;
    if (ref.type === 'folder') {
      content = await this.loadFolder(ref.absolutePath);
    } else {
      content = await this.loadFile(ref.absolutePath);
    }

    // Cache the result
    this.setCache(ref.absolutePath, content);

    return {
      reference: ref,
      content,
      fromCache: false,
    };
  }

  /**
   * Load a single file
   */
  private async loadFile(absolutePath: string): Promise<string> {
    const fileStat = await stat(absolutePath);

    if (!fileStat.isFile()) {
      throw new Error(`Not a file: ${absolutePath}`);
    }

    if (fileStat.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large (${fileStat.size} bytes, max ${MAX_FILE_SIZE})`
      );
    }

    const content = await readFile(absolutePath, 'utf-8');
    logger.debug(`Loaded file: ${absolutePath} (${content.length} bytes)`);
    return content;
  }

  /**
   * Load all relevant files from a folder
   */
  private async loadFolder(absolutePath: string): Promise<string> {
    const fileStat = await stat(absolutePath);

    if (!fileStat.isDirectory()) {
      throw new Error(`Not a directory: ${absolutePath}`);
    }

    const files = await collectFilesFromDirectory(absolutePath, {
      extensions: CONTEXT_EXTENSIONS,
      ignoredDirs: IGNORED_DIRS,
      maxDepth: DEFAULT_MAX_DEPTH,
    });

    // Load content from each file in parallel for better performance
    const fileReadPromises = files.map(async (file) => {
      try {
        const content = await readFile(file, 'utf-8');
        const relativePath = relative(absolutePath, file);
        const lang = extname(file).substring(1); // e.g., '.ts' -> 'ts'
        // Don't wrap markdown files in code fences - they should render as markdown
        if (lang === 'md') {
          return `## File: ${relativePath}\n\n${content}`;
        }
        return `## File: ${relativePath}\n\n\`\`\`${lang}\n${content}\n\`\`\``;
      } catch (error) {
        logger.warn(
          `Skipped unreadable file: ${file} - ${(error as Error).message}`
        );
        return null;
      }
    });

    const resolvedContents = await Promise.all(fileReadPromises);
    const contents = resolvedContents.filter((c): c is string => c !== null);

    logger.debug(`Loaded folder: ${absolutePath} (${files.length} files)`);
    return contents.join('\n\n');
  }

  /**
   * Get content from cache if not expired
   */
  private getFromCache(key: string): string | null {
    const cached = this.cache.get(key);
    if (!cached) return null;

    const age = Date.now() - cached.timestamp;
    if (age > this.cacheTTLMs) {
      this.cache.delete(key);
      return null;
    }

    return cached.content;
  }

  /**
   * Set content in cache
   */
  private setCache(key: string, content: string): void {
    this.cache.set(key, {
      content,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

/**
 * Create a context resolver with default settings
 */
export function createContextResolver(
  workingDirectory?: string
): ContextResolver {
  return new ContextResolver(workingDirectory);
}

/**
 * Convenience function to resolve references in a prompt
 */
export async function resolveContextReferences(
  text: string,
  workingDirectory?: string
): Promise<ResolveResult> {
  const resolver = new ContextResolver(workingDirectory);
  return resolver.resolve(text);
}
