/**
 * Custom error classes for categorized error handling
 * Enables smart retry logic - some errors should not be retried
 */

/**
 * Base error class for retryable errors
 * These errors might succeed if retried (e.g., timeouts, rate limits)
 */
export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly retryAfter?: number
  ) {
    super(message);
    this.name = 'RetryableError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RetryableError);
    }
  }
}

/**
 * Base error class for non-retryable errors
 * These errors will not succeed if retried (e.g., config errors, missing files)
 */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, NonRetryableError);
    }
  }
}

/**
 * Backend CLI not found error
 * This is non-retryable - the CLI must be installed first
 */
export class BackendNotFoundError extends NonRetryableError {
  constructor(
    public readonly backend: string,
    public readonly installInstructions?: string
  ) {
    super(
      `Backend CLI not found: ${backend}` +
        (installInstructions ? `\nInstallation: ${installInstructions}` : '')
    );
    this.name = 'BackendNotFoundError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, BackendNotFoundError);
    }
  }
}

/**
 * Timeout error
 * This is retryable - the operation might succeed with more time
 */
export class TimeoutError extends RetryableError {
  constructor(
    public readonly timeoutMs: number,
    public readonly operation?: string
  ) {
    super(
      `${operation || 'Execution'} timed out after ${timeoutMs}ms`,
      undefined
    );
    this.name = 'TimeoutError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TimeoutError);
    }
  }
}

/**
 * Rate limit error
 * This is retryable - should wait for retryAfter period
 */
export class RateLimitError extends RetryableError {
  constructor(retryAfterMs?: number) {
    super(
      'Rate limit exceeded' +
        (retryAfterMs ? `. Retry after ${retryAfterMs}ms` : ''),
      retryAfterMs
    );
    this.name = 'RateLimitError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RateLimitError);
    }
  }
}

/**
 * Configuration error
 * This is non-retryable - config must be fixed first
 */
export class ConfigurationError extends NonRetryableError {
  constructor(
    message: string,
    public readonly configKey?: string
  ) {
    super(message);
    this.name = 'ConfigurationError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ConfigurationError);
    }
  }
}

/**
 * Circuit breaker open error
 * This is non-retryable - the circuit must reset first
 */
export class CircuitOpenError extends NonRetryableError {
  constructor(
    public readonly backend: string,
    public readonly retryAt?: Date
  ) {
    super(
      `Backend '${backend}' circuit is OPEN. ` +
        (retryAt ? `Will retry at ${retryAt.toISOString()}. ` : '') +
        `Run 'airunx doctor' for status or 'airunx circuit reset ${backend}' to reset.`
    );
    this.name = 'CircuitOpenError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CircuitOpenError);
    }
  }
}

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof NonRetryableError) {
    return false;
  }
  if (error instanceof RetryableError) {
    return true;
  }
  // For generic errors, check the message for common retryable patterns
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const retryablePatterns = [
      'timeout',
      'etimedout',
      'econnreset',
      'econnrefused',
      'rate limit',
      'too many requests',
      '429',
      '503',
      '502',
      'service unavailable',
    ];
    return retryablePatterns.some((pattern) => message.includes(pattern));
  }
  return false;
}
