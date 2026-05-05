/**
 * Claude Code CLI Adapter
 * Executes agent tasks via the claude-code CLI
 *
 * Authentication: Claude Code CLI supports two auth methods:
 * 1. Subscription-based (OAuth/login) - No API key needed
 * 2. API key-based - Uses ANTHROPIC_API_KEY environment variable
 */

import { spawnSync } from 'child_process';
import { BaseCliAdapter, type CliAdapterConfig } from './base-cli-adapter.js';
import type { ExecutionRequest } from '../core/adapter-types.js';
import { ANTHROPIC_PRICING } from './pricing.js';
import { ConfigurationError } from '../utils/errors.js';
import {
  DEFAULT_CLI_EXECUTABLES,
  DEFAULT_MODELS,
  AGENT_DISALLOWED_TOOLS,
  ORCHESTRATOR_DISALLOWED_TOOLS,
} from './constants.js';
import { createLogger } from '../utils/logger.js';

export class ClaudeCodeAdapter extends BaseCliAdapter {
  name = 'claude-code' as const;
  private claudeLogger = createLogger('claude-code-adapter');
  private useSubscriptionAuth = false;

  protected getCliConfig(): CliAdapterConfig {
    return {
      cliCommand: DEFAULT_CLI_EXECUTABLES.CLAUDE_CODE,
      installInstructions: 'npm install -g @anthropic-ai/claude-code',
      pricingMap: ANTHROPIC_PRICING,
      defaultModel: DEFAULT_MODELS.ANTHROPIC,
    };
  }

  /**
   * Claude Code CLI supports both API key and subscription (OAuth) authentication.
   * We don't hard-require ANTHROPIC_API_KEY since subscription users authenticate
   * via `claude auth login` and the CLI handles auth internally.
   */
  protected async validateAuthentication(): Promise<void> {
    // 1. Prefer subscription authentication (claude auth login)
    // IMPORTANT: Run auth status WITHOUT ANTHROPIC_API_KEY in the env, because
    // Claude CLI v2.1+ reports loggedIn=true when the API key is present even
    // without a real subscription. Stripping it gives us the true OAuth state.
    try {
      const cliCmd = this.getCliConfig().cliCommand;
      const result = spawnSync(cliCmd, ['auth', 'status'], {
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env, ANTHROPIC_API_KEY: undefined },
      });
      if (result.status === 0 && result.stdout) {
        try {
          const stdout = result.stdout.trim();
          const start = stdout.indexOf('{');
          const end = stdout.lastIndexOf('}');
          const parsed = JSON.parse(
            start !== -1 && end !== -1 ? stdout.slice(start, end + 1) : stdout
          );
          if (parsed.loggedIn === true) {
            this.claudeLogger.debug('Using subscription authentication');
            this.useSubscriptionAuth = true;
            return;
          }
        } catch {
          // stdout not valid JSON, fall through to API key
        }
      }
    } catch {
      // CLI not available or auth check failed, fall through to API key
    }

    // 2. Fall back to API key with --bare mode
    const apiKey = this.config?.apiKey || process.env.ANTHROPIC_API_KEY;
    if (apiKey?.trim()) {
      this.claudeLogger.debug(
        'No subscription login — using API key authentication (--bare mode)'
      );
      if (!apiKey.startsWith('sk-ant-')) {
        this.claudeLogger.warn(
          'ANTHROPIC_API_KEY does not match expected format (sk-ant-...). This may cause issues.'
        );
      }
      this.useSubscriptionAuth = false;
      return;
    }

    throw new ConfigurationError(
      'No subscription login found and ANTHROPIC_API_KEY is not set. ' +
        'Run "claude auth login" or set ANTHROPIC_API_KEY.',
      'authentication'
    );
  }

  protected buildCliArgs(request: ExecutionRequest, prompt: string): string[] {
    // Claude CLI syntax: claude [options] [prompt]
    // -p enables print mode (non-interactive)
    // Options must come BEFORE the prompt
    // Note: We don't use --add-dir because it consumes the prompt as a directory
    // The cwd is passed to execFile instead
    const approvalFlags = this.getApprovalModeFlags();

    // Block git/gh write operations at the tool level (cannot be bypassed by the LLM).
    // In pipeline mode: ALL roles (including orchestrator) get full gh restrictions —
    // the pipeline executor handles PR creation after all stages complete.
    // In standalone/raw mode: orchestrator retains gh access for PR/issue management.
    const isPipelineMode =
      request.context.additionalContext?.pipelineMode === true;
    const disallowedToolsFlags =
      request.agent.role === 'orchestrator' && !isPipelineMode
        ? ['--disallowedTools', ORCHESTRATOR_DISALLOWED_TOOLS.join(',')]
        : ['--disallowedTools', AGENT_DISALLOWED_TOOLS.join(',')];

    // In pipeline mode, orchestrator coordinates — it doesn't need file tools.
    // --tools "" disables all built-in tools (Read, Glob, Grep, Bash, Edit, Write)
    // so the orchestrator can only reason and output text, not explore the codebase.
    // Allowlist approach is safer than blocklist — new tools won't leak through.
    const toolsFlags =
      request.agent.role === 'orchestrator' && isPipelineMode
        ? ['--tools', '']
        : [];

    // When using API key auth (not subscription/OAuth), pass --bare so the CLI
    // uses ANTHROPIC_API_KEY directly without attempting OAuth/keychain reads.
    // Claude CLI v2.1+ requires this for headless API key execution.
    const bareFlag = !this.useSubscriptionAuth ? ['--bare'] : [];

    const args = [
      '-p', // Print mode (non-interactive)
      '--output-format',
      'json',
      ...bareFlag,
      ...approvalFlags,
      ...disallowedToolsFlags,
      ...toolsFlags,
      '--no-session-persistence', // Don't save session to disk (faster, no session prompts)
      prompt, // Prompt must be LAST
    ];

    return args;
  }

  protected buildEnv(): Record<string, string | undefined> {
    // When subscription auth is active, do NOT inject ANTHROPIC_API_KEY —
    // the CLI handles auth internally via its OAuth token, and injecting an
    // API key would cause the CLI to use it instead of the subscription.
    // Setting it to `undefined` causes Node's spawn to omit it entirely.
    if (this.useSubscriptionAuth) {
      return { ANTHROPIC_API_KEY: undefined };
    }
    return {
      ANTHROPIC_API_KEY:
        this.config?.apiKey || process.env.ANTHROPIC_API_KEY || '',
    };
  }
}
