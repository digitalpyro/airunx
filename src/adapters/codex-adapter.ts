/**
 * OpenAI Codex CLI Adapter
 * Executes agent tasks via the codex CLI
 *
 * Known issue: The codex CLI binary on Linux does not send the Authorization
 * header when using OPENAI_API_KEY directly. As a workaround, this adapter
 * auto-provisions a custom model provider in ~/.codex/config.toml on Linux
 * so the CLI reads the key via the env_key path instead.
 * See: https://github.com/openai/codex/issues/6620
 */

import * as path from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { spawnAsync } from '../utils/async-spawn.js';
import { homedir, platform } from 'os';
import { BaseCliAdapter, type CliAdapterConfig } from './base-cli-adapter.js';
import type {
  ExecutionRequest,
  ExecutionResult,
} from '../core/adapter-types.js';
import { OPENAI_PRICING } from './pricing.js';
import {
  DEFAULT_API_KEY_ENV,
  DEFAULT_CLI_EXECUTABLES,
  DEFAULT_MODELS,
} from './constants.js';
import { ConfigurationError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('codex-adapter');

/**
 * Custom model provider name used in config.toml for Linux workaround
 */
const LINUX_PROVIDER_NAME = 'openai-env-key';

/**
 * The config.toml snippet that tells the codex CLI to read the API key
 * from the OPENAI_API_KEY env var via a custom provider, bypassing the
 * Linux auth header bug.
 */
const LINUX_CONFIG_SNIPPET = `# Auto-provisioned by AIRunX for Linux compatibility
# See: https://github.com/openai/codex/issues/6620
model_provider = "${LINUX_PROVIDER_NAME}"

[model_providers.${LINUX_PROVIDER_NAME}]
name = "openai"
env_key = "${DEFAULT_API_KEY_ENV.codex}"
`;

export class CodexAdapter extends BaseCliAdapter {
  name = 'codex' as const;
  private useSubscriptionAuth = false;

  protected getCliConfig(): CliAdapterConfig {
    return {
      cliCommand: DEFAULT_CLI_EXECUTABLES.CODEX,
      installInstructions: 'npm install -g @openai/codex',
      pricingMap: OPENAI_PRICING,
      defaultModel: DEFAULT_MODELS.OPENAI,
    };
  }

  protected buildCliArgs(request: ExecutionRequest, prompt: string): string[] {
    const { context } = request;

    // Normalize to absolute path for reliability
    const rawDir = context.workingDirectory || process.cwd();
    const workingDir = path.resolve(rawDir);

    // Get approval mode flags from settings
    const approvalFlags = this.getApprovalModeFlags();

    // Codex CLI syntax: codex exec [OPTIONS] [PROMPT]
    // -C sets the working directory for Codex operations
    // 'exec' subcommand is required for non-interactive execution
    // '--' separator prevents prompt from being interpreted as a flag

    // In pipeline mode, restrict to workspace-write sandbox to limit blast radius.
    // Codex has no --disallowedTools equivalent, so sandbox is the primary control.
    // The pre-push git hook provides the actual git push block.
    const isPipelineMode =
      request.context.additionalContext?.pipelineMode === true;
    const sandboxFlags = isPipelineMode ? ['--sandbox', 'workspace-write'] : [];

    // Only pass --model when explicitly configured (via settings or AGENTS.md).
    // When no override is set, let the Codex CLI use its own default model,
    // which is version-appropriate and subscription-compatible.
    const model =
      this.config?.model || request.agent.preferredModel || undefined;
    const modelFlags = model ? ['--model', model] : [];

    const args = [
      'exec',
      '-C',
      workingDir,
      '--json', // Structured JSONL output with token data in turn.completed events
      ...approvalFlags,
      ...sandboxFlags,
      ...modelFlags,
      '--',
      prompt,
    ];

    return args;
  }

  /**
   * Parse Codex JSONL output to extract token usage and agent text.
   * Codex --json outputs one JSON object per line with event types:
   * - turn.completed: contains usage with input_tokens, output_tokens, cached_input_tokens
   * - item.completed: contains agent text output in item.text
   * Multiple turn.completed events occur per session (one per tool-use round).
   */
  protected parseOutput(
    stdout: string,
    stderr: string
  ): {
    outputs: ExecutionResult['outputs'];
    tokensUsed: number;
    inputTokens?: number;
    outputTokens?: number;
    totalCostUsd?: number;
  } {
    const lines = stdout.trim().split('\n');
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let agentText = '';
    let parsedAnyEvent = false;

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        parsedAnyEvent = true;
        if (event.type === 'turn.completed' && event.usage) {
          // OpenAI convention: input_tokens already includes cached_input_tokens,
          // and output_tokens already includes reasoning_output_tokens.
          // Do NOT sum the breakdowns — that would double-count.
          totalInputTokens += event.usage.input_tokens ?? 0;
          totalOutputTokens += event.usage.output_tokens ?? 0;
        }
        if (event.type === 'item.completed' && event.item?.text) {
          agentText += event.item.text + '\n';
        }
      } catch {
        // Skip non-JSON lines (e.g., stderr mixed in, "Reading additional input" banner)
      }
    }

    // Fall back to base class parsing if no JSONL events found
    if (!parsedAnyEvent) {
      return super.parseOutput(stdout, stderr);
    }

    const tokensUsed = totalInputTokens + totalOutputTokens;

    return {
      outputs: {
        analysis:
          (stderr.trim() ? `STDERR:\n${stderr}\n\n` : '') +
          (agentText.trim() || stdout),
        files: [],
        recommendations: [],
      },
      tokensUsed,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    };
  }

  /**
   * Codex CLI supports both API key and subscription (ChatGPT login) authentication.
   * We don't hard-require OPENAI_API_KEY since subscription users authenticate
   * via `codex login` and the CLI handles auth internally.
   */
  protected async validateAuthentication(): Promise<void> {
    // 1. Prefer subscription authentication (codex login)
    try {
      const cliCmd = this.getCliConfig().cliCommand;
      const result = await spawnAsync(cliCmd, ['login', 'status'], {
        timeout: 5000,
      });
      const output = (result.stdout || '') + (result.stderr || '');
      if (
        result.status === 0 &&
        output.includes('Logged in') &&
        !output.toLowerCase().includes('not logged in')
      ) {
        logger.debug('Using subscription authentication');
        this.useSubscriptionAuth = true;
        return;
      }
    } catch {
      // codex CLI not available or login check failed, fall through to API key
    }

    // 2. Fall back to API key
    const apiKey =
      this.config?.apiKey || process.env[DEFAULT_API_KEY_ENV.codex];
    if (apiKey?.trim()) {
      logger.debug('No subscription login — using API key authentication');

      // On Linux, the codex CLI binary has a known bug where it does not send
      // the Authorization header in HTTP requests when using OPENAI_API_KEY
      // directly. Provision a custom model provider in config.toml as workaround.
      if (platform() === 'linux') {
        this.ensureLinuxConfigWorkaround();
      }
      return;
    }

    throw new ConfigurationError(
      `No subscription login found and ${DEFAULT_API_KEY_ENV.codex} is not set. ` +
        'Run "codex login" or set OPENAI_API_KEY.',
      'authentication'
    );
  }

  /**
   * Ensure ~/.codex/config.toml has the custom model provider for Linux.
   *
   * - If config.toml doesn't exist, creates it with the workaround snippet.
   * - If it exists but lacks the provider, appends the snippet.
   * - If it already has the provider, does nothing.
   */
  private ensureLinuxConfigWorkaround(): void {
    const codexDir = path.join(homedir(), '.codex');
    const configPath = path.join(codexDir, 'config.toml');

    try {
      // Ensure ~/.codex/ exists
      if (!existsSync(codexDir)) {
        mkdirSync(codexDir, { recursive: true });
      }

      if (!existsSync(configPath)) {
        // No config file — create with workaround
        writeFileSync(configPath, LINUX_CONFIG_SNIPPET, 'utf-8');
        logger.info(
          `Created ${configPath} with Linux auth workaround (custom model provider)`
        );
        return;
      }

      // Config exists — check if workaround already present
      const existing = readFileSync(configPath, 'utf-8');
      if (existing.includes(LINUX_PROVIDER_NAME)) {
        logger.debug('Linux config workaround already present');
        return;
      }

      // Check if there's already a model_provider set
      if (/^model_provider\s*=/m.test(existing)) {
        logger.warn(
          `${configPath} already has a model_provider set. ` +
            `Skipping Linux workaround. If codex auth fails, manually set ` +
            `model_provider = "${LINUX_PROVIDER_NAME}" in ${configPath}`
        );
        return;
      }

      // Append workaround
      const separator = existing.endsWith('\n') ? '\n' : '\n\n';
      writeFileSync(
        configPath,
        existing + separator + LINUX_CONFIG_SNIPPET,
        'utf-8'
      );
      logger.info(
        `Appended Linux auth workaround to ${configPath} (custom model provider)`
      );
    } catch (error) {
      // Non-fatal — log and continue, the codex CLI may still work
      logger.warn(
        `Failed to provision Linux config workaround: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  /**
   * Execute with model fallback.
   * If the API rejects the model with "model is not supported" or
   * "requires a newer version", retry once with no explicit model
   * so the Codex CLI uses its own version-appropriate default.
   */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const result = await super.execute(request);

    // Detect model rejection and retry without --model flag
    const outputText = `${result.outputs?.stdout ?? ''} ${result.outputs?.stderr ?? ''}`;
    if (
      !result.success &&
      (outputText.includes('model is not supported') ||
        outputText.includes('requires a newer version'))
    ) {
      const currentModel = request.agent.preferredModel;

      logger.warn(
        `Model '${currentModel}' rejected — retrying without --model (CLI default)`
      );

      // Clear preferredModel so buildCommand omits --model flag
      const retryRequest = {
        ...request,
        agent: { ...request.agent, preferredModel: undefined },
      };
      return super.execute(retryRequest);
    }

    return result;
  }

  protected buildEnv(): Record<string, string | undefined> {
    // When subscription auth is active, do NOT inject the API key —
    // the CLI handles auth internally via its login token, and injecting an
    // API key would cause the CLI to use it instead of the subscription.
    // Setting it to `undefined` causes Node's spawn to omit it entirely.
    if (this.useSubscriptionAuth) {
      return { [DEFAULT_API_KEY_ENV.codex]: undefined };
    }
    return {
      [DEFAULT_API_KEY_ENV.codex]:
        this.config?.apiKey || process.env[DEFAULT_API_KEY_ENV.codex] || '',
    };
  }
}
