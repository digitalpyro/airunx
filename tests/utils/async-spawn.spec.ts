/**
 * spawnAsync tests — provider admin keys never reach the child
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnAsync } from '../../src/utils/async-spawn.js';
import {
  PROVIDER_ADMIN_KEY_DENYLIST,
  withoutProviderAdminKeys,
} from '../../src/utils/env-filter.js';

const PRINT_ENV = ['-e', 'process.stdout.write(JSON.stringify(process.env))'];

const childEnv = async (
  env?: Record<string, string | undefined>
): Promise<Record<string, string>> => {
  const result = await spawnAsync(process.execPath, PRINT_ENV, {
    timeout: 10_000,
    ...(env ? { env } : {}),
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
};

describe('spawnAsync env filtering', () => {
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of PROVIDER_ADMIN_KEY_DENYLIST) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('strips admin keys from the default (process.env) environment', async () => {
    for (const key of PROVIDER_ADMIN_KEY_DENYLIST) {
      saved[key] = process.env[key];
      process.env[key] = 'sk-admin-secret';
    }
    process.env.AIRUNX_SPAWN_TEST_MARKER = 'kept';
    try {
      const env = await childEnv();
      expect(env.AIRUNX_SPAWN_TEST_MARKER).toBe('kept');
      for (const key of PROVIDER_ADMIN_KEY_DENYLIST) {
        expect(env[key]).toBeUndefined();
      }
    } finally {
      delete process.env.AIRUNX_SPAWN_TEST_MARKER;
    }
  });

  it('strips admin keys from an explicitly provided environment', async () => {
    const explicit: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      ANTHROPIC_ADMIN_KEY: 'sk-ant-admin-x',
      OPENAI_ADMIN_KEY: 'sk-admin-y',
      KEEP_ME: '1',
    };
    const env = await childEnv(explicit);
    expect(env.KEEP_ME).toBe('1');
    expect(env.ANTHROPIC_ADMIN_KEY).toBeUndefined();
    expect(env.OPENAI_ADMIN_KEY).toBeUndefined();
    // Caller's object is not mutated
    expect(explicit.ANTHROPIC_ADMIN_KEY).toBe('sk-ant-admin-x');
  });
});

describe('withoutProviderAdminKeys', () => {
  it('returns a copy without the denylisted keys', () => {
    const input = { ANTHROPIC_ADMIN_KEY: 'a', OPENAI_ADMIN_KEY: 'b', X: 'c' };
    expect(withoutProviderAdminKeys(input)).toEqual({ X: 'c' });
    expect(input.ANTHROPIC_ADMIN_KEY).toBe('a');
  });
});
