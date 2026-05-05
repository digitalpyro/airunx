/**
 * GitHub issue/PR parser
 */

import { GitHubCLI } from '../integrations/github-cli.js';
import { extractUrls, formatContext } from '../integrations/mcp-helpers.js';
import type { InputParser, ParsedInput } from './input-parser.js';

export class GitHubParser implements InputParser {
  canParse(input: string): boolean {
    return /github\.com.*\/(issues|pull)/.test(input);
  }

  async parse(input: string): Promise<ParsedInput> {
    // Parse URL
    const parsed = GitHubCLI.parseGitHubUrl(input);
    if (!parsed || parsed.type === 'repo') {
      throw new Error('Invalid GitHub issue or PR URL');
    }

    // Check gh CLI availability
    const available = await GitHubCLI.isAvailable();
    if (!available.available) {
      throw new Error(available.error || 'gh CLI not available');
    }

    // Fetch issue or PR
    let data;
    if (parsed.type === 'issue') {
      data = await GitHubCLI.getIssue(parsed.repo, parsed.number);
    } else {
      data = await GitHubCLI.getPullRequest(parsed.repo, parsed.number);
    }

    // Extract embedded URLs for additional context
    const embeddedUrls = extractUrls(data.body);

    // Build context
    const context: Record<string, unknown> = {
      repo: parsed.repo,
      number: data.number,
      state: data.state,
      embeddedUrls,
    };

    // Use type guard to safely access PR-specific properties
    if (parsed.type === 'pr' && 'baseBranch' in data && 'headBranch' in data) {
      context.baseBranch = data.baseBranch;
      context.headBranch = data.headBranch;
    }

    return {
      type: 'github',
      title: data.title,
      description: formatContext({
        title: data.title,
        body: data.body,
        labels: data.labels,
        author: data.author,
        url: data.url,
      }),
      context,
      metadata: {
        source: 'github',
        author: data.author,
        labels: data.labels,
        url: data.url,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        type: parsed.type,
      },
    };
  }
}
