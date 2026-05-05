/**
 * Shared utilities for generating conventional commit titles
 * Used by both auto-commit and pr-generator for consistency
 */

import type { WorkflowContext } from '../core/types.js';
import {
  loadSettings,
  type ResolvedSettings,
  type PRTitleRules,
} from '../utils/settings.js';

/** Maximum length for commit/PR title subject line */
const MAX_TITLE_LENGTH = 72;

/** Default type mappings for commit type inference - ordered by specificity */
const DEFAULT_COMMIT_TYPE_MAPPINGS: { type: string; keywords: string[] }[] = [
  { type: 'fix', keywords: ['fix', 'bug'] },
  { type: 'docs', keywords: ['doc', 'readme'] },
  { type: 'refactor', keywords: ['refactor'] },
  { type: 'test', keywords: ['test'] },
  { type: 'chore', keywords: ['chore', 'config'] },
];

/**
 * Get commit type mappings from rules or use defaults
 */
function getCommitTypeMappings(
  rules: PRTitleRules | undefined
): { type: string; keywords: string[] }[] {
  if (!rules) {
    return DEFAULT_COMMIT_TYPE_MAPPINGS;
  }

  // Convert { fix: ['fix', 'bug'] } to [{ type: 'fix', keywords: ['fix', 'bug'] }]
  return Object.entries(rules)
    .filter(([key]) => key !== 'default')
    .map(([type, keywords]) => ({
      type,
      keywords: Array.isArray(keywords) ? keywords : [keywords],
    }));
}

/**
 * Get default commit type from rules or use 'feat'
 */
function getDefaultCommitType(rules: PRTitleRules | undefined): string {
  const defaultType = rules?.default;
  return typeof defaultType === 'string' ? defaultType : 'feat';
}

/**
 * Extract explicit type marker from text
 * Format: [type: <type>] (case-insensitive, requires space after colon)
 * @param text - Text to search for marker
 * @returns The type value (lowercase) or null if no marker found
 */
function extractTypeMarker(text: string | undefined): string | null {
  if (!text) return null;
  const match = text.match(/\[type:\s+(\w+)\]/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Infer commit type from context using keyword matching
 * Supports explicit markers like [type: feat] in task descriptions which take
 * precedence over keyword inference. Only scans taskTitle for keywords to avoid
 * false positives from description content (e.g., acceptance criteria mentioning tests).
 * @param context - Workflow context containing task info
 * @param settings - Settings object containing title rules
 */
export function inferCommitType(
  context: WorkflowContext,
  settings: ResolvedSettings
): string {
  const rules = settings.gh_pr_title_rules;

  // Check for explicit marker first (highest precedence after overrideType)
  const markerType = extractTypeMarker(context.taskDescription);
  if (markerType) {
    return markerType;
  }

  // Only scan title, not description (fixes false positive issue)
  const title = (context.taskTitle || '').toLowerCase();

  const mappings = getCommitTypeMappings(rules);

  for (const mapping of mappings) {
    if (
      mapping.keywords.some((keyword) =>
        new RegExp(`\\b${keyword}\\b`).test(title)
      )
    ) {
      return mapping.type;
    }
  }

  return getDefaultCommitType(rules);
}

/**
 * Generate a conventional commit title from workflow context
 * Handles:
 * - Cleaning existing prefixes to avoid duplication (e.g., "fix: fix: bug")
 * - Inferring appropriate commit type from context
 * - Truncating long titles to stay under 72 characters
 * @param context - Workflow context containing task info
 * @param overrideType - Optional commit type to use instead of inferring
 * @param settings - Optional settings object (loads from file if not provided)
 */
export function generateConventionalTitle(
  context: WorkflowContext,
  overrideType?: string,
  settings?: ResolvedSettings
): string {
  const resolvedSettings = settings ?? loadSettings();
  const title = context.taskTitle || 'AI-generated implementation';

  // Clean up title - remove any existing conventional commit prefixes
  // Handles: type:, type(scope):, type!:, type(scope)!:
  const cleanTitle = title.replace(/^\w+(\(.*\))?!?:\s*/i, '').trim();

  // Use override type if provided, otherwise infer from context
  const prefix = overrideType || inferCommitType(context, resolvedSettings);

  const fullTitle = `${prefix}: ${cleanTitle}`;

  // Truncate if too long (reserve space for prefix, ": ", and "...")
  // Truncate at word boundary for cleaner titles
  if (fullTitle.length > MAX_TITLE_LENGTH) {
    const availableLength = MAX_TITLE_LENGTH - prefix.length - 5; // 2 for ": ", 3 for "..."
    let truncated = cleanTitle.substring(0, availableLength);
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > 0) {
      truncated = truncated.substring(0, lastSpace);
    }
    return `${prefix}: ${truncated}...`;
  }

  return fullTitle;
}
