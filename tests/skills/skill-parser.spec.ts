/**
 * Tests for SKILL.md parser
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';

// Mock fs module
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

// Import after mocks
import {
  parseSkillFile,
  parseFrontmatter,
} from '../../src/skills/skill-parser.js';

describe('skill-parser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('parseFrontmatter', () => {
    it('should parse valid frontmatter', () => {
      const content = `---
name: test-skill
description: A test skill for testing
---

# Test Skill

This is the content.`;

      const result = parseFrontmatter(content);

      expect(result.frontmatter.name).toBe('test-skill');
      expect(result.frontmatter.description).toBe('A test skill for testing');
      expect(result.body).toContain('# Test Skill');
    });

    it('should parse boolean frontmatter values', () => {
      const content = `---
name: restricted
disable-model-invocation: true
user-invocable: false
---

Content here`;

      const result = parseFrontmatter(content);

      expect(result.frontmatter['disable-model-invocation']).toBe(true);
      expect(result.frontmatter['user-invocable']).toBe(false);
    });

    it('should handle quoted values', () => {
      const content = `---
name: "quoted-skill"
description: 'Single quoted description'
---

Content`;

      const result = parseFrontmatter(content);

      expect(result.frontmatter.name).toBe('quoted-skill');
      expect(result.frontmatter.description).toBe('Single quoted description');
    });

    it('should return empty frontmatter for content without frontmatter', () => {
      const content = `# Just Content

No frontmatter here.`;

      const result = parseFrontmatter(content);

      expect(result.frontmatter).toEqual({});
      expect(result.body).toContain('# Just Content');
    });

    it('should handle allowed-tools field', () => {
      const content = `---
name: read-only
allowed-tools: Read, Grep, Glob
---

Content`;

      const result = parseFrontmatter(content);

      expect(result.frontmatter['allowed-tools']).toBe('Read, Grep, Glob');
    });

    it('should handle model field', () => {
      const content = `---
name: heavy
model: opus
---

Content`;

      const result = parseFrontmatter(content);

      expect(result.frontmatter.model).toBe('opus');
    });

    it('should handle Windows line endings', () => {
      const content = `---\r\nname: windows-skill\r\ndescription: Works on Windows\r\n---\r\n\r\nContent here`;

      const result = parseFrontmatter(content);

      expect(result.frontmatter.name).toBe('windows-skill');
      expect(result.frontmatter.description).toBe('Works on Windows');
    });
  });

  describe('parseSkillFile', () => {
    it('should parse a complete skill file', () => {
      const content = `---
name: example-skill
description: An example skill for demonstration
---

# Example Skill

This skill demonstrates how skills work.

## Usage

Invoke with /example-skill`;

      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const skill = parseSkillFile(
        '/path/to/SKILL.md',
        'example-skill',
        'project'
      );

      expect(skill).not.toBeNull();
      expect(skill!.id).toBe('example-skill');
      expect(skill!.name).toBe('example-skill');
      expect(skill!.description).toBe('An example skill for demonstration');
      expect(skill!.source).toBe('project');
      expect(skill!.path).toBe('/path/to/SKILL.md');
      expect(skill!.content).toContain('# Example Skill');
    });

    it('should use directory name as id', () => {
      const content = `---
name: Custom Name
---

Content`;

      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const skill = parseSkillFile(
        '/path/to/my-skill/SKILL.md',
        'my-skill',
        'global'
      );

      expect(skill!.id).toBe('my-skill');
      expect(skill!.name).toBe('Custom Name');
    });

    it('should fallback to directory name when name not in frontmatter', () => {
      const content = `---
description: A skill without a name field
---

Content`;

      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const skill = parseSkillFile('/path/to/SKILL.md', 'fallback-name', 'npm');

      expect(skill!.id).toBe('fallback-name');
      expect(skill!.name).toBe('fallback-name');
    });

    it('should extract first paragraph as description when not in frontmatter', () => {
      const content = `# My Skill

This is the first paragraph that should be used as description.

## More content

Other stuff here.`;

      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const skill = parseSkillFile('/path/to/SKILL.md', 'auto-desc', 'project');

      expect(skill!.description).toBe(
        'This is the first paragraph that should be used as description.'
      );
    });

    it('should truncate long auto-extracted descriptions', () => {
      const longParagraph = 'x'.repeat(300);
      const content = `# Skill

${longParagraph}

More content.`;

      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const skill = parseSkillFile('/path/to/SKILL.md', 'long-desc', 'project');

      expect(skill!.description.length).toBeLessThanOrEqual(200);
    });

    it('should return null on read error', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('File not found');
      });

      const skill = parseSkillFile(
        '/path/to/SKILL.md',
        'error-skill',
        'project'
      );

      expect(skill).toBeNull();
    });

    it('should preserve all frontmatter fields', () => {
      const content = `---
name: full-skill
description: Full featured skill
disable-model-invocation: true
user-invocable: false
allowed-tools: Read, Write
model: haiku
---

Content`;

      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const skill = parseSkillFile(
        '/path/to/SKILL.md',
        'full-skill',
        'project'
      );

      expect(skill!.frontmatter).toEqual({
        name: 'full-skill',
        description: 'Full featured skill',
        'disable-model-invocation': true,
        'user-invocable': false,
        'allowed-tools': 'Read, Write',
        model: 'haiku',
      });
    });
  });
});
