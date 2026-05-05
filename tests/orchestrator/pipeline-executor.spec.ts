/**
 * Tests for Pipeline Executor
 * Validates end-to-end pipeline execution and workflow management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PipelineExecutor } from '../../src/orchestrator/pipeline-executor.js';
import type { ExecutionAdapter } from '../../src/core/adapter-types.js';
import type { Todo } from '../../src/core/types.js';
import { existsSync } from 'fs';
import { rm, writeFile, mkdir, readdir, readFile } from 'fs/promises';
import path from 'path';
import { spawnSync } from 'child_process';

// Track todos created during tests
const createdTodos: Todo[] = [];

// Mock TodoManager to track todo creation
vi.mock('../../src/utils/todo-manager.js', () => {
  const TodoManager = vi.fn(
    class MockTodoManager {
      create = vi
        .fn()
        .mockImplementation(
          async (todo: Omit<Todo, 'id' | 'createdAt' | 'updatedAt'>) => {
            const newTodo: Todo = {
              id: `todo-${createdTodos.length + 1}`,
              title: todo.title,
              description: todo.description,
              status: todo.status,
              priority: todo.priority,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            createdTodos.push(newTodo);
            return newTodo;
          }
        );
      getAll = vi.fn().mockImplementation(async () => createdTodos);
      get = vi.fn();
      update = vi.fn();
      delete = vi.fn();
    }
  );
  return { TodoManager };
});

// Mock LangGraphRunner
vi.mock('../../src/orchestrator/langgraph-runner.js', () => {
  const LangGraphRunner = vi.fn(
    class MockLangGraphRunner {
      private context: Record<string, unknown>;
      constructor(
        _adapter: unknown,
        _stateManager: unknown,
        _pipeline: unknown,
        context: Record<string, unknown>
      ) {
        this.context = context;
      }
      execute = vi.fn().mockImplementation(async () => ({
        ...this.context,
        status: 'completed',
        iterationCount: 0,
        metrics: {
          tokensUsed: 1000,
          totalTokens: 1000,
          runtime: 5000,
          totalRuntimeMs: 5000,
          stagesCompleted: 5,
          totalStages: 5,
          errors: 0,
          totalCost: 0.05,
        },
      }));
    }
  );
  return { LangGraphRunner };
});

// Mock child_process.spawnSync for test verification gate
// Preserves real exports (execFile, spawn) for AutoCommit/PRGenerator
vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>();
  return {
    ...original,
    spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' }),
  };
});

// Valid standard pipeline YAML for tests (uses valid pipeline type key)
const VALID_STANDARD_PIPELINE_YAML = `
pipelines:
  standard:
    name: standard
    description: Standard test pipeline
    default_fidelity: standard
    max_iterations: 7
    stages:
      - name: orchestrator
        agent: orchestrator
        input: Plan the work
        optional: false
      - name: implementer
        agent: developer
        input: Implement the feature
        optional: false
`;

describe('Pipeline Executor', () => {
  let mockAdapter: ExecutionAdapter;
  let pipelineExecutor: PipelineExecutor;
  const TEST_CONFIG_DIR = path.join('.agentos', 'test-pipeline-executor');
  const TEST_CONFIG_PATH = path.join(TEST_CONFIG_DIR, 'test-pipelines.yaml');
  const TEST_STATE_DIR = path.join(TEST_CONFIG_DIR, 'state');
  const TEST_TODOS_DIR = path.join(TEST_CONFIG_DIR, 'todos');

  // Helper to set up standard pipeline config
  async function setupStandardPipelineConfig() {
    await mkdir(TEST_CONFIG_DIR, { recursive: true });
    await writeFile(TEST_CONFIG_PATH, VALID_STANDARD_PIPELINE_YAML, 'utf-8');
    await pipelineExecutor.loadPipelineConfig(TEST_CONFIG_PATH);
  }

  beforeEach(async () => {
    // Clear tracked todos
    createdTodos.length = 0;

    // Create mock adapter
    mockAdapter = {
      execute: vi.fn(),
      name: 'mock-adapter',
      capabilities: ['coding', 'analysis'],
    };

    pipelineExecutor = new PipelineExecutor(mockAdapter);

    // Clean up test directories
    if (existsSync(TEST_CONFIG_DIR)) {
      await rm(TEST_CONFIG_DIR, { recursive: true });
    }
  });

  afterEach(async () => {
    // Clean up test directories
    if (existsSync(TEST_CONFIG_DIR)) {
      await rm(TEST_CONFIG_DIR, { recursive: true });
    }
  });

  describe('Pipeline Configuration', () => {
    it('should load pipeline configuration from YAML', async () => {
      await mkdir(TEST_CONFIG_DIR, { recursive: true });
      const yamlContent = `
pipelines:
  standard:
    name: standard
    description: Standard pipeline
    default_fidelity: standard
    stages:
      - name: orchestrator
        agent: orchestrator
        input: Plan the work
        optional: false
      - name: implementer
        agent: developer
        input: Implement the feature
        optional: false
`;

      await writeFile(TEST_CONFIG_PATH, yamlContent, 'utf-8');

      const config =
        await pipelineExecutor.loadPipelineConfig(TEST_CONFIG_PATH);

      expect(config).not.toBeNull();
      expect(config?.pipelines.standard).toBeDefined();
      expect(config?.pipelines.standard.stages).toHaveLength(2);
    });

    it('should return null when config file not found', async () => {
      const config =
        await pipelineExecutor.loadPipelineConfig('non-existent.yaml');

      expect(config).toBeNull();
    });

    it('should return null for invalid YAML', async () => {
      await mkdir(TEST_CONFIG_DIR, { recursive: true });
      await writeFile(TEST_CONFIG_PATH, 'invalid: yaml: content:', 'utf-8');

      const config = pipelineExecutor.loadPipelineConfig(TEST_CONFIG_PATH);

      expect(config).toBeNull();
    });

    it('should get pipeline by name', async () => {
      await mkdir(TEST_CONFIG_DIR, { recursive: true });
      const yamlContent = `
pipelines:
  feature:
    name: feature
    description: Feature pipeline
    default_fidelity: thorough
    stages:
      - name: test-stage
        agent: developer
        input: Test
        optional: false
`;

      await writeFile(TEST_CONFIG_PATH, yamlContent, 'utf-8');
      await pipelineExecutor.loadPipelineConfig(TEST_CONFIG_PATH);

      const pipeline = pipelineExecutor.getPipeline('feature');

      expect(pipeline).not.toBeNull();
      expect(pipeline?.name).toBe('feature');
      expect(pipeline?.default_fidelity).toBe('thorough');
    });

    it('should return null for non-existent pipeline', async () => {
      await mkdir(TEST_CONFIG_DIR, { recursive: true });
      const yamlContent = `
pipelines:
  standard:
    name: standard
    description: Standard pipeline
    default_fidelity: standard
    stages:
      - name: test
        agent: developer
        input: Test
        optional: false
`;

      await writeFile(TEST_CONFIG_PATH, yamlContent, 'utf-8');
      await pipelineExecutor.loadPipelineConfig(TEST_CONFIG_PATH);

      const pipeline = pipelineExecutor.getPipeline('non-existent');

      expect(pipeline).toBeNull();
    });
  });

  describe('Workflow Execution', () => {
    it('should execute workflow with default pipeline', async () => {
      await setupStandardPipelineConfig();

      const result = await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
        mode: 'pipeline',
        fidelityLevel: 'standard',
      });

      // Mock adapter produces no worktree, so status is downgraded
      expect(result.status).toBe('completed_with_errors');
      expect(result.input).toBe('Test task');
      expect(result.inputType).toBe('prompt');
    });

    it('should use specified pipeline if found', async () => {
      await mkdir(TEST_CONFIG_DIR, { recursive: true });
      const yamlContent = `
pipelines:
  thin:
    name: thin
    description: Thin pipeline
    default_fidelity: fast
    stages:
      - name: dev
        agent: developer
        input: Code
        optional: false
`;

      await writeFile(TEST_CONFIG_PATH, yamlContent, 'utf-8');
      await pipelineExecutor.loadPipelineConfig(TEST_CONFIG_PATH);

      const result = await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
        pipelineName: 'thin',
      });

      // Mock adapter produces no worktree, so status is downgraded
      expect(result.status).toBe('completed_with_errors');
    });

    it('should throw an error for a non-existent pipeline', async () => {
      await setupStandardPipelineConfig();

      await expect(
        pipelineExecutor.execute({
          input: 'Test task',
          inputType: 'prompt',
          pipelineName: 'non-existent-pipeline' as any,
        })
      ).rejects.toThrow("Pipeline 'non-existent-pipeline' not found.");
    });

    it('should apply fidelity level from options', async () => {
      await setupStandardPipelineConfig();

      const result = await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
        fidelityLevel: 'thorough',
      });

      expect(result.fidelityLevel).toBe('thorough');
    });

    it('should handle workflow execution failure', async () => {
      await setupStandardPipelineConfig();

      // Mock LangGraphRunner to throw error using class-style mock
      const { LangGraphRunner } = await import(
        '../../src/orchestrator/langgraph-runner.js'
      );
      vi.mocked(LangGraphRunner).mockImplementationOnce(
        class FailingRunner {
          execute = vi.fn().mockRejectedValue(new Error('Execution failed'));
        } as unknown as typeof LangGraphRunner
      );

      await expect(
        pipelineExecutor.execute({
          input: 'Test task',
          inputType: 'prompt',
        })
      ).rejects.toThrow('Execution failed');
    });
  });

  describe('Todo Management', () => {
    it('should create todos from task description with bullet points', async () => {
      await setupStandardPipelineConfig();

      const taskDescription = `
Task requirements:
- Implement feature A
- Add tests for feature A
- Update documentation
`;

      await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
        taskDescription,
      });

      // Verify todos were created with correct titles from bullet points
      expect(createdTodos).toHaveLength(3);
      expect(createdTodos[0].title).toBe('Implement feature A');
      expect(createdTodos[1].title).toBe('Add tests for feature A');
      expect(createdTodos[2].title).toBe('Update documentation');
      // Verify all todos have expected priority for list items
      expect(createdTodos.every((t) => t.priority === 'p2')).toBe(true);
    });

    it('should create todos from task description with numbered list', async () => {
      await setupStandardPipelineConfig();

      const taskDescription = `
1. Design the API
2. Implement endpoints
3. Write tests
`;

      await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
        taskDescription,
      });

      // Verify todos were created with correct titles from numbered list
      expect(createdTodos).toHaveLength(3);
      expect(createdTodos[0].title).toBe('Design the API');
      expect(createdTodos[1].title).toBe('Implement endpoints');
      expect(createdTodos[2].title).toBe('Write tests');
      expect(createdTodos.every((t) => t.status === 'pending')).toBe(true);
    });

    it('should create single todo when no list format detected', async () => {
      await setupStandardPipelineConfig();

      const taskDescription = 'This is a simple task description without lists';

      await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
        taskDescription,
      });

      // Verify a single todo was created with 'Complete implementation' title
      expect(createdTodos).toHaveLength(1);
      expect(createdTodos[0].title).toBe('Complete implementation');
      expect(createdTodos[0].description).toBe(taskDescription);
      expect(createdTodos[0].priority).toBe('p1');
    });

    it('should not create todos when no task description provided', async () => {
      await setupStandardPipelineConfig();

      await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
      });

      // Verify no todos were created
      expect(createdTodos).toHaveLength(0);
    });
  });

  describe('Workflow Resume', () => {
    it('should resume workflow from saved state', async () => {
      await setupStandardPipelineConfig();

      // First create a workflow
      const result1 = await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
      });

      const workflowId = result1.id;

      // Then try to resume it
      const result2 = await pipelineExecutor.resume(workflowId);

      expect(result2.id).toBe(workflowId);
      expect(result2.status).toBe('completed');
    });

    it('should throw error when resuming non-existent workflow', async () => {
      await setupStandardPipelineConfig();

      await expect(
        pipelineExecutor.resume('non-existent-workflow')
      ).rejects.toThrow('Workflow not found');
    });

    it('should handle resume of already completed workflow', async () => {
      await setupStandardPipelineConfig();

      const result1 = await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
      });

      const workflowId = result1.id;

      // Resume already completed workflow
      const result2 = await pipelineExecutor.resume(workflowId);

      expect(result2.status).toBe('completed');
      expect(result2.id).toBe(workflowId);
    });
  });

  describe('Workflow Status', () => {
    it('should get workflow status', async () => {
      await setupStandardPipelineConfig();

      const result = await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
      });

      const status = await pipelineExecutor.getStatus(result.id);

      expect(status).not.toBeNull();
      expect(status?.id).toBe(result.id);
      // Status may be 'initializing', 'completed', or 'completed_with_errors'
      // (completed_with_errors when no worktree was produced)
      expect([
        'initializing',
        'running',
        'completed',
        'completed_with_errors',
      ]).toContain(status?.status);
    });

    it('should return null for non-existent workflow', async () => {
      const status = await pipelineExecutor.getStatus('non-existent');

      expect(status).toBeNull();
    });
  });

  describe('Workflow Cleanup', () => {
    it('should cleanup workflow state', async () => {
      await setupStandardPipelineConfig();

      const result = await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
      });

      await pipelineExecutor.cleanup(result.id);

      const status = await pipelineExecutor.getStatus(result.id);
      expect(status).toBeNull();
    });
  });

  describe('Test Verification Gate', () => {
    const TEST_WORKTREE = path.join(
      '.agentos',
      'test-pipeline-executor',
      'worktree'
    );

    // Pipeline YAML with an 'implement' stage (mirrors real pipeline config)
    const PIPELINE_WITH_IMPLEMENT = `
pipelines:
  standard:
    name: standard
    max_iterations: 3
    stages:
      - name: orchestrate
        agent: orchestrator
      - name: implement
        agent: developer
`;

    // Pipeline YAML without an implement stage
    const PIPELINE_NO_IMPLEMENT = `
pipelines:
  standard:
    name: standard
    stages:
      - name: analyze
        agent: code-reviewer
`;

    function completedResultWithWorktree(
      overrides: Record<string, unknown> = {}
    ) {
      return {
        id: 'wf-test',
        input: 'task',
        inputType: 'prompt',
        status: 'completed',
        worktreePath: TEST_WORKTREE,
        stageResults: {
          implement: {
            success: true,
            outputs: {},
            metrics: { tokensUsed: 0, duration: 0 },
          },
        },
        iterationCount: 0,
        metrics: {
          tokensUsed: 0,
          runtime: 0,
          stagesCompleted: 1,
          totalStages: 1,
          errors: 0,
        },
        createdAt: new Date(),
        mode: 'pipeline',
        ...overrides,
      };
    }

    async function setupWorktreeWithPackageJson(
      scripts: Record<string, string> = { test: 'vitest' }
    ) {
      await mkdir(TEST_WORKTREE, { recursive: true });
      // Create node_modules/ so installDepsIfNeeded skips npm install
      await mkdir(path.join(TEST_WORKTREE, 'node_modules'), {
        recursive: true,
      });
      await writeFile(
        path.join(TEST_WORKTREE, 'package.json'),
        JSON.stringify({ scripts }),
        'utf-8'
      );
    }

    async function setupWorktreeWithComposerJson(
      opts: {
        scripts?: Record<string, string>;
        requireDev?: Record<string, string>;
      } = {}
    ) {
      await mkdir(TEST_WORKTREE, { recursive: true });
      // Create vendor/ so installDepsIfNeeded skips composer install
      await mkdir(path.join(TEST_WORKTREE, 'vendor'), { recursive: true });
      const composer: Record<string, unknown> = {};
      if (opts.scripts) composer.scripts = opts.scripts;
      if (opts.requireDev) composer['require-dev'] = opts.requireDev;
      await writeFile(
        path.join(TEST_WORKTREE, 'composer.json'),
        JSON.stringify(composer),
        'utf-8'
      );
    }

    beforeEach(() => {
      vi.mocked(spawnSync).mockReset();
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: '',
        stderr: '',
      } as ReturnType<typeof spawnSync>);
    });

    it('should skip test gate when no test framework is detected', async () => {
      await mkdir(path.join('.agentos', 'test-pipeline-executor'), {
        recursive: true,
      });
      await writeFile(TEST_CONFIG_PATH, PIPELINE_WITH_IMPLEMENT, 'utf-8');
      await pipelineExecutor.loadPipelineConfig(TEST_CONFIG_PATH);

      // Worktree exists but has no package.json or composer.json
      await mkdir(TEST_WORKTREE, { recursive: true });

      const { LangGraphRunner } = await import(
        '../../src/orchestrator/langgraph-runner.js'
      );
      vi.mocked(LangGraphRunner).mockImplementationOnce(
        class {
          execute = vi.fn().mockResolvedValue(completedResultWithWorktree());
        } as unknown as typeof LangGraphRunner
      );

      const result = await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
        skipCommit: true,
      });

      expect(result.status).toBe('completed');
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it('should pass when tests succeed (package.json)', async () => {
      await mkdir(path.join('.agentos', 'test-pipeline-executor'), {
        recursive: true,
      });
      await writeFile(TEST_CONFIG_PATH, PIPELINE_WITH_IMPLEMENT, 'utf-8');
      await pipelineExecutor.loadPipelineConfig(TEST_CONFIG_PATH);
      await setupWorktreeWithPackageJson();

      const { LangGraphRunner } = await import(
        '../../src/orchestrator/langgraph-runner.js'
      );
      vi.mocked(LangGraphRunner).mockImplementationOnce(
        class {
          execute = vi.fn().mockResolvedValue(completedResultWithWorktree());
        } as unknown as typeof LangGraphRunner
      );

      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: 'Tests passed',
        stderr: '',
      } as ReturnType<typeof spawnSync>);

      const result = await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
        skipCommit: true,
      });

      expect(result.status).toBe('completed');
      expect(spawnSync).toHaveBeenCalledWith(
        'npm',
        ['test'],
        expect.objectContaining({ cwd: TEST_WORKTREE })
      );
    });

    it('should detect composer test command', async () => {
      await mkdir(path.join('.agentos', 'test-pipeline-executor'), {
        recursive: true,
      });
      await writeFile(TEST_CONFIG_PATH, PIPELINE_WITH_IMPLEMENT, 'utf-8');
      await pipelineExecutor.loadPipelineConfig(TEST_CONFIG_PATH);
      await setupWorktreeWithComposerJson({ scripts: { test: 'phpunit' } });

      const { LangGraphRunner } = await import(
        '../../src/orchestrator/langgraph-runner.js'
      );
      vi.mocked(LangGraphRunner).mockImplementationOnce(
        class {
          execute = vi.fn().mockResolvedValue(completedResultWithWorktree());
        } as unknown as typeof LangGraphRunner
      );

      const result = await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
        skipCommit: true,
      });

      expect(result.status).toBe('completed');
      expect(spawnSync).toHaveBeenCalledWith(
        'composer',
        ['test'],
        expect.objectContaining({ cwd: TEST_WORKTREE })
      );
    });

    it('should detect phpunit from require-dev', async () => {
      await mkdir(path.join('.agentos', 'test-pipeline-executor'), {
        recursive: true,
      });
      await writeFile(TEST_CONFIG_PATH, PIPELINE_WITH_IMPLEMENT, 'utf-8');
      await pipelineExecutor.loadPipelineConfig(TEST_CONFIG_PATH);
      await setupWorktreeWithComposerJson({
        requireDev: { 'phpunit/phpunit': '^10.0' },
      });

      const { LangGraphRunner } = await import(
        '../../src/orchestrator/langgraph-runner.js'
      );
      vi.mocked(LangGraphRunner).mockImplementationOnce(
        class {
          execute = vi.fn().mockResolvedValue(completedResultWithWorktree());
        } as unknown as typeof LangGraphRunner
      );

      const result = await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
        skipCommit: true,
      });

      expect(spawnSync).toHaveBeenCalledWith(
        path.join(TEST_WORKTREE, 'vendor/bin/phpunit'),
        [],
        expect.objectContaining({ cwd: TEST_WORKTREE })
      );
    });

    it('should downgrade when tests fail and no implement stage to retry', async () => {
      await mkdir(path.join('.agentos', 'test-pipeline-executor'), {
        recursive: true,
      });
      await writeFile(TEST_CONFIG_PATH, PIPELINE_NO_IMPLEMENT, 'utf-8');
      await pipelineExecutor.loadPipelineConfig(TEST_CONFIG_PATH);
      await setupWorktreeWithPackageJson();

      const { LangGraphRunner } = await import(
        '../../src/orchestrator/langgraph-runner.js'
      );
      vi.mocked(LangGraphRunner).mockImplementationOnce(
        class {
          execute = vi.fn().mockResolvedValue(completedResultWithWorktree());
        } as unknown as typeof LangGraphRunner
      );

      vi.mocked(spawnSync).mockReturnValue({
        status: 1,
        stdout: '',
        stderr: 'Test failed',
      } as ReturnType<typeof spawnSync>);

      const result = await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
        skipCommit: true,
      });

      expect(result.status).toBe('completed_with_errors');
    });

    it('should iterate back to implement when tests fail', async () => {
      await mkdir(path.join('.agentos', 'test-pipeline-executor'), {
        recursive: true,
      });
      await writeFile(TEST_CONFIG_PATH, PIPELINE_WITH_IMPLEMENT, 'utf-8');
      await pipelineExecutor.loadPipelineConfig(TEST_CONFIG_PATH);
      await setupWorktreeWithPackageJson();

      const mockExecute = vi
        .fn()
        // First run: completed with worktree
        .mockResolvedValueOnce(completedResultWithWorktree())
        // Retry after test failure: completed with worktree
        .mockResolvedValueOnce(
          completedResultWithWorktree({ iterationCount: 1 })
        );

      const { LangGraphRunner } = await import(
        '../../src/orchestrator/langgraph-runner.js'
      );
      vi.mocked(LangGraphRunner).mockImplementationOnce(
        class {
          execute = mockExecute;
        } as unknown as typeof LangGraphRunner
      );

      // First test run fails, retry test run passes
      vi.mocked(spawnSync)
        .mockReturnValueOnce({
          status: 1,
          stdout: '',
          stderr: 'FAIL',
        } as ReturnType<typeof spawnSync>)
        .mockReturnValueOnce({
          status: 0,
          stdout: 'PASS',
          stderr: '',
        } as ReturnType<typeof spawnSync>);

      const result = await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
        skipCommit: true,
      });

      // Should have called execute twice (original + retry)
      expect(mockExecute).toHaveBeenCalledTimes(2);
      // Retry should have cleared implement stage from saved outputs
      const retryArg = mockExecute.mock.calls[1][0] as Record<string, unknown>;
      expect(retryArg).not.toHaveProperty('implement');
      expect(result.status).toBe('completed');
    });

    it('should downgrade when tests still fail after retry', async () => {
      await mkdir(path.join('.agentos', 'test-pipeline-executor'), {
        recursive: true,
      });
      await writeFile(TEST_CONFIG_PATH, PIPELINE_WITH_IMPLEMENT, 'utf-8');
      await pipelineExecutor.loadPipelineConfig(TEST_CONFIG_PATH);
      await setupWorktreeWithPackageJson();

      const mockExecute = vi
        .fn()
        .mockResolvedValueOnce(completedResultWithWorktree())
        .mockResolvedValueOnce(completedResultWithWorktree());

      const { LangGraphRunner } = await import(
        '../../src/orchestrator/langgraph-runner.js'
      );
      vi.mocked(LangGraphRunner).mockImplementationOnce(
        class {
          execute = mockExecute;
        } as unknown as typeof LangGraphRunner
      );

      // Both test runs fail
      vi.mocked(spawnSync).mockReturnValue({
        status: 1,
        stdout: '',
        stderr: 'Tests always fail',
      } as ReturnType<typeof spawnSync>);

      const result = await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
        skipCommit: true,
      });

      expect(mockExecute).toHaveBeenCalledTimes(2);
      expect(result.status).toBe('completed_with_errors');
    });

    it('should skip default npm test placeholder', async () => {
      await mkdir(path.join('.agentos', 'test-pipeline-executor'), {
        recursive: true,
      });
      await writeFile(TEST_CONFIG_PATH, PIPELINE_WITH_IMPLEMENT, 'utf-8');
      await pipelineExecutor.loadPipelineConfig(TEST_CONFIG_PATH);
      await setupWorktreeWithPackageJson({
        test: 'echo "Error: no test specified" && exit 1',
      });

      const { LangGraphRunner } = await import(
        '../../src/orchestrator/langgraph-runner.js'
      );
      vi.mocked(LangGraphRunner).mockImplementationOnce(
        class {
          execute = vi.fn().mockResolvedValue(completedResultWithWorktree());
        } as unknown as typeof LangGraphRunner
      );

      const result = await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
        skipCommit: true,
      });

      expect(result.status).toBe('completed');
      expect(spawnSync).not.toHaveBeenCalled();
    });
  });

  describe('Pipeline Tier Validation', () => {
    beforeEach(async () => {
      await mkdir(TEST_CONFIG_DIR, { recursive: true });
    });

    it('should load thin pipeline with fast fidelity and 3 max iterations', async () => {
      const yamlContent = `
pipelines:
  thin:
    name: "Thin Pipeline"
    description: "Quick iterations"
    deliverable: pull_request
    default_fidelity: fast
    max_iterations: 3
    stages:
      - name: implement
        agent: developer
`;

      await writeFile(TEST_CONFIG_PATH, yamlContent, 'utf-8');
      await pipelineExecutor.loadPipelineConfig(TEST_CONFIG_PATH);

      const pipeline = pipelineExecutor.getPipeline('thin');

      expect(pipeline).not.toBeNull();
      expect(pipeline?.default_fidelity).toBe('fast');
      expect(pipeline?.max_iterations).toBe(3);
      expect(pipeline?.deliverable).toBe('pull_request');
    });

    it('should load standard pipeline with standard fidelity and 7 max iterations', async () => {
      const yamlContent = `
pipelines:
  standard:
    name: "Standard Pipeline"
    description: "Full development lifecycle"
    deliverable: pull_request
    default_fidelity: standard
    max_iterations: 7
    stages:
      - name: implement
        agent: developer
`;

      await writeFile(TEST_CONFIG_PATH, yamlContent, 'utf-8');
      await pipelineExecutor.loadPipelineConfig(TEST_CONFIG_PATH);

      const pipeline = pipelineExecutor.getPipeline('standard');

      expect(pipeline).not.toBeNull();
      expect(pipeline?.default_fidelity).toBe('standard');
      expect(pipeline?.max_iterations).toBe(7);
    });

    it('should load feature pipeline with thorough fidelity and 14 max iterations', async () => {
      const yamlContent = `
pipelines:
  feature:
    name: "Feature Pipeline"
    description: "Production-ready features"
    deliverable: pull_request
    default_fidelity: thorough
    max_iterations: 14
    stages:
      - name: implement
        agent: developer
`;

      await writeFile(TEST_CONFIG_PATH, yamlContent, 'utf-8');
      await pipelineExecutor.loadPipelineConfig(TEST_CONFIG_PATH);

      const pipeline = pipelineExecutor.getPipeline('feature');

      expect(pipeline).not.toBeNull();
      expect(pipeline?.default_fidelity).toBe('thorough');
      expect(pipeline?.max_iterations).toBe(14);
    });

    it('should load mission-critical pipeline with ultra fidelity and 100 max iterations', async () => {
      const yamlContent = `
pipelines:
  mission-critical:
    name: "Mission Critical Pipeline"
    description: "Highest quality"
    deliverable: pull_request
    default_fidelity: ultra
    max_iterations: 100
    stages:
      - name: implement
        agent: developer
`;

      await writeFile(TEST_CONFIG_PATH, yamlContent, 'utf-8');
      await pipelineExecutor.loadPipelineConfig(TEST_CONFIG_PATH);

      const pipeline = pipelineExecutor.getPipeline('mission-critical');

      expect(pipeline).not.toBeNull();
      expect(pipeline?.default_fidelity).toBe('ultra');
      expect(pipeline?.max_iterations).toBe(100);
    });

    it('should use pipeline max_iterations in workflow context', async () => {
      const yamlContent = `
pipelines:
  thin:
    name: "Thin Pipeline"
    deliverable: pull_request
    default_fidelity: fast
    max_iterations: 3
    stages:
      - name: implement
        agent: developer
`;

      await writeFile(TEST_CONFIG_PATH, yamlContent, 'utf-8');
      await pipelineExecutor.loadPipelineConfig(TEST_CONFIG_PATH);

      const result = await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
        pipelineName: 'thin',
      });

      expect(result.maxIterations).toBe(3);
    });

    it('should default to fidelity-based max iterations when not specified', async () => {
      const yamlContent = `
pipelines:
  thin:
    name: "Thin Pipeline"
    default_fidelity: standard
    stages:
      - name: implement
        agent: developer
`;

      await writeFile(TEST_CONFIG_PATH, yamlContent, 'utf-8');
      await pipelineExecutor.loadPipelineConfig(TEST_CONFIG_PATH);

      const result = await pipelineExecutor.execute({
        input: 'Test task',
        inputType: 'prompt',
        pipelineName: 'thin',
      });

      // Standard fidelity has reviewIterations: 5 (full rotation)
      expect(result.maxIterations).toBe(5);
    });
  });
});
