/**
 * Tests for Verbose Reporter
 * Validates escalating interval progress reporting functionality
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StateManager } from '../../src/orchestrator/state-manager.js';
import type { WorkflowContext } from '../../src/core/types.js';
import { rm } from 'fs/promises';
import { existsSync } from 'fs';

describe('VerboseReporter', () => {
  const TEST_STATE_DIR = '.airunx-test/test-verbose-reporter';
  let stateManager: StateManager;
  let testWorkflowId: string;
  let testContext: WorkflowContext;

  beforeEach(async () => {
    // Ensure clean state first
    if (existsSync(TEST_STATE_DIR)) {
      await rm(TEST_STATE_DIR, { recursive: true });
    }

    // Create state manager and test workflow
    testWorkflowId = `test-workflow-${Date.now()}`;
    stateManager = new StateManager(TEST_STATE_DIR);

    testContext = stateManager.createWorkflowContext({
      id: testWorkflowId,
      input: 'Test task',
      inputType: 'prompt',
      mode: 'pipeline',
      fidelityLevel: 'standard',
      taskTitle: 'Test Task',
      backend: 'claude-code',
      maxIterations: 3,
    });

    // Save the context so it can be loaded by VerboseReporter
    await stateManager.save(testContext);
  });

  afterEach(async () => {
    // Clean up test directory
    if (existsSync(TEST_STATE_DIR)) {
      await rm(TEST_STATE_DIR, { recursive: true });
    }
  });

  describe('Initialization', () => {
    it('should create a VerboseReporter instance', async () => {
      const { VerboseReporter } = await import('../../src/orchestrator/verbose-reporter.js');

      const reporter = new VerboseReporter({
        stateManager,
        workflowId: testWorkflowId,
      });

      expect(reporter).toBeInstanceOf(VerboseReporter);
    });

    it('should use provided output function', async () => {
      const { VerboseReporter } = await import('../../src/orchestrator/verbose-reporter.js');
      const outputFn = vi.fn();

      const reporter = new VerboseReporter({
        stateManager,
        workflowId: testWorkflowId,
        output: outputFn,
      });

      expect(reporter).toBeDefined();
    });
  });

  describe('Start and Stop', () => {
    it('should handle stop when not started', async () => {
      const { VerboseReporter } = await import('../../src/orchestrator/verbose-reporter.js');

      const reporter = new VerboseReporter({
        stateManager,
        workflowId: testWorkflowId,
      });

      // Stop without starting should be fine - no error
      await reporter.stop();
    });

    it('should start without throwing', async () => {
      const { VerboseReporter } = await import('../../src/orchestrator/verbose-reporter.js');

      const reporter = new VerboseReporter({
        stateManager,
        workflowId: testWorkflowId,
      });

      reporter.start();

      // Starting again should be a no-op
      reporter.start();

      // Clean up
      await reporter.stop();
    });

    it('should stop cleanly after starting', async () => {
      const { VerboseReporter } = await import('../../src/orchestrator/verbose-reporter.js');

      const reporter = new VerboseReporter({
        stateManager,
        workflowId: testWorkflowId,
      });

      reporter.start();

      // Stop should complete without hanging
      await reporter.stop();

      // Stopping again should be a no-op
      await reporter.stop();
    });
  });

  describe('Reporting Intervals', () => {
    it('should not report when stopped immediately', async () => {
      const { VerboseReporter } = await import(
        '../../src/orchestrator/verbose-reporter.js'
      );
      const outputFn = vi.fn();
      const reporter = new VerboseReporter({
        stateManager,
        workflowId: testWorkflowId,
        output: outputFn,
      });

      reporter.start();

      // Immediately stopping should mean no reports yet (first report at 1 min)
      await reporter.stop();
      expect(outputFn).not.toHaveBeenCalled();
    });

    it('should use injected delayFn for testability', async () => {
      const { VerboseReporter } = await import(
        '../../src/orchestrator/verbose-reporter.js'
      );
      const outputFn = vi.fn();
      const delayFn = vi.fn().mockRejectedValue({ name: 'AbortError' });

      const reporter = new VerboseReporter({
        stateManager,
        workflowId: testWorkflowId,
        output: outputFn,
        delayFn,
      });

      reporter.start();
      await reporter.stop();

      // Verify the injected delay function was called with the first interval (60_000ms)
      expect(delayFn).toHaveBeenCalledWith(60_000, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it('should handle start/stop lifecycle correctly', async () => {
      const { VerboseReporter } = await import(
        '../../src/orchestrator/verbose-reporter.js'
      );
      const outputFn = vi.fn();
      const reporter = new VerboseReporter({
        stateManager,
        workflowId: testWorkflowId,
        output: outputFn,
      });

      // Starting twice should be idempotent
      reporter.start();
      reporter.start();

      // Stopping twice should be idempotent
      await reporter.stop();
      await reporter.stop();

      // Can restart after stopping
      reporter.start();
      await reporter.stop();

      // Output not called since we stop before first interval (1 min)
      expect(outputFn).not.toHaveBeenCalled();
    });

    it('should call delayFn with escalating intervals', async () => {
      const { VerboseReporter } = await import(
        '../../src/orchestrator/verbose-reporter.js'
      );
      const outputFn = vi.fn();
      // Spy on the private method `reportStatus` to check if it's called
      const reportStatusSpy = vi
        .spyOn(VerboseReporter.prototype as any, 'reportStatus')
        .mockResolvedValue(undefined);

      // Create a promise that resolves when the loop should stop
      let resolveLoopComplete: () => void;
      const loopCompletePromise = new Promise<void>((resolve) => {
        resolveLoopComplete = resolve;
      });

      // Mock delayFn to resolve twice, then reject to stop the loop for the test
      const delayFn = vi.fn()
        .mockResolvedValueOnce(undefined) // After 1st interval
        .mockResolvedValueOnce(undefined) // After 2nd interval
        .mockImplementation(async () => {
          // Signal loop completion and throw AbortError
          resolveLoopComplete();
          throw { name: 'AbortError' };
        });

      const reporter = new VerboseReporter({
        stateManager,
        workflowId: testWorkflowId,
        output: outputFn,
        delayFn,
      });

      reporter.start();

      // Wait for the loop to complete naturally via mocked delays
      await loopCompletePromise;

      // Now stop to clean up (loop already exited via AbortError)
      await reporter.stop();

      // The intervals are defined as: 1 min, 4 min, 5 min
      const ONE_MINUTE_MS = 60_000;
      const FOUR_MINUTES_MS = 4 * 60_000;
      const FIVE_MINUTES_MS = 5 * 60_000;

      // Verify delayFn was called with the correct escalating intervals
      expect(delayFn).toHaveBeenCalledTimes(3);
      expect(delayFn).toHaveBeenNthCalledWith(1, ONE_MINUTE_MS, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(delayFn).toHaveBeenNthCalledWith(2, FOUR_MINUTES_MS, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(delayFn).toHaveBeenNthCalledWith(3, FIVE_MINUTES_MS, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) }));

      // Verify reportStatus was called after each successful delay
      expect(reportStatusSpy).toHaveBeenCalledTimes(2);

      // Clean up the spy
      reportStatusSpy.mockRestore();
    });
  });

  describe('External Abort Signal', () => {
    it('should respect external abort signal on construction', async () => {
      const { VerboseReporter } = await import('../../src/orchestrator/verbose-reporter.js');
      const abortController = new AbortController();
      const outputFn = vi.fn();

      const reporter = new VerboseReporter({
        stateManager,
        workflowId: testWorkflowId,
        output: outputFn,
        signal: abortController.signal,
      });

      reporter.start();

      // Abort immediately
      abortController.abort();

      // Stop should complete
      await reporter.stop();
    });
  });

  describe('Options Interface', () => {
    it('should accept all optional parameters', async () => {
      const { VerboseReporter } = await import('../../src/orchestrator/verbose-reporter.js');
      const abortController = new AbortController();

      const reporter = new VerboseReporter({
        stateManager,
        workflowId: testWorkflowId,
        output: console.log,
        signal: abortController.signal,
      });

      expect(reporter).toBeDefined();

      await reporter.stop();
    });

    it('should work with minimal required options', async () => {
      const { VerboseReporter } = await import('../../src/orchestrator/verbose-reporter.js');

      const reporter = new VerboseReporter({
        stateManager,
        workflowId: testWorkflowId,
      });

      expect(reporter).toBeDefined();

      await reporter.stop();
    });
  });
});
