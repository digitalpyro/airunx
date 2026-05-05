/**
 * Base CLI Adapter
 * Abstract base class for CLI-based adapters (Claude Code, Cursor, etc.)
 * Provides common CLI execution logic to reduce duplication
 */

import { exec, execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { stat } from 'fs/promises';
import { BaseAdapter } from './base-adapter.js';
import type {
  ExecutionRequest,
  ExecutionResult,
  BackendAvailability,
  AdapterConfig,
} from '../core/adapter-types.js';
import { calculateCost, getModelPricing } from './pricing.js';
import type { ModelPricing } from './pricing.js';
import {
  DEFAULT_CLI_TIMEOUT,
  HANG_CHECK_INTERVAL_MS,
  HANG_DETECTION_POLL_INTERVAL_MS,
  SIGTERM_GRACE_PERIOD_MS,
  APPROVAL_MODE_FLAGS,
} from './constants.js';
import { loadSettings } from '../utils/settings.js';
import { createLogger } from '../utils/logger.js';
import {
  BackendNotFoundError,
  ConfigurationError,
  TimeoutError,
  RateLimitError,
  RetryableError,
  NonRetryableError,
} from '../utils/errors.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Estimated ratio of input tokens to total tokens for CLI adapters
 * CLI tools don't provide separate input/output token counts, so we estimate
 * a 50/50 split for cost calculation purposes
 */
const ESTIMATED_CLI_INPUT_TOKEN_RATIO = 0.5;

/**
 * Configuration for CLI-specific behavior
 */
export interface CliAdapterConfig {
  /** The CLI command name (e.g., 'claude-code', 'cursor-agent') */
  cliCommand: string;
  /** Install instructions for when CLI is not found */
  installInstructions: string;
  /** Pricing model to use for cost calculation */
  pricingMap: Record<string, ModelPricing>;
  /** Default model if not specified */
  defaultModel: string;
}

/**
 * Shared interface for process execution errors
 * Used by executeWithSpawn rejections and categorizeError
 * Includes stdout as some tools output error info to stdout
 */
export interface ProcessError extends Error {
  code?: number | string;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}

export abstract class BaseCliAdapter extends BaseAdapter {
  type = 'cli' as const;
  protected logger = createLogger('base-cli-adapter');

  /** Subclasses must provide CLI-specific configuration */
  protected abstract getCliConfig(): CliAdapterConfig;

  /**
   * Subclasses must implement how to build CLI arguments
   */
  protected abstract buildCliArgs(
    _request: ExecutionRequest,
    _prompt: string
  ): string[];

  /**
   * Get approval mode flags for this adapter
   * Reads from settings, with YOLO mode warning
   */
  protected getApprovalModeFlags(): string[] {
    const settings = loadSettings();
    let mode = settings.approval_mode ?? 'auto';

    if (mode === 'yolo') {
      // Use the shell-only value captured before dotenv loaded .env files.
      // This prevents a project-controlled .env from silently enabling YOLO.
      const shellYolo = process.env._AIRUNX_SHELL_ALLOW_YOLO;
      if (shellYolo !== '1') {
        this.logger.warn(
          'YOLO mode requires AIRUNX_ALLOW_YOLO=1 in your shell environment (not .env). Falling back to "auto" approval mode.'
        );
        mode = 'auto';
      } else {
        this.logger.warn(
          '⚠️  YOLO mode: All approvals and sandboxing disabled'
        );
      }
    }

    return APPROVAL_MODE_FLAGS[this.name]?.[mode] ?? [];
  }

  /**
   * Get timeout in milliseconds from config
   * Config stores timeout in seconds, but Node.js APIs expect milliseconds
   * Throws on negative values to fail fast on invalid configuration
   */
  protected getTimeoutMs(): number {
    const timeoutSeconds = this.config?.timeout;

    if (timeoutSeconds != null && timeoutSeconds >= 0) {
      return timeoutSeconds * 1000;
    }

    if (timeoutSeconds != null && timeoutSeconds < 0) {
      throw new Error(
        `Invalid configuration: Timeout value cannot be negative. Received ${timeoutSeconds}s.`
      );
    }

    return DEFAULT_CLI_TIMEOUT;
  }

  async init(config: AdapterConfig): Promise<void> {
    await super.init(config);
    const cliConfig = this.getCliConfig();

    // Step 1: Check CLI binary exists in PATH
    try {
      await execFileAsync('which', [cliConfig.cliCommand]);
    } catch {
      throw new BackendNotFoundError(
        cliConfig.cliCommand,
        cliConfig.installInstructions
      );
    }

    // Step 2: Run backend-specific validation (auth checks, etc.)
    // Subclasses override validateBackend() for custom checks
    await this.validateBackend();
  }

  /**
   * Backend-specific validation hook
   * Subclasses should override this to add authentication checks
   * or other backend-specific validation (e.g., cursor-agent login status)
   *
   * @throws ConfigurationError if backend requires configuration
   * @throws BackendNotFoundError if backend CLI has issues
   */
  protected async validateBackend(): Promise<void> {
    // Run authentication checks during initialization for fail-fast behavior
    await this.validateAuthentication();
  }

  /**
   * Pre-flight validation before executing CLI
   * Checks working directory exists and authentication is valid
   */
  protected async validatePreFlight(workingDirectory: string): Promise<void> {
    // Check working directory exists and is a directory
    try {
      const stats = await stat(workingDirectory);
      if (!stats.isDirectory()) {
        throw new ConfigurationError(
          `Not a directory: ${workingDirectory}`,
          'directory'
        );
      }
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        throw new ConfigurationError(
          `Working directory does not exist: ${workingDirectory}`,
          'directory'
        );
      }
      // Re-throw other errors, including ConfigurationError from the isDirectory check
      throw error;
    }

    // Subclasses can add authentication checks
    await this.validateAuthentication();
  }

  /**
   * Override in subclasses for backend-specific auth validation
   * Called during pre-flight validation
   */
  protected async validateAuthentication(): Promise<void> {
    // Default: no validation
  }

  /**
   * Kill process with escalation: SIGTERM → wait → SIGKILL
   */
  private killProcess(child: ChildProcess, reason: string): void {
    this.logger.debug(`Killing process (reason: ${reason}), sending SIGTERM`);
    child.kill('SIGTERM');

    globalThis.setTimeout(() => {
      if (!child.killed) {
        this.logger.debug('Process still alive after SIGTERM, sending SIGKILL');
        child.kill('SIGKILL');
      }
    }, SIGTERM_GRACE_PERIOD_MS);
  }

  /**
   * Execute CLI command with proper stdin handling, timeout, and hang detection.
   * Uses spawn instead of execFile to prevent hanging on interactive prompts.
   *
   * Key improvements over execFileAsync:
   * - Closes stdin immediately to prevent interactive prompt waits
   * - Implements hang detection (kills if no output for HANG_CHECK_INTERVAL_MS)
   * - Proper process cleanup with SIGTERM → SIGKILL escalation
   */
  protected async executeWithSpawn(
    cliConfig: CliAdapterConfig,
    args: string[],
    workingDirectory: string,
    timeoutOverrideMs?: number
  ): Promise<{ stdout: string; stderr: string }> {
    // Pre-flight validation
    await this.validatePreFlight(workingDirectory);

    return new Promise((resolve, reject) => {
      const timeoutMs = timeoutOverrideMs ?? this.getTimeoutMs();
      let stdout = '';
      let stderr = '';
      let lastOutputTime = Date.now();
      let hasOutput = false;
      let isSettled = false;

      this.logger.debug(`Executing: ${cliConfig.cliCommand} ${args.join(' ')}`);
      this.logger.debug(`Working directory: ${workingDirectory}`);
      this.logger.debug(`Timeout: ${timeoutMs}ms`);

      const child = spawn(cliConfig.cliCommand, args, {
        cwd: workingDirectory,
        env: this.getFilteredEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // CRITICAL: Close stdin immediately to prevent interactive prompts
      child.stdin.end();

      // Collect output
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
        lastOutputTime = Date.now();
        hasOutput = true;
      });

      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
        lastOutputTime = Date.now();
        hasOutput = true;
      });

      // Timer IDs for cleanup
      let timeoutId: ReturnType<typeof globalThis.setTimeout>;
      let hangCheckerId: ReturnType<typeof globalThis.setInterval>;

      // Cleanup function - must be defined before timers so handlers can call it
      const cleanup = (): void => {
        globalThis.clearTimeout(timeoutId);
        globalThis.clearInterval(hangCheckerId);
      };

      // Timeout handler
      timeoutId = globalThis.setTimeout(() => {
        if (isSettled) return;
        isSettled = true;
        cleanup(); // Prevent resource leak
        this.logger.warn(`CLI execution timeout after ${timeoutMs}ms`);
        this.killProcess(child, 'timeout');
        // Attach stdout/stderr for debugging what happened before timeout
        const timeoutError = new TimeoutError(timeoutMs, 'CLI execution');
        Object.assign(timeoutError, { stdout, stderr });
        reject(timeoutError);
      }, timeoutMs);

      // Hang detection - only kill if we HAD output and then stopped
      hangCheckerId = globalThis.setInterval(() => {
        if (isSettled) return;
        const timeSinceLastOutput = Date.now() - lastOutputTime;
        if (hasOutput && timeSinceLastOutput > HANG_CHECK_INTERVAL_MS) {
          isSettled = true;
          cleanup(); // Prevent resource leak
          this.logger.warn(
            `Process hang detected (no output for ${timeSinceLastOutput}ms)`
          );
          this.killProcess(child, 'hang');
          // Attach stdout/stderr for debugging what happened before hang
          const hangError = new TimeoutError(
            timeSinceLastOutput,
            'Process hang detected'
          );
          Object.assign(hangError, { stdout, stderr });
          reject(hangError);
        }
      }, HANG_DETECTION_POLL_INTERVAL_MS);

      child.on('close', (code, signal) => {
        cleanup();

        if (isSettled) {
          return; // Already rejected
        }
        isSettled = true;

        if (signal) {
          const error = Object.assign(
            new Error(`Process killed by signal: ${signal}`),
            { signal }
          );
          reject(error);
        } else if (code !== 0) {
          // Create error object with additional properties for categorization
          const error = Object.assign(
            new Error(`CLI execution failed with exit code ${code}`),
            { code, stderr, stdout }
          );
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      });

      child.on('error', (error) => {
        cleanup();
        if (isSettled) return;
        isSettled = true;
        reject(error);
      });
    });
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    this.ensureInitialized();

    const startTime = Date.now();
    const { agent, task, context } = request;
    const cliConfig = this.getCliConfig();

    try {
      // Build the prompt
      const prompt = this.buildPrompt(agent, task, context);

      // Warn on large prompts — each spawn with a 100KB+ prompt is expensive
      const PROMPT_SIZE_WARNING_THRESHOLD = 100_000; // ~25K tokens
      if (prompt.length > PROMPT_SIZE_WARNING_THRESHOLD) {
        this.logger.warn(
          `Large prompt: ${(prompt.length / 1024).toFixed(0)}KB (~${Math.ceil(prompt.length / 4).toLocaleString()} tokens est., actual may vary)`
        );
      }

      // Build CLI-specific arguments
      const args = this.buildCliArgs(request, prompt);

      // Execute using spawn with stdin handling and hang detection
      // This prevents hanging on interactive prompts and detects stuck processes
      const { stdout, stderr } = await this.executeWithSpawn(
        cliConfig,
        args,
        context.workingDirectory,
        request.fidelityParams?.timeoutMs
      );

      // Parse output
      const result = this.parseOutput(stdout, stderr);

      // Calculate cost using centralized pricing
      // Use actual input/output tokens when available from CLI response,
      // otherwise fall back to 50/50 estimation
      const model =
        this.config?.model || agent.preferredModel || cliConfig.defaultModel;
      const pricing = getModelPricing(
        model,
        cliConfig.pricingMap,
        cliConfig.defaultModel
      );

      // Determine input/output tokens for accurate cost calculation
      let inputTokens: number;
      let outputTokens: number;

      if (
        result.inputTokens !== undefined &&
        result.outputTokens !== undefined
      ) {
        // Best case: we have both from the CLI response
        inputTokens = result.inputTokens;
        outputTokens = result.outputTokens;
      } else if (result.inputTokens !== undefined) {
        // We have input tokens, derive output from total
        inputTokens = result.inputTokens;
        outputTokens = Math.max(0, result.tokensUsed - inputTokens);
      } else if (result.outputTokens !== undefined) {
        // We have output tokens, derive input from total
        outputTokens = result.outputTokens;
        inputTokens = Math.max(0, result.tokensUsed - outputTokens);
      } else {
        // No breakdown available, estimate 50/50 split
        inputTokens = result.tokensUsed * ESTIMATED_CLI_INPUT_TOKEN_RATIO;
        outputTokens =
          result.tokensUsed * (1 - ESTIMATED_CLI_INPUT_TOKEN_RATIO);
      }

      // Prefer CLI-reported cost when available (e.g., Claude Code's total_cost_usd)
      // This accounts for cache tokens, thinking tokens, and exact model pricing
      // Fall back to local calculation, or undefined when tokens are 0
      const cost =
        result.totalCostUsd ??
        (result.tokensUsed > 0
          ? calculateCost(inputTokens, outputTokens, pricing)
          : undefined);

      const duration = Date.now() - startTime;
      return this.createSuccessResult(result.outputs, {
        tokensUsed: result.tokensUsed,
        duration,
        cost,
        spawnCount: 1, // Single CLI spawn for base adapter
      });
    } catch (error) {
      const duration = Date.now() - startTime;

      // Handle already-categorized errors from pre-flight checks or setup
      // These may have stdout/stderr attached for debugging (e.g., TimeoutError)
      if (
        error instanceof RetryableError ||
        error instanceof NonRetryableError
      ) {
        const processError = error as ProcessError;
        this.logger.error(`Execution failed: ${error.message}`);

        // Attempt to salvage cost data from partial output (e.g., timeout after real API work).
        // NOTE: Claude Code with --output-format json writes the full JSON (including
        // total_cost_usd and token counts) only on clean exit. On SIGTERM kill, stdout
        // is typically empty — salvage will not recover cost data in that case.
        // The primary defense against wasted spend is the per-run cost cap, not timeouts.
        let metrics: { tokensUsed: number; duration: number; cost?: number } = {
          tokensUsed: 0,
          duration,
        };
        if (processError.stdout?.trim()) {
          try {
            const partial = this.parseOutput(
              processError.stdout,
              processError.stderr ?? ''
            );
            if (partial.tokensUsed > 0 || partial.totalCostUsd) {
              // Calculate cost from tokens if totalCostUsd not available
              let salvagedCost = partial.totalCostUsd;
              if (salvagedCost === undefined && partial.tokensUsed > 0) {
                const model =
                  this.config?.model ||
                  agent.preferredModel ||
                  cliConfig.defaultModel;
                const pricing = getModelPricing(
                  model,
                  cliConfig.pricingMap,
                  cliConfig.defaultModel
                );
                const inTokens =
                  partial.inputTokens ??
                  partial.tokensUsed * ESTIMATED_CLI_INPUT_TOKEN_RATIO;
                const outTokens =
                  partial.outputTokens ??
                  partial.tokensUsed * (1 - ESTIMATED_CLI_INPUT_TOKEN_RATIO);
                salvagedCost = calculateCost(inTokens, outTokens, pricing);
              }
              metrics = {
                tokensUsed: partial.tokensUsed,
                duration,
                cost: salvagedCost,
              };
              this.logger.warn(
                `Salvaged partial metrics from failed execution: ${partial.tokensUsed} tokens, $${salvagedCost?.toFixed(4) ?? '?'}`
              );
            }
          } catch {
            // Parsing failed, keep tokensUsed: 0
          }
        }

        return {
          success: false,
          outputs: {
            error: error.message,
            stdout: processError.stdout,
            stderr: processError.stderr,
          },
          metrics,
          errors: [error],
        };
      }

      // Handle process execution errors using shared ProcessError interface
      const execError = error as ProcessError;

      // Build detailed error information
      const details: string[] = [];
      if (execError.code !== undefined) {
        details.push(`Exit code: ${execError.code}`);
      }
      if (execError.signal) {
        details.push(`Signal: ${execError.signal}`);
      }
      if (execError.stderr) {
        details.push(`stderr: ${execError.stderr}`);
      }
      if (execError.stdout) {
        details.push(`stdout: ${execError.stdout}`);
      }

      const detailStr = details.length > 0 ? `\n${details.join('\n')}` : '';

      this.logger.error(
        `CLI execution failed: ${execError.message}${detailStr}`
      );

      // Categorize error for smart retry logic
      const categorizedError = this.categorizeError(execError);

      return {
        success: false,
        outputs: {
          error: execError.message,
          exitCode: execError.code,
          signal: execError.signal,
          stderr: execError.stderr,
          stdout: execError.stdout,
        },
        metrics: {
          tokensUsed: 0,
          duration,
          cost: 0,
        },
        errors: [categorizedError],
      };
    }
  }

  /**
   * Categorize CLI execution errors for smart retry logic
   * Returns appropriate error type based on error patterns
   */
  private categorizeError(error: ProcessError): Error {
    const message = (error.message || '').toLowerCase();
    const stderr = (error.stderr || '').toLowerCase();
    const stdout = (error.stdout || '').toLowerCase();
    const combined = `${message} ${stderr} ${stdout}`;

    // Check for ENOENT - CLI not found
    if (error.code === 'ENOENT') {
      const cliConfig = this.getCliConfig();
      return new BackendNotFoundError(
        cliConfig.cliCommand,
        cliConfig.installInstructions
      );
    }

    // Check for authentication issues
    if (
      combined.includes('not logged in') ||
      combined.includes('sign in') ||
      combined.includes('authentication') ||
      combined.includes('unauthorized')
    ) {
      return new ConfigurationError(
        'Backend requires authentication. Please check login status.',
        'authentication'
      );
    }

    // Check for timeout (SIGTERM from timeout or explicit timeout message)
    if (combined.includes('timeout') || error.signal === 'SIGTERM') {
      return new TimeoutError(this.getTimeoutMs(), 'CLI execution');
    }

    // Check for rate limiting
    if (
      combined.includes('rate limit') ||
      combined.includes('too many requests') ||
      combined.includes('429')
    ) {
      return new RateLimitError();
    }

    // Default to retryable for unknown errors
    return new RetryableError(error.message || 'CLI execution failed');
  }

  async isAvailable(): Promise<BackendAvailability> {
    const cliConfig = this.getCliConfig();

    try {
      await execAsync(`which ${cliConfig.cliCommand}`);

      try {
        const { stdout } = await execAsync(`${cliConfig.cliCommand} --version`);
        return {
          available: true,
          version: stdout.trim(),
        };
      } catch {
        return { available: true };
      }
    } catch {
      return {
        available: false,
        error: `${cliConfig.cliCommand} not found in PATH`,
        installInstructions: cliConfig.installInstructions,
      };
    }
  }

  /**
   * Environment variables allowed to pass through to spawned CLI processes.
   * Security: prevents credential exfiltration via `printenv` in agent shells.
   */
  private static readonly ENV_ALLOWLIST = [
    // System
    'HOME',
    'PATH',
    'TMPDIR',
    'LANG',
    'TERM',
    'SHELL',
    'USER',
    // Locale
    'LC_ALL',
    'LC_CTYPE',
    'LC_MESSAGES',
    // Node
    'NODE_ENV',
    'NODE_PATH',
    // Network (corporate proxies)
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    // Git
    'SSH_AUTH_SOCK',
    'GIT_SSH_COMMAND',
    // Linux desktop
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    // Editor
    'EDITOR',
    'VISUAL',
    // Timezone
    'TZ',
  ];

  /** CI-standard vars auto-included when CI=true is detected */
  private static readonly CI_VARS = [
    'CI',
    'GITHUB_TOKEN',
    'GITHUB_ACTIONS',
    'RUNNER_TEMP',
  ];

  /**
   * Build filtered environment for spawned CLI processes.
   * Combines allowlisted process.env vars with backend-specific vars from buildEnv().
   */
  protected getFilteredEnv(): Record<string, string | undefined> {
    const filtered: Record<string, string | undefined> = {};

    // Copy allowlisted variables from process.env
    for (const key of BaseCliAdapter.ENV_ALLOWLIST) {
      if (process.env[key] !== undefined) {
        filtered[key] = process.env[key];
      }
    }

    // Auto-include CI vars when running in CI
    if (process.env.CI) {
      for (const key of BaseCliAdapter.CI_VARS) {
        if (process.env[key] !== undefined) {
          filtered[key] = process.env[key];
        }
      }
    }

    // Support escape hatch for custom vars
    const extraVars = process.env.AIRUNX_EXTRA_ENV_VARS;
    if (extraVars) {
      for (const key of extraVars.split(',').map((k) => k.trim())) {
        if (key && process.env[key] !== undefined) {
          filtered[key] = process.env[key];
        }
      }
    }

    // Merge backend-specific vars (API keys, etc.)
    const backendEnv = this.buildEnv();
    return { ...filtered, ...backendEnv };
  }

  /**
   * Build backend-specific environment variables for CLI execution.
   * Subclasses should override to set CLI-specific environment variables
   * (e.g., ANTHROPIC_API_KEY for claude-code, CURSOR_API_KEY for cursor-agent).
   *
   * NOTE: Do NOT spread process.env here — the base class handles env filtering
   * via getFilteredEnv(). Only return backend-specific key-value pairs.
   */
  protected buildEnv(): Record<string, string | undefined> {
    return {};
  }

  /**
   * Parse CLI output into structured result
   * Subclasses can override for custom parsing logic
   *
   * Returns inputTokens/outputTokens when available from CLI JSON output
   * for accurate cost calculation. Falls back to tokensUsed with 50/50 estimation.
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
    try {
      // Handle empty stdout before attempting to parse
      if (!stdout.trim()) {
        return {
          outputs: {
            analysis: stderr.trim()
              ? `STDERR:\n${stderr}`
              : 'No output from CLI.',
            files: [],
            recommendations: [],
          },
          tokensUsed: 0,
        };
      }

      // Try parsing full stdout first; if that fails, try extracting the last
      // JSON object as a defense against output pollution (library logs, banners)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parsed: any;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        const lastBrace = stdout.lastIndexOf('{');
        if (lastBrace >= 0) {
          parsed = JSON.parse(stdout.substring(lastBrace));
        } else {
          throw new Error('No JSON object found in output');
        }
      }

      // Ensure we have a non-null object before processing
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Helper to safely extract numeric values (handles null, non-numeric strings)
        const getNumeric = (val: unknown): number | undefined =>
          typeof val === 'number' ? val : undefined;

        // Extract input/output tokens if available (for accurate cost calculation)
        // Try multiple field names that different CLIs might use
        const inputTokens =
          getNumeric(parsed.input_tokens) ??
          getNumeric(parsed.inputTokens) ??
          getNumeric(parsed.usage?.input_tokens) ??
          getNumeric(parsed.usage?.prompt_tokens);
        const outputTokens =
          getNumeric(parsed.output_tokens) ??
          getNumeric(parsed.outputTokens) ??
          getNumeric(parsed.usage?.output_tokens) ??
          getNumeric(parsed.usage?.completion_tokens);

        // Pre-computed cost from CLI (most accurate — accounts for cache, thinking, exact pricing)
        // Claude Code: total_cost_usd
        const totalCostUsd = getNumeric(parsed.total_cost_usd);

        const tokensUsed =
          getNumeric(parsed.tokens_used) ??
          getNumeric(parsed.tokensUsed) ??
          getNumeric(parsed.usage?.total_tokens) ??
          (inputTokens !== undefined && outputTokens !== undefined
            ? inputTokens + outputTokens
            : this.estimateTokens(stdout));

        return {
          outputs: {
            files: parsed.files || [],
            analysis:
              (stderr.trim() ? `STDERR:\n${stderr}\n\n` : '') +
              (parsed.analysis ||
                parsed.result ||
                parsed.output ||
                parsed.response ||
                stdout),
            recommendations: parsed.recommendations || [],
            diff: parsed.diff || '',
          },
          tokensUsed,
          inputTokens,
          outputTokens,
          totalCostUsd,
        };
      }
    } catch (parseError) {
      // CLI output may be plain text - this is expected for some backends (e.g., codex)
      // Log at debug level since fallback parsing handles this correctly
      this.logger.debug(
        `CLI output is not JSON (${parseError instanceof Error ? parseError.message : 'unknown error'}), using plain text parsing. Output preview: ${stdout.substring(0, 100)}...`
      );
    }

    // Fallback for non-JSON or non-object JSON output
    // Include stderr if present to aid debugging
    this.logger.warn(
      'Token data unavailable from CLI output, cost estimate may be inaccurate'
    );
    return {
      outputs: {
        analysis: stderr.trim()
          ? `STDERR:\n${stderr}\n\nSTDOUT:\n${stdout}`
          : stdout,
        files: [],
        recommendations: [],
      },
      tokensUsed: this.estimateTokens(stdout),
    };
  }
}
