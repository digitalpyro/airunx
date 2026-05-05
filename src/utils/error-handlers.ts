/**
 * Shared error handling utilities
 */

import { z } from 'zod';
import { YAMLError } from 'yaml';
import type { Logger } from './logger.js';

/**
 * Converts an unknown value to an Error instance.
 * Useful for normalizing caught errors in try/catch blocks.
 *
 * @param error - The unknown error value to convert
 * @returns An Error instance
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

/**
 * Handles configuration parsing errors with detailed formatting
 *
 * @param error - The error thrown during config parsing
 * @param configType - The type of config (e.g., 'pipeline', 'system')
 * @param path - The file path where the error occurred
 * @throws Error with formatted message and preserved cause
 */
export function handleConfigError(
  error: unknown,
  configType: string,
  path: string
): never {
  if (error instanceof z.ZodError) {
    const formattedIssues = error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid ${configType} configuration:\n${formattedIssues}`,
      {
        cause: error,
      }
    );
  } else if (error instanceof YAMLError) {
    throw new Error(
      `Invalid YAML in ${configType} config at '${path}': ${error.message}`,
      { cause: error }
    );
  } else if (error instanceof Error) {
    throw new Error(
      `Failed to load ${configType} config from '${path}': ${error.message}`,
      {
        cause: error,
      }
    );
  } else {
    throw new Error(
      `An unknown error occurred while loading ${configType} config from '${path}': ${String(error)}`,
      { cause: error }
    );
  }
}

/**
 * Handles CLI command errors with consistent logging
 *
 * @param error - The error thrown during command execution
 * @param logger - The logger instance to use
 * @param messagePrefix - The prefix for error messages (e.g., 'Initialization', 'Execution')
 */
export function handleCommandError(
  error: unknown,
  logger: Logger,
  messagePrefix: string
): void {
  if (error instanceof Error) {
    logger.error(`${messagePrefix} failed: ${error.message}`, error);
  } else {
    const errorMessage = String(error);
    logger.error(
      `${messagePrefix} failed with an unknown error: ${errorMessage}`,
      new Error(errorMessage, { cause: error })
    );
  }
}
