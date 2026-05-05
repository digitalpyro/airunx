/**
 * Skill types following the Agent Skills open standard
 * @see https://skills.sh/
 */

/**
 * YAML frontmatter fields for SKILL.md files
 */
export interface SkillFrontmatter {
  /** Display name for the skill (defaults to directory name) */
  readonly name?: string;
  /** Description of when to use this skill */
  readonly description?: string;
  /** Prevent Claude from automatically loading this skill */
  readonly 'disable-model-invocation'?: boolean;
  /** Whether the skill appears in the command menu (default: true) */
  readonly 'user-invocable'?: boolean;
  /** Comma-separated list of allowed tools */
  readonly 'allowed-tools'?: string;
  /** Model override for this skill */
  readonly model?: string;
}

/**
 * Source location for a loaded skill
 */
export type SkillSource = 'project' | 'global' | 'npm';

/**
 * A parsed skill from a SKILL.md file
 */
export interface Skill {
  /** Unique identifier (directory name) */
  readonly id: string;
  /** Display name */
  readonly name: string;
  /** Usage description */
  readonly description: string;
  /** Markdown instructions (body after frontmatter) */
  readonly content: string;
  /** Parsed YAML frontmatter */
  readonly frontmatter: SkillFrontmatter;
  /** Where the skill was loaded from */
  readonly source: SkillSource;
  /** Absolute path to SKILL.md */
  readonly path: string;
}

/**
 * Registry of loaded skills with lookup methods
 *
 * Provides a map-like interface for accessing skills while
 * encapsulating the internal storage.
 */
export interface SkillsRegistry {
  /** Get a skill by id (Map-compatible) */
  get(id: string): Skill | undefined;
  /** Get all loaded skills as an array */
  getAll(): readonly Skill[];
  /** Get skills filtered by source */
  getBySource(source: SkillSource): readonly Skill[];
  /** Returns an iterable of [id, skill] pairs */
  entries(): IterableIterator<[string, Skill]>;
  /** Returns an iterable of skill IDs */
  keys(): IterableIterator<string>;
  /** Returns an iterable of skills */
  values(): IterableIterator<Skill>;
  /** The number of skills in the registry */
  readonly size: number;
}
