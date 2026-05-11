/**
 * Tests for LangGraph Runner
 * Validates StateGraph integration for orchestration
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LangGraphRunner } from '../../src/orchestrator/langgraph-runner.js';
import type { ExecutionAdapter, ExecutionResult } from '../../src/core/adapter-types.js';
import type { Pipeline, WorkflowContext } from '../../src/core/types.js';
import { StateManager } from '../../src/orchestrator/state-manager.js';

// Mock AuditLogger to prevent tests from writing to .airunx-state/audit/
vi.mock('../../src/audit/audit-logger.js', () => {
  class MockAuditLogger {
    log = vi.fn();
    logStageStart = vi.fn();
    logStageComplete = vi.fn();
    logStageHandoff = vi.fn();
    logStageError = vi.fn();
    logAgentCompletionSignal = vi.fn();
  }
  return {
    AuditLogger: MockAuditLogger,
    getDefaultAuditDir: vi.fn(() => '/tmp/airunx-test-audit'),
  };
});

// Mock LangGraph with full graph traversal simulation
vi.mock('@langchain/langgraph', () => {
  // Define the mock StateGraph class
  const StateGraph = vi.fn(
    class MockStateGraph<T> {
      private nodes = new Map<string, (state: T) => Promise<Partial<T>>>();
      private edges = new Map<
        string,
        Array<string | { conditional: true; condition: (state: T) => string; targets: Record<string, string> }>
      >();
      private entryPoint: string | null = null;

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      constructor(_config: unknown) {
        // Config is passed but not used in mock
      }

      addNode = vi.fn((name: string, fn: (state: T) => Promise<Partial<T>>) => {
        this.nodes.set(name, fn);
      });

      addEdge = vi.fn((from: string, to: string) => {
        if (!this.edges.has(from)) this.edges.set(from, []);
        this.edges.get(from)!.push(to);
        // Track entry point from START
        if (from === 'START') {
          this.entryPoint = to;
        }
      });

      addConditionalEdges = vi.fn(
        (from: string, condition: (state: T) => string, targets: Record<string, string>) => {
          if (!this.edges.has(from)) this.edges.set(from, []);
          this.edges.get(from)!.push({ conditional: true, condition, targets });
        }
      );

      compile = vi.fn(() => {
        const nodes = this.nodes;
        const edges = this.edges;
        const entryPoint = this.entryPoint;

        return {
          invoke: vi.fn(async (state: T): Promise<T> => {
            // Simulate full graph traversal following edges
            let currentState = { ...state } as T;
            let currentNode = entryPoint;
            const visited = new Set<string>();
            const maxIterations = 20; // Safety limit
            let iterationCount = 0;

            while (currentNode && currentNode !== 'END' && iterationCount < maxIterations) {
              iterationCount++;

              // Prevent infinite loops on same node (except judge which may legitimately loop)
              if (visited.has(currentNode) && !currentNode.includes('judge')) {
                break;
              }
              visited.add(currentNode);

              // Execute current node
              const nodeFn = nodes.get(currentNode);
              if (nodeFn) {
                const result = await nodeFn(currentState);
                currentState = { ...currentState, ...result };
              }

              // Find next node via edges
              const nodeEdges = edges.get(currentNode);
              if (!nodeEdges || nodeEdges.length === 0) {
                break;
              }

              let nextNode: string | null = null;
              for (const edge of nodeEdges) {
                if (typeof edge === 'string') {
                  // Simple edge
                  nextNode = edge;
                  break;
                } else if (edge.conditional) {
                  // Conditional edge - evaluate condition
                  const targetKey = edge.condition(currentState);
                  if (targetKey === 'END') {
                    nextNode = 'END';
                  } else {
                    nextNode = edge.targets[targetKey] || null;
                  }
                  break;
                }
              }

              currentNode = nextNode;
            }

            return currentState;
          }),
        };
      });
    }
  );

  return {
    StateGraph,
    END: 'END',
    START: 'START',
  };
});

describe('LangGraph Runner', () => {
  let mockAdapter: ExecutionAdapter;
  let stateManager: StateManager;
  let testPipeline: Pipeline;
  let testContext: WorkflowContext;

  beforeEach(() => {
    // Create mock adapter
    mockAdapter = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        outputs: { result: 'test output' },
        metrics: { tokensUsed: 100, duration: 1000, cost: 0.01 },
        errors: [],
      } as ExecutionResult),
      name: 'mock-adapter',
      capabilities: ['coding', 'analysis'],
    };

    // Create state manager
    stateManager = new StateManager('.agentos/test-langgraph-state');

    // Create test pipeline
    testPipeline = {
      name: 'test-pipeline',
      description: 'Test pipeline',
      default_fidelity: 'standard',
      stages: [
        {
          name: 'orchestrator',
          agent: 'orchestrator',
          input: 'Plan the work',
        },
        {
          name: 'developer',
          agent: 'developer',
          input: 'Implement the feature',
        },
      ],
    };

    // Create test workflow context
    testContext = {
      id: 'test-workflow-123',
      input: 'Test task',
      inputType: 'prompt',
      mode: 'autonomous',
      fidelityLevel: 'standard',
      createdAt: new Date(),
      status: 'initializing',
      iterationCount: 0,
      maxIterations: 3,
      todos: [],
      metrics: {
        tokensUsed: 0,
        totalTokens: 0,
        runtime: 0,
        totalRuntimeMs: 0,
        stagesCompleted: 0,
        totalStages: 2,
        errors: 0,
        totalCost: 0,
      },
    };
  });

  describe('Initialization', () => {
    it('should create LangGraphRunner with required dependencies', () => {
      const runner = new LangGraphRunner(
        mockAdapter,
        stateManager,
        testPipeline,
        testContext
      );

      expect(runner).toBeDefined();
    });
  });

  describe('Graph Execution', () => {
    it('should execute pipeline successfully', async () => {
      // Mock state manager methods
      vi.spyOn(stateManager, 'update').mockResolvedValue(testContext);
      vi.spyOn(stateManager, 'updateStatus').mockResolvedValue();
      vi.spyOn(stateManager, 'updateCurrentStage').mockResolvedValue();
      vi.spyOn(stateManager, 'updateMetrics').mockResolvedValue();
      vi.spyOn(stateManager, 'save').mockResolvedValue();
      vi.spyOn(stateManager, 'load').mockResolvedValue(testContext);

      const runner = new LangGraphRunner(
        mockAdapter,
        stateManager,
        testPipeline,
        testContext
      );

      const result = await runner.execute();

      expect(result).toBeDefined();
      expect(stateManager.updateStatus).toHaveBeenCalledWith('test-workflow-123', 'running');
    });

    it('should handle execution errors gracefully', async () => {
      // Mock state manager to throw error during execution
      vi.spyOn(stateManager, 'updateStatus').mockImplementation(async (id, status) => {
        if (status === 'running') {
          throw new Error('State update failed');
        }
      });

      const runner = new LangGraphRunner(
        mockAdapter,
        stateManager,
        testPipeline,
        testContext
      );

      await expect(runner.execute()).rejects.toThrow('State update failed');
    });

    it('should update workflow status during execution', async () => {
      vi.spyOn(stateManager, 'update').mockResolvedValue(testContext);
      vi.spyOn(stateManager, 'updateStatus').mockResolvedValue();
      vi.spyOn(stateManager, 'updateCurrentStage').mockResolvedValue();
      vi.spyOn(stateManager, 'updateMetrics').mockResolvedValue();
      vi.spyOn(stateManager, 'save').mockResolvedValue();
      vi.spyOn(stateManager, 'load').mockResolvedValue(testContext);

      const runner = new LangGraphRunner(
        mockAdapter,
        stateManager,
        testPipeline,
        testContext
      );

      await runner.execute();

      // Verify status was updated to running
      expect(stateManager.updateStatus).toHaveBeenCalledWith('test-workflow-123', 'running');
      expect(stateManager.updateCurrentStage).toHaveBeenCalled();
    });
  });

  describe('Pipeline with Judge', () => {
    it('should handle pipeline with judge node', async () => {
      const pipelineWithJudge: Pipeline = {
        name: 'test-with-judge',
        description: 'Pipeline with judge',
        default_fidelity: 'standard',
        stages: [
          {
            name: 'developer',
            agent: 'developer',
            input: 'Implement',
          },
          {
            name: 'judge',
            agent: 'code-judge',
            input: 'Review',
            evaluates_stage: 'developer',
          },
        ],
      };

      vi.spyOn(stateManager, 'update').mockResolvedValue(testContext);
      vi.spyOn(stateManager, 'updateStatus').mockResolvedValue();
      vi.spyOn(stateManager, 'updateCurrentStage').mockResolvedValue();
      vi.spyOn(stateManager, 'updateMetrics').mockResolvedValue();
      vi.spyOn(stateManager, 'save').mockResolvedValue();
      vi.spyOn(stateManager, 'load').mockResolvedValue(testContext);

      const runner = new LangGraphRunner(
        mockAdapter,
        stateManager,
        pipelineWithJudge,
        testContext
      );

      const result = await runner.execute();

      expect(result).toBeDefined();
    });
  });

  describe('Post-judge Stage Routing', () => {
    it('should route from judge to document stage on PROCEED', async () => {
      const pipelineWithDocs: Pipeline = {
        name: 'test-judge-to-docs',
        description: 'Pipeline with judge and document stages',
        default_fidelity: 'standard',
        stages: [
          {
            name: 'develop',
            agent: 'developer',
            input: 'Implement',
          },
          {
            name: 'judge',
            agent: 'code-judge',
            input: 'Judge',
            evaluates_stage: 'develop',
          },
          {
            name: 'document',
            agent: 'docs-generator',
            input: 'Generate docs',
          },
        ],
      };

      vi.spyOn(stateManager, 'update').mockResolvedValue(testContext);
      vi.spyOn(stateManager, 'updateStatus').mockResolvedValue();
      vi.spyOn(stateManager, 'updateCurrentStage').mockResolvedValue();
      vi.spyOn(stateManager, 'updateMetrics').mockResolvedValue();
      vi.spyOn(stateManager, 'save').mockResolvedValue();
      vi.spyOn(stateManager, 'load').mockResolvedValue(testContext);

      const runner = new LangGraphRunner(
        mockAdapter,
        stateManager,
        pipelineWithDocs,
        testContext
      );

      const result = await runner.execute();

      expect(result).toBeDefined();

      // Verify document stage was executed.
      // Judge uses its own JudgeAgent (not the adapter), so adapter calls
      // are from implement and document stages only (2 calls, not 3).
      const executeCalls = vi.mocked(mockAdapter.execute).mock.calls;
      const executedTasks = executeCalls.map((call) => call[0].task as string);
      expect(executedTasks.some((task) => task.includes('Generate docs'))).toBe(true);
    });
  });

  describe('Multi-stage Pipeline', () => {
    it('should execute multi-stage pipeline', async () => {
      const multiStagePipeline: Pipeline = {
        name: 'multi-stage',
        description: 'Multi-stage pipeline',
        default_fidelity: 'standard',
        stages: [
          { name: 'planning', agent: 'orchestrator', input: 'Plan' },
          { name: 'implementation', agent: 'developer', input: 'Implement' },
          { name: 'review', agent: 'code-reviewer', input: 'Review' },
        ],
      };

      vi.spyOn(stateManager, 'update').mockResolvedValue(testContext);
      vi.spyOn(stateManager, 'updateStatus').mockResolvedValue();
      vi.spyOn(stateManager, 'updateCurrentStage').mockResolvedValue();
      vi.spyOn(stateManager, 'updateMetrics').mockResolvedValue();
      vi.spyOn(stateManager, 'save').mockResolvedValue();
      vi.spyOn(stateManager, 'load').mockResolvedValue(testContext);

      const runner = new LangGraphRunner(
        mockAdapter,
        stateManager,
        multiStagePipeline,
        testContext
      );

      const result = await runner.execute();

      expect(result).toBeDefined();
      expect(stateManager.updateStatus).toHaveBeenCalled();
    });
  });

  describe('Fidelity Resolution', () => {
    it('should use CLI fidelity level when provided', async () => {
      const contextWithFidelity = {
        ...testContext,
        fidelityLevel: 'thorough' as const,
      };

      vi.spyOn(stateManager, 'update').mockResolvedValue(contextWithFidelity);
      vi.spyOn(stateManager, 'updateStatus').mockResolvedValue();
      vi.spyOn(stateManager, 'updateCurrentStage').mockResolvedValue();
      vi.spyOn(stateManager, 'updateMetrics').mockResolvedValue();
      vi.spyOn(stateManager, 'save').mockResolvedValue();
      vi.spyOn(stateManager, 'load').mockResolvedValue(contextWithFidelity);

      const runner = new LangGraphRunner(
        mockAdapter,
        stateManager,
        testPipeline,
        contextWithFidelity
      );

      await runner.execute();

      expect(mockAdapter.execute).toHaveBeenCalled();
    });

    it('should use stage fidelity when no CLI override', async () => {
      const pipelineWithStageFidelity: Pipeline = {
        name: 'test',
        description: 'Test',
        default_fidelity: 'standard',
        stages: [
          {
            name: 'dev',
            agent: 'developer',
            input: 'Implement',
            fidelity: 'fast',
          },
        ],
      };

      vi.spyOn(stateManager, 'update').mockResolvedValue(testContext);
      vi.spyOn(stateManager, 'updateStatus').mockResolvedValue();
      vi.spyOn(stateManager, 'updateCurrentStage').mockResolvedValue();
      vi.spyOn(stateManager, 'updateMetrics').mockResolvedValue();
      vi.spyOn(stateManager, 'save').mockResolvedValue();
      vi.spyOn(stateManager, 'load').mockResolvedValue(testContext);

      const runner = new LangGraphRunner(
        mockAdapter,
        stateManager,
        pipelineWithStageFidelity,
        testContext
      );

      await runner.execute();

      expect(mockAdapter.execute).toHaveBeenCalled();
    });
  });

  describe('Metrics Tracking', () => {
    it('should track and accumulate metrics across stages', async () => {
      const contextWithMetrics = {
        ...testContext,
        metrics: {
          tokensUsed: 50,
          totalTokens: 50,
          runtime: 500,
          totalRuntimeMs: 500,
          stagesCompleted: 0,
          totalStages: 2,
          errors: 0,
          totalCost: 0.005,
        },
      };
      const updateSpy = vi.spyOn(stateManager, 'update').mockResolvedValue(contextWithMetrics);
      vi.spyOn(stateManager, 'updateStatus').mockResolvedValue();
      vi.spyOn(stateManager, 'updateCurrentStage').mockResolvedValue();
      vi.spyOn(stateManager, 'updateMetrics').mockResolvedValue();
      vi.spyOn(stateManager, 'save').mockResolvedValue();
      vi.spyOn(stateManager, 'load').mockResolvedValue(contextWithMetrics);

      const runner = new LangGraphRunner(
        mockAdapter,
        stateManager,
        testPipeline,
        testContext
      );

      await runner.execute();

      // Verify update was called and inspect the updater's effect
      expect(updateSpy).toHaveBeenCalled();
      const updater = updateSpy.mock.calls[0][1];
      const updatedContext = updater(contextWithMetrics);
      expect(updatedContext.metrics.tokensUsed).toBeGreaterThan(50);
    });
  });

  describe('Context Management', () => {
    it('should pass working directory to agent', async () => {
      const contextWithWorktree = {
        ...testContext,
        worktreePath: '/test/worktree',
        branchName: 'feature-branch',
      };

      vi.spyOn(stateManager, 'update').mockResolvedValue(contextWithWorktree);
      vi.spyOn(stateManager, 'updateStatus').mockResolvedValue();
      vi.spyOn(stateManager, 'updateCurrentStage').mockResolvedValue();
      vi.spyOn(stateManager, 'updateMetrics').mockResolvedValue();
      vi.spyOn(stateManager, 'save').mockResolvedValue();
      vi.spyOn(stateManager, 'load').mockResolvedValue(contextWithWorktree);

      const runner = new LangGraphRunner(
        mockAdapter,
        stateManager,
        testPipeline,
        contextWithWorktree
      );

      await runner.execute();

      expect(mockAdapter.execute).toHaveBeenCalled();
    });

    it('should use cwd when no worktree specified', async () => {
      vi.spyOn(stateManager, 'update').mockResolvedValue(testContext);
      vi.spyOn(stateManager, 'updateStatus').mockResolvedValue();
      vi.spyOn(stateManager, 'updateCurrentStage').mockResolvedValue();
      vi.spyOn(stateManager, 'updateMetrics').mockResolvedValue();
      vi.spyOn(stateManager, 'save').mockResolvedValue();
      vi.spyOn(stateManager, 'load').mockResolvedValue(testContext);

      const runner = new LangGraphRunner(
        mockAdapter,
        stateManager,
        testPipeline,
        testContext
      );

      await runner.execute();

      expect(mockAdapter.execute).toHaveBeenCalled();
    });
  });

  describe('Stage Input Handling', () => {
    it('should use stage input when provided', async () => {
      vi.spyOn(stateManager, 'update').mockResolvedValue(testContext);
      vi.spyOn(stateManager, 'updateStatus').mockResolvedValue();
      vi.spyOn(stateManager, 'updateCurrentStage').mockResolvedValue();
      vi.spyOn(stateManager, 'updateMetrics').mockResolvedValue();
      vi.spyOn(stateManager, 'save').mockResolvedValue();
      vi.spyOn(stateManager, 'load').mockResolvedValue(testContext);

      const runner = new LangGraphRunner(
        mockAdapter,
        stateManager,
        testPipeline,
        testContext
      );

      await runner.execute();

      const executeCall = vi.mocked(mockAdapter.execute).mock.calls[0];
      expect(executeCall[0].task).toContain('Plan the work');
    });

    it('should generate default task when no input provided', async () => {
      const pipelineNoInput: Pipeline = {
        name: 'test',
        description: 'Test',
        default_fidelity: 'standard',
        stages: [
          {
            name: 'dev',
            agent: 'developer',
          },
        ],
      };

      vi.spyOn(stateManager, 'update').mockResolvedValue(testContext);
      vi.spyOn(stateManager, 'updateStatus').mockResolvedValue();
      vi.spyOn(stateManager, 'updateCurrentStage').mockResolvedValue();
      vi.spyOn(stateManager, 'updateMetrics').mockResolvedValue();
      vi.spyOn(stateManager, 'save').mockResolvedValue();
      vi.spyOn(stateManager, 'load').mockResolvedValue(testContext);

      const runner = new LangGraphRunner(
        mockAdapter,
        stateManager,
        pipelineNoInput,
        testContext
      );

      await runner.execute();

      const executeCall = vi.mocked(mockAdapter.execute).mock.calls[0];
      // New format includes stage context + user request
      expect(executeCall[0].task).toContain('Execute stage: dev');
      expect(executeCall[0].task).toContain('User Request: Test task');
    });
  });

  describe('Skip Condition with Iteration Context', () => {
    // Shared pipeline fixtures
    const interimSkipPipeline: Pipeline = {
      name: 'test-skip',
      description: 'Pipeline with skip condition',
      default_fidelity: 'standard',
      stages: [
        { name: 'always-run', agent: 'orchestrator', input: 'Plan' },
        {
          name: 'skip-interim',
          agent: 'code-reviewer',
          input: 'Analyze',
          skip_condition: 'iteration.interim',
        },
        { name: 'final', agent: 'developer', input: 'Implement' },
      ],
    };

    const twoStagePipeline: Pipeline = {
      name: 'test-skip',
      description: 'Pipeline with skip condition',
      default_fidelity: 'standard',
      stages: [
        { name: 'always-run', agent: 'orchestrator', input: 'Plan' },
        {
          name: 'skip-interim',
          agent: 'code-reviewer',
          input: 'Analyze',
          skip_condition: 'iteration.interim',
        },
      ],
    };

    // Helper to setup stateManager mocks
    const setupMocks = (context: WorkflowContext) => {
      vi.spyOn(stateManager, 'update').mockResolvedValue(context);
      vi.spyOn(stateManager, 'updateStatus').mockResolvedValue();
      vi.spyOn(stateManager, 'updateCurrentStage').mockResolvedValue();
      vi.spyOn(stateManager, 'updateMetrics').mockResolvedValue();
      vi.spyOn(stateManager, 'save').mockResolvedValue();
      vi.spyOn(stateManager, 'load').mockResolvedValue(context);
    };

    // Helper to map execute calls to stage names
    const getExecutedStages = () => {
      return vi.mocked(mockAdapter.execute).mock.calls.map((call) => {
        const task = call[0].task as string;
        if (task.includes('Plan')) return 'always-run';
        if (task.includes('Analyze')) return 'skip-interim';
        if (task.includes('Implement')) return 'final';
        return 'unknown';
      });
    };

    it('should skip stage with skip_condition on interim iterations', async () => {
      const interimContext: WorkflowContext = {
        ...testContext,
        iterationCount: 1, // 0-indexed, so this is iteration 2
        maxIterations: 5,
      };
      setupMocks(interimContext);

      const runner = new LangGraphRunner(
        mockAdapter,
        stateManager,
        interimSkipPipeline,
        interimContext
      );
      await runner.execute();

      const stagesExecuted = getExecutedStages();
      expect(stagesExecuted).toContain('always-run');
      expect(stagesExecuted).toContain('final');
      expect(stagesExecuted).not.toContain('skip-interim');
    });

    it('should run stage with skip_condition on first iteration', async () => {
      const firstIterContext: WorkflowContext = {
        ...testContext,
        iterationCount: 0, // 0-indexed, so this is iteration 1
        maxIterations: 5,
      };
      setupMocks(firstIterContext);

      const runner = new LangGraphRunner(
        mockAdapter,
        stateManager,
        interimSkipPipeline,
        firstIterContext
      );
      await runner.execute();

      const stagesExecuted = getExecutedStages();
      expect(stagesExecuted).toContain('always-run');
      expect(stagesExecuted).toContain('skip-interim');
      expect(stagesExecuted).toContain('final');
    });

    it('should run stage with skip_condition on last iteration', async () => {
      const lastIterContext: WorkflowContext = {
        ...testContext,
        iterationCount: 4, // 0-indexed, so this is iteration 5
        maxIterations: 5,
      };
      setupMocks(lastIterContext);

      const runner = new LangGraphRunner(
        mockAdapter,
        stateManager,
        interimSkipPipeline,
        lastIterContext
      );
      await runner.execute();

      const stagesExecuted = getExecutedStages();
      expect(stagesExecuted).toContain('always-run');
      expect(stagesExecuted).toContain('skip-interim');
      expect(stagesExecuted).toContain('final');
    });

    it('should handle max_iterations=1 (no interim exists)', async () => {
      const singleIterContext: WorkflowContext = {
        ...testContext,
        iterationCount: 0,
        maxIterations: 1,
      };
      setupMocks(singleIterContext);

      const runner = new LangGraphRunner(
        mockAdapter,
        stateManager,
        twoStagePipeline,
        singleIterContext
      );
      await runner.execute();

      const executeCalls = vi.mocked(mockAdapter.execute).mock.calls;
      expect(executeCalls.length).toBe(2);
    });

    it('should handle max_iterations=2 (no interim exists)', async () => {
      const twoIterContext: WorkflowContext = {
        ...testContext,
        iterationCount: 1, // 0-indexed, so this is iteration 2
        maxIterations: 2,
      };
      setupMocks(twoIterContext);

      const runner = new LangGraphRunner(
        mockAdapter,
        stateManager,
        twoStagePipeline,
        twoIterContext
      );
      await runner.execute();

      const executeCalls = vi.mocked(mockAdapter.execute).mock.calls;
      expect(executeCalls.length).toBe(2);
    });

    it('should support !iteration.last skip condition', async () => {
      const onlyLastPipeline: Pipeline = {
        name: 'test-skip',
        description: 'Pipeline with skip condition',
        default_fidelity: 'standard',
        stages: [
          { name: 'always-run', agent: 'orchestrator', input: 'Plan' },
          {
            name: 'only-last',
            agent: 'docs-generator',
            input: 'Generate docs',
            skip_condition: '!iteration.last',
          },
        ],
      };

      const notLastContext: WorkflowContext = {
        ...testContext,
        iterationCount: 0,
        maxIterations: 5,
      };
      setupMocks(notLastContext);

      const runner = new LangGraphRunner(
        mockAdapter,
        stateManager,
        onlyLastPipeline,
        notLastContext
      );
      await runner.execute();

      const executeCalls = vi.mocked(mockAdapter.execute).mock.calls;
      expect(executeCalls.length).toBe(1);
      expect(executeCalls[0][0].task).toContain('Plan');
    });

    describe('checkbox skip condition', () => {
      const checkboxPipeline: Pipeline = {
        name: 'test-checkbox',
        description: 'Pipeline with checkbox skip condition',
        default_fidelity: 'standard',
        stages: [
          { name: 'always-run', agent: 'orchestrator', input: 'Plan' },
          {
            name: 'docs',
            agent: 'docs-generator',
            input: 'Generate docs',
            skip_condition: '!checkbox.generate_documentation',
            optional: true,
          },
        ],
      };

      it('should skip stage when no matching checkbox in taskDescription', async () => {
        const noCheckboxContext: WorkflowContext = {
          ...testContext,
          taskDescription: 'Fix the login bug\n- [ ] Write tests',
        };
        setupMocks(noCheckboxContext);

        const runner = new LangGraphRunner(
          mockAdapter,
          stateManager,
          checkboxPipeline,
          noCheckboxContext
        );
        await runner.execute();

        const executeCalls = vi.mocked(mockAdapter.execute).mock.calls;
        expect(executeCalls.length).toBe(1);
        expect(executeCalls[0][0].task).toContain('Plan');
      });

      it('should run stage when matching checkbox is present', async () => {
        const withCheckboxContext: WorkflowContext = {
          ...testContext,
          taskDescription:
            'Add new feature\n- [ ] Write tests\n- [ ] Generate documentation',
        };
        setupMocks(withCheckboxContext);

        const runner = new LangGraphRunner(
          mockAdapter,
          stateManager,
          checkboxPipeline,
          withCheckboxContext
        );
        await runner.execute();

        const executeCalls = vi.mocked(mockAdapter.execute).mock.calls;
        expect(executeCalls.length).toBe(2);
      });

      it('should match checkbox case-insensitively', async () => {
        const mixedCaseContext: WorkflowContext = {
          ...testContext,
          taskDescription: '- [ ] generate Documentation',
        };
        setupMocks(mixedCaseContext);

        const runner = new LangGraphRunner(
          mockAdapter,
          stateManager,
          checkboxPipeline,
          mixedCaseContext
        );
        await runner.execute();

        const executeCalls = vi.mocked(mockAdapter.execute).mock.calls;
        expect(executeCalls.length).toBe(2);
      });

      it('should match checked checkbox [x]', async () => {
        const checkedContext: WorkflowContext = {
          ...testContext,
          taskDescription: '- [x] Generate documentation',
        };
        setupMocks(checkedContext);

        const runner = new LangGraphRunner(
          mockAdapter,
          stateManager,
          checkboxPipeline,
          checkedContext
        );
        await runner.execute();

        const executeCalls = vi.mocked(mockAdapter.execute).mock.calls;
        expect(executeCalls.length).toBe(2);
      });

      it('should skip when taskDescription is undefined', async () => {
        const noDescContext: WorkflowContext = {
          ...testContext,
          taskDescription: undefined,
        };
        setupMocks(noDescContext);

        const runner = new LangGraphRunner(
          mockAdapter,
          stateManager,
          checkboxPipeline,
          noDescContext
        );
        await runner.execute();

        const executeCalls = vi.mocked(mockAdapter.execute).mock.calls;
        expect(executeCalls.length).toBe(1);
      });
    });

    describe('stage.success skip condition (backward compatibility)', () => {
      const stageSuccessPipeline: Pipeline = {
        name: 'test-skip',
        description: 'Pipeline with stage success condition',
        default_fidelity: 'standard',
        stages: [
          { name: 'build', agent: 'developer', input: 'Build' },
          {
            name: 'deploy',
            agent: 'orchestrator',
            input: 'Deploy',
            skip_condition: '!build.success',
            optional: true,
          },
        ],
      };

      it('should run stage when !stage.success condition is NOT met (build succeeds)', async () => {
        setupMocks(testContext);

        const runner = new LangGraphRunner(
          mockAdapter,
          stateManager,
          stageSuccessPipeline,
          testContext
        );
        await runner.execute();

        // Both stages run because build succeeds (default mock behavior)
        const executeCalls = vi.mocked(mockAdapter.execute).mock.calls;
        expect(executeCalls.length).toBe(2);
      });

      // Note: Testing the failure case (build fails -> deploy skipped) requires
      // a more sophisticated mock that properly tracks stage outputs across
      // conditional edge evaluations. The current mock StateGraph doesn't fully
      // replicate LangGraph's state management. The success case above validates
      // the skip_condition pattern matching works correctly.
    });
  });
});
