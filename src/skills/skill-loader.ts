/**
 * Skills discovery and loading
 *
 * Loads skills from cascading directories with the following priority:
 * 1. Project: .airunx/skills/<name>/SKILL.md (highest)
 * 2. Global: ~/.airunx/skills/<name>/SKILL.md
 * 3. npm: node_modules/@skills/<pkg>/SKILL.md
 * 4. npm: node_modules/*\/skills/<name>/SKILL.md (lowest)
 */

import { existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { getProjectConfigDir, getGlobalConfigDir } from '../utils/paths.js';
import { parseSkillFile } from './skill-parser.js';
import type { Skill, SkillSource, SkillsRegistry } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('skills');
const SKILLS_SUBDIR = 'skills';

/**
 * Get the project skills directory (.airunx/skills in project root)
 */
export function getProjectSkillsDir(projectDir?: string): string {
  return join(getProjectConfigDir(projectDir), SKILLS_SUBDIR);
}

/**
 * Get the global user skills directory (~/.airunx/skills)
 */
export function getGlobalSkillsDir(): string {
  return join(getGlobalConfigDir(), SKILLS_SUBDIR);
}

/**
 * Cache for loaded skills to avoid redundant filesystem scans.
 * Keyed by resolved project directory path for per-project caching.
 */
const skillsCache = new Map<string, SkillsRegistry>();

/**
 * Load all skills from the cascading directory hierarchy
 *
 * Skills are loaded in reverse priority order so higher-priority
 * sources overwrite lower-priority ones with the same id.
 *
 * @param projectDir - Optional project directory (defaults to cwd)
 * @returns Registry of loaded skills
 */
export function loadSkills(projectDir?: string): SkillsRegistry {
  const effectiveDir = resolve(projectDir || process.cwd());

  const cached = skillsCache.get(effectiveDir);
  if (cached) {
    logger.debug(`Using cached skills registry for ${effectiveDir}`);
    return cached;
  }

  const skills = new Map<string, Skill>();

  // Load in reverse priority order (npm → global → project)
  // Later loads overwrite earlier ones

  // 1. npm-installed skills (lowest priority)
  loadNpmSkills(skills, effectiveDir);

  // 2. Global user skills
  loadSkillsFromDir(skills, getGlobalSkillsDir(), 'global');

  // 3. Project skills (highest priority)
  loadSkillsFromDir(skills, getProjectSkillsDir(effectiveDir), 'project');

  logger.debug(`Loaded ${skills.size} skills for ${effectiveDir}`);

  const registry = createRegistry(skills);
  skillsCache.set(effectiveDir, registry);
  return registry;
}

/**
 * Clear the skills cache (useful for testing or when skills change)
 */
export function clearSkillsCache(): void {
  skillsCache.clear();
  logger.debug('Skills cache cleared');
}

/**
 * Load skills from a directory containing skill subdirectories
 */
function loadSkillsFromDir(
  skills: Map<string, Skill>,
  dir: string,
  source: SkillSource
): void {
  if (!existsSync(dir)) {
    logger.debug(`Skills directory does not exist: ${dir}`);
    return;
  }

  try {
    // Sort entries alphabetically for deterministic loading order
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillPath = join(dir, entry.name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;

      const skill = parseSkillFile(skillPath, entry.name, source);
      if (skill) {
        logger.debug(`Loaded skill '${skill.id}' from ${source}: ${skillPath}`);
        skills.set(skill.id, skill);
      }
    }
  } catch (error) {
    logger.warn(`Failed to read skills directory ${dir}:`, error);
  }
}

/**
 * Load skills from npm packages
 *
 * Checks two locations:
 * 1. node_modules/@skills/<pkg>/SKILL.md - scoped skill packages
 * 2. node_modules/<pkg>/skills/<name>/SKILL.md - packages with skills subdirectory
 */
function loadNpmSkills(skills: Map<string, Skill>, projectDir: string): void {
  const nodeModules = join(projectDir, 'node_modules');
  if (!existsSync(nodeModules)) {
    return;
  }

  // Check @skills namespace (skills packages have SKILL.md at root)
  const skillsNamespace = join(nodeModules, '@skills');
  loadSkillsFromDir(skills, skillsNamespace, 'npm');

  // Helper to check if a package has a skills/ directory and load it
  const loadSkillsFromPackage = (packagePath: string): void => {
    const pkgSkillsDir = join(packagePath, 'skills');
    if (existsSync(pkgSkillsDir)) {
      loadSkillsFromDir(skills, pkgSkillsDir, 'npm');
    }
  };

  // Check all packages for skills/ subdirectory (including scoped packages)
  // Sort entries alphabetically for deterministic loading order
  try {
    const entries = readdirSync(nodeModules, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name)
    );

    for (const entry of entries) {
      // Skip hidden dirs and @skills (already processed above)
      if (
        !entry.isDirectory() ||
        entry.name.startsWith('.') ||
        entry.name === '@skills'
      ) {
        continue;
      }

      if (entry.name.startsWith('@')) {
        // For scoped packages, check each package within the scope
        const scopeDir = join(nodeModules, entry.name);
        try {
          const scopedEntries = readdirSync(scopeDir, {
            withFileTypes: true,
          }).sort((a, b) => a.name.localeCompare(b.name));

          for (const scopedEntry of scopedEntries) {
            if (!scopedEntry.isDirectory()) continue;
            loadSkillsFromPackage(join(scopeDir, scopedEntry.name));
          }
        } catch (error) {
          logger.warn(
            `Failed to scan scoped packages in ${entry.name}:`,
            error
          );
        }
      } else {
        loadSkillsFromPackage(join(nodeModules, entry.name));
      }
    }
  } catch (error) {
    logger.warn('Failed to scan node_modules for skills:', error);
  }
}

/**
 * Create a SkillsRegistry from a skills map
 *
 * Pre-computes arrays for O(1) getAll and getBySource lookups.
 */
function createRegistry(skills: Map<string, Skill>): SkillsRegistry {
  const allSkills: Skill[] = [];
  const bySource: Record<SkillSource, Skill[]> = {
    project: [],
    global: [],
    npm: [],
  };

  for (const skill of skills.values()) {
    allSkills.push(skill);
    bySource[skill.source].push(skill);
  }

  return {
    get: (id: string) => skills.get(id),
    getAll: () => [...allSkills],
    getBySource: (source: SkillSource) => [...bySource[source]],
    entries: () => skills.entries(),
    keys: () => skills.keys(),
    values: () => skills.values(),
    get size(): number {
      return allSkills.length;
    },
  };
}
