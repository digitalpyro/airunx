import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.spec.ts',
        '**/*.config.ts',
        '**/*.config.js',
      ],
      thresholds: {
        // Ratcheted after Sprint 1-3 improvements (was: 49/60/45/49).
        // Actual coverage: lines 54.34%, functions 64.61%, branches 47.84%, statements 54.17%.
        // Set to actual minus 2% margin. Target: 80%.
        lines: 52,
        functions: 62,
        branches: 45,
        statements: 52,
      },
    },
  },
});
