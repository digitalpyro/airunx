import { describe, it, expect } from 'vitest';

describe('CLI', () => {
  it('should be testable', () => {
    expect(true).toBe(true);
  });

  it('should have proper package structure', async () => {
    // This test ensures the test infrastructure is working
    const packageJson = (
      await import('../../package.json', { with: { type: 'json' } })
    ).default;
    expect(packageJson.name).toBe('airunx');
    expect(packageJson.version).toBeDefined();
  });
});
