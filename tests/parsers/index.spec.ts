/**
 * Tests for Parser Index / Factory
 * Validates automatic parser selection via parseInput
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseInput } from '../../src/parsers/index.js';
import * as fs from 'fs';
import { execFile } from 'child_process';

// Mock dependencies
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('../../src/integrations/github-cli.js', () => ({
  GitHubCLI: {
    parseGitHubUrl: vi.fn(),
    isAvailable: vi.fn(),
    getIssue: vi.fn(),
    getPullRequest: vi.fn(),
  },
}));

vi.mock('../../src/integrations/mcp-helpers.js', () => ({
  extractUrls: vi.fn(() => []),
  formatContext: vi.fn(() => 'Formatted context'),
}));

describe('Parser Index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseInput', () => {
    it('should use GitHubParser for GitHub issue URLs', async () => {
      const { GitHubCLI } = await import('../../src/integrations/github-cli.js');

      vi.mocked(GitHubCLI.parseGitHubUrl).mockReturnValue({
        type: 'issue',
        repo: 'owner/repo',
        number: 123,
      });

      vi.mocked(GitHubCLI.isAvailable).mockResolvedValue({
        available: true,
        version: '2.0.0',
      });

      vi.mocked(GitHubCLI.getIssue).mockResolvedValue({
        number: 123,
        title: 'Test Issue',
        body: 'Issue body',
        state: 'open',
        labels: ['bug'],
        author: 'testuser',
        url: 'https://github.com/owner/repo/issues/123',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-02T00:00:00Z',
      });

      const result = await parseInput('https://github.com/owner/repo/issues/123');

      expect(result.type).toBe('github');
      expect(result.title).toBe('Test Issue');
    });

    it('should use GitHubParser for GitHub PR URLs', async () => {
      const { GitHubCLI } = await import('../../src/integrations/github-cli.js');

      vi.mocked(GitHubCLI.parseGitHubUrl).mockReturnValue({
        type: 'pr',
        repo: 'owner/repo',
        number: 456,
      });

      vi.mocked(GitHubCLI.isAvailable).mockResolvedValue({
        available: true,
        version: '2.0.0',
      });

      vi.mocked(GitHubCLI.getPullRequest).mockResolvedValue({
        number: 456,
        title: 'Test PR',
        body: 'PR body',
        state: 'open',
        labels: ['enhancement'],
        author: 'contributor',
        url: 'https://github.com/owner/repo/pull/456',
        baseBranch: 'main',
        headBranch: 'feature',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-02T00:00:00Z',
      });

      const result = await parseInput('https://github.com/owner/repo/pull/456');

      expect(result.type).toBe('github');
      expect(result.title).toBe('Test PR');
    });

    it('should use PRDParser for .md files', async () => {
      const content = `# Test PRD\n\n## Overview\nThis is a test PRD`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = await parseInput('/path/to/document.md');

      expect(result.type).toBe('prd');
      expect(result.title).toBe('Test PRD');
    });

    it('should use PromptParser for plain text as fallback', async () => {
      const result = await parseInput('Just some plain text prompt');

      expect(result.type).toBe('prompt');
      expect(result.description).toContain('Just some plain text prompt');
    });

    it('should use PromptParser for multi-line text', async () => {
      const input = `First line of prompt
Second line
Third line`;

      const result = await parseInput(input);

      expect(result.type).toBe('prompt');
      expect(result.description).toBe(input);
    });

    it('should prioritize parsers in correct order', async () => {
      // Test that GitHub URLs are parsed as GitHub, not as prompts
      const { GitHubCLI } = await import('../../src/integrations/github-cli.js');

      vi.mocked(GitHubCLI.parseGitHubUrl).mockReturnValue({
        type: 'issue',
        repo: 'owner/repo',
        number: 999,
      });

      vi.mocked(GitHubCLI.isAvailable).mockResolvedValue({
        available: true,
        version: '2.0.0',
      });

      vi.mocked(GitHubCLI.getIssue).mockResolvedValue({
        number: 999,
        title: 'Priority Test',
        body: 'Body',
        state: 'open',
        labels: [],
        author: 'user',
        url: 'https://github.com/owner/repo/issues/999',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      });

      const result = await parseInput('github.com/owner/repo/issues/999');

      expect(result.type).toBe('github');
      expect(result.type).not.toBe('prompt');
    });

    it('should handle URLs without protocol', async () => {
      const { GitHubCLI } = await import('../../src/integrations/github-cli.js');

      vi.mocked(GitHubCLI.parseGitHubUrl).mockReturnValue({
        type: 'issue',
        repo: 'owner/repo',
        number: 111,
      });

      vi.mocked(GitHubCLI.isAvailable).mockResolvedValue({
        available: true,
        version: '2.0.0',
      });

      vi.mocked(GitHubCLI.getIssue).mockResolvedValue({
        number: 111,
        title: 'No Protocol Test',
        body: 'Body',
        state: 'open',
        labels: [],
        author: 'user',
        url: 'https://github.com/owner/repo/issues/111',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      });

      const result = await parseInput('github.com/owner/repo/issues/111');

      expect(result.type).toBe('github');
    });
  });
});
