/**
 * Tests for State Manager
 * Validates workflow state persistence and management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StateManager } from '../../src/orchestrator/state-manager.js';
import type { WorkflowContext, WorkflowMetrics, QualityMetrics, Todo } from '../../src/core/types.js';
import { existsSync } from 'fs';
import { rm, mkdir } from 'fs/promises';
import path from 'path';

describe('State Manager', () => {
  const TEST_STATE_DIR = '.agentos/test-state';
  let stateManager: StateManager;
  let testWorkflowId: string;
  let testContext: WorkflowContext;

  beforeEach(async () => {
    // Create fresh state manager for each test
    testWorkflowId = `test-workflow-${Date.now()}`;
    stateManager = new StateManager(TEST_STATE_DIR);

    // Create test workflow context
    testContext = stateManager.createWorkflowContext({
      id: testWorkflowId,
      input: 'Test task',
      inputType: 'prompt',
      mode: 'pipeline',
      fidelityLevel: 'standard',
      taskTitle: 'Test Task',
      taskDescription: 'Test description',
      backend: 'claude-code',
      maxIterations: 3,
    });

    // Ensure clean state
    if (existsSync(TEST_STATE_DIR)) {
      await rm(TEST_STATE_DIR, { recursive: true });
    }
  });

  afterEach(async () => {
    // Clean up test directory
    if (existsSync(TEST_STATE_DIR)) {
      await rm(TEST_STATE_DIR, { recursive: true });
    }
  });

  describe('Initialization', () => {
    it('should create state directory if it does not exist', async () => {
      expect(existsSync(TEST_STATE_DIR)).toBe(false);

      await stateManager.initialize();

      expect(existsSync(TEST_STATE_DIR)).toBe(true);
    });

    it('should not fail if state directory already exists', async () => {
      await mkdir(TEST_STATE_DIR, { recursive: true });

      await expect(stateManager.initialize()).resolves.not.toThrow();
    });
  });

  describe('Save and Load', () => {
    it('should save workflow state to filesystem', async () => {
      await stateManager.save(testContext);

      const statePath = path.join(TEST_STATE_DIR, `${testWorkflowId}.json`);
      expect(existsSync(statePath)).toBe(true);
    });

    it('should load saved workflow state', async () => {
      await stateManager.save(testContext);

      const loaded = await stateManager.load(testWorkflowId);

      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe(testWorkflowId);
      expect(loaded?.input).toBe('Test task');
      expect(loaded?.status).toBe('initializing');
    });

    it('should return null when loading non-existent workflow', async () => {
      const loaded = await stateManager.load('non-existent-id');

      expect(loaded).toBeNull();
    });

    it('should return null when loading corrupted state file', async () => {
      // Create corrupted state file
      await stateManager.initialize();
      const statePath = path.join(TEST_STATE_DIR, `${testWorkflowId}.json`);
      const fs = await import('fs/promises');
      await fs.writeFile(statePath, 'invalid json{', 'utf-8');

      const loaded = await stateManager.load(testWorkflowId);

      expect(loaded).toBeNull();
    });
  });

  describe('Serialization', () => {
    it('should serialize dates to ISO strings', async () => {
      testContext.createdAt = new Date('2025-01-01T10:00:00Z');

      await stateManager.save(testContext);

      const fs = await import('fs/promises');
      const statePath = path.join(TEST_STATE_DIR, `${testWorkflowId}.json`);
      const content = await fs.readFile(statePath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.createdAt).toBe('2025-01-01T10:00:00.000Z');
    });

    it('should deserialize ISO strings to Date objects', async () => {
      testContext.createdAt = new Date('2025-01-01T10:00:00Z');
      await stateManager.save(testContext);

      const loaded = await stateManager.load(testWorkflowId);

      expect(loaded?.createdAt).toBeInstanceOf(Date);
      expect(loaded?.createdAt.toISOString()).toBe('2025-01-01T10:00:00.000Z');
    });

    it('should serialize and deserialize issueUrl', async () => {
      testContext.issueUrl = 'https://github.com/owner/repo/issues/123';
      await stateManager.save(testContext);

      const loaded = await stateManager.load(testWorkflowId);

      expect(loaded?.issueUrl).toBe('https://github.com/owner/repo/issues/123');
    });

    it('should serialize and deserialize testPlan', async () => {
      testContext.testPlan = '### Steps to Verify\n1. Run tests\n2. Check output';
      await stateManager.save(testContext);

      const loaded = await stateManager.load(testWorkflowId);

      expect(loaded?.testPlan).toBe('### Steps to Verify\n1. Run tests\n2. Check output');
    });

    it('should serialize and deserialize todos with dates', async () => {
      const testTodo: Todo = {
        id: '001',
        title: 'Test todo',
        description: 'Test description',
        status: 'pending',
        priority: 'p1',
        createdAt: new Date('2025-01-01T10:00:00Z'),
        updatedAt: new Date('2025-01-01T11:00:00Z'),
      };

      testContext.todos = [testTodo];
      await stateManager.save(testContext);

      const loaded = await stateManager.load(testWorkflowId);

      expect(loaded?.todos).toHaveLength(1);
      expect(loaded?.todos?.[0].createdAt).toBeInstanceOf(Date);
      expect(loaded?.todos?.[0].updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('Cleanup', () => {
    it('should delete workflow state file', async () => {
      await stateManager.save(testContext);
      const statePath = path.join(TEST_STATE_DIR, `${testWorkflowId}.json`);
      expect(existsSync(statePath)).toBe(true);

      await stateManager.cleanup(testWorkflowId);

      expect(existsSync(statePath)).toBe(false);
    });

    it('should not fail when cleaning up non-existent workflow', async () => {
      await expect(stateManager.cleanup('non-existent-id')).resolves.not.toThrow();
    });
  });

  describe('Status Updates', () => {
    it('should update workflow status', async () => {
      await stateManager.save(testContext);

      await stateManager.updateStatus(testWorkflowId, 'running');

      const loaded = await stateManager.load(testWorkflowId);
      expect(loaded?.status).toBe('running');
    });

    it('should throw error when updating status of non-existent workflow', async () => {
      // Initialize directory first so lockfile can work
      await stateManager.initialize();

      await expect(
        stateManager.updateStatus('non-existent-id', 'running')
      ).rejects.toThrow('Workflow not found: non-existent-id');
    });

    it('should support all status transitions', async () => {
      await stateManager.save(testContext);

      const statuses: Array<'initializing' | 'running' | 'completed' | 'failed'> = [
        'initializing',
        'running',
        'completed',
      ];

      for (const status of statuses) {
        await stateManager.updateStatus(testWorkflowId, status);
        const loaded = await stateManager.load(testWorkflowId);
        expect(loaded?.status).toBe(status);
      }
    });
  });

  describe('Stage Updates', () => {
    it('should update current stage', async () => {
      await stateManager.save(testContext);

      await stateManager.updateCurrentStage(testWorkflowId, 'developer');

      const loaded = await stateManager.load(testWorkflowId);
      expect(loaded?.currentStage).toBe('developer');
    });

    it('should update current stage with stage object', async () => {
      await stateManager.save(testContext);

      const stageObj = {
        name: 'developer',
        agent: 'developer' as const,
        input: 'Implement feature',
        optional: false, // Zod schema applies this default
        ignore_context: false, // Zod schema applies this default
      };

      await stateManager.updateCurrentStage(testWorkflowId, 'developer', stageObj);

      const loaded = await stateManager.load(testWorkflowId);
      expect(loaded?.currentStage).toBe('developer');
      expect(loaded?.currentStageObj).toEqual(stageObj);
    });

    it('should throw error when updating stage of non-existent workflow', async () => {
      // Initialize directory first so lockfile can work
      await stateManager.initialize();

      await expect(
        stateManager.updateCurrentStage('non-existent-id', 'developer')
      ).rejects.toThrow('Workflow not found: non-existent-id');
    });
  });

  describe('Iteration Management', () => {
    it('should increment iteration count', async () => {
      await stateManager.save(testContext);

      const count = await stateManager.incrementIteration(testWorkflowId);

      expect(count).toBe(1);

      const loaded = await stateManager.load(testWorkflowId);
      expect(loaded?.iterationCount).toBe(1);
    });

    it('should increment iteration count multiple times', async () => {
      await stateManager.save(testContext);

      await stateManager.incrementIteration(testWorkflowId);
      await stateManager.incrementIteration(testWorkflowId);
      const count = await stateManager.incrementIteration(testWorkflowId);

      expect(count).toBe(3);
    });

    it('should throw error when incrementing iteration of non-existent workflow', async () => {
      // Initialize directory first so lockfile can work
      await stateManager.initialize();

      await expect(
        stateManager.incrementIteration('non-existent-id')
      ).rejects.toThrow('Workflow not found: non-existent-id');
    });
  });

  describe('Metrics Updates', () => {
    it('should update workflow metrics', async () => {
      await stateManager.save(testContext);

      const metricsUpdate: Partial<WorkflowMetrics> = {
        tokensUsed: 1000,
        totalCost: 0.05,
      };

      await stateManager.updateMetrics(testWorkflowId, metricsUpdate);

      const loaded = await stateManager.load(testWorkflowId);
      expect(loaded?.metrics.tokensUsed).toBe(1000);
      expect(loaded?.metrics.totalCost).toBe(0.05);
    });

    it('should merge metrics updates', async () => {
      await stateManager.save(testContext);

      await stateManager.updateMetrics(testWorkflowId, { tokensUsed: 1000 });
      await stateManager.updateMetrics(testWorkflowId, { totalCost: 0.05 });

      const loaded = await stateManager.load(testWorkflowId);
      expect(loaded?.metrics.tokensUsed).toBe(1000);
      expect(loaded?.metrics.totalCost).toBe(0.05);
    });

    it('should throw error when updating metrics of non-existent workflow', async () => {
      await expect(
        stateManager.updateMetrics('non-existent-id', { tokensUsed: 1000 })
      ).rejects.toThrow('Workflow not found');
    });
  });

  describe('Todos Updates', () => {
    it('should update workflow todos', async () => {
      await stateManager.save(testContext);

      const todos: Todo[] = [
        {
          id: '001',
          title: 'Task 1',
          status: 'pending',
          priority: 'p1',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      await stateManager.updateTodos(testWorkflowId, todos);

      const loaded = await stateManager.load(testWorkflowId);
      expect(loaded?.todos).toHaveLength(1);
      expect(loaded?.todos?.[0].title).toBe('Task 1');
    });

    it('should throw error when updating todos of non-existent workflow', async () => {
      await expect(
        stateManager.updateTodos('non-existent-id', [])
      ).rejects.toThrow('Workflow not found');
    });
  });

  describe('Quality Metrics Updates', () => {
    it('should update quality metrics', async () => {
      await stateManager.save(testContext);

      const qualityMetrics: QualityMetrics = {
        coverage: 85,
        lintPassed: true,
        typeCheckPassed: true,
        securityIssues: 0,
      };

      await stateManager.updateQualityMetrics(testWorkflowId, qualityMetrics);

      const loaded = await stateManager.load(testWorkflowId);
      expect(loaded?.qualityMetrics).toEqual(qualityMetrics);
    });

    it('should throw error when updating quality metrics of non-existent workflow', async () => {
      await expect(
        stateManager.updateQualityMetrics('non-existent-id', {})
      ).rejects.toThrow('Workflow not found');
    });
  });

  describe('Context Creation', () => {
    it('should create workflow context with required fields', () => {
      const context = stateManager.createWorkflowContext({
        id: 'test-id',
        input: 'Test input',
        inputType: 'github',
        mode: 'pipeline',
        fidelityLevel: 'thorough',
      });

      expect(context.id).toBe('test-id');
      expect(context.input).toBe('Test input');
      expect(context.inputType).toBe('github');
      expect(context.mode).toBe('pipeline');
      expect(context.fidelityLevel).toBe('thorough');
      expect(context.status).toBe('initializing');
      expect(context.iterationCount).toBe(0);
      expect(context.todos).toEqual([]);
    });

    it('should create workflow context with optional fields', () => {
      const context = stateManager.createWorkflowContext({
        id: 'test-id',
        input: 'Test input',
        inputType: 'prompt',
        mode: 'pipeline',
        fidelityLevel: 'standard',
        worktreePath: '/path/to/worktree',
        repoPath: '/path/to/repo',
        branchName: 'feature-branch',
        taskTitle: 'Task Title',
        taskDescription: 'Task Description',
        backend: 'cursor',
        maxIterations: 5,
      });

      expect(context.worktreePath).toBe('/path/to/worktree');
      expect(context.repoPath).toBe('/path/to/repo');
      expect(context.branchName).toBe('feature-branch');
      expect(context.taskTitle).toBe('Task Title');
      expect(context.taskDescription).toBe('Task Description');
      expect(context.backend).toBe('cursor');
      expect(context.maxIterations).toBe(5);
    });

    it('should initialize metrics with zero values', () => {
      const context = stateManager.createWorkflowContext({
        id: 'test-id',
        input: 'Test',
        inputType: 'prompt',
        mode: 'pipeline',
        fidelityLevel: 'fast',
      });

      expect(context.metrics.tokensUsed).toBe(0);
      expect(context.metrics.totalTokens).toBe(0);
      expect(context.metrics.runtime).toBe(0);
      expect(context.metrics.totalRuntimeMs).toBe(0);
      expect(context.metrics.stagesCompleted).toBe(0);
      expect(context.metrics.totalStages).toBe(0);
      expect(context.metrics.errors).toBe(0);
      expect(context.metrics.totalCost).toBe(0);
    });
  });

  describe('Multiple Updates', () => {
    it('should handle multiple sequential updates correctly', async () => {
      await stateManager.save(testContext);

      // Perform multiple updates sequentially
      await stateManager.updateStatus(testWorkflowId, 'running');
      await stateManager.updateCurrentStage(testWorkflowId, 'developer');
      await stateManager.incrementIteration(testWorkflowId);

      const loaded = await stateManager.load(testWorkflowId);
      expect(loaded?.status).toBe('running');
      expect(loaded?.currentStage).toBe('developer');
      expect(loaded?.iterationCount).toBe(1);
    });
  });
});
