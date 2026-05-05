/**
 * Workspace Loader - Parse VSCode .code-workspace files
 *
 * Extracts folder definitions from VSCode workspace files for import into
 * AIRunX settings. Paths are resolved relative to the workspace file location.
 */

import { readFileSync } from 'fs';
import { dirname, basename, resolve } from 'path';
import { z } from 'zod';
import type { ProjectFolder } from './project-resolver.js';
import { parseJsonc } from './json-utils.js';

/**
 * Zod schema for VSCode workspace file structure
 */
const WorkspaceFolderSchema = z.object({
  path: z.string(),
  name: z.string().optional(),
});

const WorkspaceFileSchema = z.object({
  folders: z.array(WorkspaceFolderSchema).optional(),
});

/**
 * Parse folders from a VSCode .code-workspace file
 *
 * @param filePath - Path to the .code-workspace file
 * @returns Array of normalized project folders with resolved absolute paths
 * @throws Error if file cannot be read or parsed
 */
export function parseWorkspaceFolders(filePath: string): ProjectFolder[] {
  const content = readFileSync(filePath, 'utf-8');
  const workspace = WorkspaceFileSchema.parse(parseJsonc(content));
  const baseDir = dirname(filePath);

  return (workspace.folders || []).map((f) => ({
    name: f.name || basename(f.path),
    path: resolve(baseDir, f.path),
  }));
}
