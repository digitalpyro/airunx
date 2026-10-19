/**
 * Tests for Agent Invoker
 * Validates agent execution with fidelity parameters and retry logic
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentInvoker } from '../../src/orchestrator/agent-invoker.js';
import type {
  AttemptRecord,
  ExecutionAdapter,
  ExecutionRequest,
  ExecutionResult,
  SpawnObserver,
} from '../../src/core/adapter-types.js';
import type { CostSummary, FidelityParameters } from '../../src/core/types.js';
import type { AdapterFactory } from '../../src/adapters/adapter-factory.js';
import type { ProviderRouter } from '../../src/orchestrator/provider-router.js';
import { spawnCostSummary } from '../../src/core/cost-accounting.js';
import { ConfigurationError, TimeoutError } from '../../src/utils/errors.js';
import {
  ShutdownInProgressError,
  shutdownCoordinator,
} from '../../src/utils/shutdown-coordinator.js';

// Mock settings to prevent AGENTS.md loading during tests (use defaults)
vi.mock('../../src/utils/settings.js', () => ({
  loadSettings: vi.fn(() => ({
    _source: 'default',
    _sourceFile: '/test/settings.json',
    resolvedPaths: {
      // No agents_md path - forces use of defaults
    },
  })),
}));

describe('Agent Invoker', () => {
  let mockAdapter: ExecutionAdapter;
  let fidelityParams: FidelityParameters;

  beforeEach(() => {
    // Create mock adapter
    mockAdapter = {
      execute: vi.fn(),
      name: 'mock-adapter',
      capabilities: ['coding', 'analysis'],
    };

    // Default fidelity parameters
    fidelityParams = {
      temperature: 0.2,
      maxTokens: 4096,
      retryCount: 2,
      useCaching: true,
      enableVerification: true,
      reviewIterations: 2,
    };
  });

  describe('Successful Execution', () => {
    it('should execute agent successfully on first attempt', async () => {
      const successResult: ExecutionResult = {
        success: true,
        outputs: { analysis: 'Test output' },
        metrics: { tokensUsed: 100, duration: 1000, cost: 0.01 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(successResult);

      const invoker = new AgentInvoker(mockAdapter, fidelityParams);
      const result = await invoker.execute({
        role: 'developer',
        task: 'Implement feature',
        projectContext: {
          workingDirectory: '/test/dir',
        },
      });

      expect(result.success).toBe(true);
      expect(result.outputs).toEqual({ analysis: 'Test output' });
      expect(mockAdapter.execute).toHaveBeenCalledTimes(1);
    });

    it('should apply fidelity parameters to execution request', async () => {
      const successResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(successResult);

      const invoker = new AgentInvoker(mockAdapter, fidelityParams);
      await invoker.execute({
        role: 'developer',
        task: 'Test task',
        projectContext: {
          workingDirectory: '/test',
        },
      });

      const call = vi.mocked(mockAdapter.execute).mock.calls[0][0];
      expect(call.fidelityParams).toEqual({
        temperature: 0.2,
        maxTokens: 4096,
        retryCount: 2,
        useCaching: true,
        enableVerification: true,
      });
    });

    it('should pass project context to adapter', async () => {
      const successResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 0, duration: 0 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(successResult);

      const invoker = new AgentInvoker(mockAdapter, fidelityParams);
      await invoker.execute({
        role: 'developer',
        task: 'Test task',
        projectContext: {
          workingDirectory: '/test/dir',
          gitBranch: 'feature-branch',
        },
      });

      const call = vi.mocked(mockAdapter.execute).mock.calls[0][0];
      expect(call.context).toEqual({
        workingDirectory: '/test/dir',
        gitBranch: 'feature-branch',
      });
    });

    it('should pass previous outputs to adapter', async () => {
      const successResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 0, duration: 0 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(successResult);

      const previousOutputs = {
        stage1: { result: 'data' },
        stage2: { result: 'more data' },
      };

      const invoker = new AgentInvoker(mockAdapter, fidelityParams);
      await invoker.execute({
        role: 'developer',
        task: 'Test task',
        projectContext: { workingDirectory: '/test' },
        previousOutputs,
      });

      const call = vi.mocked(mockAdapter.execute).mock.calls[0][0];
      expect(call.previousOutputs).toEqual(previousOutputs);
    });

    it('should use custom system prompt when provided', async () => {
      const successResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 0, duration: 0 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(successResult);

      const customPrompt = 'Custom system prompt for testing';

      const invoker = new AgentInvoker(mockAdapter, fidelityParams);
      await invoker.execute({
        role: 'developer',
        task: 'Test task',
        projectContext: { workingDirectory: '/test' },
        systemPrompt: customPrompt,
      });

      const call = vi.mocked(mockAdapter.execute).mock.calls[0][0];
      expect(call.agent.systemPrompt).toBe(customPrompt);
    });

    it('should use default system prompt for known agent roles', async () => {
      const successResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 0, duration: 0 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(successResult);

      const invoker = new AgentInvoker(mockAdapter, fidelityParams);
      await invoker.execute({
        role: 'code-judge',
        task: 'Evaluate quality',
        projectContext: { workingDirectory: '/test' },
      });

      const call = vi.mocked(mockAdapter.execute).mock.calls[0][0];
      expect(call.agent.role).toBe('code-judge');
      expect(call.agent.capabilities).toContain('quality-assessment');
      expect(call.agent.systemPrompt).toContain('judge agent');
    });
  });

  describe('Retry Logic', () => {
    it('should retry on failure and succeed on second attempt', async () => {
      const failureResult: ExecutionResult = {
        success: false,
        outputs: {},
        metrics: { tokensUsed: 0, duration: 0 },
        errors: [new Error('First attempt failed')],
      };

      const successResult: ExecutionResult = {
        success: true,
        outputs: { analysis: 'Success on retry' },
        metrics: { tokensUsed: 100, duration: 1000 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute)
        .mockResolvedValueOnce(failureResult)
        .mockResolvedValueOnce(successResult);

      const invoker = new AgentInvoker(mockAdapter, fidelityParams);
      const result = await invoker.execute({
        role: 'developer',
        task: 'Test task',
        projectContext: { workingDirectory: '/test' },
      });

      expect(result.success).toBe(true);
      expect(mockAdapter.execute).toHaveBeenCalledTimes(2);
    });

    it('should respect retry count from fidelity parameters', async () => {
      const failureResult: ExecutionResult = {
        success: false,
        outputs: {},
        metrics: { tokensUsed: 0, duration: 0 },
        errors: [new Error('Failed')],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(failureResult);

      const customFidelity = {
        ...fidelityParams,
        retryCount: 3,
      };

      const invoker = new AgentInvoker(mockAdapter, customFidelity);
      await invoker.execute({
        role: 'developer',
        task: 'Test task',
        projectContext: { workingDirectory: '/test' },
      });

      expect(mockAdapter.execute).toHaveBeenCalledTimes(3);
    });

    it('should retry all attempts when execution fails', async () => {
      const failureResult: ExecutionResult = {
        success: false,
        outputs: {},
        metrics: { tokensUsed: 0, duration: 0 },
        errors: [new Error('Failed')],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(failureResult);

      const invoker = new AgentInvoker(mockAdapter, {
        ...fidelityParams,
        retryCount: 3,
      });

      await invoker.execute({
        role: 'developer',
        task: 'Test task',
        projectContext: { workingDirectory: '/test' },
      });

      // Verify all retries happened (3 attempts total)
      expect(mockAdapter.execute).toHaveBeenCalledTimes(3);
    });

    it('should handle adapter throwing exceptions', async () => {
      vi.mocked(mockAdapter.execute).mockRejectedValue(
        new Error('Adapter error')
      );

      const invoker = new AgentInvoker(mockAdapter, fidelityParams);
      const result = await invoker.execute({
        role: 'developer',
        task: 'Test task',
        projectContext: { workingDirectory: '/test' },
      });

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors?.[0].message).toBe('Adapter error');
      expect(mockAdapter.execute).toHaveBeenCalledTimes(2);
    });

    it('should return last result after exhausting retries', async () => {
      const failureResult: ExecutionResult = {
        success: false,
        outputs: { partial: 'data' },
        metrics: { tokensUsed: 50, duration: 500 },
        errors: [new Error('Persistent failure')],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(failureResult);

      const invoker = new AgentInvoker(mockAdapter, fidelityParams);
      const result = await invoker.execute({
        role: 'developer',
        task: 'Test task',
        projectContext: { workingDirectory: '/test' },
      });

      expect(result.success).toBe(false);
      expect(result.outputs).toEqual({ partial: 'data' });
      expect(result.errors?.[0].message).toBe('Persistent failure');
    });

    it('should create failure result when no result available', async () => {
      vi.mocked(mockAdapter.execute).mockRejectedValue(
        new Error('Complete failure')
      );

      const invoker = new AgentInvoker(mockAdapter, {
        ...fidelityParams,
        retryCount: 1,
      });

      const result = await invoker.execute({
        role: 'developer',
        task: 'Test task',
        projectContext: { workingDirectory: '/test' },
      });

      expect(result.success).toBe(false);
      expect(result.outputs.analysis).toContain('failed after 1 attempts');
      expect(result.errors?.[0].message).toBe('Complete failure');
    });
  });

  describe('Agent Definitions', () => {
    it('should load definition for orchestrator role', async () => {
      const successResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 0, duration: 0 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(successResult);

      const invoker = new AgentInvoker(mockAdapter, fidelityParams);
      await invoker.execute({
        role: 'orchestrator',
        task: 'Plan work',
        projectContext: { workingDirectory: '/test' },
      });

      const call = vi.mocked(mockAdapter.execute).mock.calls[0][0];
      expect(call.agent.role).toBe('orchestrator');
      expect(call.agent.capabilities).toContain('planning');
      expect(call.agent.capabilities).toContain('coordination');
    });

    it('should load definition for developer role', async () => {
      const successResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 0, duration: 0 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(successResult);

      const invoker = new AgentInvoker(mockAdapter, fidelityParams);
      await invoker.execute({
        role: 'developer',
        task: 'Design architecture',
        projectContext: { workingDirectory: '/test' },
      });

      const call = vi.mocked(mockAdapter.execute).mock.calls[0][0];
      expect(call.agent.role).toBe('developer');
      expect(call.agent.capabilities).toContain('architecture');
      expect(call.agent.capabilities).toContain('design');
    });

    it('should load definition for code-reviewer role', async () => {
      const successResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 0, duration: 0 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(successResult);

      const invoker = new AgentInvoker(mockAdapter, fidelityParams);
      await invoker.execute({
        role: 'code-reviewer',
        task: 'Review code',
        projectContext: { workingDirectory: '/test' },
      });

      const call = vi.mocked(mockAdapter.execute).mock.calls[0][0];
      expect(call.agent.role).toBe('code-reviewer');
      expect(call.agent.capabilities).toContain('code-review');
      expect(call.agent.capabilities).toContain('quality-checks');
    });
  });

  describe('Fidelity Parameters', () => {
    it('should apply different temperature settings', async () => {
      const successResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 0, duration: 0 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(successResult);

      const invoker = new AgentInvoker(mockAdapter, {
        ...fidelityParams,
        temperature: 0.0,
      });

      await invoker.execute({
        role: 'developer',
        task: 'Test',
        projectContext: { workingDirectory: '/test' },
      });

      const call = vi.mocked(mockAdapter.execute).mock.calls[0][0];
      expect(call.fidelityParams?.temperature).toBe(0.0);
    });

    it('should apply different max tokens settings', async () => {
      const successResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 0, duration: 0 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(successResult);

      const invoker = new AgentInvoker(mockAdapter, {
        ...fidelityParams,
        maxTokens: 16384,
      });

      await invoker.execute({
        role: 'developer',
        task: 'Test',
        projectContext: { workingDirectory: '/test' },
      });

      const call = vi.mocked(mockAdapter.execute).mock.calls[0][0];
      expect(call.fidelityParams?.maxTokens).toBe(16384);
    });

    it('should pass caching and verification settings', async () => {
      const successResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 0, duration: 0 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(successResult);

      const invoker = new AgentInvoker(mockAdapter, {
        ...fidelityParams,
        useCaching: false,
        enableVerification: false,
      });

      await invoker.execute({
        role: 'developer',
        task: 'Test',
        projectContext: { workingDirectory: '/test' },
      });

      const call = vi.mocked(mockAdapter.execute).mock.calls[0][0];
      expect(call.fidelityParams?.useCaching).toBe(false);
      expect(call.fidelityParams?.enableVerification).toBe(false);
    });
  });

  describe('Dynamic Agent Loading from AGENTS.md', () => {
    it('should store agent definitions via setLoadedAgents', () => {
      const invoker = new AgentInvoker(mockAdapter, fidelityParams);

      const loadedAgents = new Map([
        [
          'orchestrator' as const,
          {
            role: 'orchestrator' as const,
            purpose: 'Coordinate work across agents',
            responsibilities: ['planning', 'task distribution'],
            tools: ['TaskQueue', 'AgentSelector'],
            output: 'execution plan',
          },
        ],
      ]);

      invoker.setLoadedAgents(loadedAgents);

      // The loadedAgents should be stored (verified via execute behavior)
      expect(loadedAgents.size).toBe(1);
    });

    it('should use system prompt from AGENTS.md when available', async () => {
      const successResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 0, duration: 0 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(successResult);

      const loadedAgents = new Map([
        [
          'orchestrator' as const,
          {
            role: 'orchestrator' as const,
            purpose:
              'Coordinate and plan work across multiple specialized agents.',
            responsibilities: [
              'task planning',
              'agent coordination',
              'progress tracking',
            ],
            tools: ['TaskManager', 'AgentRouter'],
            output: 'execution plan with assigned tasks',
          },
        ],
      ]);

      const invoker = new AgentInvoker(mockAdapter, fidelityParams);
      invoker.setLoadedAgents(loadedAgents);

      await invoker.execute({
        role: 'orchestrator',
        task: 'Plan work',
        projectContext: { workingDirectory: '/test' },
      });

      const call = vi.mocked(mockAdapter.execute).mock.calls[0][0];
      // Should include purpose from AGENTS.md
      expect(call.agent.systemPrompt).toContain('orchestrator agent');
      expect(call.agent.systemPrompt).toContain('Coordinate and plan work');
      // Should include responsibilities
      expect(call.agent.systemPrompt).toContain('task planning');
      // Should include tools
      expect(call.agent.systemPrompt).toContain('TaskManager');
      // Should include output
      expect(call.agent.systemPrompt).toContain('execution plan');
      // Capabilities should be derived from tools
      expect(call.agent.capabilities).toContain('TaskManager');
      expect(call.agent.capabilities).toContain('AgentRouter');
      // contextRequired should be derived from responsibilities
      expect(call.agent.contextRequired).toContain('task planning');
      expect(call.agent.contextRequired).toContain('agent coordination');
    });

    it('should prefer custom systemPrompt over AGENTS.md definition', async () => {
      const successResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 0, duration: 0 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(successResult);

      const loadedAgents = new Map([
        [
          'orchestrator' as const,
          {
            role: 'orchestrator' as const,
            purpose: 'Purpose from AGENTS.md',
            responsibilities: ['responsibility from markdown'],
            tools: [],
            output: 'output from markdown',
          },
        ],
      ]);

      const customPrompt = 'Custom system prompt takes precedence';

      const invoker = new AgentInvoker(mockAdapter, fidelityParams);
      invoker.setLoadedAgents(loadedAgents);

      await invoker.execute({
        role: 'orchestrator',
        task: 'Plan work',
        projectContext: { workingDirectory: '/test' },
        systemPrompt: customPrompt,
      });

      const call = vi.mocked(mockAdapter.execute).mock.calls[0][0];
      expect(call.agent.systemPrompt).toBe(customPrompt);
      expect(call.agent.systemPrompt).not.toContain('Purpose from AGENTS.md');
    });

    it('should fall back to default prompt when role not in AGENTS.md', async () => {
      const successResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 0, duration: 0 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(successResult);

      // Load agents but don't include developer
      const loadedAgents = new Map([
        [
          'orchestrator' as const,
          {
            role: 'orchestrator' as const,
            purpose: 'Only orchestrator is loaded',
            responsibilities: [],
            tools: [],
            output: '',
          },
        ],
      ]);

      const invoker = new AgentInvoker(mockAdapter, fidelityParams);
      invoker.setLoadedAgents(loadedAgents);

      await invoker.execute({
        role: 'developer',
        task: 'Design architecture',
        projectContext: { workingDirectory: '/test' },
      });

      const call = vi.mocked(mockAdapter.execute).mock.calls[0][0];
      // Should use default prompt since developer wasn't loaded
      expect(call.agent.systemPrompt).toContain(
        'developer agent responsible for both strategic design and implementation'
      );
      expect(call.agent.systemPrompt).not.toContain(
        'Only orchestrator is loaded'
      );
    });

    it('should accept loadedAgents in constructor', async () => {
      const successResult: ExecutionResult = {
        success: true,
        outputs: {},
        metrics: { tokensUsed: 0, duration: 0 },
        errors: [],
      };

      vi.mocked(mockAdapter.execute).mockResolvedValue(successResult);

      const loadedAgents = new Map([
        [
          'developer' as const,
          {
            role: 'developer' as const,
            purpose: 'Write production-quality code',
            responsibilities: ['coding', 'debugging', 'refactoring'],
            tools: ['CodeEditor', 'Debugger'],
            output: 'working code',
          },
        ],
      ]);

      // Pass loadedAgents to constructor
      const invoker = new AgentInvoker(
        mockAdapter,
        fidelityParams,
        loadedAgents
      );

      await invoker.execute({
        role: 'developer',
        task: 'Implement feature',
        projectContext: { workingDirectory: '/test' },
      });

      const call = vi.mocked(mockAdapter.execute).mock.calls[0][0];
      expect(call.agent.systemPrompt).toContain('developer agent');
      expect(call.agent.systemPrompt).toContain(
        'Write production-quality code'
      );
    });
  });
});

describe('Agent Invoker attempt events (U4)', () => {
  const fidelity: FidelityParameters = {
    temperature: 0.2,
    maxTokens: 4096,
    retryCount: 3,
    useCaching: true,
    enableVerification: true,
    reviewIterations: 2,
  };

  const spawnContext = {
    workflowId: 'wf-attempts',
    stage: 'developer',
    iteration: 1,
  };

  const summary = (micro: number): CostSummary =>
    spawnCostSummary({
      costUsd: micro / 1_000_000,
      costProvenance: 'reported',
      billingBasis: 'billed',
    });

  const failed = (cost: number, spawnId: string): ExecutionResult => ({
    success: false,
    outputs: {},
    metrics: {
      tokensUsed: 10,
      duration: 5,
      cost,
      costSummary: summary(cost * 1_000_000),
    },
    errors: [new TimeoutError(1000, 'cli')],
    spawnId,
  });

  const succeeded = (cost: number, spawnId: string): ExecutionResult => ({
    success: true,
    outputs: { analysis: 'ok' },
    metrics: {
      tokensUsed: 100,
      duration: 50,
      cost,
      spawnCount: 1,
      costSummary: summary(cost * 1_000_000),
    },
    errors: [],
    spawnId,
  });

  const observedAdapter = (
    name: string,
    attempts: AttemptRecord[]
  ): ExecutionAdapter => {
    const observer: SpawnObserver = {
      onSpawnComplete: vi.fn(),
      onAttempt: (record) => attempts.push(record),
    };
    return {
      execute: vi.fn(),
      name,
      getSpawnObserver: () => observer,
    } as unknown as ExecutionAdapter;
  };

  it('emits one attempt event per attempt and keeps failed-attempt spend', async () => {
    const attempts: AttemptRecord[] = [];
    const adapter = observedAdapter('claude-code', attempts);
    vi.mocked(adapter.execute)
      .mockResolvedValueOnce(failed(0.1, 's1'))
      .mockResolvedValueOnce(failed(0.2, 's2'))
      .mockResolvedValueOnce(succeeded(0.3, 's3'));

    const invoker = new AgentInvoker(adapter, fidelity);
    const result = await invoker.execute({
      role: 'developer',
      task: 'Implement',
      projectContext: { workingDirectory: '/test' },
      spawnContext,
    });

    expect(result.success).toBe(true);
    expect(attempts.map((a) => [a.attempt, a.outcome, a.spawnId])).toEqual([
      [1, 'failure', 's1'],
      [2, 'failure', 's2'],
      [3, 'success', 's3'],
    ]);
    expect(attempts[0]).toMatchObject({
      backend: 'claude-code',
      errorCategory: 'TimeoutError',
      fallback: false,
      costUsd: 0.1,
      workflowId: 'wf-attempts',
      stage: 'developer',
      iteration: 1,
      maxAttempts: 3,
    });
    // Run total includes both failed attempts' salvaged cost
    expect(result.metrics.cost).toBeCloseTo(0.6);
    expect(result.metrics.tokensUsed).toBe(120);
    expect(result.metrics.spawnCount).toBe(3);
    expect(result.metrics.costSummary?.billedMicroUsd).toBe(600_000);
    expect(result.metrics.costSummary?.spawnCount).toBe(3);
  });

  it('emits no attempt event for a clean first-attempt success', async () => {
    const attempts: AttemptRecord[] = [];
    const adapter = observedAdapter('claude-code', attempts);
    vi.mocked(adapter.execute).mockResolvedValueOnce(succeeded(0.3, 's1'));

    const invoker = new AgentInvoker(adapter, fidelity);
    const result = await invoker.execute({
      role: 'developer',
      task: 'Implement',
      projectContext: { workingDirectory: '/test' },
    });

    expect(attempts).toEqual([]);
    expect(result.metrics.cost).toBe(0.3);
  });

  it('folds earlier failures into the last result when all attempts fail', async () => {
    const attempts: AttemptRecord[] = [];
    const adapter = observedAdapter('claude-code', attempts);
    vi.mocked(adapter.execute)
      .mockResolvedValueOnce(failed(0.1, 's1'))
      .mockResolvedValueOnce(failed(0.2, 's2'))
      .mockResolvedValueOnce(failed(0.3, 's3'));

    const invoker = new AgentInvoker(adapter, fidelity);
    const result = await invoker.execute({
      role: 'developer',
      task: 'Implement',
      projectContext: { workingDirectory: '/test' },
    });

    expect(result.success).toBe(false);
    expect(attempts).toHaveLength(3);
    expect(result.metrics.cost).toBeCloseTo(0.6);
    expect(result.metrics.costSummary?.billedMicroUsd).toBe(600_000);
  });

  it('marks the attempt that switched providers as a fallback', async () => {
    const attempts: AttemptRecord[] = [];
    const primary = observedAdapter('claude-code', attempts);
    const secondary = observedAdapter('codex', attempts);
    vi.mocked(primary.execute).mockResolvedValueOnce({
      ...failed(0.05, 'p1'),
      errors: [new ConfigurationError('auth missing', 'authentication')],
    });
    vi.mocked(secondary.execute).mockResolvedValueOnce(succeeded(0.2, 'f1'));

    const adapters: Record<string, ExecutionAdapter> = {
      'claude-code': primary,
      codex: secondary,
    };
    let unavailable = false;
    const providerRouter = {
      selectProvider: vi.fn(() => ({
        provider: unavailable ? 'codex' : 'claude-code',
        reason: 'test',
      })),
      setProviderAvailability: vi.fn(() => {
        unavailable = true;
      }),
    };
    const adapterFactory = {
      getAdapter: vi.fn(async (backend: string) => adapters[backend]),
    };

    const invoker = new AgentInvoker({
      adapterFactory: adapterFactory as unknown as AdapterFactory,
      providerRouter: providerRouter as unknown as ProviderRouter,
      fidelityParams: fidelity,
    });
    const result = await invoker.execute({
      role: 'developer',
      task: 'Implement',
      projectContext: { workingDirectory: '/test' },
      spawnContext,
    });

    expect(result.success).toBe(true);
    expect(result.metrics.provider).toBe('codex');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      attempt: 1,
      backendAttempt: 1,
      backend: 'claude-code',
      outcome: 'failure',
      errorCategory: 'ConfigurationError',
      fallback: true,
      fallbackTo: 'codex',
    });
    // Per-backend counter resets, the global attempt number does not
    expect(attempts[1]).toMatchObject({
      attempt: 2,
      backendAttempt: 1,
      backend: 'codex',
      outcome: 'success',
      fallback: false,
    });
    expect(result.metrics.cost).toBeCloseTo(0.25);
  });

  it('never lets a throwing observer break execution', async () => {
    const adapter = {
      execute: vi
        .fn()
        .mockResolvedValueOnce(failed(0.1, 's1'))
        .mockResolvedValueOnce(succeeded(0.1, 's2')),
      name: 'claude-code',
      getSpawnObserver: () => ({
        onSpawnComplete: vi.fn(),
        onAttempt: () => {
          throw new Error('ledger down');
        },
      }),
    } as unknown as ExecutionAdapter;

    const invoker = new AgentInvoker(adapter, fidelity);
    const result = await invoker.execute({
      role: 'developer',
      task: 'Implement',
      projectContext: { workingDirectory: '/test' },
    });
    expect(result.success).toBe(true);
  });

  describe('after run shutdown starts', () => {
    const refused = (): ExecutionResult => ({
      success: false,
      outputs: { error: 'Shutdown in progress: no new CLI spawns' },
      metrics: { tokensUsed: 0, duration: 0 },
      errors: [new ShutdownInProgressError()],
    });

    afterEach(() => {
      shutdownCoordinator.reset();
    });

    it('a not-spawned refusal is no attempt, no spawn and stops retrying', async () => {
      const attempts: AttemptRecord[] = [];
      const adapter = observedAdapter('claude-code', attempts);
      vi.mocked(adapter.execute)
        .mockResolvedValueOnce(failed(0.1, 's1'))
        .mockResolvedValueOnce(refused())
        .mockResolvedValueOnce(succeeded(0.3, 's3'));

      const invoker = new AgentInvoker(adapter, fidelity);
      const result = await invoker.execute({
        role: 'developer',
        task: 'Implement',
        projectContext: { workingDirectory: '/test' },
        spawnContext,
      });

      expect(adapter.execute).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(false);
      expect(attempts.map((a) => [a.attempt, a.outcome])).toEqual([
        [1, 'failure'],
      ]);
      // Only the real (failed) spawn counts
      expect(result.metrics.spawnCount).toBe(1);
      expect(result.metrics.cost).toBeCloseTo(0.1);
    });

    it('a thrown ShutdownInProgressError counts zero spawns and no attempts', async () => {
      const attempts: AttemptRecord[] = [];
      const adapter = observedAdapter('claude-code', attempts);
      vi.mocked(adapter.execute).mockRejectedValue(
        new ShutdownInProgressError()
      );

      const invoker = new AgentInvoker(adapter, fidelity);
      const started = Date.now();
      const result = await invoker.execute({
        role: 'developer',
        task: 'Implement',
        projectContext: { workingDirectory: '/test' },
        spawnContext,
      });

      expect(adapter.execute).toHaveBeenCalledTimes(1);
      expect(Date.now() - started).toBeLessThan(500); // no retry backoff
      expect(attempts).toEqual([]);
      expect(result.metrics.spawnCount).toBe(0);
    });

    it('a spawn failing during shutdown is recorded once and not retried', async () => {
      void shutdownCoordinator.shutdown({ timeoutMs: 10, flushTimeoutMs: 10 });
      const attempts: AttemptRecord[] = [];
      const adapter = observedAdapter('claude-code', attempts);
      vi.mocked(adapter.execute)
        .mockRejectedValueOnce(new Error('interrupted'))
        .mockResolvedValueOnce(succeeded(0.3, 's2'));

      const invoker = new AgentInvoker(adapter, fidelity);
      const started = Date.now();
      const result = await invoker.execute({
        role: 'developer',
        task: 'Implement',
        projectContext: { workingDirectory: '/test' },
        spawnContext,
      });

      expect(adapter.execute).toHaveBeenCalledTimes(1);
      expect(Date.now() - started).toBeLessThan(500); // no retry backoff
      expect(result.success).toBe(false);
      expect(attempts.map((a) => a.outcome)).toEqual(['failure']);
    });
  });
});
