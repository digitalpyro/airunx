/**
 * Claude Code CLI Adapter
 * Executes agent tasks via the claude-code CLI
 *
 * Authentication: Claude Code CLI supports two auth methods:
 * 1. Subscription-based (OAuth/login) - No API key needed
 * 2. API key-based - Uses ANTHROPIC_API_KEY environment variable
 */

import { spawnAsync } from '../utils/async-spawn.js';
import {
  BaseCliAdapter,
  type CliAdapterConfig,
  type ParsedCliOutput,
} from './base-cli-adapter.js';
import type { ExecutionRequest, SpawnAuthMode } from '../core/adapter-types.js';
import type { NormalizedTokenUsage } from '../core/types.js';
import { ANTHROPIC_CACHE_PRICING, ANTHROPIC_PRICING } from './pricing.js';
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
      cachePricingMap: ANTHROPIC_CACHE_PRICING,
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
      const result = await spawnAsync(cliCmd, ['auth', 'status'], {
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

  /**
   * Normalize Claude Code `--output-format json` usage.
   *
   * Tokens come from `modelUsage` (which, like `total_cost_usd`, includes
   * Claude Code's own subagents) rather than `usage` (main thread only).
   * Anthropic `input_tokens` excludes cache, so normalized input is
   * input + cache_read + cache_creation; the 5m/1h write split comes from
   * `cache_creation.ephemeral_*` where reported. An `error_during_execution`
   * result with a zeroed cost is treated as missing, not $0.
   */
  protected extractUsage(
    parsed: Record<string, unknown>,
    inputTokens: number | undefined,
    outputTokens: number | undefined
  ): Partial<ParsedCliOutput> {
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    const obj = (v: unknown): Record<string, unknown> | undefined =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : undefined;

    const providerUsage: Record<string, number> = {};
    const keep = (key: string, value: unknown): number | undefined => {
      const n = num(value);
      if (n !== undefined) providerUsage[key] = n;
      return n;
    };

    const totalCost = keep('total_cost_usd', parsed.total_cost_usd);
    const usage = obj(parsed.usage) ?? {};
    const rawInput = keep('usage.input_tokens', usage.input_tokens);
    const rawOutput = keep('usage.output_tokens', usage.output_tokens);
    const rawCacheRead = keep(
      'usage.cache_read_input_tokens',
      usage.cache_read_input_tokens
    );
    const rawCacheWrite = keep(
      'usage.cache_creation_input_tokens',
      usage.cache_creation_input_tokens
    );
    const creation = obj(usage.cache_creation) ?? {};
    const split5m = keep(
      'usage.cache_creation.ephemeral_5m_input_tokens',
      creation.ephemeral_5m_input_tokens
    );
    const split1h = keep(
      'usage.cache_creation.ephemeral_1h_input_tokens',
      creation.ephemeral_1h_input_tokens
    );

    const unmodeledModifiers: string[] = [];
    if (usage.speed === 'fast') unmodeledModifiers.push('fast_mode');
    if (usage.service_tier === 'batch') unmodeledModifiers.push('batch');

    const toUsage = (
      input: number,
      output: number,
      cacheRead: number,
      cacheWrite: number,
      w5m: number | undefined,
      w1h: number | undefined
    ): NormalizedTokenUsage => {
      const u: NormalizedTokenUsage = {
        inputTokens: input + cacheRead + cacheWrite,
        outputTokens: output,
        cacheReadInputTokens: cacheRead,
        cacheWriteInputTokens: cacheWrite,
      };
      if (w1h !== undefined) {
        u.cacheWrite1hInputTokens = Math.min(w1h, cacheWrite);
        u.cacheWrite5mInputTokens = cacheWrite - u.cacheWrite1hInputTokens;
      } else if (w5m !== undefined) {
        u.cacheWrite5mInputTokens = Math.min(w5m, cacheWrite);
      }
      return u;
    };

    // Per-model usage (includes subagents)
    const usageByModel: Record<string, NormalizedTokenUsage> = {};
    const costBasis: Record<string, string> = {};
    const modelUsage = obj(parsed.modelUsage) ?? {};
    for (const [rawModel, value] of Object.entries(modelUsage)) {
      const entry = obj(value);
      if (!entry) continue;
      // Drop context-window suffixes like "[1m]" before pricing lookup
      const model = rawModel.replace(/\[.*\]$/, '');
      const prefix = `modelUsage.${model}`;
      const input = keep(`${prefix}.inputTokens`, entry.inputTokens) ?? 0;
      const output = keep(`${prefix}.outputTokens`, entry.outputTokens) ?? 0;
      const cacheRead =
        keep(`${prefix}.cacheReadInputTokens`, entry.cacheReadInputTokens) ?? 0;
      const cacheWrite =
        keep(
          `${prefix}.cacheCreationInputTokens`,
          entry.cacheCreationInputTokens
        ) ?? 0;
      keep(`${prefix}.costUSD`, entry.costUSD);
      const entryCreation = obj(entry.cacheCreation) ?? {};
      usageByModel[model] = toUsage(
        input,
        output,
        cacheRead,
        cacheWrite,
        num(entryCreation.ephemeral5mInputTokens) ??
          num(entryCreation.ephemeral_5m_input_tokens),
        num(entryCreation.ephemeral1hInputTokens) ??
          num(entryCreation.ephemeral_1h_input_tokens)
      );
      if (
        typeof entry.costBasis === 'string' &&
        /^[\w.:-]{1,32}$/.test(entry.costBasis)
      ) {
        costBasis[model] = entry.costBasis;
      }
    }

    let normalized: NormalizedTokenUsage | undefined;
    const models = Object.values(usageByModel);
    if (models.length > 0) {
      normalized = models.reduce((acc, u) => ({
        inputTokens: acc.inputTokens + u.inputTokens,
        outputTokens: acc.outputTokens + u.outputTokens,
        cacheReadInputTokens: acc.cacheReadInputTokens + u.cacheReadInputTokens,
        cacheWriteInputTokens:
          acc.cacheWriteInputTokens + u.cacheWriteInputTokens,
      }));
      // Apply the main-thread 1h split (unsplit remainder is the 5m default)
      if (split1h !== undefined || split5m !== undefined) {
        const w = normalized.cacheWriteInputTokens;
        normalized.cacheWrite1hInputTokens = Math.min(split1h ?? 0, w);
        normalized.cacheWrite5mInputTokens =
          w - normalized.cacheWrite1hInputTokens;
      }
      // Single model: carry the split onto the per-model usage for pricing
      if (models.length === 1) {
        const [only] = Object.keys(usageByModel);
        usageByModel[only] = { ...normalized };
      }
    } else if (rawInput !== undefined || rawOutput !== undefined) {
      normalized = toUsage(
        rawInput ?? inputTokens ?? 0,
        rawOutput ?? outputTokens ?? 0,
        rawCacheRead ?? 0,
        rawCacheWrite ?? 0,
        split5m,
        split1h
      );
    }

    const result: Partial<ParsedCliOutput> = {
      providerUsage:
        Object.keys(providerUsage).length > 0 ? providerUsage : undefined,
      unmodeledModifiers,
    };
    if (normalized) result.usage = normalized;
    if (Object.keys(usageByModel).length > 0)
      result.usageByModel = usageByModel;
    if (Object.keys(costBasis).length > 0) result.costBasis = costBasis;

    // error_during_execution results can carry zeroed cost fields: that is
    // "unknown", not a real $0 spend
    if (
      parsed.subtype === 'error_during_execution' &&
      (totalCost === undefined || totalCost === 0)
    ) {
      result.totalCostUsd = undefined;
    }
    return result;
  }

  protected getAuthMode(): SpawnAuthMode {
    return this.useSubscriptionAuth ? 'subscription' : 'api_key';
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
