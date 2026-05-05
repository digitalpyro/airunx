/**
 * System configuration tests
 * Only subscription-based CLI providers are supported
 */

import { describe, it, expect } from 'vitest';
import {
  generateDefaultConfig,
  validateSystemConfig,
  loadSystemConfig,
} from '../../src/utils/system-config.js';

describe('System Config', () => {
  describe('generateDefaultConfig', () => {
    it('should generate valid config with claude-code backend', () => {
      const config = generateDefaultConfig('claude-code');

      expect(config.fallback_backend).toBe('claude-code');
      expect(config.agent_routing.orchestrator).toBe('claude-code');
      expect(config.backends['claude-code']).toBeDefined();
      expect(config.backends['claude-code'].type).toBe('cli');
    });

    it('should generate valid config with cursor backend', () => {
      const config = generateDefaultConfig('cursor');

      expect(config.fallback_backend).toBe('cursor');
      expect(config.agent_routing.orchestrator).toBe('cursor');
      expect(config.backends.cursor).toBeDefined();
      expect(config.backends.cursor.type).toBe('cli');
    });

    it('should generate valid config with codex backend', () => {
      const config = generateDefaultConfig('codex');

      expect(config.fallback_backend).toBe('codex');
      expect(config.agent_routing.orchestrator).toBe('codex');
      expect(config.backends.codex).toBeDefined();
      expect(config.backends.codex.type).toBe('cli');
    });

    it('should include all CLI backend definitions', () => {
      const config = generateDefaultConfig('claude-code');

      expect(config.backends).toHaveProperty('claude-code');
      expect(config.backends).toHaveProperty('cursor');
      expect(config.backends).toHaveProperty('codex');
      expect(Object.keys(config.backends)).toHaveLength(3);
    });

    it('should include execution_fidelity configuration', () => {
      const config = generateDefaultConfig('claude-code');

      expect(config.execution_fidelity).toBeDefined();
      expect(config.execution_fidelity?.default_level).toBe('standard');
      expect(config.execution_fidelity?.levels).toBeDefined();
      expect(config.execution_fidelity?.levels.fast).toBeDefined();
      expect(config.execution_fidelity?.levels.standard).toBeDefined();
      expect(config.execution_fidelity?.levels.thorough).toBeDefined();
      expect(config.execution_fidelity?.levels.ultra).toBeDefined();
    });

    it('should include cache_ttl_minutes with default value', () => {
      const config = generateDefaultConfig('claude-code');

      expect(config.cache_ttl_minutes).toBe(5);
    });
  });

  describe('loadSystemConfig', () => {
    it('should return default config when no config files exist', () => {
      // When no config.yml exists at any location, loadSystemConfig falls back
      // to generateDefaultConfig with the default backend
      const config = loadSystemConfig();

      expect(config.fallback_backend).toBe('claude-code');
      expect(config.verify_on_start).toBe(true);

      const result = validateSystemConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should throw when explicit config path does not exist', () => {
      expect(() => loadSystemConfig('/nonexistent/path/config.yml')).toThrow(
        'Configuration file not found: /nonexistent/path/config.yml'
      );
    });
  });

  describe('validateSystemConfig', () => {
    it('should validate correct config', () => {
      const config = generateDefaultConfig('claude-code');
      const result = validateSystemConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject invalid config', () => {
      const invalidConfig = {
        agent_routing: {},
        backends: {},
        // Missing fallback_backend
      } as any;

      const result = validateSystemConfig(invalidConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject config with invalid backend type', () => {
      const config = generateDefaultConfig('claude-code');
      config.backends['claude-code'].type = 'invalid' as any;

      const result = validateSystemConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('type'))).toBe(true);
    });
  });
});
