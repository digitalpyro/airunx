/**
 * Tests for the AdapterFactory class
 * Validates lazy adapter creation and caching behavior
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AdapterFactory,
  createAdapterFactory,
  selectAdapterForRole,
  type ProviderRouterLike,
} from '../../src/adapters/adapter-factory.js';
import type {
  SystemConfig,
  ExecutionAdapter,
  BackendType,
} from '../../src/core/adapter-types.js';
import {
  ConfigurationError,
  BackendNotFoundError,
} from '../../src/utils/errors.js';

// Mock the adapter index module
vi.mock('../../src/adapters/index.js', () => ({
  createAdapter: vi.fn((backend: string) => ({
    name: backend,
    type: 'cli',
    init: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue({ success: true }),
    isAvailable: vi.fn().mockResolvedValue({ available: true }),
    cleanup: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Import the mocked createAdapter
import { createAdapter } from '../../src/adapters/index.js';
const mockCreateAdapter = vi.mocked(createAdapter);

describe('AdapterFactory Class', () => {
  const createMockSystemConfig = (): SystemConfig => ({
    agent_routing: {
      orchestrator: 'claude-code',
      'developer': 'cursor',
      'code-reviewer': 'codex',
      'test-creator': 'codex',
      'code-judge': 'claude-code',
      'docs-generator': 'claude-code',
    },
    backends: {
      'claude-code': {
        type: 'cli',
        executable: 'claude',
        timeout: 300,
        max_tokens: 4096,
        temperature: 0.7,
      },
      cursor: {
        type: 'cli',
        executable: 'cursor-agent',
        timeout: 300,
        max_tokens: 4096,
      },
      codex: {
        type: 'cli',
        executable: 'codex',
        timeout: 300,
        max_tokens: 4096,
      },
    },
    fallback_backend: 'claude-code',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the mock to create fresh adapters each time
    mockCreateAdapter.mockImplementation((backend: string) => ({
      name: backend,
      type: 'cli',
      init: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue({ success: true }),
      isAvailable: vi.fn().mockResolvedValue({ available: true }),
      cleanup: vi.fn().mockResolvedValue(undefined),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getAdapter', () => {
    it('should create and initialize adapter on first request', async () => {
      const systemConfig = createMockSystemConfig();
      const factory = new AdapterFactory(systemConfig);

      const adapter = await factory.getAdapter('claude-code');

      expect(adapter).toBeDefined();
      expect(adapter.name).toBe('claude-code');
      expect(mockCreateAdapter).toHaveBeenCalledWith('claude-code');
      expect(adapter.init).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'cli',
          executable: 'claude',
          timeout: 300,
        })
      );
    });

    it('should cache and reuse adapters', async () => {
      const systemConfig = createMockSystemConfig();
      const factory = new AdapterFactory(systemConfig);

      const adapter1 = await factory.getAdapter('claude-code');
      const adapter2 = await factory.getAdapter('claude-code');

      expect(adapter1).toBe(adapter2);
      expect(mockCreateAdapter).toHaveBeenCalledTimes(1);
    });

    it('should create separate adapters for different backends', async () => {
      const systemConfig = createMockSystemConfig();
      const factory = new AdapterFactory(systemConfig);

      const claudeAdapter = await factory.getAdapter('claude-code');
      const cursorAdapter = await factory.getAdapter('cursor');
      const codexAdapter = await factory.getAdapter('codex');

      expect(claudeAdapter.name).toBe('claude-code');
      expect(cursorAdapter.name).toBe('cursor');
      expect(codexAdapter.name).toBe('codex');
      expect(mockCreateAdapter).toHaveBeenCalledTimes(3);
    });

    it('should throw error for unconfigured backend', async () => {
      const systemConfig = createMockSystemConfig();
      // Remove cursor backend config
      // @ts-expect-error - intentionally deleting to test error handling
      delete systemConfig.backends['cursor'];
      const factory = new AdapterFactory(systemConfig);

      await expect(factory.getAdapter('cursor')).rejects.toThrow(
        /Backend configuration not found for: cursor/
      );
    });

    it('should handle concurrent requests for same adapter', async () => {
      const systemConfig = createMockSystemConfig();
      const factory = new AdapterFactory(systemConfig);

      // Request same adapter concurrently
      const [adapter1, adapter2, adapter3] = await Promise.all([
        factory.getAdapter('claude-code'),
        factory.getAdapter('claude-code'),
        factory.getAdapter('claude-code'),
      ]);

      // All should be the same instance
      expect(adapter1).toBe(adapter2);
      expect(adapter2).toBe(adapter3);
      // Should only create one adapter
      expect(mockCreateAdapter).toHaveBeenCalledTimes(1);
    });
  });

  describe('hasAdapter', () => {
    it('should return false before adapter is created', () => {
      const systemConfig = createMockSystemConfig();
      const factory = new AdapterFactory(systemConfig);

      expect(factory.hasAdapter('claude-code')).toBe(false);
    });

    it('should return true after adapter is created', async () => {
      const systemConfig = createMockSystemConfig();
      const factory = new AdapterFactory(systemConfig);

      await factory.getAdapter('claude-code');

      expect(factory.hasAdapter('claude-code')).toBe(true);
    });
  });

  describe('getCachedBackends', () => {
    it('should return empty array initially', () => {
      const systemConfig = createMockSystemConfig();
      const factory = new AdapterFactory(systemConfig);

      expect(factory.getCachedBackends()).toEqual([]);
    });

    it('should return list of cached backend types', async () => {
      const systemConfig = createMockSystemConfig();
      const factory = new AdapterFactory(systemConfig);

      await factory.getAdapter('claude-code');
      await factory.getAdapter('cursor');

      const cached = factory.getCachedBackends();
      expect(cached).toContain('claude-code');
      expect(cached).toContain('cursor');
      expect(cached).toHaveLength(2);
    });
  });

  describe('cleanup', () => {
    it('should cleanup all cached adapters', async () => {
      const systemConfig = createMockSystemConfig();
      const factory = new AdapterFactory(systemConfig);

      const claudeAdapter = await factory.getAdapter('claude-code');
      const cursorAdapter = await factory.getAdapter('cursor');

      await factory.cleanup();

      expect(claudeAdapter.cleanup).toHaveBeenCalled();
      expect(cursorAdapter.cleanup).toHaveBeenCalled();
      expect(factory.getCachedBackends()).toEqual([]);
    });

    it('should handle cleanup errors gracefully', async () => {
      const systemConfig = createMockSystemConfig();
      const factory = new AdapterFactory(systemConfig);

      // Create adapter with failing cleanup
      mockCreateAdapter.mockImplementation(() => ({
        name: 'claude-code',
        type: 'cli',
        init: vi.fn().mockResolvedValue(undefined),
        execute: vi.fn().mockResolvedValue({ success: true }),
        isAvailable: vi.fn().mockResolvedValue({ available: true }),
        cleanup: vi.fn().mockRejectedValue(new Error('Cleanup failed')),
      }));

      await factory.getAdapter('claude-code');

      // Should not throw
      await expect(factory.cleanup()).resolves.toBeUndefined();
    });
  });

  describe('createAdapterFactory', () => {
    it('should create factory from helper function', () => {
      const systemConfig = createMockSystemConfig();
      const factory = createAdapterFactory(systemConfig);

      expect(factory).toBeInstanceOf(AdapterFactory);
    });
  });
});

describe('selectAdapterForRole with provider fallback', () => {
  const createMockSystemConfig = (): SystemConfig => ({
    agent_routing: {
      orchestrator: 'claude-code',
      'developer': 'cursor',
      'code-reviewer': 'codex',
      'test-creator': 'codex',
      'code-judge': 'claude-code',
      'docs-generator': 'claude-code',
    },
    backends: {
      'claude-code': {
        type: 'cli',
        executable: 'claude',
        timeout: 300,
        max_tokens: 4096,
        temperature: 0.7,
      },
      cursor: {
        type: 'cli',
        executable: 'cursor-agent',
        timeout: 300,
        max_tokens: 4096,
      },
      codex: {
        type: 'cli',
        executable: 'codex',
        timeout: 300,
        max_tokens: 4096,
      },
    },
    fallback_backend: 'claude-code',
  });

  let mockProviderRouter: ProviderRouterLike;
  let providerAvailability: Map<BackendType, boolean>;
  let currentSelectionIndex: number;

  beforeEach(() => {
    vi.clearAllMocks();
    providerAvailability = new Map();
    currentSelectionIndex = 0;

    mockProviderRouter = {
      selectProvider: vi.fn((role) => {
        // First call returns cursor, second call (after marking unavailable) returns claude-code
        const isFirstCall = currentSelectionIndex === 0;
        currentSelectionIndex++;

        if (isFirstCall || providerAvailability.get('cursor') !== false) {
          return {
            provider: 'cursor' as BackendType,
            source: 'agents-md',
            usedFallback: false,
          };
        }
        return {
          provider: 'claude-code' as BackendType,
          source: 'fallback',
          usedFallback: true,
          originalProvider: 'cursor' as BackendType,
        };
      }),
      setProviderAvailability: vi.fn((provider, available, _reason) => {
        providerAvailability.set(provider, available);
      }),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should fallback when BackendNotFoundError is thrown', async () => {
    const systemConfig = createMockSystemConfig();
    const factory = new AdapterFactory(systemConfig);

    // Mock createAdapter to throw BackendNotFoundError for cursor, succeed for claude-code
    mockCreateAdapter.mockImplementation((backend: string) => {
      if (backend === 'cursor') {
        return {
          name: 'cursor',
          type: 'cli',
          init: vi
            .fn()
            .mockRejectedValue(
              new BackendNotFoundError(
                'cursor-agent',
                'curl https://cursor.com/install'
              )
            ),
          execute: vi.fn(),
          isAvailable: vi.fn(),
          cleanup: vi.fn(),
        };
      }
      return {
        name: backend,
        type: 'cli',
        init: vi.fn().mockResolvedValue(undefined),
        execute: vi.fn().mockResolvedValue({ success: true }),
        isAvailable: vi.fn().mockResolvedValue({ available: true }),
        cleanup: vi.fn().mockResolvedValue(undefined),
      };
    });

    const result = await selectAdapterForRole({
      role: 'developer',
      adapterFactory: factory,
      providerRouter: mockProviderRouter,
    });

    // Should have fallen back to claude-code
    expect(result.adapter.name).toBe('claude-code');
    // Provider should have been marked unavailable
    expect(mockProviderRouter.setProviderAvailability).toHaveBeenCalledWith(
      'cursor',
      false,
      expect.stringContaining('Backend CLI not found')
    );
  });

  it('should fallback when ConfigurationError is thrown', async () => {
    const systemConfig = createMockSystemConfig();
    const factory = new AdapterFactory(systemConfig);

    // Mock createAdapter to throw ConfigurationError for cursor
    mockCreateAdapter.mockImplementation((backend: string) => {
      if (backend === 'cursor') {
        return {
          name: 'cursor',
          type: 'cli',
          init: vi
            .fn()
            .mockRejectedValue(
              new ConfigurationError('Authentication required', 'cursor.auth')
            ),
          execute: vi.fn(),
          isAvailable: vi.fn(),
          cleanup: vi.fn(),
        };
      }
      return {
        name: backend,
        type: 'cli',
        init: vi.fn().mockResolvedValue(undefined),
        execute: vi.fn().mockResolvedValue({ success: true }),
        isAvailable: vi.fn().mockResolvedValue({ available: true }),
        cleanup: vi.fn().mockResolvedValue(undefined),
      };
    });

    const result = await selectAdapterForRole({
      role: 'developer',
      adapterFactory: factory,
      providerRouter: mockProviderRouter,
    });

    expect(result.adapter.name).toBe('claude-code');
    expect(mockProviderRouter.setProviderAvailability).toHaveBeenCalledWith(
      'cursor',
      false,
      expect.stringContaining('Authentication required')
    );
  });

  it('should propagate other errors without fallback', async () => {
    const systemConfig = createMockSystemConfig();
    const factory = new AdapterFactory(systemConfig);

    // Mock createAdapter to throw a generic error
    mockCreateAdapter.mockImplementation((backend: string) => {
      if (backend === 'cursor') {
        return {
          name: 'cursor',
          type: 'cli',
          init: vi
            .fn()
            .mockRejectedValue(new Error('Unexpected internal error')),
          execute: vi.fn(),
          isAvailable: vi.fn(),
          cleanup: vi.fn(),
        };
      }
      return {
        name: backend,
        type: 'cli',
        init: vi.fn().mockResolvedValue(undefined),
        execute: vi.fn().mockResolvedValue({ success: true }),
        isAvailable: vi.fn().mockResolvedValue({ available: true }),
        cleanup: vi.fn().mockResolvedValue(undefined),
      };
    });

    await expect(
      selectAdapterForRole({
        role: 'developer',
        adapterFactory: factory,
        providerRouter: mockProviderRouter,
      })
    ).rejects.toThrow('Unexpected internal error');

    // Provider should NOT have been marked unavailable for generic errors
    expect(mockProviderRouter.setProviderAvailability).not.toHaveBeenCalled();
  });

  it('should throw descriptive error when all providers unavailable', async () => {
    const systemConfig = createMockSystemConfig();
    const factory = new AdapterFactory(systemConfig);

    // Mock both providers to fail with BackendNotFoundError
    mockCreateAdapter.mockImplementation((backend: string) => ({
      name: backend,
      type: 'cli',
      init: vi
        .fn()
        .mockRejectedValue(
          new BackendNotFoundError(backend, `Install ${backend}`)
        ),
      execute: vi.fn(),
      isAvailable: vi.fn(),
      cleanup: vi.fn(),
    }));

    await expect(
      selectAdapterForRole({
        role: 'developer',
        adapterFactory: factory,
        providerRouter: mockProviderRouter,
      })
    ).rejects.toThrow(/No available providers.*configuration errors/);
  });
});
