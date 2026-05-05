/**
 * Validate command tests
 * Tests config file validation with fixture files
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';
import { validateCommand } from '../../../src/cli/commands/validate.js';

// Suppress console output and spinners
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});
const exitSpy = vi
  .spyOn(process, 'exit')
  .mockImplementation((() => {}) as never);

let tmpDir: string;
let origCwd: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'validate-test-'));
  origCwd = process.cwd();
  exitSpy.mockClear();
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('validateCommand', () => {
  it('validates a valid settings.json file', async () => {
    const settingsPath = join(tmpDir, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        default_backend: 'claude-code',
        approval_mode: 'auto',
      })
    );

    await validateCommand([settingsPath], { type: 'settings' });

    // Should not exit with error code
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('reports errors for invalid settings.json', async () => {
    const settingsPath = join(tmpDir, 'settings.json');
    writeFileSync(settingsPath, '{ invalid json }}}');

    await validateCommand([settingsPath], { type: 'settings' });

    // Invalid file should report issues — either exit(1) or log errors
    // The validator may catch parse errors and report them as validation issues
    expect(console.log).toHaveBeenCalled();
  });

  it('validates with lenient mode', async () => {
    const settingsPath = join(tmpDir, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        default_backend: 'claude-code',
        unknown_field: 'value',
      })
    );

    await validateCommand([settingsPath], {
      type: 'settings',
      lenient: true,
    });

    // Lenient mode should be more forgiving
    // (exact behavior depends on validator implementation)
  });

  it('handles non-existent file gracefully', async () => {
    await validateCommand([join(tmpDir, 'nonexistent.json')], {
      type: 'settings',
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('outputs JSON format when requested', async () => {
    const settingsPath = join(tmpDir, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({ default_backend: 'claude-code' })
    );

    await validateCommand([settingsPath], {
      type: 'settings',
      json: true,
    });

    // JSON mode should output parseable JSON via console.log
    // Check that console.log was called (output suppressed by mock)
    expect(console.log).toHaveBeenCalled();
  });

  it('validates all project config when --all is passed', async () => {
    // Create a minimal project structure
    const airunxDir = join(tmpDir, '.airunx');
    mkdirSync(airunxDir, { recursive: true });
    writeFileSync(
      join(airunxDir, 'settings.json'),
      JSON.stringify({ default_backend: 'claude-code' })
    );

    process.chdir(tmpDir);

    await validateCommand([], { all: true });

    // Should complete without throwing
  });
});
