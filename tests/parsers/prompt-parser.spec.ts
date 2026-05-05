/**
 * Tests for Prompt Parser
 * Validates parsing of direct text prompts
 */

import { describe, it, expect } from 'vitest';
import { PromptParser } from '../../src/parsers/prompt-parser.js';

describe('Prompt Parser', () => {
  const parser = new PromptParser();

  describe('canParse', () => {
    it('should accept any input', () => {
      expect(parser.canParse('simple prompt')).toBe(true);
      expect(parser.canParse('')).toBe(true);
      expect(parser.canParse('multi\nline\nprompt')).toBe(true);
    });
  });

  describe('parse', () => {
    it('should parse simple single-line prompt', async () => {
      const input = 'Fix the authentication bug';
      const result = await parser.parse(input);

      expect(result.type).toBe('prompt');
      expect(result.title).toBe('Fix the authentication bug');
      expect(result.description).toBe(input);
      expect(result.context?.lines).toBe(1);
      expect(result.context?.length).toBe(input.length);
      expect(result.metadata?.source).toBe('prompt');
    });

    it('should parse multi-line prompt with first line as title', async () => {
      const input = 'Add user registration\nImplement email verification\nAdd password reset';
      const result = await parser.parse(input);

      expect(result.type).toBe('prompt');
      expect(result.title).toBe('Add user registration');
      expect(result.description).toBe(input);
      expect(result.context?.lines).toBe(3);
      expect(result.context?.length).toBe(input.length);
    });

    it('should truncate long first lines in title', async () => {
      const longLine = 'This is a very long prompt that exceeds the maximum title length and should be truncated to ensure the title is not too long for display purposes and remains readable';
      const input = `${longLine}\nSecond line`;

      const result = await parser.parse(input);

      expect(result.title).toHaveLength(103); // 100 chars + '...'
      expect(result.title.endsWith('...')).toBe(true);
      expect(result.title).not.toBe(longLine);
    });

    it('should use default title for empty input', async () => {
      const result = await parser.parse('');

      expect(result.type).toBe('prompt');
      expect(result.title).toBe('Custom Prompt');
      expect(result.description).toBe('');
    });

    it('should handle input with only whitespace', async () => {
      const input = '   \n   \n   ';
      const result = await parser.parse(input);

      expect(result.type).toBe('prompt');
      expect(result.title).toBe('Custom Prompt'); // Empty after trim
      expect(result.context?.lines).toBe(3);
    });

    it('should include metadata with input length', async () => {
      const input = 'Test prompt';
      const result = await parser.parse(input);

      expect(result.metadata?.inputLength).toBe(input.length);
      expect(result.metadata?.source).toBe('prompt');
    });
  });
});
