/**
 * Tests for File Validator utility
 * Validates configuration file validation with schema support
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import {
  validateFile,
  validateContent,
  validateAgentsMd,
  detectFileType,
  formatValidationResults,
  isValidEnumValue,
  validateEnumValue,
  KNOWN_ENUMS,
  type ValidationResult,
} from '../../src/utils/file-validator.js';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe('File Validator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('detectFileType', () => {
    it('should detect settings.json', () => {
      expect(detectFileType('settings.json')).toBe('settings');
      expect(detectFileType('/path/to/settings.json')).toBe('settings');
      expect(detectFileType('.airunx/settings.json')).toBe('settings');
    });

    it('should detect pipelines.yaml', () => {
      expect(detectFileType('pipelines.yaml')).toBe('pipelines');
      expect(detectFileType('pipelines.yml')).toBe('pipelines');
      expect(detectFileType('/path/to/pipelines.yaml')).toBe('pipelines');
    });

    it('should detect AGENTS.md', () => {
      expect(detectFileType('AGENTS.md')).toBe('agents');
      expect(detectFileType('agents.md')).toBe('agents');
      expect(detectFileType('/path/to/AGENTS.md')).toBe('agents');
    });

    it('should detect config.yml', () => {
      expect(detectFileType('config.yml')).toBe('system-config');
      expect(detectFileType('config.yaml')).toBe('system-config');
    });

    it('should return unknown for unrecognized files', () => {
      expect(detectFileType('unknown.txt')).toBe('unknown');
    });
  });

  describe('validateFile', () => {
    it('should return error for non-existent file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = validateFile('/path/to/missing.json');

      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].severity).toBe('error');
      expect(result.issues[0].message).toBe('File not found');
    });

    it('should return warning for empty file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('');

      const result = validateFile('/path/to/empty.json');

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].severity).toBe('warning');
      expect(result.issues[0].message).toBe('File is empty');
    });

    it('should validate valid settings.json', () => {
      const validSettings = JSON.stringify({
        default_fidelity: 'standard',
        default_backend: 'claude-code',
        skip_version_check: false,
      });

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(validSettings);

      const result = validateFile('/path/to/settings.json', { fileType: 'settings' });

      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should detect invalid enum values in settings.json', () => {
      const invalidSettings = JSON.stringify({
        default_fidelity: 'invalid-fidelity',
        default_backend: 'claude-code',
      });

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(invalidSettings);

      const result = validateFile('/path/to/settings.json', {
        fileType: 'settings',
        mode: 'strict',
      });

      expect(result.valid).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0].severity).toBe('error');
    });

    it('should use lenient mode for warnings', () => {
      const invalidSettings = JSON.stringify({
        default_fidelity: 'invalid-fidelity',
        default_backend: 'claude-code',
      });

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(invalidSettings);

      const result = validateFile('/path/to/settings.json', {
        fileType: 'settings',
        mode: 'lenient',
      });

      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0].severity).toBe('warning');
    });

    it('should handle invalid settings with schema validation', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // Valid JSON but with invalid enum value for fidelity level
      vi.mocked(fs.readFileSync).mockReturnValue('{"default_fidelity": "invalid_level"}');

      const result = validateFile('/path/to/settings.json', { fileType: 'settings' });

      // Schema validation should fail on invalid enum value
      expect(result.valid).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it('should handle YAML parse errors', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('invalid: yaml: content:');

      const result = validateFile('/path/to/pipelines.yaml', { fileType: 'pipelines' });

      expect(result.valid).toBe(false);
    });
  });

  describe('validateContent', () => {
    it('should validate settings JSON content', () => {
      const content = JSON.stringify({
        default_fidelity: 'standard',
        default_backend: 'claude-code',
      });

      const result = validateContent(content, 'settings');

      expect(result.valid).toBe(true);
    });

    it('should validate pipelines YAML content', () => {
      const content = `
pipelines:
  standard:
    name: Standard Pipeline
    stages:
      - name: stage1
        agent: orchestrator
`;

      const result = validateContent(content, 'pipelines');

      expect(result.valid).toBe(true);
    });

    it('should return warning for empty content', () => {
      const result = validateContent('   ', 'settings');

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].severity).toBe('warning');
      expect(result.issues[0].message).toBe('Content is empty');
    });
  });

  describe('validateAgentsMd', () => {
    it('should validate valid AGENTS.md content', () => {
      const content = `# Agents Configuration

## Agent Roles

### orchestrator
- **Purpose**: Coordinate the pipeline
- **Tools**: GitHub CLI

### developer
- **Purpose**: Write code
- **Tools**: Editor, Tests
`;

      const { issues } = validateAgentsMd(content);

      // Should have no errors for valid roles
      const errors = issues.filter((i) => i.severity === 'error');
      expect(errors).toHaveLength(0);
    });

    it('should detect invalid agent roles', () => {
      const content = `# Agents Configuration

## Agent Roles

### invalid-role
- **Purpose**: Test invalid role

### orchstrator
- **Purpose**: Typo in role name
`;

      const { issues } = validateAgentsMd(content, 'strict');

      // Should have errors for invalid roles
      const errors = issues.filter((i) => i.severity === 'error');
      expect(errors.length).toBeGreaterThan(0);
    });

    it('should suggest corrections for typos', () => {
      const content = `# Agents Configuration

## Agent Roles

### orchstrator
- **Purpose**: Typo test
`;

      const { issues } = validateAgentsMd(content);

      // Should find a suggestion for the typo
      const issueWithSuggestion = issues.find((i) => i.suggestion?.includes('orchestrator'));
      expect(issueWithSuggestion).toBeDefined();
    });

    it('should warn about missing sections', () => {
      const content = `# Agents Configuration

### orchestrator
- **Purpose**: Test
`;

      const { issues } = validateAgentsMd(content);

      const sectionWarning = issues.find((i) => i.path === 'structure');
      expect(sectionWarning).toBeDefined();
    });

    it('should use lenient mode', () => {
      const content = `# Agents Configuration

## Agent Roles

### invalid-role
- **Purpose**: Test
`;

      const { issues: strictIssues } = validateAgentsMd(content, 'strict');
      const { issues: lenientIssues } = validateAgentsMd(content, 'lenient');

      const strictErrors = strictIssues.filter((i) => i.severity === 'error');
      const lenientErrors = lenientIssues.filter((i) => i.severity === 'error');

      expect(strictErrors.length).toBeGreaterThan(lenientErrors.length);
    });
  });

  describe('formatValidationResults', () => {
    it('should format valid results', () => {
      const results: ValidationResult[] = [
        {
          valid: true,
          filePath: '/path/to/settings.json',
          fileType: 'settings',
          issues: [],
        },
      ];

      const formatted = formatValidationResults(results);

      expect(formatted).toContain('✓');
      expect(formatted).toContain('settings.json');
    });

    it('should format invalid results with issues', () => {
      const results: ValidationResult[] = [
        {
          valid: false,
          filePath: '/path/to/settings.json',
          fileType: 'settings',
          issues: [
            {
              severity: 'error',
              path: 'default_fidelity',
              message: 'Invalid value',
              suggestion: 'Use standard instead',
            },
          ],
        },
      ];

      const formatted = formatValidationResults(results);

      expect(formatted).toContain('✗');
      expect(formatted).toContain('Invalid value');
      expect(formatted).toContain('Use standard instead');
    });
  });

  describe('isValidEnumValue', () => {
    it('should return true for valid agent roles', () => {
      expect(isValidEnumValue('orchestrator', KNOWN_ENUMS.agentRoles)).toBe(true);
      expect(isValidEnumValue('developer', KNOWN_ENUMS.agentRoles)).toBe(true);
      expect(isValidEnumValue('code-judge', KNOWN_ENUMS.agentRoles)).toBe(true);
    });

    it('should return false for invalid agent roles', () => {
      expect(isValidEnumValue('invalid', KNOWN_ENUMS.agentRoles)).toBe(false);
      expect(isValidEnumValue('ORCHESTRATOR', KNOWN_ENUMS.agentRoles)).toBe(false);
    });

    it('should return true for valid fidelity levels', () => {
      expect(isValidEnumValue('fast', KNOWN_ENUMS.fidelityLevels)).toBe(true);
      expect(isValidEnumValue('standard', KNOWN_ENUMS.fidelityLevels)).toBe(true);
      expect(isValidEnumValue('ultra', KNOWN_ENUMS.fidelityLevels)).toBe(true);
    });

    it('should return true for valid backend types', () => {
      expect(isValidEnumValue('claude-code', KNOWN_ENUMS.backendTypes)).toBe(true);
      expect(isValidEnumValue('cursor', KNOWN_ENUMS.backendTypes)).toBe(true);
    });
  });

  describe('validateEnumValue', () => {
    it('should return null for valid values', () => {
      const result = validateEnumValue('orchestrator', KNOWN_ENUMS.agentRoles, 'agent');
      expect(result).toBeNull();
    });

    it('should return issue with suggestion for invalid values', () => {
      const result = validateEnumValue('orchstrator', KNOWN_ENUMS.agentRoles, 'agent');

      expect(result).not.toBeNull();
      expect(result?.severity).toBe('warning');
      expect(result?.suggestion).toContain('orchestrator');
    });

    it('should list valid values in suggestion', () => {
      const result = validateEnumValue('completely-wrong', KNOWN_ENUMS.fidelityLevels, 'fidelity');

      expect(result).not.toBeNull();
      expect(result?.suggestion).toContain('Valid values:');
      expect(result?.suggestion).toContain('standard');
    });
  });

  describe('KNOWN_ENUMS', () => {
    it('should have all expected agent roles', () => {
      expect(KNOWN_ENUMS.agentRoles).toContain('orchestrator');
      expect(KNOWN_ENUMS.agentRoles).toContain('developer');
      expect(KNOWN_ENUMS.agentRoles).toContain('code-reviewer');
      expect(KNOWN_ENUMS.agentRoles).toContain('code-judge');
    });

    it('should have all expected fidelity levels', () => {
      expect(KNOWN_ENUMS.fidelityLevels).toContain('fast');
      expect(KNOWN_ENUMS.fidelityLevels).toContain('standard');
      expect(KNOWN_ENUMS.fidelityLevels).toContain('thorough');
      expect(KNOWN_ENUMS.fidelityLevels).toContain('ultra');
    });

    it('should have all expected backend types', () => {
      expect(KNOWN_ENUMS.backendTypes).toContain('claude-code');
      expect(KNOWN_ENUMS.backendTypes).toContain('cursor');
      expect(KNOWN_ENUMS.backendTypes).toContain('codex');
    });
  });
});
