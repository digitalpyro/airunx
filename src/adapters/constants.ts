/**
 * Adapter configuration constants
 * Supports both subscription-based auth (login) and API key auth
 */

import type { ApprovalMode, ExecutionFidelityLevel } from '../core/types.js';
import type { BackendType } from '../core/adapter-types.js';

/**
 * Default models for each backend
 */
export const DEFAULT_MODELS = {
  // Drives the cursor adapter's --model flag and cost-estimation fallbacks.
  // The claude CLI runs its own default (no --model is passed) and codex
  // passes --model only when explicitly configured.
  OPENAI: 'gpt-5.6-terra',
  ANTHROPIC: 'claude-sonnet-5',
} as const;

/**
 * Default temperature settings
 */
export const DEFAULT_TEMPERATURE = 0.2;

/**
 * Default system prompt for agents
 */
export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful AI coding assistant.';

/**
 * Default CLI timeouts (in milliseconds)
 * LLM operations need adequate time for complex reasoning
 */
export const DEFAULT_CLI_TIMEOUT = 300000; // 5 minutes

/**
 * Default CLI timeouts (in seconds) for config files
 */
export const DEFAULT_CLI_TIMEOUT_SECONDS = 300; // 5 minutes

/**
 * Per-agent CLI timeout scaled by fidelity level (in milliseconds).
 * Higher fidelity levels allow agents more time for deeper analysis.
 */
export const FIDELITY_CLI_TIMEOUT: Record<ExecutionFidelityLevel, number> = {
  fast: 600000, // 10 minutes
  standard: 1800000, // 30 minutes
  thorough: 3600000, // 60 minutes
  ultra: 10800000, // 180 minutes
};

/**
 * Hang detection interval (in milliseconds)
 * Process is considered hanging if no output for this duration
 */
export const HANG_CHECK_INTERVAL_MS = 30000; // 30 seconds

/**
 * Grace period before escalating SIGTERM to SIGKILL (in milliseconds)
 */
export const SIGTERM_GRACE_PERIOD_MS = 5000; // 5 seconds

/**
 * Interval for polling hang detection (in milliseconds)
 * How often we check if a process has stopped producing output
 */
export const HANG_DETECTION_POLL_INTERVAL_MS = 5000; // 5 seconds

/**
 * Default CLI buffer size
 */
export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10MB

/**
 * Default CLI executables for each backend
 */
export const DEFAULT_CLI_EXECUTABLES = {
  CLAUDE_CODE: 'claude',
  CURSOR: 'cursor-agent',
  CODEX: 'codex',
} as const;

/**
 * Default API key environment variable names
 */
export const DEFAULT_API_KEY_ENV = {
  'claude-code': 'ANTHROPIC_API_KEY',
  cursor: 'CURSOR_API_KEY',
  codex: 'OPENAI_API_KEY',
} as const;

/**
 * Backend display names for user-facing output
 * Centralized mapping to ensure consistent naming across all commands
 */
export const BACKEND_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor CLI',
  codex: 'OpenAI Codex',
} as const;

/**
 * Convert backend key to display name
 * Uses centralized display name map with programmatic fallback
 * @param key - Backend key (e.g., 'claude-code')
 * @returns Display name (e.g., 'Claude Code')
 */
export function toDisplayName(key: string): string {
  return (
    BACKEND_DISPLAY_NAMES[key] ||
    key
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  );
}

/**
 * CLI flags for each approval mode, per adapter
 * Maps abstract approval modes to concrete CLI arguments
 */
export const APPROVAL_MODE_FLAGS: Record<
  BackendType,
  Record<ApprovalMode, string[]>
> = {
  codex: {
    manual: [],
    auto: ['--full-auto'],
    yolo: ['--dangerously-bypass-approvals-and-sandbox'],
  },
  'claude-code': {
    manual: [],
    auto: ['--dangerously-skip-permissions'],
    yolo: ['--dangerously-skip-permissions'],
  },
  cursor: {
    manual: [],
    auto: [], // Cursor doesn't have specific auto-approval flags
    yolo: [],
  },
} as const;

/**
 * Git write operations disallowed for all agent roles.
 * Shared base for both orchestrator and non-orchestrator restrictions.
 *
 * Uses Bash(git*<subcommand>*) pattern to catch flags before the subcommand
 * (e.g., `git -C /path push` bypasses `Bash(git push*)` but not `Bash(git*push*)`).
 */
const GIT_WRITE_DISALLOWED = [
  'Bash(git*commit*)',
  'Bash(git*push*)',
  'Bash(git*add*)',
  'Bash(git*reset*)',
  'Bash(git*revert*)',
  'Bash(git*rebase*)',
  'Bash(git*cherry-pick*)',
  'Bash(git*merge*)',
  'Bash(git*tag*)',
] as const;

/**
 * Orchestrator agents: block git writes only.
 * gh operations remain open so create_issue / create_pr stages can
 * manage PRs and issues programmatically.
 */
export const ORCHESTRATOR_DISALLOWED_TOOLS = [...GIT_WRITE_DISALLOWED] as const;

/**
 * Non-orchestrator agents: block git writes AND gh write operations.
 * Uses Claude Code's Bash() pattern matching syntax.
 *
 * Pattern syntax: Bash(<command prefix>*)
 * - Matches any bash command starting with the prefix
 * - '*' is a wildcard matching any suffix
 * - Case-sensitive (git != GIT)
 */
export const AGENT_DISALLOWED_TOOLS = [
  ...GIT_WRITE_DISALLOWED,
  // GitHub PR/issue creation and comments
  'Bash(gh pr create*)',
  'Bash(gh issue create*)',
  'Bash(gh issue comment*)',
  'Bash(gh pr comment*)',
  // GitHub PR state changes
  'Bash(gh pr merge*)',
  'Bash(gh pr close*)',
  'Bash(gh pr edit*)',
  'Bash(gh pr review*)',
  'Bash(gh pr ready*)',
  // GitHub Releases
  'Bash(gh release create*)',
  // GitHub repository management
  'Bash(gh repo create*)',
  'Bash(gh repo delete*)',
  'Bash(gh repo edit*)',
  // GitHub secrets and variables
  'Bash(gh secret set*)',
  'Bash(gh secret delete*)',
  'Bash(gh variable set*)',
  'Bash(gh variable delete*)',
  // GitHub Actions workflows
  'Bash(gh workflow run*)',
  'Bash(gh workflow enable*)',
  'Bash(gh workflow disable*)',
] as const;
