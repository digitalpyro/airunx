/**
 * SKILL.md file parser
 *
 * Parses skill files with YAML frontmatter and markdown content.
 * Uses the yaml package for robust frontmatter parsing.
 */

import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import type { Skill, SkillFrontmatter, SkillSource } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('skill-parser');

/** Regex to match YAML frontmatter between --- markers */
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse a SKILL.md file into a Skill object
 *
 * @param path - Absolute path to the SKILL.md file
 * @param dirName - Directory name (used as skill id)
 * @param source - Where the skill was loaded from
 * @returns Parsed skill or null if parsing fails
 */
export function parseSkillFile(
  path: string,
  dirName: string,
  source: SkillSource
): Skill | null {
  try {
    const content = readFileSync(path, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);

    return {
      id: dirName,
      name: frontmatter.name || dirName,
      description: frontmatter.description || extractFirstParagraph(body),
      content: body,
      frontmatter,
      source,
      path,
    };
  } catch (error) {
    logger.warn(
      `Failed to parse skill file at ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Parse frontmatter and body from skill content
 */
export function parseFrontmatter(content: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  const match = content.match(FRONTMATTER_REGEX);

  if (!match) {
    return { frontmatter: {}, body: content.trim() };
  }

  const [, yamlStr, body] = match;
  const frontmatter = parseYamlFrontmatter(yamlStr);

  return { frontmatter, body: body.trim() };
}

/**
 * Parse YAML frontmatter using the yaml package
 *
 * Uses the standard yaml parser for robust handling of multi-line strings,
 * special characters, and other YAML features.
 */
function parseYamlFrontmatter(yamlStr: string): SkillFrontmatter {
  try {
    const data = parseYaml(yamlStr);

    if (typeof data !== 'object' || data === null) {
      return {};
    }

    return {
      name: typeof data.name === 'string' ? data.name : undefined,
      description:
        typeof data.description === 'string' ? data.description : undefined,
      'disable-model-invocation': data['disable-model-invocation'] === true,
      'user-invocable': data['user-invocable'] !== false,
      'allowed-tools':
        typeof data['allowed-tools'] === 'string'
          ? data['allowed-tools']
          : undefined,
      model: typeof data.model === 'string' ? data.model : undefined,
    };
  } catch (error) {
    logger.warn(
      `Failed to parse skill frontmatter: ${error instanceof Error ? error.message : String(error)}`
    );
    return {};
  }
}

/**
 * Extract the first paragraph of content as a fallback description
 *
 * Skips headings, blockquotes, and list items. Returns the first block of
 * regular text, truncated to 200 chars.
 */
function extractFirstParagraph(content: string): string {
  const lines = content.split('\n');
  const paragraph: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // If we encounter a structural element or an empty line...
    if (!trimmed || /^(#|>|- |\* |\+ |\d+\. )/.test(trimmed)) {
      // ...and we've already started a paragraph, then we're done.
      if (paragraph.length > 0) {
        break;
      }
      // Otherwise, skip this line and continue searching for the first paragraph.
      continue;
    }

    // This is a line of paragraph text.
    paragraph.push(trimmed);
  }

  return paragraph.join(' ').slice(0, 200);
}
