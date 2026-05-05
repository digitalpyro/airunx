/**
 * Adapter Factory - Lazy adapter creation and caching
 *
 * Creates and caches adapters per backend type for efficient multi-provider execution.
 * Each backend type has at most one adapter instance, initialized lazily on first use.
 */

import {
  DEFAULT_FALLBACK_BACKEND,
  type BackendType,
  type ExecutionAdapter,
  type AdapterConfig,
  type SystemConfig,
} from '../core/adapter-types.js';
import type { AgentRole } from '../core/types.js';
import { createAdapter } from './index.js';
import { createLogger } from '../utils/logger.js';
import { ConfigurationError, BackendNotFoundError } from '../utils/errors.js';

const logger = createLogger('adapter-factory');

/**
 * Adapter Factory class
 *
 * Manages lazy creation and caching of execution adapters.
 * Ensures each backend type has at most one initialized adapter.
 */
export class AdapterFactory {
  private adapters: Map<BackendType, ExecutionAdapter> = new Map();
  private initializing: Map<BackendType, Promise<ExecutionAdapter>> = new Map();
  private systemConfig: SystemConfig;

  constructor(systemConfig: SystemConfig) {
    this.systemConfig = systemConfig;
  }

  /**
   * Get or create an adapter for the specified backend
   *
   * - Returns cached adapter if already initialized
   * - Waits for in-flight initialization if adapter is being created
   * - Creates and initializes new adapter if not cached
   */
  async getAdapter(backend: BackendType): Promise<ExecutionAdapter> {
    // Return cached adapter
    if (this.adapters.has(backend)) {
      logger.debug(`Using cached adapter for ${backend}`);
      return this.adapters.get(backend)!;
    }

    // Wait for in-flight initialization (prevents race conditions)
    if (this.initializing.has(backend)) {
      logger.debug(`Waiting for in-flight initialization of ${backend}`);
      return this.initializing.get(backend)!;
    }

    // Create and cache new adapter
    logger.info(`Creating new adapter for ${backend}`);
    const initPromise = this.createAndInitAdapter(backend);
    this.initializing.set(backend, initPromise);

    try {
      const adapter = await initPromise;
      this.adapters.set(backend, adapter);
      return adapter;
    } finally {
      this.initializing.delete(backend);
    }
  }

  /**
   * Create and initialize an adapter for the specified backend
   */
  private async createAndInitAdapter(
    backend: BackendType
  ): Promise<ExecutionAdapter> {
    const adapter = createAdapter(backend);

    // Get backend configuration from system config
    const backendConfig = this.systemConfig.backends[backend];
    if (!backendConfig) {
      throw new Error(`Backend configuration not found for: ${backend}`);
    }

    // Initialize adapter with configuration
    const config: AdapterConfig = {
      type: backendConfig.type as 'cli' | 'sdk',
      executable: backendConfig.executable,
      timeout: backendConfig.timeout,
      maxTokens: backendConfig.max_tokens,
      temperature: backendConfig.temperature,
      retryCount: backendConfig.retry_count,
      useCaching: backendConfig.use_caching,
      enableVerification: backendConfig.enable_verification,
    };

    await adapter.init(config);
    logger.info(`Initialized ${backend} adapter`);

    return adapter;
  }

  /**
   * Check if an adapter is already cached
   */
  hasAdapter(backend: BackendType): boolean {
    return this.adapters.has(backend);
  }

  /**
   * Get list of all cached backend types
   */
  getCachedBackends(): BackendType[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Clean up all adapters
   *
   * Should be called on process exit to release resources.
   */
  async cleanup(): Promise<void> {
    logger.info(`Cleaning up ${this.adapters.size} adapter(s)`);

    const cleanupPromises: Promise<void>[] = [];

    for (const [backend, adapter] of this.adapters) {
      logger.debug(`Cleaning up ${backend} adapter`);
      cleanupPromises.push(
        adapter.cleanup().catch((error) => {
          logger.warn(`Failed to cleanup ${backend} adapter: ${error}`);
        })
      );
    }

    await Promise.all(cleanupPromises);
    this.adapters.clear();
    this.initializing.clear();

    logger.info('All adapters cleaned up');
  }
}

/**
 * Create an AdapterFactory instance
 */
export function createAdapterFactory(
  systemConfig: SystemConfig
): AdapterFactory {
  return new AdapterFactory(systemConfig);
}

/**
 * Provider selection result from ProviderRouter
 */
export interface ProviderSelection {
  provider: BackendType;
  source: string;
  usedFallback: boolean;
  originalProvider?: BackendType;
}

/**
 * Minimal interface for provider router (avoids circular import)
 */
export interface ProviderRouterLike {
  selectProvider: (role: AgentRole) => ProviderSelection;
  setProviderAvailability: (
    provider: BackendType,
    available: boolean,
    reason?: string
  ) => void;
}

/**
 * Options for selecting an adapter for a specific role
 */
export interface AdapterSelectionOptions {
  /** Agent role to get adapter for */
  role: AgentRole;
  /** Adapter factory for multi-provider mode */
  adapterFactory?: AdapterFactory | null;
  /** Provider router for backend selection */
  providerRouter?: ProviderRouterLike | null;
  /** Single adapter for legacy mode */
  singleAdapter?: ExecutionAdapter | null;
  /** Fallback backend when no router available */
  fallbackBackend?: BackendType;
}

/**
 * Result of adapter selection
 */
export interface AdapterSelectionResult {
  adapter: ExecutionAdapter;
  selection?: ProviderSelection;
}

/**
 * Result of attempting to get an adapter
 */
interface AdapterAttemptResult {
  adapter: ExecutionAdapter | null;
  error: Error | null;
}

/**
 * Try to get an adapter for a provider, handling unavailability errors gracefully
 *
 * Returns the adapter on success, or null if the provider is unavailable.
 * For configuration errors and missing CLI errors, marks the provider as unavailable
 * in the router and allows fallback to another provider.
 * Other errors are returned for the caller to handle.
 */
async function tryGetAdapter(
  adapterFactory: AdapterFactory,
  providerRouter: ProviderRouterLike,
  provider: BackendType,
  role: AgentRole
): Promise<AdapterAttemptResult> {
  try {
    const adapter = await adapterFactory.getAdapter(provider);
    return { adapter, error: null };
  } catch (error) {
    // Handle errors that indicate the provider is unavailable but fallback should be tried
    if (
      error instanceof ConfigurationError ||
      error instanceof BackendNotFoundError
    ) {
      logger.warn(
        `Provider '${provider}' unavailable for ${role}: ${error.message}`
      );
      providerRouter.setProviderAvailability(provider, false, error.message);
      return { adapter: null, error: null };
    }
    // Other errors (runtime failures, unexpected issues) should be propagated
    return {
      adapter: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Select the appropriate adapter for an agent role
 *
 * Shared logic used by AgentInvoker and LangGraphRunner to avoid duplication.
 *
 * Priority:
 * 1. ProviderRouter + AdapterFactory (if both available)
 * 2. Single adapter (legacy mode)
 * 3. AdapterFactory with fallback backend (if factory but no router)
 *
 * @returns The selected adapter and optional selection metadata for logging
 */
export async function selectAdapterForRole(
  options: AdapterSelectionOptions
): Promise<AdapterSelectionResult> {
  const {
    role,
    adapterFactory,
    providerRouter,
    singleAdapter,
    fallbackBackend = DEFAULT_FALLBACK_BACKEND,
  } = options;

  // If we have provider routing, use it
  if (providerRouter && adapterFactory) {
    const selection = providerRouter.selectProvider(role);

    // Try primary provider
    const primaryResult = await tryGetAdapter(
      adapterFactory,
      providerRouter,
      selection.provider,
      role
    );

    if (primaryResult.adapter) {
      return { adapter: primaryResult.adapter, selection };
    }

    if (primaryResult.error) {
      throw primaryResult.error;
    }

    // Primary failed with configuration error - try fallback
    const fallbackSelection = providerRouter.selectProvider(role);
    if (fallbackSelection.provider !== selection.provider) {
      logger.info(
        `Falling back to '${fallbackSelection.provider}' for ${role}`
      );

      const fallbackResult = await tryGetAdapter(
        adapterFactory,
        providerRouter,
        fallbackSelection.provider,
        role
      );

      if (fallbackResult.adapter) {
        return {
          adapter: fallbackResult.adapter,
          selection: fallbackSelection,
        };
      }

      if (fallbackResult.error) {
        logger.error(
          `Fallback provider '${fallbackSelection.provider}' also failed to initialize.`
        );
        throw fallbackResult.error;
      }

      // Both providers had configuration errors
      throw new ConfigurationError(
        `No available providers for ${role}: both '${selection.provider}' and '${fallbackSelection.provider}' have configuration errors`
      );
    }

    // No different fallback available
    throw new ConfigurationError(
      `Provider '${selection.provider}' has a configuration error and no fallback is available for ${role}`
    );
  }

  // Fall back to single adapter (legacy mode)
  if (singleAdapter) {
    return { adapter: singleAdapter };
  }

  // If we have adapterFactory but no router, use fallback backend
  if (adapterFactory) {
    logger.debug(
      `No provider router for ${role}, using fallback backend: ${fallbackBackend}`
    );
    const adapter = await adapterFactory.getAdapter(
      fallbackBackend as BackendType
    );
    return { adapter };
  }

  throw new Error(
    'No adapter available. Provide either singleAdapter or adapterFactory.'
  );
}

/**
 * Format a provider selection log message
 *
 * Creates a consistent log message for provider selection across all callers.
 * Used by AgentInvoker and LangGraphRunner to avoid duplicated logging logic.
 *
 * @param role - The agent role being routed
 * @param selection - The provider selection result
 * @returns Formatted log message string
 */
export function formatProviderSelectionLog(
  role: string,
  selection: ProviderSelection
): string {
  const fallbackInfo = selection.usedFallback
    ? ` (fallback from ${selection.originalProvider})`
    : '';
  return `[provider-router] ${role} → ${selection.provider} [${selection.source}]${fallbackInfo}`;
}
