/**
 * Input parser tests
 */

import { describe, it, expect } from 'vitest';
import { detectInputType } from '../../src/parsers/input-parser.js';
import { PromptParser } from '../../src/parsers/prompt-parser.js';

describe('Input Parser', () => {
  describe('detectInputType', () => {
    it('should detect GitHub issue URLs', () => {
      const result = detectInputType(
        'https://github.com/owner/repo/issues/123'
      );
      expect(result).toBe('github');
    });

    it('should detect GitHub PR URLs', () => {
      const result = detectInputType('https://github.com/owner/repo/pull/456');
      expect(result).toBe('github');
    });

    it('should treat Slack URLs as prompt input', () => {
      const result = detectInputType(
        'https://workspace.slack.com/archives/C123/p456'
      );
      expect(result).toBe('prompt');
    });

    it('should detect PRD file paths', () => {
      expect(detectInputType('./prd.md')).toBe('prd');
      expect(detectInputType('docs/feature.md')).toBe('prd');
    });

    it('should default to prompt for plain text', () => {
      const result = detectInputType('Add a new feature');
      expect(result).toBe('prompt');
    });
  });

  describe('PromptParser', () => {
    it('should parse simple prompts', async () => {
      const parser = new PromptParser();
      const result = await parser.parse('Add authentication');

      expect(result.type).toBe('prompt');
      expect(result.title).toBe('Add authentication');
      expect(result.description).toBe('Add authentication');
    });

    it('should truncate long titles', async () => {
      const parser = new PromptParser();
      const longPrompt = 'A'.repeat(150);
      const result = await parser.parse(longPrompt);

      expect(result.title.length).toBeLessThanOrEqual(103); // 100 + '...'
    });

    it('should extract first line as title', async () => {
      const parser = new PromptParser();
      const result = await parser.parse('Title here\nBody content\nMore content');

      expect(result.title).toBe('Title here');
      expect(result.description).toContain('Body content');
    });
  });
});
