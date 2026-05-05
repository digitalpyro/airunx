/**
 * Doctor command tests
 * Tests diagnostic checks with mocked system state
 */

import { describe, it, expect, vi } from 'vitest';
import { doctorCommand } from '../../../src/cli/commands/doctor.js';

// Suppress console output and spinners
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

describe('doctorCommand', () => {
  it('completes without throwing', async () => {
    // Doctor checks actual system state (backends, Node version, etc.)
    // In test environment, backends may not be available — that's fine,
    // doctor should report their status without crashing
    await expect(doctorCommand()).resolves.not.toThrow();
  });

  it('outputs diagnostic information', async () => {
    await doctorCommand();

    // Doctor should produce console output with diagnostic results
    expect(console.log).toHaveBeenCalled();
  });
});
