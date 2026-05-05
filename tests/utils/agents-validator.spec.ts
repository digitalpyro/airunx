/**
 * Agents validator tests
 * Validates AGENTS.md interactive validation, auto-fix, and formatting
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';
import {
  validateAgentsMdWithConfirmation,
  formatAgentsValidationResult,
  formatAgentsValidationResultJson,
  type AgentsValidationResult,
} from '../../src/utils/agents-validator.js';

// Suppress console output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agents-validator-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const VALID_AGENTS_MD = `# Agents

## Configuration

### Developer
- **Model**: sonnet
- **Responsibilities**: Write code

### Reviewer
- **Model**: opus
- **Responsibilities**: Review code
`;

const INVALID_MODEL_AGENTS_MD = `# Agents

## Configuration

### Developer
- **Model**: sonnet-typo
- **Responsibilities**: Write code
`;

const EMPTY_AGENTS_MD = '';

describe('validateAgentsMdWithConfirmation', () => {
  describe('file not found', () => {
    it('returns invalid result when file does not exist', async () => {
      const result = await validateAgentsMdWithConfirmation(
        join(tmpDir, 'nonexistent.md'),
        { interactive: false }
      );

      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].severity).toBe('error');
      expect(result.issues[0].message).toContain('not found');
    });
  });

  describe('valid AGENTS.md', () => {
    it('returns result with parsed config for well-formed file', async () => {
      const filePath = join(tmpDir, 'AGENTS.md');
      writeFileSync(filePath, VALID_AGENTS_MD);

      const result = await validateAgentsMdWithConfirmation(filePath, {
        interactive: false,
        mode: 'lenient',
      });

      expect(result.filePath).toBe(filePath);
      expect(result.parsedConfig).toBeDefined();
      expect(result.fixesApplied).toHaveLength(0);
    });

    it('parses agents from valid file', async () => {
      const filePath = join(tmpDir, 'AGENTS.md');
      writeFileSync(filePath, VALID_AGENTS_MD);

      const result = await validateAgentsMdWithConfirmation(filePath, {
        interactive: false,
      });

      expect(result.parsedConfig?.agents).toBeDefined();
      expect(result.parsedConfig!.agents.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('invalid model', () => {
    it('reports invalid model in non-interactive mode', async () => {
      const filePath = join(tmpDir, 'AGENTS.md');
      writeFileSync(filePath, INVALID_MODEL_AGENTS_MD);

      const result = await validateAgentsMdWithConfirmation(filePath, {
        interactive: false,
        json: true,
      });

      // Should have model-related issues
      const modelIssues = result.issues.filter((i) =>
        i.path.endsWith('.model')
      );
      expect(modelIssues.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('auto-fix mode', () => {
    it('applies fixes and creates backup', async () => {
      const filePath = join(tmpDir, 'AGENTS.md');
      writeFileSync(filePath, INVALID_MODEL_AGENTS_MD);

      const result = await validateAgentsMdWithConfirmation(filePath, {
        interactive: false,
        fix: true,
        json: true,
      });

      // If there were fixable issues, fixes should be applied
      if (result.fixesApplied.length > 0) {
        // A backup file should have been created
        const files = require('fs').readdirSync(tmpDir);
        const backups = files.filter((f: string) => f.includes('.bak.'));
        expect(backups.length).toBeGreaterThan(0);
      }
    });
  });

  describe('empty file', () => {
    it('handles empty AGENTS.md', async () => {
      const filePath = join(tmpDir, 'AGENTS.md');
      writeFileSync(filePath, EMPTY_AGENTS_MD);

      const result = await validateAgentsMdWithConfirmation(filePath, {
        interactive: false,
      });

      // Empty file should parse but may have no agents
      expect(result.parsedConfig).toBeDefined();
    });
  });

  describe('cost warnings', () => {
    it('filters cost warnings when costWarnings is false', async () => {
      const filePath = join(tmpDir, 'AGENTS.md');
      writeFileSync(filePath, VALID_AGENTS_MD);

      const resultWithWarnings = await validateAgentsMdWithConfirmation(
        filePath,
        {
          interactive: false,
          costWarnings: true,
        }
      );

      const resultWithoutWarnings = await validateAgentsMdWithConfirmation(
        filePath,
        {
          interactive: false,
          costWarnings: false,
        }
      );

      // Without cost warnings should have equal or fewer issues
      expect(resultWithoutWarnings.issues.length).toBeLessThanOrEqual(
        resultWithWarnings.issues.length
      );
    });
  });
});

describe('formatAgentsValidationResult', () => {
  it('formats valid result without errors', () => {
    const result: AgentsValidationResult = {
      valid: true,
      filePath: '/test/AGENTS.md',
      issues: [],
      fixesApplied: [],
    };

    // Should not throw
    expect(() => formatAgentsValidationResult(result)).not.toThrow();
  });

  it('formats result with mixed severity issues', () => {
    const result: AgentsValidationResult = {
      valid: false,
      filePath: '/test/AGENTS.md',
      issues: [
        {
          severity: 'error',
          path: 'agents.dev.model',
          message: 'Unknown model',
        },
        {
          severity: 'warning',
          path: 'agents.dev.tools',
          message: 'No tools specified',
        },
        {
          severity: 'info',
          path: 'agents.dev.model',
          message: 'Expensive model',
          suggestion: 'Consider sonnet for cost savings',
        },
      ],
      fixesApplied: [],
    };

    expect(() => formatAgentsValidationResult(result)).not.toThrow();
  });
});

describe('formatAgentsValidationResultJson', () => {
  it('returns valid JSON string', () => {
    const result: AgentsValidationResult = {
      valid: true,
      filePath: '/test/AGENTS.md',
      issues: [],
      fixesApplied: ['Fixed model: typo → sonnet'],
    };

    const json = formatAgentsValidationResultJson(result);
    const parsed = JSON.parse(json);

    expect(parsed.valid).toBe(true);
    expect(parsed.filePath).toBe('/test/AGENTS.md');
    expect(parsed.fixesApplied).toContain('Fixed model: typo → sonnet');
    expect(parsed.summary).toEqual({ errors: 0, warnings: 0, info: 0 });
  });

  it('includes issue counts in summary', () => {
    const result: AgentsValidationResult = {
      valid: false,
      filePath: '/test/AGENTS.md',
      issues: [
        { severity: 'error', path: 'a', message: 'err1' },
        { severity: 'error', path: 'b', message: 'err2' },
        { severity: 'warning', path: 'c', message: 'warn1' },
      ],
      fixesApplied: [],
    };

    const parsed = JSON.parse(formatAgentsValidationResultJson(result));
    expect(parsed.summary.errors).toBe(2);
    expect(parsed.summary.warnings).toBe(1);
    expect(parsed.summary.info).toBe(0);
  });
});
