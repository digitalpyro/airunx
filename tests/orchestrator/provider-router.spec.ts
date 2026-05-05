/**
 * Tests for Provider Router
 * Validates provider selection logic and fallback chains
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ProviderRouter,
  createProviderRouter,
  type AgentProviderConfig,
} from '../../src/orchestrator/provider-router.js';
import type {
  SystemConfig,
  BackendType,
} from '../../src/core/adapter-types.js';
import type { AgentRole } from '../../src/core/types.js';

describe('ProviderRouter', () => {
  // Default system config for testing
  const createDefaultSystemConfig = (): SystemConfig => ({
    agent_routing: {
      orchestrator: 'claude-code',
      'developer': 'cursor',
      'code-reviewer': 'codex',
      'test-creator': 'codex',
      'code-judge': 'claude-code',
      'docs-generator': 'claude-code',
    },
    backends: {
      'claude-code': { type: 'cli', executable: 'claude', timeout: 300 },
      cursor: { type: 'cli', executable: 'cursor-agent', timeout: 300 },
      codex: { type: 'cli', executable: 'codex', timeout: 300 },
    },
    fallback_backend: 'claude-code',
  });

  describe('selectProvider', () => {
    it('should select provider from AGENTS.md when specified', () => {
      const agentsConfig: AgentProviderConfig[] = [
        {
          role: 'orchestrator',
          provider: 'codex', // Override default
        },
      ];
      const systemConfig = createDefaultSystemConfig();
      const router = new ProviderRouter(agentsConfig, systemConfig);

      const result = router.selectProvider('orchestrator');

      expect(result.provider).toBe('codex');
      expect(result.source).toBe('agents-md');
      expect(result.usedFallback).toBe(false);
    });

    it('should fallback to config.yml routing when no AGENTS.md config', () => {
      const agentsConfig: AgentProviderConfig[] = [];
      const systemConfig = createDefaultSystemConfig();
      const router = new ProviderRouter(agentsConfig, systemConfig);

      const result = router.selectProvider('code-reviewer');

      expect(result.provider).toBe('codex');
      expect(result.source).toBe('config-routing');
    });

    it('should use fallback_backend when no other config exists', () => {
      const agentsConfig: AgentProviderConfig[] = [];
      const systemConfig = createDefaultSystemConfig();
      // Remove the specific agent routing
      delete (systemConfig.agent_routing as Record<string, BackendType>)[
        'code-reviewer'
      ];
      const router = new ProviderRouter(agentsConfig, systemConfig);

      const result = router.selectProvider('code-reviewer');

      expect(result.provider).toBe('claude-code');
      expect(result.source).toBe('fallback-backend');
      expect(result.usedFallback).toBe(true);
    });

    it('should use AGENTS.md fallback-provider when primary unavailable', () => {
      const agentsConfig: AgentProviderConfig[] = [
        {
          role: 'orchestrator',
          provider: 'cursor',
          fallbackProvider: 'codex',
        },
      ];
      const systemConfig = createDefaultSystemConfig();
      const providerAvailability = new Map<BackendType, boolean>([
        ['cursor', false],
        ['codex', true],
      ]);
      const router = new ProviderRouter(
        agentsConfig,
        systemConfig,
        providerAvailability
      );

      const result = router.selectProvider('orchestrator');

      expect(result.provider).toBe('codex');
      expect(result.source).toBe('agents-md');
      expect(result.usedFallback).toBe(true);
      expect(result.originalProvider).toBe('cursor');
    });

    it('should cascade to config.yml when both AGENTS.md providers unavailable', () => {
      const agentsConfig: AgentProviderConfig[] = [
        {
          role: 'orchestrator',
          provider: 'cursor',
          fallbackProvider: 'codex',
        },
      ];
      const systemConfig = createDefaultSystemConfig();
      const providerAvailability = new Map<BackendType, boolean>([
        ['cursor', false],
        ['codex', false],
        ['claude-code', true],
      ]);
      const router = new ProviderRouter(
        agentsConfig,
        systemConfig,
        providerAvailability
      );

      const result = router.selectProvider('orchestrator');

      expect(result.provider).toBe('claude-code');
      expect(result.source).toBe('config-routing');
      expect(result.usedFallback).toBe(true);
      expect(result.originalProvider).toBe('cursor');
    });

    it('should throw error when all providers are unavailable including fallback_backend', () => {
      const agentsConfig: AgentProviderConfig[] = [
        {
          role: 'orchestrator',
          provider: 'cursor',
          fallbackProvider: 'codex',
        },
      ];
      const systemConfig = createDefaultSystemConfig();
      const providerAvailability = new Map<BackendType, boolean>([
        ['cursor', false],
        ['codex', false],
        ['claude-code', false], // fallback_backend also unavailable
      ]);
      const router = new ProviderRouter(
        agentsConfig,
        systemConfig,
        providerAvailability
      );

      expect(() => router.selectProvider('orchestrator')).toThrow(
        /All providers for role 'orchestrator' are unavailable/
      );
    });

    it('should throw error when only fallback_backend exists but is unavailable', () => {
      const agentsConfig: AgentProviderConfig[] = [];
      const systemConfig = createDefaultSystemConfig();
      // Remove the specific agent routing
      delete (systemConfig.agent_routing as Record<string, BackendType>)[
        'code-reviewer'
      ];
      const providerAvailability = new Map<BackendType, boolean>([
        ['claude-code', false], // fallback_backend unavailable
      ]);
      const router = new ProviderRouter(
        agentsConfig,
        systemConfig,
        providerAvailability
      );

      expect(() => router.selectProvider('code-reviewer')).toThrow(
        /All providers for role 'code-reviewer' are unavailable/
      );
    });
  });

  describe('setProviderAvailability', () => {
    it('should update provider availability', () => {
      const agentsConfig: AgentProviderConfig[] = [];
      const systemConfig = createDefaultSystemConfig();
      const router = new ProviderRouter(agentsConfig, systemConfig);

      // Initially available (default)
      expect(router.isProviderAvailable('cursor')).toBe(true);

      // Mark as unavailable
      router.setProviderAvailability('cursor', false, 'API key missing');
      expect(router.isProviderAvailable('cursor')).toBe(false);

      // Mark as available again
      router.setProviderAvailability('cursor', true);
      expect(router.isProviderAvailable('cursor')).toBe(true);
    });
  });

  describe('selectProvidersForPipeline', () => {
    it('should select providers for multiple roles', () => {
      const agentsConfig: AgentProviderConfig[] = [
        { role: 'orchestrator', provider: 'claude-code' },
        { role: 'developer', provider: 'cursor' },
        { role: 'code-reviewer', provider: 'codex' },
      ];
      const systemConfig = createDefaultSystemConfig();
      const router = new ProviderRouter(agentsConfig, systemConfig);

      const roles: AgentRole[] = [
        'orchestrator',
        'developer',
        'code-reviewer',
      ];
      const selections = router.selectProvidersForPipeline(roles);

      expect(selections.get('orchestrator')?.provider).toBe('claude-code');
      expect(selections.get('developer')?.provider).toBe('cursor');
      expect(selections.get('code-reviewer')?.provider).toBe('codex');
    });
  });

  describe('hasProviderDiversity', () => {
    it('should detect diverse providers between dev and review', () => {
      const agentsConfig: AgentProviderConfig[] = [
        { role: 'developer', provider: 'cursor' },
        { role: 'code-reviewer', provider: 'codex' },
      ];
      const systemConfig = createDefaultSystemConfig();
      const router = new ProviderRouter(agentsConfig, systemConfig);

      const devRoles: AgentRole[] = ['developer'];
      const reviewRoles: AgentRole[] = ['code-reviewer'];

      const result = router.hasProviderDiversity(devRoles, reviewRoles);

      expect(result.hasDiversity).toBe(true);
      expect(result.devProviders.has('cursor')).toBe(true);
      expect(result.reviewProviders.has('codex')).toBe(true);
    });

    it('should detect no diversity when same provider used', () => {
      const agentsConfig: AgentProviderConfig[] = [
        { role: 'developer', provider: 'claude-code' },
        { role: 'code-reviewer', provider: 'claude-code' },
      ];
      const systemConfig = createDefaultSystemConfig();
      const router = new ProviderRouter(agentsConfig, systemConfig);

      const devRoles: AgentRole[] = ['developer'];
      const reviewRoles: AgentRole[] = ['code-reviewer'];

      const result = router.hasProviderDiversity(devRoles, reviewRoles);

      expect(result.hasDiversity).toBe(false);
    });
  });

  describe('getProviderSummary', () => {
    it('should generate human-readable summary', () => {
      const agentsConfig: AgentProviderConfig[] = [
        { role: 'orchestrator', provider: 'claude-code' },
        { role: 'developer', provider: 'cursor' },
      ];
      const systemConfig = createDefaultSystemConfig();
      const router = new ProviderRouter(agentsConfig, systemConfig);

      const roles: AgentRole[] = ['orchestrator', 'developer'];
      const summary = router.getProviderSummary(roles);

      expect(summary).toContain('Provider Assignments:');
      expect(summary).toContain('orchestrator: claude-code [agents-md]');
      expect(summary).toContain('developer: cursor [agents-md]');
    });

    it('should indicate fallback in summary', () => {
      const agentsConfig: AgentProviderConfig[] = [
        {
          role: 'orchestrator',
          provider: 'cursor',
          fallbackProvider: 'codex',
        },
      ];
      const systemConfig = createDefaultSystemConfig();
      const providerAvailability = new Map<BackendType, boolean>([
        ['cursor', false],
        ['codex', true],
      ]);
      const router = new ProviderRouter(
        agentsConfig,
        systemConfig,
        providerAvailability
      );

      const summary = router.getProviderSummary(['orchestrator']);

      expect(summary).toContain('fallback from cursor');
    });
  });

  describe('createProviderRouter', () => {
    it('should create router from factory function', () => {
      const agentsConfig: AgentProviderConfig[] = [
        { role: 'orchestrator', provider: 'claude-code' },
      ];
      const systemConfig = createDefaultSystemConfig();

      const router = createProviderRouter(agentsConfig, systemConfig);

      expect(router).toBeInstanceOf(ProviderRouter);
      expect(router.selectProvider('orchestrator').provider).toBe(
        'claude-code'
      );
    });
  });

  describe('Real-world scenarios', () => {
    it('should prevent self-deception in dev-review workflow', () => {
      // Configure different providers for dev and review roles
      const agentsConfig: AgentProviderConfig[] = [
        {
          role: 'developer',
          provider: 'cursor',
          providerRationale: 'Superior code understanding',
        },
        {
          role: 'developer',
          provider: 'cursor',
          providerRationale: 'IDE integration',
        },
        {
          role: 'code-reviewer',
          provider: 'codex',
          providerRationale: 'Independent perspective prevents self-deception',
        },
      ];
      const systemConfig = createDefaultSystemConfig();
      const router = new ProviderRouter(agentsConfig, systemConfig);

      const devRoles: AgentRole[] = ['developer'];
      const reviewRoles: AgentRole[] = ['code-reviewer'];

      const diversity = router.hasProviderDiversity(devRoles, reviewRoles);

      // Verify we have provider diversity between dev and review
      expect(diversity.hasDiversity).toBe(true);
      expect([...diversity.devProviders]).toEqual(['cursor']);
      expect([...diversity.reviewProviders]).toEqual(['codex']);
    });

    it('should gracefully handle provider outage', () => {
      const agentsConfig: AgentProviderConfig[] = [
        {
          role: 'orchestrator',
          provider: 'cursor',
          fallbackProvider: 'codex',
        },
        {
          role: 'code-reviewer',
          provider: 'codex',
          fallbackProvider: 'claude-code',
        },
      ];
      const systemConfig = createDefaultSystemConfig();
      const router = new ProviderRouter(agentsConfig, systemConfig);

      // Simulate cursor outage
      router.setProviderAvailability('cursor', false, 'Service unavailable');

      const orchestratorResult = router.selectProvider('orchestrator');
      const reviewerResult = router.selectProvider('code-reviewer');

      // Orchestrator should use fallback
      expect(orchestratorResult.provider).toBe('codex');
      expect(orchestratorResult.usedFallback).toBe(true);

      // Reviewer unaffected
      expect(reviewerResult.provider).toBe('codex');
      expect(reviewerResult.usedFallback).toBe(false);
    });
  });
});
