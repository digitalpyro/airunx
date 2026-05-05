/**
 * Unit tests for Circuit Breaker
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CircuitBreaker,
  CircuitState,
  type CircuitBreakerConfig,
} from '../../src/utils/circuit-breaker.js';
import { RetryableError, TimeoutError, ConfigurationError } from '../../src/utils/errors.js';

describe('Circuit Breaker', () => {
  let testDir: string;
  let stateFilePath: string;
  let circuitBreaker: CircuitBreaker;

  const defaultConfig: Partial<CircuitBreakerConfig> = {
    failureThreshold: 3,
    resetTimeoutMs: 1000, // 1 second for faster tests
    maxResetTimeoutMs: 5000,
    halfOpenSuccessThreshold: 1,
  };

  beforeEach(async () => {
    // Create a unique temp directory for each test
    testDir = join(tmpdir(), `circuit-breaker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
    stateFilePath = join(testDir, 'circuit-breaker.json');
    circuitBreaker = new CircuitBreaker(stateFilePath, defaultConfig);
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Initial State', () => {
    it('should start with CLOSED state for unknown backends', async () => {
      const state = await circuitBreaker.getState('test-backend');
      expect(state.state).toBe(CircuitState.CLOSED);
      expect(state.failureCount).toBe(0);
      expect(state.successCount).toBe(0);
    });

    it('should return false for isOpen on CLOSED circuit', async () => {
      const isOpen = await circuitBreaker.isOpen('test-backend');
      expect(isOpen).toBe(false);
    });
  });

  describe('State Transitions', () => {
    it('should transition from CLOSED to OPEN after threshold failures', async () => {
      const backend = 'test-backend';
      const error = new RetryableError('Test failure');

      // Record failures up to threshold
      for (let i = 0; i < 3; i++) {
        await circuitBreaker.recordFailure(backend, error);
      }

      const state = await circuitBreaker.getState(backend);
      expect(state.state).toBe(CircuitState.OPEN);
      expect(state.failureCount).toBe(3);
    });

    it('should return true for isOpen when circuit is OPEN', async () => {
      const backend = 'test-backend';
      const error = new RetryableError('Test failure');

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await circuitBreaker.recordFailure(backend, error);
      }

      const isOpen = await circuitBreaker.isOpen(backend);
      expect(isOpen).toBe(true);
    });

    it('should transition from OPEN to HALF_OPEN after timeout', async () => {
      const backend = 'test-backend';
      const error = new RetryableError('Test failure');

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await circuitBreaker.recordFailure(backend, error);
      }

      // Wait for reset timeout
      await new Promise(resolve => setTimeout(resolve, 1100));

      // isOpen should return false and transition to HALF_OPEN
      const isOpen = await circuitBreaker.isOpen(backend);
      expect(isOpen).toBe(false);

      const state = await circuitBreaker.getState(backend);
      expect(state.state).toBe(CircuitState.HALF_OPEN);
    });

    it('should transition from HALF_OPEN to CLOSED on success', async () => {
      const backend = 'test-backend';
      const error = new RetryableError('Test failure');

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await circuitBreaker.recordFailure(backend, error);
      }

      // Wait for reset timeout
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Trigger HALF_OPEN
      await circuitBreaker.isOpen(backend);

      // Record success
      await circuitBreaker.recordSuccess(backend);

      const state = await circuitBreaker.getState(backend);
      expect(state.state).toBe(CircuitState.CLOSED);
      expect(state.failureCount).toBe(0);
    });

    it('should transition from HALF_OPEN to OPEN on failure', async () => {
      const backend = 'test-backend';
      const error = new RetryableError('Test failure');

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await circuitBreaker.recordFailure(backend, error);
      }

      // Wait for reset timeout
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Trigger HALF_OPEN
      await circuitBreaker.isOpen(backend);
      let state = await circuitBreaker.getState(backend);
      expect(state.state).toBe(CircuitState.HALF_OPEN);

      // Record failure during HALF_OPEN
      await circuitBreaker.recordFailure(backend, error);

      state = await circuitBreaker.getState(backend);
      expect(state.state).toBe(CircuitState.OPEN);
      expect(state.resetAttempts).toBe(1);
    });
  });

  describe('Error Categorization', () => {
    it('should count RetryableError toward circuit', async () => {
      const backend = 'test-backend';
      const error = new RetryableError('Retryable failure');

      await circuitBreaker.recordFailure(backend, error);

      const state = await circuitBreaker.getState(backend);
      expect(state.failureCount).toBe(1);
    });

    it('should count TimeoutError toward circuit', async () => {
      const backend = 'test-backend';
      const error = new TimeoutError(30000, 'CLI execution');

      await circuitBreaker.recordFailure(backend, error);

      const state = await circuitBreaker.getState(backend);
      expect(state.failureCount).toBe(1);
    });

    it('should NOT count ConfigurationError toward circuit', async () => {
      const backend = 'test-backend';
      const error = new ConfigurationError('Invalid config', 'test');

      await circuitBreaker.recordFailure(backend, error);

      const state = await circuitBreaker.getState(backend);
      expect(state.failureCount).toBe(0);
    });
  });

  describe('Success Recording', () => {
    it('should reset failure count on success in CLOSED state', async () => {
      const backend = 'test-backend';
      const error = new RetryableError('Failure');

      // Record some failures (but not enough to open)
      await circuitBreaker.recordFailure(backend, error);
      await circuitBreaker.recordFailure(backend, error);

      let state = await circuitBreaker.getState(backend);
      expect(state.failureCount).toBe(2);

      // Record success
      await circuitBreaker.recordSuccess(backend);

      state = await circuitBreaker.getState(backend);
      expect(state.failureCount).toBe(0);
    });
  });

  describe('Manual Reset', () => {
    it('should reset circuit to CLOSED state', async () => {
      const backend = 'test-backend';
      const error = new RetryableError('Failure');

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await circuitBreaker.recordFailure(backend, error);
      }

      let state = await circuitBreaker.getState(backend);
      expect(state.state).toBe(CircuitState.OPEN);

      // Reset
      await circuitBreaker.reset(backend);

      state = await circuitBreaker.getState(backend);
      expect(state.state).toBe(CircuitState.CLOSED);
      expect(state.failureCount).toBe(0);
      expect(state.resetAttempts).toBe(0);
    });
  });

  describe('Retry Time Calculation', () => {
    it('should return null for CLOSED circuit', async () => {
      const state = await circuitBreaker.getState('test-backend');
      const retryTime = circuitBreaker.getRetryTime(state);
      expect(retryTime).toBeNull();
    });

    it('should calculate retry time for OPEN circuit', async () => {
      const backend = 'test-backend';
      const error = new RetryableError('Failure');

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await circuitBreaker.recordFailure(backend, error);
      }

      const state = await circuitBreaker.getState(backend);
      const retryTime = circuitBreaker.getRetryTime(state);

      expect(retryTime).not.toBeNull();
      expect(retryTime).toBeInstanceOf(Date);
      // Retry time should be in the future
      expect(retryTime!.getTime()).toBeGreaterThan(Date.now() - 100);
    });

    it('should apply exponential backoff on repeated failures', async () => {
      const backend = 'test-backend';
      const error = new RetryableError('Failure');

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        await circuitBreaker.recordFailure(backend, error);
      }

      // Wait for timeout and fail again
      await new Promise(resolve => setTimeout(resolve, 1100));
      await circuitBreaker.isOpen(backend); // Triggers HALF_OPEN
      await circuitBreaker.recordFailure(backend, error); // Back to OPEN

      const state = await circuitBreaker.getState(backend);
      expect(state.resetAttempts).toBe(1);
      // With 1 reset attempt, timeout should be doubled
    });
  });

  describe('State Persistence', () => {
    it('should persist state to file', async () => {
      const backend = 'test-backend';
      const error = new RetryableError('Failure');

      await circuitBreaker.recordFailure(backend, error);

      // Read file directly
      const content = await fs.readFile(stateFilePath, 'utf-8');
      const data = JSON.parse(content);

      expect(data.version).toBe('1.0.0');
      expect(data.backends[backend]).toBeDefined();
      expect(data.backends[backend].failureCount).toBe(1);
    });

    it('should load state from file on new instance', async () => {
      const backend = 'test-backend';
      const error = new RetryableError('Failure');

      // Record failures with first instance
      for (let i = 0; i < 3; i++) {
        await circuitBreaker.recordFailure(backend, error);
      }

      // Create new instance
      const newCircuitBreaker = new CircuitBreaker(stateFilePath, defaultConfig);
      const state = await newCircuitBreaker.getState(backend);

      expect(state.state).toBe(CircuitState.OPEN);
      expect(state.failureCount).toBe(3);
    });

    it('should handle missing state file gracefully', async () => {
      const nonExistentPath = join(testDir, 'non-existent', 'state.json');
      const cb = new CircuitBreaker(nonExistentPath, defaultConfig);

      const state = await cb.getState('test-backend');
      expect(state.state).toBe(CircuitState.CLOSED);
    });

    it('should handle corrupted state file gracefully', async () => {
      // Write invalid JSON
      await fs.mkdir(testDir, { recursive: true });
      await fs.writeFile(stateFilePath, 'not valid json');

      const state = await circuitBreaker.getState('test-backend');
      expect(state.state).toBe(CircuitState.CLOSED);
    });
  });

  describe('Multiple Backends', () => {
    it('should track state independently for each backend', async () => {
      const error = new RetryableError('Failure');

      // Open circuit for backend1
      for (let i = 0; i < 3; i++) {
        await circuitBreaker.recordFailure('backend1', error);
      }

      // Record one failure for backend2
      await circuitBreaker.recordFailure('backend2', error);

      const state1 = await circuitBreaker.getState('backend1');
      const state2 = await circuitBreaker.getState('backend2');

      expect(state1.state).toBe(CircuitState.OPEN);
      expect(state2.state).toBe(CircuitState.CLOSED);
      expect(state2.failureCount).toBe(1);
    });

    it('should return all states', async () => {
      const error = new RetryableError('Failure');

      await circuitBreaker.recordFailure('backend1', error);
      await circuitBreaker.recordSuccess('backend2');

      const allStates = await circuitBreaker.getAllStates();

      expect(allStates['backend1']).toBeDefined();
      expect(allStates['backend1'].failureCount).toBe(1);
    });
  });
});
