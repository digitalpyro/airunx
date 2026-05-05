/**
 * GitHub CLI integration tests
 */

import { describe, it, expect } from 'vitest';
import { GitHubCLI } from '../../src/integrations/github-cli.js';

describe('GitHubCLI', () => {
  describe('parseGitHubUrl', () => {
    it('should parse issue URLs', () => {
      const result = GitHubCLI.parseGitHubUrl(
        'https://github.com/owner/repo/issues/123'
      );

      expect(result).toEqual({
        repo: 'owner/repo',
        type: 'issue',
        number: 123,
      });
    });

    it('should parse PR URLs', () => {
      const result = GitHubCLI.parseGitHubUrl(
        'https://github.com/owner/repo/pull/456'
      );

      expect(result).toEqual({
        repo: 'owner/repo',
        type: 'pr',
        number: 456,
      });
    });

    it('should parse plain repo URLs', () => {
      const result = GitHubCLI.parseGitHubUrl(
        'https://github.com/owner/repo'
      );

      expect(result).toEqual({
        repo: 'owner/repo',
        type: 'repo',
        number: undefined,
      });
    });

    it('should parse repo URLs with .git suffix', () => {
      const result = GitHubCLI.parseGitHubUrl(
        'https://github.com/owner/repo.git'
      );

      expect(result).toEqual({
        repo: 'owner/repo',
        type: 'repo',
        number: undefined,
      });
    });

    it('should parse repo URLs with trailing slash', () => {
      const result = GitHubCLI.parseGitHubUrl(
        'https://github.com/owner/repo/'
      );

      expect(result).toEqual({
        repo: 'owner/repo',
        type: 'repo',
        number: undefined,
      });
    });

    it('should parse repo URL embedded in a prompt', () => {
      const result = GitHubCLI.parseGitHubUrl(
        'clone https://github.com/suredone/suredone and create test.txt'
      );

      expect(result).toEqual({
        repo: 'suredone/suredone',
        type: 'repo',
        number: undefined,
      });
    });

    it('should return null for invalid URLs', () => {
      expect(GitHubCLI.parseGitHubUrl('https://example.com')).toBeNull();
      expect(GitHubCLI.parseGitHubUrl('not a url')).toBeNull();
    });
  });
});
