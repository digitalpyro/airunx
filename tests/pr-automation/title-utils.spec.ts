/**
 * Tests for title-utils
 * Validates commit type inference and PR title generation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowContext } from '../../src/core/types.js';

// Mock settings module
vi.mock('../../src/utils/settings.js', () => ({
  loadSettings: vi.fn(() => ({
    gh_pr_title_rules: null,
    gh_pr_label_rules: null,
  })),
}));

/**
 * Helper to create mock WorkflowContext with sensible defaults
 * Only specify the fields you care about for each test
 */
function createMockContext(
  overrides: Partial<WorkflowContext> = {}
): WorkflowContext {
  return {
    id: 'test-123',
    input: overrides.taskTitle || 'Test input',
    inputType: 'prompt',
    mode: 'pipeline',
    createdAt: new Date(),
    status: 'running',
    taskTitle: 'Default title',
    metrics: {
      tokensUsed: 0,
      runtimeMs: 0,
      totalTokens: 0,
      totalRuntimeMs: 0,
      totalCost: 0,
    },
    ...overrides,
  };
}

// Default settings with null rules (uses built-in defaults)
const defaultSettings = {
  gh_pr_title_rules: null,
  gh_pr_label_rules: null,
} as Parameters<
  typeof import('../../src/pr-automation/title-utils.js').inferCommitType
>[1];

describe('title-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('inferCommitType with default rules', () => {
    it('should return feat for generic feature titles', async () => {
      const { inferCommitType } = await import(
        '../../src/pr-automation/title-utils.js'
      );
      const context = createMockContext({ taskTitle: 'Add new authentication' });
      expect(inferCommitType(context, defaultSettings)).toBe('feat');
    });

    it('should infer fix type from bug keyword', async () => {
      const { inferCommitType } = await import(
        '../../src/pr-automation/title-utils.js'
      );
      const context = createMockContext({ taskTitle: 'Fix authentication bug' });
      expect(inferCommitType(context, defaultSettings)).toBe('fix');
    });

    it('should infer docs type from readme keyword', async () => {
      const { inferCommitType } = await import(
        '../../src/pr-automation/title-utils.js'
      );
      const context = createMockContext({ taskTitle: 'Update README' });
      expect(inferCommitType(context, defaultSettings)).toBe('docs');
    });
  });

  describe('false positive prevention', () => {
    it('should not match keywords in description', async () => {
      const { inferCommitType } = await import(
        '../../src/pr-automation/title-utils.js'
      );
      const context = createMockContext({
        taskTitle: 'eBay Inventory Mapping API',
        taskDescription:
          'Acceptance: PHPUnit tests for InventoryMapping service',
      });
      expect(inferCommitType(context, defaultSettings)).toBe('feat');
    });

    it('should match keywords in title only', async () => {
      const { inferCommitType } = await import(
        '../../src/pr-automation/title-utils.js'
      );
      const context = createMockContext({
        taskTitle: 'Add test coverage for auth module',
        taskDescription: 'Implement comprehensive testing',
      });
      expect(inferCommitType(context, defaultSettings)).toBe('test');
    });
  });

  describe('explicit type markers', () => {
    it('should extract type from marker in description', async () => {
      const { inferCommitType } = await import(
        '../../src/pr-automation/title-utils.js'
      );
      const context = createMockContext({
        taskTitle: 'Add new feature',
        taskDescription: 'This is a chore task [type: chore] with details',
      });
      expect(inferCommitType(context, defaultSettings)).toBe('chore');
    });

    it('should be case-insensitive for markers', async () => {
      const { inferCommitType } = await import(
        '../../src/pr-automation/title-utils.js'
      );
      const context = createMockContext({
        taskTitle: 'Update system',
        taskDescription: '[Type: DOCS] Update documentation',
      });
      expect(inferCommitType(context, defaultSettings)).toBe('docs');
    });

    it('should use first marker when multiple present', async () => {
      const { inferCommitType } = await import(
        '../../src/pr-automation/title-utils.js'
      );
      const context = createMockContext({
        taskTitle: 'Mixed signals',
        taskDescription: '[type: feat] first [type: fix] second',
      });
      expect(inferCommitType(context, defaultSettings)).toBe('feat');
    });

    it('should ignore malformed markers without space after colon', async () => {
      const { inferCommitType } = await import(
        '../../src/pr-automation/title-utils.js'
      );
      const context = createMockContext({
        taskTitle: 'eBay Inventory Mapping API',
        taskDescription: '[type:nospace] missing space',
      });
      expect(inferCommitType(context, defaultSettings)).toBe('feat');
    });
  });

  describe('precedence order', () => {
    it('should prioritize marker over title keyword', async () => {
      const { inferCommitType } = await import(
        '../../src/pr-automation/title-utils.js'
      );
      const context = createMockContext({
        taskTitle: 'Fix the bug in auth',
        taskDescription: '[type: feat] This is actually a feature',
      });
      expect(inferCommitType(context, defaultSettings)).toBe('feat');
    });
  });

  describe('inferCommitType with custom rules', () => {
    it('should use custom mappings from settings', async () => {
      const { inferCommitType } = await import(
        '../../src/pr-automation/title-utils.js'
      );
      const customSettings = {
        gh_pr_title_rules: {
          hotfix: ['urgent', 'critical'],
          perf: ['performance', 'optimize'],
          default: 'chore',
        },
        gh_pr_label_rules: null,
      } as Parameters<typeof inferCommitType>[1];

      const context = createMockContext({ taskTitle: 'Urgent security patch' });
      expect(inferCommitType(context, customSettings)).toBe('hotfix');
    });

    it('should use custom default type when no keywords match', async () => {
      const { inferCommitType } = await import(
        '../../src/pr-automation/title-utils.js'
      );
      const customSettings = {
        gh_pr_title_rules: {
          fix: ['fix', 'bug'],
          default: 'chore',
        },
        gh_pr_label_rules: null,
      } as Parameters<typeof inferCommitType>[1];

      const context = createMockContext({ taskTitle: 'Random update' });
      expect(inferCommitType(context, customSettings)).toBe('chore');
    });

    it('should handle string keyword (single value instead of array)', async () => {
      const { inferCommitType } = await import(
        '../../src/pr-automation/title-utils.js'
      );
      const customSettings = {
        gh_pr_title_rules: {
          ci: 'pipeline',
          default: 'feat',
        },
        gh_pr_label_rules: null,
      } as Parameters<typeof inferCommitType>[1];

      const context = createMockContext({ taskTitle: 'Update CI pipeline config' });
      expect(inferCommitType(context, customSettings)).toBe('ci');
    });
  });

  describe('generateConventionalTitle', () => {
    beforeEach(() => {
      vi.resetModules();
      vi.doMock('../../src/utils/settings.js', () => ({
        loadSettings: vi.fn(() => ({
          gh_pr_title_rules: null,
          gh_pr_label_rules: null,
        })),
      }));
    });

    it('should generate title with inferred commit type', async () => {
      const { generateConventionalTitle } = await import(
        '../../src/pr-automation/title-utils.js'
      );
      const context = createMockContext({ taskTitle: 'Add user authentication' });
      expect(generateConventionalTitle(context)).toBe(
        'feat: Add user authentication'
      );
    });

    it('should use override type when provided', async () => {
      const { generateConventionalTitle } = await import(
        '../../src/pr-automation/title-utils.js'
      );
      const context = createMockContext({ taskTitle: 'Add user authentication' });
      expect(generateConventionalTitle(context, 'chore')).toBe(
        'chore: Add user authentication'
      );
    });

    it('should remove existing commit prefix from title', async () => {
      const { generateConventionalTitle } = await import(
        '../../src/pr-automation/title-utils.js'
      );
      const context = createMockContext({ taskTitle: 'fix: Fix the login bug' });
      const title = generateConventionalTitle(context);
      expect(title).toBe('fix: Fix the login bug');
      expect(title).not.toBe('fix: fix: Fix the login bug');
    });

    it('should truncate long titles', async () => {
      const { generateConventionalTitle } = await import(
        '../../src/pr-automation/title-utils.js'
      );
      const longTitle =
        'Add a very long feature that requires an extremely detailed description that exceeds the maximum length';
      const context = createMockContext({ taskTitle: longTitle });
      const title = generateConventionalTitle(context);
      expect(title.length).toBeLessThanOrEqual(72);
      expect(title).toMatch(/\.\.\.$/);
    });
  });
});
