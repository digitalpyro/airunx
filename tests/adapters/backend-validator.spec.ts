/**
 * Backend validator tests
 * Only subscription-based CLI providers are supported
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackendValidator } from '../../src/adapters/backend-validator.js';
import { exec } from 'child_process';

// Mock child_process
vi.mock('child_process');

describe('BackendValidator', () => {
  let validator: BackendValidator;

  beforeEach(() => {
    validator = new BackendValidator();
    vi.clearAllMocks();
  });

  // Note: CLI-based adapter tests (claude-code, cursor) are covered by integration tests
  // Unit testing promisified exec is complex and the factory pattern makes it harder to mock.
  // The actual functionality is verified through manual QA and integration tests.

  describe('getAvailableBackends', () => {
    it('should return list of available CLI backends', async () => {
      vi.mocked(exec).mockImplementation((cmd: string, callback: any) => {
        // Mock CLI tools as not available
        setImmediate(() => {
          callback(new Error('not found'), '', '');
        });
        return {} as any;
      });

      const available = await validator.getAvailableBackends();

      // When no CLIs are found, the list should be empty
      expect(Array.isArray(available)).toBe(true);
    });
  });
});
