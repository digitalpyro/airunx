/**
 * Base CLI Adapter
 * Abstract base class for CLI-based adapters (Claude Code, Cursor, etc.)
 * Provides common CLI execution logic to reduce duplication
 */

import { exec, execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { stat } from 'fs/promises';
import {
  BaseAdapter,
  dominantPromptSection,
  formatPromptSections,
} from './base-adapter.js';
import type {
  ExecutionRequest,
  ExecutionResult,
  BackendAvailability,
  AdapterConfig,
  SpawnAuthMode,
  SpawnExitReason,
  SpawnRecord,
} from '../core/adapter-types.js';
import {
  PRICING_VERSION,
  bucketsFromUsage,
  calculateCacheAwareCost,
  getCacheRates,
  getModelPricing,
} from './pricing.js';
import type { CacheRates, ModelPricing } from './pricing.js';
import type { CostProvenance, NormalizedTokenUsage } from '../core/types.js';
import { GENAI_SEMCONV_VERSION } from '../core/types.js';
import {
  billingBasisForAuth,
  spawnCostSummary,
} from '../core/cost-accounting.js';
import {
  DEFAULT_CLI_TIMEOUT,
  HANG_CHECK_INTERVAL_MS,
  HANG_DETECTION_POLL_INTERVAL_MS,
  SIGTERM_GRACE_PERIOD_MS,
  APPROVAL_MODE_FLAGS,
} from './constants.js';
import {
  KILL_TIME_ESTIMATION_METHOD,
  runSpendTracker,
} from './spend-estimator.js';
import { loadSettings } from '../utils/settings.js';
import { createLogger } from '../utils/logger.js';
import { ulid } from '../utils/ulid.js';
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

/** TimeoutError operation label used for hang detection kills */
const HANG_OPERATION = 'Process hang detected';

/**
 * Per-spawn facts gathered during execution and reported to the SpawnObserver
 */
interface SpawnOutcome {
  exitReason: SpawnExitReason;
  salvaged: boolean;
  errorCategory?: string;
  providerSessionId?: string;
  /** CLI-reported token counts (undefined when not reported) */
  inputTokens?: number;
  outputTokens?: number;
  /** Provenance-tagged cost facts (undefined when nothing was parsed) */
  cost?: SpawnCostAccounting;
  /** Kill-time estimate for a spawn that ended without cost JSON */
  spendLostUsd?: number;
  /** Partial cost recovered from a failed spawn's output */
  spendSalvagedUsd?: number;
}

/**
 * Spawn timing attached to executeWithSpawn rejections, so the kill-time
 * estimate measures active time (start → last output), not kill time
 */
interface SpawnTiming {
  spawnStartedAt?: number;
  /** Epoch ms of the last stdout/stderr chunk; undefined = no output */
  lastOutputAt?: number;
}

/**
 * Minimum active time before a non-zero exit without cost JSON is estimated
 * (shorter exits are treated as rejections — auth, bad model — before work)
 */
const MIN_ERROR_EXIT_ESTIMATE_ACTIVE_MS = 5_000;

/** Exit reasons that mean the CLI was cut off before it could report cost */
const KILLED_EXIT_REASONS: ReadonlySet<SpawnExitReason> = new Set([
  'timeout',
  'hang',
  'signal',
]);

/**
 * Provenance-tagged cost facts for one spawn
 */
interface SpawnCostAccounting {
  /** Headline cost; undefined = missing */
  costUsd?: number;
  costProvenance?: CostProvenance;
  /** Token×pricing figure, also kept when a reported cost exists */
  derivedCostUsd?: number;
  pricingVersion?: string;
  tokens?: NormalizedTokenUsage;
  tokenProvenance?: 'reported' | 'estimated';
  estimationMethods: string[];
  unmodeledModifiers: string[];
  providerUsage?: Record<string, number>;
  costBasis?: Record<string, string>;
}

/**
 * Parsed CLI output shape returned by parseOutput()
 */
export interface ParsedCliOutput {
  outputs: ExecutionResult['outputs'];
  tokensUsed: number;
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  /** Provider session/thread ID when the CLI reports one */
  sessionId?: string;
  /** Normalized (inclusive) token usage, when the provider reports it */
  usage?: NormalizedTokenUsage;
  /** Normalized usage per model (priced per model when present) */
  usageByModel?: Record<string, NormalizedTokenUsage>;
  /** Allowlisted numeric copy of the provider's raw usage fields */
  providerUsage?: Record<string, number>;
  /** True when tokensUsed came from the chars÷4 estimate */
  tokensEstimated?: boolean;
  /** Claude Code modelUsage[*].costBasis, keyed by model */
  costBasis?: Record<string, string>;
  /** Known pricing modifiers the table does not model */
  unmodeledModifiers?: string[];
}

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
  /** Per-model prompt-cache rates (missing → input rate, one-time warning) */
  cachePricingMap?: Record<string, CacheRates>;
  /** Default model if not specified */
  defaultModel: string;
}

/**
 * Shared interface for process execution errors
 * Used by executeWithSpawn rejections and categorizeError
 * Includes stdout as some tools output error info to stdout
 */
export interface ProcessError extends Error, SpawnTiming {
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
      // Kill-time estimation measures active time to the last real output
      const spawnStartedAt = Date.now();
      let lastOutputAt: number | undefined;
      const timing = (): SpawnTiming => ({ spawnStartedAt, lastOutputAt });

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
        lastOutputAt = lastOutputTime;
        hasOutput = true;
      });

      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
        lastOutputTime = Date.now();
        lastOutputAt = lastOutputTime;
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
        Object.assign(timeoutError, { stdout, stderr, ...timing() });
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
            HANG_OPERATION
          );
          Object.assign(hangError, { stdout, stderr, ...timing() });
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
            { signal, stdout, stderr, ...timing() }
          );
          reject(error);
        } else if (code !== 0) {
          // Create error object with additional properties for categorization
          const error = Object.assign(
            new Error(`CLI execution failed with exit code ${code}`),
            { code, stderr, stdout, ...timing() }
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

  /**
   * Execute one CLI spawn and report it to the SpawnObserver (if any).
   * Every call emits exactly one SpawnRecord — success, failure or salvage —
   * and the returned result carries the record's spawnId.
   */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    this.ensureInitialized();

    const spawnId = ulid();
    const startTime = Date.now();
    const outcome: SpawnOutcome = { exitReason: 'error', salvaged: false };
    const result = await this.runSpawn(request, outcome, startTime);
    result.spawnId = spawnId;
    this.notifySpawnObserver(request, result, outcome, spawnId, startTime);
    return result;
  }

  /**
   * Model to attribute a spawn to. Subclasses override when the CLI may pick
   * its own model (return undefined).
   */
  protected getSpawnModel(request: ExecutionRequest): string | undefined {
    return (
      this.config?.model ||
      request.agent.preferredModel ||
      this.getCliConfig().defaultModel
    );
  }

  /**
   * Authentication mode used by spawned CLIs, when known
   */
  protected getAuthMode(): SpawnAuthMode | undefined {
    return undefined;
  }

  /**
   * Build the SpawnRecord and hand it to the observer. Never throws.
   */
  private notifySpawnObserver(
    request: ExecutionRequest,
    result: ExecutionResult,
    outcome: SpawnOutcome,
    spawnId: string,
    startTime: number
  ): void {
    const observer = this.spawnObserver;
    if (!observer) return;

    try {
      const endTime = Date.now();
      const ctx = request.spawnContext;
      const record: SpawnRecord = {
        spawnId,
        parentSpawnId: ctx?.parentSpawnId,
        workflowId: ctx?.workflowId,
        stage: ctx?.stage,
        iteration: ctx?.iteration,
        backend: this.name,
        model: this.getSpawnModel(request),
        authMode: this.getAuthMode(),
        agentRole: request.agent.role,
        promptBytes: result.metrics.promptBytes,
        promptSections: result.metrics.promptSections,
        tokensUsed: result.metrics.tokensUsed,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        costUsd: result.metrics.cost,
        startedAt: new Date(startTime).toISOString(),
        endedAt: new Date(endTime).toISOString(),
        durationMs: endTime - startTime,
        exitReason: outcome.exitReason,
        success: result.success,
        salvaged: outcome.salvaged,
        errorCategory: outcome.errorCategory,
        providerSessionId: outcome.providerSessionId,
        costProvenance: outcome.cost?.costProvenance,
        billingBasis: billingBasisForAuth(this.getAuthMode()),
        derivedCostUsd: outcome.cost?.derivedCostUsd,
        pricingVersion: outcome.cost?.pricingVersion,
        unmodeledModifiers: outcome.cost?.unmodeledModifiers ?? [],
        tokens: outcome.cost?.tokens,
        tokenProvenance: outcome.cost?.tokenProvenance,
        estimationMethods: outcome.cost?.estimationMethods ?? [],
        providerUsage: outcome.cost?.providerUsage,
        costBasis: outcome.cost?.costBasis,
        semconvVersion: GENAI_SEMCONV_VERSION,
        spendLostUsd: outcome.spendLostUsd,
        spendSalvagedUsd: outcome.spendSalvagedUsd,
      };
      observer.onSpawnComplete(record, request);
    } catch (error) {
      this.logger.warn(
        `Spawn observer failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Classify why a failed spawn ended
   */
  private classifyExit(error: unknown): SpawnExitReason {
    if (error instanceof TimeoutError) {
      return error.operation === HANG_OPERATION ? 'hang' : 'timeout';
    }
    if ((error as ProcessError | undefined)?.signal) {
      return 'signal';
    }
    return 'error';
  }

  private async runSpawn(
    request: ExecutionRequest,
    outcome: SpawnOutcome,
    startTime: number
  ): Promise<ExecutionResult> {
    const { agent, task, context } = request;
    const cliConfig = this.getCliConfig();
    // Prompt size metrics, attached to every result (success or failure)
    let promptMetrics: Pick<
      ExecutionResult['metrics'],
      'promptBytes' | 'promptSections'
    > = {};

    try {
      // Build the prompt and record its per-section byte breakdown
      const { prompt, sections } = this.buildPromptWithSections(
        agent,
        task,
        context
      );
      promptMetrics = { promptBytes: sections.total, promptSections: sections };
      this.logger.debug(
        `Prompt sections (bytes): ${formatPromptSections(sections)}`
      );

      // Warn on large prompts — each spawn with a 100KB+ prompt is expensive
      const PROMPT_SIZE_WARNING_THRESHOLD = 100_000; // ~25K tokens
      if (sections.total > PROMPT_SIZE_WARNING_THRESHOLD) {
        const dominant = dominantPromptSection(sections);
        this.logger.warn(
          `Large prompt: ${(sections.total / 1024).toFixed(0)}KB (~${Math.ceil(sections.total / 4).toLocaleString()} tokens est., actual may vary); largest section: ${dominant} ${(sections[dominant] / 1024).toFixed(0)}KB`
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
      outcome.exitReason = 'ok';
      outcome.providerSessionId = result.sessionId;
      outcome.inputTokens = result.inputTokens;
      outcome.outputTokens = result.outputTokens;

      // Provenance-tagged cost: CLI-reported cost wins; otherwise token
      // counts × versioned pricing (derived), or the 50/50 / chars÷4
      // fallback (estimated). Undefined when nothing was spent or parsed.
      const accounting = this.accountSpawnCost(result, request);
      outcome.cost = accounting;

      const duration = Date.now() - startTime;
      this.observeSpend(accounting, duration);
      return this.createSuccessResult(result.outputs, {
        tokensUsed: result.tokensUsed,
        duration,
        cost: accounting.costUsd,
        spawnCount: 1, // Single CLI spawn for base adapter
        costSummary: this.toCostSummary(accounting),
        ...promptMetrics,
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      outcome.exitReason = this.classifyExit(error);
      outcome.errorCategory =
        error instanceof Error ? error.constructor.name : 'unknown';

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
        outcome.cost = { estimationMethods: [], unmodeledModifiers: [] };
        let metrics: ExecutionResult['metrics'] = {
          tokensUsed: 0,
          duration,
          costSummary: this.toCostSummary(outcome.cost),
          ...promptMetrics,
        };
        if (processError.stdout?.trim()) {
          try {
            const partial = this.parseOutput(
              processError.stdout,
              processError.stderr ?? ''
            );
            outcome.providerSessionId = partial.sessionId;
            outcome.inputTokens = partial.inputTokens;
            outcome.outputTokens = partial.outputTokens;
            if (partial.tokensUsed > 0 || partial.totalCostUsd) {
              outcome.salvaged = true;
              const accounting = this.accountSpawnCost(partial, request);
              outcome.cost = accounting;
              const salvagedCost = accounting.costUsd;
              metrics = {
                tokensUsed: partial.tokensUsed,
                duration,
                cost: salvagedCost,
                costSummary: this.toCostSummary(accounting),
                ...promptMetrics,
              };
              this.logger.warn(
                `Salvaged partial metrics from failed execution: ${partial.tokensUsed} tokens, $${salvagedCost?.toFixed(4) ?? '?'}`
              );
            }
          } catch {
            // Parsing failed, keep tokensUsed: 0
          }
        }

        const lost = this.applyKillTimeAccounting(
          request,
          processError,
          outcome,
          startTime,
          promptMetrics.promptBytes
        );
        if (lost) {
          metrics = {
            ...metrics,
            cost: lost.costUsd,
            costSummary: this.toCostSummary(lost),
          };
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
      outcome.errorCategory = categorizedError.constructor.name;
      // No output was parsed: the cost is unknown (the legacy float stays 0)
      // unless the CLI was cut off mid-work, which gets a bounded estimate
      outcome.cost = { estimationMethods: [], unmodeledModifiers: [] };
      const lost = this.applyKillTimeAccounting(
        request,
        execError,
        outcome,
        startTime,
        promptMetrics.promptBytes
      );

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
          cost: lost?.costUsd ?? 0,
          costSummary: this.toCostSummary(outcome.cost),
          ...promptMetrics,
        },
        errors: [categorizedError],
      };
    }
  }

  /**
   * Feed a completed spawn's trusted (reported/derived) cost into the run's
   * burn-rate tracker
   */
  private observeSpend(
    accounting: SpawnCostAccounting,
    activeMs: number
  ): void {
    if (
      accounting.costUsd === undefined ||
      (accounting.costProvenance !== 'reported' &&
        accounting.costProvenance !== 'derived')
    ) {
      return;
    }
    runSpendTracker.record({
      backend: this.name,
      costUsd: accounting.costUsd,
      activeMs,
    });
  }

  /**
   * Failed-spawn spend accounting. A salvaged cost is recorded as
   * `spend_salvaged`. A spawn cut off (timeout/hang/signal, or a non-zero
   * exit after ≥5s of real output) with no cost gets a bounded kill-time estimate,
   * recorded as `spend_lost` and returned (outcome.cost is replaced).
   * Pre-spawn failures (no process ran, no output) stay unknown.
   */
  private applyKillTimeAccounting(
    request: ExecutionRequest,
    error: ProcessError,
    outcome: SpawnOutcome,
    startTime: number,
    promptBytes: number | undefined
  ): SpawnCostAccounting | undefined {
    const spawnStart = error.spawnStartedAt ?? startTime;
    const activeMs =
      error.lastOutputAt !== undefined
        ? Math.max(0, error.lastOutputAt - spawnStart)
        : 0;

    if (outcome.cost?.costUsd !== undefined) {
      outcome.spendSalvagedUsd = outcome.cost.costUsd;
      this.observeSpend(outcome.cost, activeMs);
      return undefined;
    }

    const cutOff = KILLED_EXIT_REASONS.has(outcome.exitReason);
    // A non-zero exit is estimated only when the CLI clearly did work:
    // it spawned, wrote stdout, and stayed active past a quick rejection
    const exitedAfterWork =
      outcome.exitReason === 'error' &&
      error.spawnStartedAt !== undefined &&
      !!error.stdout?.trim() &&
      activeMs >= MIN_ERROR_EXIT_ESTIMATE_ACTIVE_MS;
    if (!cutOff && !exitedAfterWork) return undefined;

    try {
      const cliConfig = this.getCliConfig();
      const model = this.getSpawnModel(request) ?? cliConfig.defaultModel;
      const pricing = getModelPricing(
        model,
        cliConfig.pricingMap,
        cliConfig.defaultModel
      );
      const estimate = runSpendTracker.estimateKillTimeSpend({
        backend: this.name,
        activeMs,
        promptBytes: promptBytes ?? 0,
        inputPricePer1M: pricing.input,
      });
      if (!(estimate.costUsd > 0)) return undefined;

      const accounting: SpawnCostAccounting = {
        ...outcome.cost,
        costUsd: estimate.costUsd,
        costProvenance: 'estimated',
        pricingVersion: PRICING_VERSION,
        estimationMethods: [
          ...new Set([
            ...(outcome.cost?.estimationMethods ?? []),
            KILL_TIME_ESTIMATION_METHOD,
          ]),
        ],
        unmodeledModifiers: outcome.cost?.unmodeledModifiers ?? [],
      };
      outcome.cost = accounting;
      outcome.spendLostUsd = estimate.costUsd;
      this.logger.warn(
        `Spawn ended (${outcome.exitReason}) without cost data; estimated lost spend $${estimate.costUsd.toFixed(4)} ` +
          `(active ${(activeMs / 1000).toFixed(1)}s, rate source ${estimate.rateSource}, bound ${estimate.bound})`
      );
      return accounting;
    } catch (estimateError) {
      this.logger.warn(
        `Kill-time estimate failed: ${estimateError instanceof Error ? estimateError.message : String(estimateError)}`
      );
      return undefined;
    }
  }

  /**
   * Assign provenance to a parsed spawn's cost and tokens.
   * - CLI-reported cost → `reported` (the token-derived figure is kept too)
   * - real token counts × pricing → `derived` (stamped with PRICING_VERSION)
   * - 50/50 split or chars÷4 tokens → `estimated`
   * Cost is computed over disjoint buckets only (uncached input, cache read,
   * each cache-write tier, output), so cache tokens are never double-priced.
   */
  protected accountSpawnCost(
    parsed: ParsedCliOutput,
    request: ExecutionRequest
  ): SpawnCostAccounting {
    const cliConfig = this.getCliConfig();
    const estimationMethods: string[] = [];
    let tokenProvenance: 'reported' | 'estimated' = 'reported';
    let tokens = parsed.usage;

    if (!tokens) {
      const total = parsed.tokensUsed;
      const zeroCache = { cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
      if (
        parsed.inputTokens !== undefined &&
        parsed.outputTokens !== undefined
      ) {
        tokens = {
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          ...zeroCache,
        };
      } else if (parsed.inputTokens !== undefined) {
        tokens = {
          inputTokens: parsed.inputTokens,
          outputTokens: Math.max(0, total - parsed.inputTokens),
          ...zeroCache,
        };
      } else if (parsed.outputTokens !== undefined) {
        tokens = {
          inputTokens: Math.max(0, total - parsed.outputTokens),
          outputTokens: parsed.outputTokens,
          ...zeroCache,
        };
      } else if (total > 0) {
        // No breakdown available, estimate 50/50 split
        tokens = {
          inputTokens: total * ESTIMATED_CLI_INPUT_TOKEN_RATIO,
          outputTokens: total * (1 - ESTIMATED_CLI_INPUT_TOKEN_RATIO),
          ...zeroCache,
        };
        estimationMethods.push('split_50_50');
        tokenProvenance = 'estimated';
      }
    }
    if (parsed.tokensEstimated) {
      estimationMethods.unshift('chars_div_4');
      tokenProvenance = 'estimated';
    }

    // Token-derived figure (per model when the CLI breaks usage down)
    let derivedCostUsd: number | undefined;
    const priceUsage = (model: string, usage: NormalizedTokenUsage): number =>
      calculateCacheAwareCost(
        bucketsFromUsage(usage),
        getModelPricing(model, cliConfig.pricingMap, cliConfig.defaultModel),
        getCacheRates(model, cliConfig.cachePricingMap, cliConfig.defaultModel),
        model
      );
    if (tokens && tokens.inputTokens + tokens.outputTokens > 0) {
      const byModel = parsed.usageByModel;
      derivedCostUsd =
        byModel && Object.keys(byModel).length > 0
          ? Object.entries(byModel).reduce(
              (sum, [model, usage]) => sum + priceUsage(model, usage),
              0
            )
          : priceUsage(
              this.config?.model ||
                request.agent.preferredModel ||
                cliConfig.defaultModel,
              tokens
            );
    }

    let costUsd: number | undefined;
    let costProvenance: CostProvenance | undefined;
    if (parsed.totalCostUsd !== undefined) {
      costUsd = parsed.totalCostUsd;
      costProvenance = 'reported';
    } else if (derivedCostUsd !== undefined) {
      costUsd = derivedCostUsd;
      costProvenance =
        tokenProvenance === 'estimated' ? 'estimated' : 'derived';
    }

    if (tokenProvenance === 'estimated') {
      this.logger.warn(
        `Spawn tokens estimated (${estimationMethods.join(', ')}); cost is approximate`
      );
    }

    return {
      costUsd,
      costProvenance,
      derivedCostUsd,
      pricingVersion:
        derivedCostUsd !== undefined ? PRICING_VERSION : undefined,
      tokens,
      tokenProvenance: tokens ? tokenProvenance : undefined,
      estimationMethods,
      unmodeledModifiers: parsed.unmodeledModifiers ?? [],
      providerUsage: parsed.providerUsage,
      costBasis: parsed.costBasis,
    };
  }

  /**
   * One-spawn CostSummary for ExecutionResult metrics
   */
  private toCostSummary(
    accounting: SpawnCostAccounting
  ): ExecutionResult['metrics']['costSummary'] {
    return spawnCostSummary({
      costUsd: accounting.costUsd,
      costProvenance: accounting.costProvenance,
      billingBasis: billingBasisForAuth(this.getAuthMode()),
      tokens: accounting.tokens,
      tokenProvenance: accounting.tokenProvenance,
      pricingVersion:
        accounting.costProvenance === 'reported'
          ? undefined
          : accounting.pricingVersion,
      estimationMethods: accounting.estimationMethods,
      unmodeledModifiers: accounting.unmodeledModifiers,
    });
  }

  /**
   * Generic usage normalization for JSON CLI output (OpenAI-style inclusive
   * input; cached tokens from `cached_input_tokens` or
   * `prompt_tokens_details.cached_tokens`). Subclasses override for
   * provider-specific shapes.
   */
  protected extractUsage(
    parsed: Record<string, unknown>,
    inputTokens: number | undefined,
    outputTokens: number | undefined
  ): Partial<ParsedCliOutput> {
    if (inputTokens === undefined || outputTokens === undefined) return {};
    const usage = (parsed.usage ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    const details = (usage.prompt_tokens_details ?? {}) as Record<
      string,
      unknown
    >;
    const cacheRead =
      num(usage.cached_input_tokens) ?? num(details.cached_tokens) ?? 0;
    return {
      usage: {
        inputTokens,
        outputTokens,
        cacheReadInputTokens: Math.min(cacheRead, inputTokens),
        cacheWriteInputTokens: 0,
      },
    };
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
  protected parseOutput(stdout: string, stderr: string): ParsedCliOutput {
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

        // Provider session ID (Claude Code: session_id)
        const rawSessionId = parsed.session_id ?? parsed.sessionId;
        const sessionId =
          typeof rawSessionId === 'string' ? rawSessionId : undefined;

        const reportedTotal =
          getNumeric(parsed.tokens_used) ??
          getNumeric(parsed.tokensUsed) ??
          getNumeric(parsed.usage?.total_tokens) ??
          (inputTokens !== undefined && outputTokens !== undefined
            ? inputTokens + outputTokens
            : undefined);
        const tokensEstimated = reportedTotal === undefined;
        const tokensUsed = reportedTotal ?? this.estimateTokens(stdout);
        const usageFields = this.extractUsage(
          parsed,
          inputTokens,
          outputTokens
        );

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
          sessionId,
          ...(tokensEstimated ? { tokensEstimated } : {}),
          ...usageFields,
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
      tokensEstimated: true,
    };
  }
}
