/**
 * Error utilities tests
 * Validates isRetryableError classification and custom error types
 */

import { describe, it, expect } from 'vitest';
import {
  isRetryableError,
  RetryableError,
  NonRetryableError,
  BackendNotFoundError,
  TimeoutError,
  RateLimitError,
  ConfigurationError,
  CircuitOpenError,
} from '../../src/utils/errors.js';

describe('isRetryableError', () => {
  describe('typed error classes', () => {
    it('returns true for RetryableError instances', () => {
      expect(isRetryableError(new RetryableError('transient'))).toBe(true);
    });

    it('returns true for TimeoutError instances', () => {
      expect(isRetryableError(new TimeoutError(5000, 'test'))).toBe(true);
    });

    it('returns true for RateLimitError instances', () => {
      expect(isRetryableError(new RateLimitError(1000))).toBe(true);
    });

    it('returns false for NonRetryableError instances', () => {
      expect(isRetryableError(new NonRetryableError('permanent'))).toBe(false);
    });

    it('returns false for BackendNotFoundError instances', () => {
      expect(isRetryableError(new BackendNotFoundError('claude'))).toBe(false);
    });

    it('returns false for ConfigurationError instances', () => {
      expect(isRetryableError(new ConfigurationError('bad config'))).toBe(
        false
      );
    });

    it('returns false for CircuitOpenError instances', () => {
      expect(isRetryableError(new CircuitOpenError('claude'))).toBe(false);
    });
  });

  describe('generic Error message matching', () => {
    it('detects timeout patterns', () => {
      expect(isRetryableError(new Error('Connection timeout'))).toBe(true);
      expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
    });

    it('detects connection errors', () => {
      expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
      expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
    });

    it('detects rate limit patterns', () => {
      expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true);
      expect(isRetryableError(new Error('Too Many Requests'))).toBe(true);
    });

    it('detects HTTP status code patterns', () => {
      expect(isRetryableError(new Error('HTTP 429 Too Many Requests'))).toBe(
        true
      );
      expect(isRetryableError(new Error('HTTP 503 Service Unavailable'))).toBe(
        true
      );
      expect(isRetryableError(new Error('HTTP 502 Bad Gateway'))).toBe(true);
    });

    it('detects service unavailable', () => {
      expect(isRetryableError(new Error('service unavailable'))).toBe(true);
    });

    it('returns false for business logic errors', () => {
      expect(isRetryableError(new Error('Invalid input'))).toBe(false);
      expect(isRetryableError(new Error('File not found'))).toBe(false);
      expect(isRetryableError(new Error('Permission denied'))).toBe(false);
    });

    it('is case insensitive', () => {
      expect(isRetryableError(new Error('TIMEOUT'))).toBe(true);
      expect(isRetryableError(new Error('Rate Limit'))).toBe(true);
      expect(isRetryableError(new Error('SERVICE UNAVAILABLE'))).toBe(true);
    });
  });

  describe('known false-positive: substring matching', () => {
    // These document the current behavior — substring matching means
    // '429' in any context triggers retryable classification.
    // If refactored to word-boundary matching, these expectations should flip.
    it('matches "429" even in data context (known limitation)', () => {
      // This IS a false positive — "429" is data, not an HTTP status
      const result = isRetryableError(new Error('processed 429 records'));
      // Document the current behavior: substring match returns true
      expect(result).toBe(true);
    });

    it('matches "503" even in non-HTTP context (known limitation)', () => {
      const result = isRetryableError(new Error('user ID 503 not found'));
      expect(result).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('returns false for non-Error objects', () => {
      expect(isRetryableError('string error')).toBe(false);
      expect(isRetryableError(42)).toBe(false);
      expect(isRetryableError(null)).toBe(false);
      expect(isRetryableError(undefined)).toBe(false);
      expect(isRetryableError({})).toBe(false);
    });

    it('returns false for Error with empty message', () => {
      expect(isRetryableError(new Error(''))).toBe(false);
    });

    it('prioritizes NonRetryableError over message matching', () => {
      // A NonRetryableError with "timeout" in the message should NOT be retryable
      const error = new NonRetryableError('timeout in configuration');
      expect(isRetryableError(error)).toBe(false);
    });

    it('prioritizes RetryableError over message content', () => {
      const error = new RetryableError('some unrecognized message');
      expect(isRetryableError(error)).toBe(true);
    });
  });
});

describe('error class hierarchy', () => {
  it('RetryableError has correct name and optional retryAfter', () => {
    const error = new RetryableError('test', 5000);
    expect(error.name).toBe('RetryableError');
    expect(error.retryAfter).toBe(5000);
    expect(error).toBeInstanceOf(Error);
  });

  it('NonRetryableError has correct name', () => {
    const error = new NonRetryableError('test');
    expect(error.name).toBe('NonRetryableError');
    expect(error).toBeInstanceOf(Error);
  });

  it('BackendNotFoundError includes install instructions', () => {
    const error = new BackendNotFoundError('claude', 'npm install -g claude');
    expect(error.name).toBe('BackendNotFoundError');
    expect(error.backend).toBe('claude');
    expect(error.installInstructions).toBe('npm install -g claude');
    expect(error.message).toContain('claude');
    expect(error.message).toContain('npm install -g claude');
    expect(error).toBeInstanceOf(NonRetryableError);
  });

  it('TimeoutError includes timeout value and operation', () => {
    const error = new TimeoutError(5000, 'CLI execution');
    expect(error.name).toBe('TimeoutError');
    expect(error.timeoutMs).toBe(5000);
    expect(error.operation).toBe('CLI execution');
    expect(error.message).toContain('5000');
    expect(error).toBeInstanceOf(RetryableError);
  });

  it('RateLimitError includes retry after', () => {
    const error = new RateLimitError(30000);
    expect(error.name).toBe('RateLimitError');
    expect(error.retryAfter).toBe(30000);
    expect(error).toBeInstanceOf(RetryableError);
  });

  it('ConfigurationError includes config key', () => {
    const error = new ConfigurationError('invalid', 'api_key');
    expect(error.name).toBe('ConfigurationError');
    expect(error.configKey).toBe('api_key');
    expect(error).toBeInstanceOf(NonRetryableError);
  });

  it('CircuitOpenError includes backend and retryAt', () => {
    const retryAt = new Date();
    const error = new CircuitOpenError('claude', retryAt);
    expect(error.name).toBe('CircuitOpenError');
    expect(error.backend).toBe('claude');
    expect(error.retryAt).toBe(retryAt);
    expect(error.message).toContain('claude');
    expect(error).toBeInstanceOf(NonRetryableError);
  });
});
