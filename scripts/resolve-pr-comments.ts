#!/usr/bin/env npx ts-node
/**
 * Script to resolve PR review comments programmatically
 *
 * SECURITY WARNING:
 * =================
 * This script applies code suggestions from PR review comments directly to your
 * local filesystem. It is intended ONLY for manual execution by trusted developers
 * on their local machines.
 *
 * DO NOT use this script in automated CI/CD pipelines, especially on public
 * repositories or forks. An attacker could submit a PR with malicious code
 * suggestions that this script would automatically apply.
 *
 * Always review suggestions before applying them with --apply.
 * Use --dry-run first to preview changes.
 *
 * Usage:
 *   npx ts-node scripts/resolve-pr-comments.ts <owner> <repo> <pr_number> [options]
 *
 * Options:
 *   --review-id <id>   Only process comments from a specific review
 *   --dry-run          Show what would be changed without making changes
 *   --apply            Apply suggested changes automatically
 *   --list             List all comments without applying changes
 *
 * Environment:
 *   GITHUB_API_TOKEN   GitHub personal access token
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

interface ReviewComment {
  id: number;
  path: string;
  body: string;
  line?: number;
  original_line?: number;
  position?: number;
  original_position?: number;
  diff_hunk: string;
  pull_request_review_id: number;
  user: {
    login: string;
  };
  created_at: string;
  html_url: string;
}

interface CommentWithSuggestion {
  comment: ReviewComment;
  suggestion?: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
}

/**
 * Parse command line arguments
 */
function parseArgs(): {
  owner: string;
  repo: string;
  prNumber: number;
  reviewId?: number;
  dryRun: boolean;
  apply: boolean;
  list: boolean;
} {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.error('Usage: resolve-pr-comments.ts <owner> <repo> <pr_number> [options]');
    console.error('Options:');
    console.error('  --review-id <id>   Only process comments from a specific review');
    console.error('  --dry-run          Show what would be changed without making changes');
    console.error('  --apply            Apply suggested changes automatically');
    console.error('  --list             List all comments without applying changes');
    process.exit(1);
  }

  const [owner, repo, prNumberStr, ...options] = args;
  const prNumber = parseInt(prNumberStr, 10);

  let reviewId: number | undefined;
  let dryRun = false;
  let apply = false;
  let list = false;

  for (let i = 0; i < options.length; i++) {
    switch (options[i]) {
      case '--review-id':
        if (i + 1 >= options.length) {
          console.error('Error: --review-id option requires a value.');
          process.exit(1);
        }
        reviewId = parseInt(options[++i], 10);
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--apply':
        apply = true;
        break;
      case '--list':
        list = true;
        break;
    }
  }

  return { owner, repo, prNumber, reviewId, dryRun, apply, list };
}

/**
 * Fetch PR review comments from GitHub API
 */
async function fetchReviewComments(
  owner: string,
  repo: string,
  prNumber: number,
  token: string
): Promise<ReviewComment[]> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch comments: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Extract suggestion from comment body
 * Looks for ```suggestion code blocks
 */
function extractSuggestion(body: string): string | undefined {
  const suggestionMatch = body.match(/```suggestion\n([\s\S]*?)```/);
  return suggestionMatch ? suggestionMatch[1] : undefined;
}

/**
 * Extract priority from comment body
 * Uses specific markers to avoid false positives from generic text
 */
function extractPriority(body: string): 'critical' | 'high' | 'medium' | 'low' {
  // Check for Gemini's priority image badges (most reliable)
  if (body.includes('critical-priority.svg')) return 'critical';
  if (body.includes('high-priority.svg')) return 'high';
  if (body.includes('medium-priority.svg')) return 'medium';
  if (body.includes('low-priority.svg')) return 'low';

  // Check for explicit severity markers [severity: X]
  const severityMatch = body.match(/\[severity:\s*(critical|high|medium|low)\]/i);
  if (severityMatch) {
    return severityMatch[1].toLowerCase() as 'critical' | 'high' | 'medium' | 'low';
  }

  // Fallback to checking for priority in markdown image alt text
  if (body.includes('![critical]')) return 'critical';
  if (body.includes('![high]')) return 'high';
  if (body.includes('![medium]')) return 'medium';

  return 'low';
}

/**
 * Process comments and extract suggestions
 */
function processComments(
  comments: ReviewComment[],
  reviewId?: number
): CommentWithSuggestion[] {
  let filtered = comments;

  if (reviewId) {
    filtered = comments.filter((c) => c.pull_request_review_id === reviewId);
  }

  return filtered.map((comment) => ({
    comment,
    suggestion: extractSuggestion(comment.body),
    priority: extractPriority(comment.body),
  }));
}

/**
 * Apply a suggestion to a file
 */
async function applySuggestion(
  filePath: string,
  diffHunk: string,
  suggestion: string,
  originalLine?: number,
  dryRun: boolean = false
): Promise<{ success: boolean; message: string }> {
  const fullPath = path.resolve(filePath);

  if (!existsSync(fullPath)) {
    return { success: false, message: `File not found: ${fullPath}` };
  }

  const content = await readFile(fullPath, 'utf-8');
  const lines = content.split('\n');

  // Extract the original code from the diff hunk
  // The diff hunk shows context, we need to find the lines that would be replaced
  const hunkLines = diffHunk.split('\n');
  const addedLines: string[] = [];

  // Find lines starting with '+' (excluding the header)
  for (const line of hunkLines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLines.push(line.substring(1));
    }
  }

  if (addedLines.length === 0) {
    return { success: false, message: 'Could not parse diff hunk' };
  }

  // Find the original code in the file
  const originalCode = addedLines.join('\n');
  const suggestionTrimmed = suggestion.trimEnd();

  // Try to find and replace
  const contentIndex = content.indexOf(originalCode);
  if (contentIndex === -1) {
    // Try line-by-line approach with the specific line number
    if (originalLine && originalLine > 0 && originalLine <= lines.length) {
      const startLine = originalLine - 1;
      const numLines = addedLines.length;
      const oldLines = lines.slice(startLine, startLine + numLines).join('\n');

      if (oldLines === originalCode) {
        const newLines = suggestionTrimmed.split('\n');
        lines.splice(startLine, numLines, ...newLines);

        if (!dryRun) {
          await writeFile(fullPath, lines.join('\n'), 'utf-8');
        }

        return {
          success: true,
          message: dryRun
            ? `[DRY RUN] Would replace ${numLines} lines at line ${originalLine}`
            : `Replaced ${numLines} lines at line ${originalLine}`,
        };
      }
    }

    return {
      success: false,
      message: 'Could not find original code in file (code may have changed)',
    };
  }

  const newContent = content.replace(originalCode, suggestionTrimmed);

  if (!dryRun) {
    await writeFile(fullPath, newContent, 'utf-8');
  }

  return {
    success: true,
    message: dryRun ? '[DRY RUN] Would apply suggestion' : 'Applied suggestion',
  };
}

/**
 * Display comment summary
 */
function displayComment(item: CommentWithSuggestion, index: number): void {
  const { comment, suggestion, priority } = item;
  const priorityColors: Record<string, string> = {
    critical: '\x1b[31m',
    high: '\x1b[33m',
    medium: '\x1b[36m',
    low: '\x1b[37m',
  };
  const reset = '\x1b[0m';

  console.log(`\n${index + 1}. ${priorityColors[priority]}[${priority.toUpperCase()}]${reset} ${comment.path}`);
  console.log(`   Line: ${comment.original_line || comment.line || 'N/A'}`);
  console.log(`   By: ${comment.user.login} at ${comment.created_at}`);
  console.log(`   URL: ${comment.html_url}`);

  // Extract first line of comment (usually the description)
  const firstLine = comment.body.split('\n')[0]?.replace(/!\[.*?\]\(.*?\)/g, '').trim();
  if (firstLine) {
    console.log(`   Summary: ${firstLine.substring(0, 100)}${firstLine.length > 100 ? '...' : ''}`);
  }

  if (suggestion) {
    console.log(`   Has suggestion: Yes`);
  }
}

/**
 * Display security warning banner
 */
function displaySecurityWarning(): void {
  const yellow = '\x1b[33m';
  const red = '\x1b[31m';
  const reset = '\x1b[0m';

  console.log(`${yellow}${'='.repeat(70)}${reset}`);
  console.log(`${red}SECURITY WARNING${reset}`);
  console.log(`${yellow}${'='.repeat(70)}${reset}`);
  console.log(`This script applies code suggestions directly to your local filesystem.`);
  console.log(`It is intended ONLY for manual execution by trusted developers.`);
  console.log(`${red}DO NOT${reset} use in CI/CD pipelines or on untrusted PR comments.`);
  console.log(`${yellow}${'='.repeat(70)}${reset}\n`);
}

/**
 * Main function
 */
async function main(): Promise<void> {
  const { owner, repo, prNumber, reviewId, dryRun, apply, list } = parseArgs();

  // Display security warning when applying changes
  if (apply && !dryRun) {
    displaySecurityWarning();
  }

  const token = process.env.GITHUB_API_TOKEN;
  if (!token) {
    console.error('Error: GITHUB_API_TOKEN environment variable is required');
    process.exit(1);
  }

  console.log(`Fetching review comments for ${owner}/${repo}#${prNumber}...`);
  if (reviewId) {
    console.log(`Filtering by review ID: ${reviewId}`);
  }

  try {
    const comments = await fetchReviewComments(owner, repo, prNumber, token);
    console.log(`Found ${comments.length} total comments`);

    const processed = processComments(comments, reviewId);
    console.log(`Processing ${processed.length} comments${reviewId ? ` from review ${reviewId}` : ''}`);

    // Sort by priority
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    processed.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    // List mode - just display comments
    if (list || (!apply && !dryRun)) {
      console.log('\n=== Review Comments ===');
      processed.forEach((item, index) => displayComment(item, index));

      const withSuggestions = processed.filter((p) => p.suggestion);
      console.log(`\n=== Summary ===`);
      console.log(`Total comments: ${processed.length}`);
      console.log(`With suggestions: ${withSuggestions.length}`);
      console.log(`By priority:`);
      console.log(`  Critical: ${processed.filter((p) => p.priority === 'critical').length}`);
      console.log(`  High: ${processed.filter((p) => p.priority === 'high').length}`);
      console.log(`  Medium: ${processed.filter((p) => p.priority === 'medium').length}`);
      console.log(`  Low: ${processed.filter((p) => p.priority === 'low').length}`);

      if (withSuggestions.length > 0 && !apply) {
        console.log(`\nRun with --apply to apply ${withSuggestions.length} suggestions`);
        console.log(`Run with --dry-run to preview changes`);
      }
      return;
    }

    // Apply mode - apply suggestions
    const withSuggestions = processed.filter((p) => p.suggestion);

    if (withSuggestions.length === 0) {
      console.log('No suggestions to apply');
      return;
    }

    console.log(`\n=== ${dryRun ? 'Previewing' : 'Applying'} ${withSuggestions.length} suggestions ===`);

    let applied = 0;
    let failed = 0;

    for (const item of withSuggestions) {
      displayComment(item, withSuggestions.indexOf(item));

      const result = await applySuggestion(
        item.comment.path,
        item.comment.diff_hunk,
        item.suggestion!,
        item.comment.original_line,
        dryRun
      );

      if (result.success) {
        console.log(`   ✓ ${result.message}`);
        applied++;
      } else {
        console.log(`   ✗ ${result.message}`);
        failed++;
      }
    }

    console.log(`\n=== Results ===`);
    console.log(`Successfully ${dryRun ? 'would apply' : 'applied'}: ${applied}`);
    console.log(`Failed: ${failed}`);

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
