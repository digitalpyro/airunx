/**
 * Tests for Configuration Validator
 * Validates AGENTS.md and pipelines.yaml validation functions
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  validateAgentsConfig,
  validatePipelinesConfig,
  validateAllConfigs,
  formatValidationResult,
} from '../../src/utils/config-validator.js';
import * as fs from 'fs';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe('Config Validator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateAgentsConfig', () => {
    it('should fail when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = validateAgentsConfig('/nonexistent/AGENTS.md');

      expect(result.valid).toBe(false);
      expect(result.checks[0].name).toBe('AGENTS.md exists');
      expect(result.checks[0].passed).toBe(false);
    });

    it('should pass when file exists and has valid content', () => {
      const content = `# Agents Configuration

### orchestrator
- **Purpose**: Coordinate the pipeline
- **Responsibilities**: Planning, coordination
- **Tools**: CLI
- **Output**: Plans

### developer
- **Purpose**: Strategic design
- **Responsibilities**: Architecture
- **Tools**: Codebase
- **Output**: Designs

### developer
- **Purpose**: Write code
- **Responsibilities**: Implementation
- **Tools**: Editor
- **Output**: Code

### code-reviewer
- **Purpose**: Review code
- **Responsibilities**: Code review
- **Tools**: Analysis
- **Output**: Reviews

### code-reviewer
- **Purpose**: Analyze code
- **Responsibilities**: Linting
- **Tools**: ESLint
- **Output**: Reports

### static-analyzer
- **Purpose**: Static analysis
- **Responsibilities**: Linting, test failure interpretation
- **Tools**: ESLint, phpcs
- **Output**: Analysis reports

### test-creator
- **Purpose**: Create tests
- **Responsibilities**: Testing
- **Tools**: Test framework
- **Output**: Tests

### code-judge
- **Purpose**: Evaluate quality
- **Responsibilities**: Assessment
- **Tools**: All outputs
- **Output**: Decisions

### docs-generator
- **Purpose**: Generate docs
- **Responsibilities**: Documentation
- **Tools**: Markdown
- **Output**: Docs

`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = validateAgentsConfig('/path/to/AGENTS.md');

      expect(result.valid).toBe(true);
    });

    it('should report missing agent roles', () => {
      const content = `# Agents

### orchestrator
- **Purpose**: Coordinate
- **Responsibilities**: Plan
- **Tools**: CLI
- **Output**: Plans
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = validateAgentsConfig('/path/to/AGENTS.md');

      const rolesCheck = result.checks.find(
        (c) => c.name === 'Agent roles complete'
      );
      // Missing roles fail validation - all required roles must be defined
      expect(rolesCheck?.passed).toBe(false);
      expect(rolesCheck?.details?.[0]).toContain('Required roles not defined');
      expect(rolesCheck?.details?.[1]).toContain('Add definitions');
    });

    it('should report incomplete agent definitions', () => {
      const content = `# Agents

### orchestrator
- **Tools**: CLI
- **Output**: Plans
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = validateAgentsConfig('/path/to/AGENTS.md');

      const completeCheck = result.checks.find(
        (c) => c.name === 'Agent definitions complete'
      );
      expect(completeCheck?.passed).toBe(false);
      expect(completeCheck?.details?.[0]).toContain('orchestrator');
    });
  });

  describe('validatePipelinesConfig', () => {
    it('should fail when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = validatePipelinesConfig('/nonexistent/pipelines.yaml');

      expect(result.valid).toBe(false);
      expect(result.checks[0].name).toBe('pipelines.yaml exists');
      expect(result.checks[0].passed).toBe(false);
    });

    it('should fail on invalid YAML syntax', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('invalid: yaml: content:');

      const result = validatePipelinesConfig('/path/to/pipelines.yaml');

      expect(result.valid).toBe(false);
      const syntaxCheck = result.checks.find((c) => c.name === 'YAML syntax');
      expect(syntaxCheck?.passed).toBe(false);
    });

    it('should pass with valid pipelines configuration', () => {
      const content = `
pipelines:
  thin:
    name: thin
    description: Quick iterations
    default_fidelity: fast
    stages:
      - name: implement
        agent: developer
  standard:
    name: standard
    description: Standard pipeline
    default_fidelity: standard
    stages:
      - name: plan
        agent: orchestrator
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = validatePipelinesConfig('/path/to/pipelines.yaml');

      expect(result.valid).toBe(true);
      expect(
        result.checks.find((c) => c.name === 'Schema validation')?.passed
      ).toBe(true);
      expect(
        result.checks.find((c) => c.name === 'Required pipelines')?.passed
      ).toBe(true);
    });

    it('should fail when required pipelines are missing', () => {
      // Use valid pipeline types but omit 'standard' to test required pipeline validation
      // 'thin' and 'feature' are valid types, but 'standard' is required and missing
      const content = `
pipelines:
  thin:
    name: thin
    description: Quick iterations
    stages:
      - name: test
        agent: orchestrator
  feature:
    name: feature
    description: Feature pipeline
    stages:
      - name: test
        agent: orchestrator
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = validatePipelinesConfig('/path/to/pipelines.yaml');

      const requiredCheck = result.checks.find(
        (c) => c.name === 'Required pipelines'
      );
      expect(requiredCheck?.passed).toBe(false);
      expect(requiredCheck?.details?.[0]).toContain('standard');
    });

    it('should fail on schema validation errors', () => {
      const content = `
pipelines:
  thin:
    name: thin
    stages: []
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const result = validatePipelinesConfig('/path/to/pipelines.yaml');

      expect(result.valid).toBe(false);
      const schemaCheck = result.checks.find(
        (c) => c.name === 'Schema validation'
      );
      expect(schemaCheck?.passed).toBe(false);
    });
  });

  describe('validateAllConfigs', () => {
    it('should validate both agents and pipelines', () => {
      const agentsContent = `### orchestrator
- **Purpose**: Coordinate
- **Responsibilities**: Plan
- **Tools**: CLI
- **Output**: Plans
`;
      const pipelinesContent = `
pipelines:
  thin:
    name: thin
    stages:
      - name: test
        agent: orchestrator
  standard:
    name: standard
    stages:
      - name: test
        agent: orchestrator
`;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
        if (String(path).endsWith('AGENTS.md')) return agentsContent;
        return pipelinesContent;
      });

      const result = validateAllConfigs('/config');

      expect(result.agentsResult).toBeDefined();
      expect(result.pipelinesResult).toBeDefined();
      // Both will have warnings/issues since agents is incomplete
      expect(result.summary).toBeDefined();
    });
  });

  describe('formatValidationResult', () => {
    it('should format checks with icons', () => {
      const result = {
        valid: true,
        checks: [
          { name: 'Test 1', passed: true, message: 'Passed' },
          {
            name: 'Test 2',
            passed: false,
            message: 'Failed',
            details: ['Detail 1'],
          },
        ],
        summary: 'Test summary',
      };

      const formatted = formatValidationResult(result);

      expect(formatted).toContain('\u2713 Test 1');
      expect(formatted).toContain('\u2717 Test 2');
      expect(formatted).toContain('Detail 1');
      expect(formatted).toContain('Test summary');
    });
  });
});
