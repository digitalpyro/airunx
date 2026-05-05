/**
 * Tests for Error Handlers
 * Validates error handling utilities for configuration and commands
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleConfigError, handleCommandError } from '../../src/utils/error-handlers.js';
import { z } from 'zod';
import { YAMLParseError } from 'yaml';
import type { Logger } from '../../src/utils/logger.js';

describe('Error Handlers', () => {
  describe('handleConfigError', () => {
    it('should format Zod validation errors with field paths', () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
        email: z.string().email(),
      });

      try {
        schema.parse({
          name: 123, // Should be string
          age: 'invalid', // Should be number
          email: 'not-an-email',
        });
      } catch (zodError) {
        expect(() => {
          handleConfigError(zodError, 'pipeline', '/path/to/config.yaml');
        }).toThrow(/Invalid pipeline configuration/);

        try {
          handleConfigError(zodError, 'pipeline', '/path/to/config.yaml');
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          if (error instanceof Error) {
            expect(error.message).toContain('Invalid pipeline configuration');
            expect(error.message).toContain('name:');
            expect(error.message).toContain('age:');
            expect(error.message).toContain('email:');
            expect(error.cause).toBe(zodError);
          }
        }
      }
    });

    it('should format Zod errors with nested field paths', () => {
      const schema = z.object({
        user: z.object({
          profile: z.object({
            name: z.string(),
          }),
        }),
      });

      try {
        schema.parse({ user: { profile: { name: 123 } } });
      } catch (zodError) {
        try {
          handleConfigError(zodError, 'system', '/config.yaml');
        } catch (error) {
          if (error instanceof Error) {
            expect(error.message).toContain('user.profile.name');
          }
        }
      }
    });

    it('should handle YAML parsing errors', () => {
      const yamlError = new YAMLParseError(
        [10, 5],
        'UNEXPECTED_TOKEN',
        'Unexpected token'
      );

      expect(() => {
        handleConfigError(yamlError, 'pipeline', '/path/to/config.yaml');
      }).toThrow(/Invalid YAML in pipeline config/);

      try {
        handleConfigError(yamlError, 'pipeline', '/path/to/config.yaml');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.message).toContain('Invalid YAML');
          expect(error.message).toContain('pipeline config');
          expect(error.message).toContain('/path/to/config.yaml');
          expect(error.cause).toBe(yamlError);
        }
      }
    });

    it('should handle generic Error instances', () => {
      const genericError = new Error('File not found');

      expect(() => {
        handleConfigError(genericError, 'system', '/path/to/config.yaml');
      }).toThrow(/Failed to load system config/);

      try {
        handleConfigError(genericError, 'system', '/path/to/config.yaml');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.message).toContain('Failed to load system config');
          expect(error.message).toContain('/path/to/config.yaml');
          expect(error.message).toContain('File not found');
          expect(error.cause).toBe(genericError);
        }
      }
    });

    it('should handle unknown error types', () => {
      const unknownError = { weird: 'object' };

      expect(() => {
        handleConfigError(unknownError, 'pipeline', '/config.yaml');
      }).toThrow(/An unknown error occurred/);

      try {
        handleConfigError(unknownError, 'pipeline', '/config.yaml');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.message).toContain('An unknown error occurred');
          expect(error.message).toContain('pipeline config');
          expect(error.message).toContain('/config.yaml');
          expect(error.cause).toBe(unknownError);
        }
      }
    });

    it('should handle string errors', () => {
      const stringError = 'Something went wrong';

      try {
        handleConfigError(stringError, 'agent', '/agents.yaml');
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).toContain('An unknown error occurred');
          expect(error.message).toContain('Something went wrong');
        }
      }
    });

    it('should handle null errors', () => {
      try {
        handleConfigError(null, 'pipeline', '/config.yaml');
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).toContain('An unknown error occurred');
          expect(error.message).toContain('null');
        }
      }
    });

    it('should handle undefined errors', () => {
      try {
        handleConfigError(undefined, 'system', '/config.yaml');
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).toContain('An unknown error occurred');
          expect(error.message).toContain('undefined');
        }
      }
    });
  });

  describe('handleCommandError', () => {
    let mockLogger: Logger;

    beforeEach(() => {
      mockLogger = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        success: vi.fn(),
      } as unknown as Logger;
    });

    it('should log Error instances with message and error object', () => {
      const error = new Error('Command execution failed');

      handleCommandError(error, mockLogger, 'Initialization');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Initialization failed: Command execution failed',
        error
      );
    });

    it('should log Error instances with stack traces', () => {
      const error = new Error('Test error');
      error.stack = 'Error: Test error\n  at test.ts:10:5';

      handleCommandError(error, mockLogger, 'Execution');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Execution failed: Test error',
        error
      );
    });

    it('should handle string errors', () => {
      const stringError = 'String error message';

      handleCommandError(stringError, mockLogger, 'Processing');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Processing failed with an unknown error: String error message',
        expect.any(Error)
      );

      const loggedError = (mockLogger.error as any).mock.calls[0][1];
      expect(loggedError.message).toBe('String error message');
      expect(loggedError.cause).toBe(stringError);
    });

    it('should handle object errors', () => {
      const objectError = { code: 'ERR_UNKNOWN', details: 'Something broke' };

      handleCommandError(objectError, mockLogger, 'Validation');

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Validation failed with an unknown error'),
        expect.any(Error)
      );

      const errorMessage = (mockLogger.error as any).mock.calls[0][0];
      // Object.toString() returns '[object Object]', not the JSON content
      expect(errorMessage).toContain('[object Object]');
    });

    it('should handle null errors', () => {
      handleCommandError(null, mockLogger, 'Operation');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Operation failed with an unknown error: null',
        expect.any(Error)
      );
    });

    it('should handle undefined errors', () => {
      handleCommandError(undefined, mockLogger, 'Task');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Task failed with an unknown error: undefined',
        expect.any(Error)
      );
    });

    it('should handle numeric errors', () => {
      handleCommandError(42, mockLogger, 'Calculation');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Calculation failed with an unknown error: 42',
        expect.any(Error)
      );
    });

    it('should preserve error context with different prefixes', () => {
      const error = new Error('Network timeout');

      handleCommandError(error, mockLogger, 'Network Request');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Network Request failed: Network timeout',
        error
      );
    });

    it('should handle errors with custom properties', () => {
      class CustomError extends Error {
        code: string;
        statusCode: number;

        constructor(message: string, code: string, statusCode: number) {
          super(message);
          this.code = code;
          this.statusCode = statusCode;
        }
      }

      const customError = new CustomError('API Error', 'ERR_API', 500);

      handleCommandError(customError, mockLogger, 'API Call');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'API Call failed: API Error',
        customError
      );

      const loggedError = (mockLogger.error as any).mock.calls[0][1];
      expect(loggedError).toBe(customError);
      expect(loggedError.code).toBe('ERR_API');
      expect(loggedError.statusCode).toBe(500);
    });

    it('should not throw when handling errors', () => {
      const error = new Error('Test');

      expect(() => {
        handleCommandError(error, mockLogger, 'Test');
      }).not.toThrow();
    });
  });
});
