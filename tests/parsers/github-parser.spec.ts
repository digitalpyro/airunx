/**
 * Tests for GitHub Parser
 * Validates parsing of GitHub issues and pull requests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GitHubParser } from '../../src/parsers/github-parser.js';
import { GitHubCLI } from '../../src/integrations/github-cli.js';
import * as mcpHelpers from '../../src/integrations/mcp-helpers.js';

// Mock dependencies
vi.mock('../../src/integrations/github-cli.js');
vi.mock('../../src/integrations/mcp-helpers.js');

describe('GitHub Parser', () => {
  let parser: GitHubParser;

  beforeEach(() => {
    parser = new GitHubParser();
    vi.clearAllMocks();
  });

  describe('canParse', () => {
    it('should recognize GitHub issue URLs', () => {
      expect(parser.canParse('https://github.com/owner/repo/issues/123')).toBe(true);
      expect(parser.canParse('http://github.com/owner/repo/issues/456')).toBe(true);
      expect(parser.canParse('github.com/owner/repo/issues/789')).toBe(true);
    });

    it('should recognize GitHub PR URLs', () => {
      expect(parser.canParse('https://github.com/owner/repo/pull/123')).toBe(true);
      expect(parser.canParse('http://github.com/owner/repo/pull/456')).toBe(true);
      expect(parser.canParse('github.com/owner/repo/pull/789')).toBe(true);
    });

    it('should reject non-GitHub URLs', () => {
      expect(parser.canParse('https://gitlab.com/owner/repo/issues/123')).toBe(false);
      expect(parser.canParse('https://example.com')).toBe(false);
      expect(parser.canParse('just some text')).toBe(false);
    });

    it('should reject GitHub URLs without issues or pull', () => {
      expect(parser.canParse('https://github.com/owner/repo')).toBe(false);
      expect(parser.canParse('https://github.com/owner/repo/commits')).toBe(false);
    });
  });

  describe('parse - Issues', () => {
    beforeEach(() => {
      // Mock GitHubCLI methods
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
        body: 'Issue description with https://example.com link',
        state: 'open',
        labels: ['bug', 'high-priority'],
        author: 'testuser',
        url: 'https://github.com/owner/repo/issues/123',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-02T00:00:00Z',
      });

      vi.mocked(mcpHelpers.extractUrls).mockReturnValue(['https://example.com']);
      vi.mocked(mcpHelpers.formatContext).mockReturnValue('Formatted context');
    });

    it('should parse GitHub issue successfully', async () => {
      const result = await parser.parse('https://github.com/owner/repo/issues/123');

      expect(result.type).toBe('github');
      expect(result.title).toBe('Test Issue');
      expect(result.description).toBe('Formatted context');
      expect(result.context).toMatchObject({
        repo: 'owner/repo',
        number: 123,
        state: 'open',
        embeddedUrls: ['https://example.com'],
      });
      expect(result.metadata).toMatchObject({
        source: 'github',
        author: 'testuser',
        labels: ['bug', 'high-priority'],
        type: 'issue',
      });
    });

    it('should call GitHubCLI.getIssue for issue URLs', async () => {
      await parser.parse('https://github.com/owner/repo/issues/123');

      expect(GitHubCLI.getIssue).toHaveBeenCalledWith('owner/repo', 123);
      expect(GitHubCLI.getPullRequest).not.toHaveBeenCalled();
    });

    it('should extract embedded URLs from issue body', async () => {
      await parser.parse('https://github.com/owner/repo/issues/123');

      expect(mcpHelpers.extractUrls).toHaveBeenCalledWith('Issue description with https://example.com link');
    });

    it('should format context with issue data', async () => {
      await parser.parse('https://github.com/owner/repo/issues/123');

      expect(mcpHelpers.formatContext).toHaveBeenCalledWith({
        title: 'Test Issue',
        body: 'Issue description with https://example.com link',
        labels: ['bug', 'high-priority'],
        author: 'testuser',
        url: 'https://github.com/owner/repo/issues/123',
      });
    });
  });

  describe('parse - Pull Requests', () => {
    beforeEach(() => {
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
        body: 'PR description',
        state: 'open',
        labels: ['enhancement'],
        author: 'contributor',
        url: 'https://github.com/owner/repo/pull/456',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-02T00:00:00Z',
        baseBranch: 'main',
        headBranch: 'feature-branch',
      });

      vi.mocked(mcpHelpers.extractUrls).mockReturnValue([]);
      vi.mocked(mcpHelpers.formatContext).mockReturnValue('Formatted PR context');
    });

    it('should parse GitHub PR successfully', async () => {
      const result = await parser.parse('https://github.com/owner/repo/pull/456');

      expect(result.type).toBe('github');
      expect(result.title).toBe('Test PR');
      expect(result.context).toMatchObject({
        repo: 'owner/repo',
        number: 456,
        state: 'open',
        baseBranch: 'main',
        headBranch: 'feature-branch',
      });
      expect(result.metadata?.type).toBe('pr');
    });

    it('should call GitHubCLI.getPullRequest for PR URLs', async () => {
      await parser.parse('https://github.com/owner/repo/pull/456');

      expect(GitHubCLI.getPullRequest).toHaveBeenCalledWith('owner/repo', 456);
      expect(GitHubCLI.getIssue).not.toHaveBeenCalled();
    });

    it('should include branch information for PRs', async () => {
      const result = await parser.parse('https://github.com/owner/repo/pull/456');

      expect(result.context).toHaveProperty('baseBranch', 'main');
      expect(result.context).toHaveProperty('headBranch', 'feature-branch');
    });
  });

  describe('Error Handling', () => {
    it('should throw error for invalid GitHub URL', async () => {
      vi.mocked(GitHubCLI.parseGitHubUrl).mockReturnValue(null);

      await expect(
        parser.parse('invalid-url')
      ).rejects.toThrow('Invalid GitHub issue or PR URL');
    });

    it('should throw error when gh CLI is not available', async () => {
      vi.mocked(GitHubCLI.parseGitHubUrl).mockReturnValue({
        type: 'issue',
        repo: 'owner/repo',
        number: 123,
      });

      vi.mocked(GitHubCLI.isAvailable).mockResolvedValue({
        available: false,
        error: 'gh CLI not found',
      });

      await expect(
        parser.parse('https://github.com/owner/repo/issues/123')
      ).rejects.toThrow('gh CLI not found');
    });

    it('should throw error with default message when gh CLI error is undefined', async () => {
      vi.mocked(GitHubCLI.parseGitHubUrl).mockReturnValue({
        type: 'issue',
        repo: 'owner/repo',
        number: 123,
      });

      vi.mocked(GitHubCLI.isAvailable).mockResolvedValue({
        available: false,
      });

      await expect(
        parser.parse('https://github.com/owner/repo/issues/123')
      ).rejects.toThrow('gh CLI not available');
    });

    it('should handle GitHub API errors', async () => {
      vi.mocked(GitHubCLI.parseGitHubUrl).mockReturnValue({
        type: 'issue',
        repo: 'owner/repo',
        number: 123,
      });

      vi.mocked(GitHubCLI.isAvailable).mockResolvedValue({
        available: true,
        version: '2.0.0',
      });

      vi.mocked(GitHubCLI.getIssue).mockRejectedValue(
        new Error('Issue not found')
      );

      await expect(
        parser.parse('https://github.com/owner/repo/issues/123')
      ).rejects.toThrow('Issue not found');
    });
  });

  describe('Edge Cases', () => {
    it('should handle issues with empty body', async () => {
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
        body: '',
        state: 'open',
        labels: [],
        author: 'testuser',
        url: 'https://github.com/owner/repo/issues/123',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-02T00:00:00Z',
      });

      vi.mocked(mcpHelpers.extractUrls).mockReturnValue([]);
      vi.mocked(mcpHelpers.formatContext).mockReturnValue('');

      const result = await parser.parse('https://github.com/owner/repo/issues/123');

      expect(result).toBeDefined();
      expect(result.title).toBe('Test Issue');
    });

    it('should handle issues with no labels', async () => {
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
        body: 'Description',
        state: 'closed',
        labels: [],
        author: 'testuser',
        url: 'https://github.com/owner/repo/issues/123',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-02T00:00:00Z',
      });

      vi.mocked(mcpHelpers.extractUrls).mockReturnValue([]);
      vi.mocked(mcpHelpers.formatContext).mockReturnValue('Formatted');

      const result = await parser.parse('https://github.com/owner/repo/issues/123');

      expect(result.metadata?.labels).toEqual([]);
    });
  });
});
