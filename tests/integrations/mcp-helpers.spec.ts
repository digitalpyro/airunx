/**
 * MCP helpers tests
 */

import { describe, it, expect } from 'vitest';
import {
  extractUrls,
  formatContext,
} from '../../src/integrations/mcp-helpers.js';

describe('MCP Helpers', () => {
  describe('extractUrls', () => {
    it('should extract and categorize URLs', () => {
      const text = `
        Check https://github.com/org/repo/issues/1
        And https://example.com
      `;

      const result = extractUrls(text);

      expect(result.github).toHaveLength(1);
      expect(result.other).toHaveLength(1);
    });
  });

  describe('formatContext', () => {
    it('should format context for agents', () => {
      const result = formatContext({
        title: 'Test Issue',
        body: 'Description here',
        labels: ['bug', 'high-priority'],
        author: 'testuser',
        url: 'https://github.com/test',
      });

      expect(result).toContain('Test Issue');
      expect(result).toContain('testuser');
      expect(result).toContain('bug, high-priority');
      expect(result).toContain('Description here');
    });
  });
});
