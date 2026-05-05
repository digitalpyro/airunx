/**
 * Backend validator - checks availability of execution backends
 */

import type {
  BackendType,
  BackendAvailability,
  SystemConfig,
} from '../core/adapter-types.js';
import { getAvailableAdapterTypes, createAdapter } from './index.js';

export interface ValidationResult {
  [key: string]: BackendAvailability;
}

export class BackendValidator {
  /**
   * Validate all configured backends
   * @param config Optional system config to limit which backends to check
   * @param deep If true, performs full initialization check including auth validation
   */
  async validateBackends(
    config?: SystemConfig,
    deep = false
  ): Promise<ValidationResult> {
    const backends: BackendType[] = config
      ? (Object.keys(config.backends) as BackendType[])
      : getAvailableAdapterTypes();

    const results: ValidationResult = {};

    // Run checks in parallel
    await Promise.all(
      backends.map(async (backend) => {
        results[backend] = deep
          ? await this.checkBackendDeep(backend)
          : await this.checkBackend(backend);
      })
    );

    return results;
  }

  /**
   * Check a specific backend by delegating to its adapter's isAvailable method
   * This follows the Open/Closed Principle - new backends only need to implement
   * the ExecutionAdapter interface without modifying this validator
   */
  async checkBackend(backend: BackendType): Promise<BackendAvailability> {
    try {
      const adapter = createAdapter(backend);
      return await adapter.isAvailable();
    } catch (error) {
      return {
        available: false,
        error: `Failed to check backend ${backend}: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Deep check of a backend - verifies CLI exists AND authentication is valid
   * This calls adapter.init() which runs backend-specific validation hooks
   * (e.g., cursor-agent checks for login status)
   */
  async checkBackendDeep(backend: BackendType): Promise<BackendAvailability> {
    try {
      const adapter = createAdapter(backend);

      // First check basic availability
      const basicCheck = await adapter.isAvailable();
      if (!basicCheck.available) {
        return basicCheck;
      }

      // Then try full initialization (includes auth checks)
      try {
        // Use minimal config with the adapter's type since we're just validating
        await adapter.init({ type: adapter.type });
        return {
          available: true,
          version: basicCheck.version,
        };
      } catch (initError) {
        // Backend exists but init failed (e.g., auth required)
        return {
          available: false,
          version: basicCheck.version,
          error: (initError as Error).message,
        };
      }
    } catch (error) {
      return {
        available: false,
        error: `Failed to check backend ${backend}: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Get a list of available backends
   */
  async getAvailableBackends(): Promise<BackendType[]> {
    const results = await this.validateBackends();
    return Object.entries(results)
      .filter(([, status]) => status.available)
      .map(([backend]) => backend as BackendType);
  }

  /**
   * Check if at least one backend is available
   */
  async hasAnyBackend(): Promise<boolean> {
    const available = await this.getAvailableBackends();
    return available.length > 0;
  }
}
