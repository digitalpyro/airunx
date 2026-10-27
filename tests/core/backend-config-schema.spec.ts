import { describe, it, expect } from 'vitest';
import { BackendConfigSchema } from '../../src/core/adapter-types.js';

describe('BackendConfigSchema mcp_config', () => {
  it('accepts absolute paths and inline JSON, alone or in a list', () => {
    expect(
      BackendConfigSchema.safeParse({
        type: 'cli',
        mcp_config: '/etc/airunx/mcp.json',
      }).success
    ).toBe(true);
    expect(
      BackendConfigSchema.safeParse({
        type: 'cli',
        mcp_config: ['/a/mcp.json', '{"mcpServers":{}}'],
      }).success
    ).toBe(true);
  });

  it('rejects values that would inject CLI flags', () => {
    expect(
      BackendConfigSchema.safeParse({
        type: 'cli',
        mcp_config: '--dangerously-skip-permissions',
      }).success
    ).toBe(false);
    expect(
      BackendConfigSchema.safeParse({
        type: 'cli',
        mcp_config: ['/a/mcp.json', '-p'],
      }).success
    ).toBe(false);
  });

  it('rejects relative paths, which would not resolve inside a worktree', () => {
    expect(
      BackendConfigSchema.safeParse({
        type: 'cli',
        mcp_config: '.airunx/mcp.json',
      }).success
    ).toBe(false);
  });
});
