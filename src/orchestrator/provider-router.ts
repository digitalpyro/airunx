/**
 * Provider Router - Intelligent per-role provider selection
 *
 * Implements the provider routing priority:
 * 1. AGENTS.md provider field (highest priority)
 * 2. config.yml agent_routing
 * 3. config.yml fallback_backend (lowest priority)
 *
 * Supports fallback chains when primary provider is unavailable.
 */

import type { BackendType, SystemConfig } from '../core/adapter-types.js';
import type { AgentRole } from '../core/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('provider-router');

/**
 * Agent configuration with optional provider preferences from AGENTS.md
 */
export interface AgentProviderConfig {
  role: AgentRole;
  provider?: BackendType;
  providerRationale?: string;
  fallbackProvider?: BackendType;
}

/**
 * Provider availability check result
 */
export interface ProviderAvailability {
  available: boolean;
  reason?: string;
}

/**
 * Result of provider selection
 */
export interface ProviderSelectionResult {
  provider: BackendType;
  source: 'agents-md' | 'config-routing' | 'fallback-backend';
  usedFallback: boolean;
  originalProvider?: BackendType;
}

/**
 * Provider Router class
 *
 * Handles intelligent provider selection for agent roles based on:
 * - AGENTS.md per-role provider specifications
 * - System config agent_routing
 * - Fallback backend configuration
 */
export class ProviderRouter {
  private agentsConfig: Map<AgentRole, AgentProviderConfig>;
  private systemConfig: SystemConfig;
  private providerAvailability: Map<BackendType, boolean>;

  constructor(
    agentsConfig: AgentProviderConfig[],
    systemConfig: SystemConfig,
    providerAvailability?: Map<BackendType, boolean>
  ) {
    // Convert array to map for O(1) lookup
    this.agentsConfig = new Map(
      agentsConfig.map((config) => [config.role, config])
    );
    this.systemConfig = systemConfig;
    // Default all providers to available if not specified
    this.providerAvailability = providerAvailability || new Map();

    // Debug: Log AGENTS.md provider configs loaded into router
    const configsWithProvider = agentsConfig.filter((c) => c.provider);
    if (configsWithProvider.length > 0) {
      logger.debug(
        `[AGENTS.md] ProviderRouter initialized with ${configsWithProvider.length} agent provider configs:`
      );
      for (const config of configsWithProvider) {
        logger.debug(
          `  - ${config.role}: provider=${config.provider}${config.fallbackProvider ? `, fallback=${config.fallbackProvider}` : ''}`
        );
      }
    } else {
      logger.debug(
        `[AGENTS.md] ProviderRouter initialized with no agent-specific providers (using config.yml routing)`
      );
    }
  }

  /**
   * Update provider availability status
   */
  setProviderAvailability(
    provider: BackendType,
    available: boolean,
    reason?: string
  ): void {
    this.providerAvailability.set(provider, available);
    if (!available) {
      logger.warn(`Provider '${provider}' marked as unavailable: ${reason}`);
    }
  }

  /**
   * Check if a provider is available
   */
  isProviderAvailable(provider: BackendType): boolean {
    // If not in the map, assume available (optimistic default)
    return this.providerAvailability.get(provider) ?? true;
  }

  /**
   * Select the best provider for an agent role
   *
   * Priority order:
   * 1. AGENTS.md provider field (if available)
   * 2. AGENTS.md fallback-provider (if primary unavailable)
   * 3. config.yml agent_routing
   * 4. config.yml fallback_backend
   */
  selectProvider(role: AgentRole): ProviderSelectionResult {
    logger.debug(`Selecting provider for role: ${role}`);

    // 1. Check AGENTS.md specification for this role
    const agentConfig = this.agentsConfig.get(role);
    if (agentConfig?.provider) {
      logger.debug(
        `Found AGENTS.md provider for ${role}: ${agentConfig.provider}`
      );

      // Try primary provider
      if (this.isProviderAvailable(agentConfig.provider)) {
        logger.info(
          `Using AGENTS.md provider for ${role}: ${agentConfig.provider}`
        );
        return {
          provider: agentConfig.provider,
          source: 'agents-md',
          usedFallback: false,
        };
      }

      // Primary unavailable, try fallback from AGENTS.md
      if (
        agentConfig.fallbackProvider &&
        this.isProviderAvailable(agentConfig.fallbackProvider)
      ) {
        const writeCapableRoles: AgentRole[] = [
          'orchestrator',
          'developer',
          'test-creator',
        ];
        if (writeCapableRoles.includes(role)) {
          logger.warn(
            `Write-capable agent '${role}' falling back from ${agentConfig.provider} to ${agentConfig.fallbackProvider}. ` +
              `Git write restrictions may differ between backends.`
          );
        } else {
          logger.info(
            `Primary provider '${agentConfig.provider}' unavailable for ${role}, ` +
              `using AGENTS.md fallback: ${agentConfig.fallbackProvider}`
          );
        }
        return {
          provider: agentConfig.fallbackProvider,
          source: 'agents-md',
          usedFallback: true,
          originalProvider: agentConfig.provider,
        };
      }

      // Both AGENTS.md providers unavailable, log and continue
      logger.warn(
        `Both AGENTS.md providers unavailable for ${role}: ` +
          `primary=${agentConfig.provider}, fallback=${agentConfig.fallbackProvider}`
      );
    }

    // 2. Check config.yml agent_routing
    const routedProvider = this.systemConfig.agent_routing[role];
    if (routedProvider && this.isProviderAvailable(routedProvider)) {
      logger.info(`Using config.yml routing for ${role}: ${routedProvider}`);
      return {
        provider: routedProvider,
        source: 'config-routing',
        usedFallback: agentConfig?.provider !== undefined,
        originalProvider: agentConfig?.provider,
      };
    }

    // 3. Use fallback_backend
    const fallback = this.systemConfig.fallback_backend;

    // Check if fallback is available before returning it
    if (!this.isProviderAvailable(fallback)) {
      const attempted = [
        agentConfig?.provider,
        agentConfig?.fallbackProvider,
        routedProvider,
        fallback,
      ].filter((p): p is BackendType => !!p);
      const uniqueAttempted = [...new Set(attempted)].map((p) => `'${p}'`);
      throw new Error(
        `All providers for role '${role}' are unavailable. ` +
          `Attempted: ${uniqueAttempted.join(', ')} ` +
          `(sources: AGENTS.md, config.yml agent_routing, config.yml fallback_backend)`
      );
    }

    logger.info(`Using fallback backend for ${role}: ${fallback}`);
    return {
      provider: fallback,
      source: 'fallback-backend',
      usedFallback: true,
      originalProvider: agentConfig?.provider || routedProvider,
    };
  }

  /**
   * Get provider selection for multiple roles
   */
  selectProvidersForPipeline(
    roles: AgentRole[]
  ): Map<AgentRole, ProviderSelectionResult> {
    const selections = new Map<AgentRole, ProviderSelectionResult>();
    for (const role of roles) {
      selections.set(role, this.selectProvider(role));
    }
    return selections;
  }

  /**
   * Get a summary of provider assignments for logging/debugging
   */
  getProviderSummary(roles: AgentRole[]): string {
    const selections = this.selectProvidersForPipeline(roles);
    const lines: string[] = ['Provider Assignments:'];

    for (const [role, selection] of selections) {
      const fallbackNote = selection.usedFallback
        ? ` (fallback from ${selection.originalProvider})`
        : '';
      lines.push(
        `  ${role}: ${selection.provider} [${selection.source}]${fallbackNote}`
      );
    }

    return lines.join('\n');
  }

  /**
   * Check if different providers will be used for development vs review
   * (helps detect potential self-deception scenarios)
   *
   * NOTE: This checks for "at least one unique" provider in review roles,
   * NOT complete separation. Partial overlap is intentional - the same
   * provider MAY handle both dev and review roles in a pipeline.
   *
   * This design allows flexibility for users who deliberately want the
   * same provider for certain handoffs. Users requiring strict separation
   * should configure their providers accordingly.
   *
   * @param devRoles - Roles involved in development (e.g., developer)
   * @param reviewRoles - Roles involved in review (e.g., reviewer, judge)
   * @returns Object with hasDiversity boolean and the provider sets
   *
   * @example
   * // Returns hasDiversity: true - codex is unique to review
   * // devProviders: {'cursor'}, reviewProviders: {'cursor', 'codex'}
   *
   * @example
   * // Returns hasDiversity: false - no unique review providers
   * // devProviders: {'cursor'}, reviewProviders: {'cursor'}
   */
  hasProviderDiversity(
    devRoles: AgentRole[],
    reviewRoles: AgentRole[]
  ): {
    hasDiversity: boolean;
    devProviders: Set<BackendType>;
    reviewProviders: Set<BackendType>;
  } {
    const devProviders = new Set(
      devRoles.map((role) => this.selectProvider(role).provider)
    );
    const reviewProviders = new Set(
      reviewRoles.map((role) => this.selectProvider(role).provider)
    );

    // Check if there's at least one provider in review that's not in dev
    const uniqueReviewProviders = [...reviewProviders].filter(
      (p) => !devProviders.has(p)
    );

    return {
      hasDiversity: uniqueReviewProviders.length > 0,
      devProviders,
      reviewProviders,
    };
  }
}

/**
 * Create a ProviderRouter from parsed AGENTS.md configs and system config
 */
export function createProviderRouter(
  agentsConfig: AgentProviderConfig[],
  systemConfig: SystemConfig,
  providerAvailability?: Map<BackendType, boolean>
): ProviderRouter {
  return new ProviderRouter(agentsConfig, systemConfig, providerAvailability);
}
