/**
 * Tests for AGENTS.md Schema and Parser
 * Validates parsing and validation of agent role definitions
 */

import { describe, it, expect } from 'vitest';
import {
  parseAgentsMd,
  validateParsedAgents,
  isValidAgentRole,
  getValidAgentRoles,
  toAgentConfigs,
  generateAgentsMdTemplate,
  isValidModel,
  getValidModels,
  getCommonModelAliases,
  VALID_MODELS,
  type ParsedAgentDefinition,
  type ParsedAgentsConfig,
} from '../../src/utils/agents-schema.js';

describe('Agents Schema', () => {
  describe('parseAgentsMd', () => {
    it('should parse basic agent definitions', () => {
      const content = `# Agents Configuration

## Agent Roles

### orchestrator
- **Purpose**: Coordinate the pipeline
- **Tools**: GitHub CLI
`;

      const result = parseAgentsMd(content);

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].role).toBe('orchestrator');
      expect(result.agents[0].isValidRole).toBe(true);
      expect(result.agents[0].purpose).toBe('Coordinate the pipeline');
      expect(result.agents[0].tools).toEqual(['GitHub CLI']);
    });

    it('should parse multiple agents', () => {
      const content = `# Agents Configuration

## Agent Roles

### orchestrator
- **Purpose**: Coordinate workflow

### developer
- **Purpose**: Write code

### code-reviewer
- **Purpose**: Review code
`;

      const result = parseAgentsMd(content);

      expect(result.agents).toHaveLength(3);
      expect(result.agents.map((a) => a.role)).toEqual([
        'orchestrator',
        'developer',
        'code-reviewer',
      ]);
    });

    it('should mark invalid roles', () => {
      const content = `# Agents Configuration

## Agent Roles

### invalid-role
- **Purpose**: This is not a valid role

### orchestrator
- **Purpose**: This is valid
`;

      const result = parseAgentsMd(content);

      expect(result.agents).toHaveLength(2);
      expect(result.agents[0].role).toBe('invalid-role');
      expect(result.agents[0].isValidRole).toBe(false);
      expect(result.agents[1].role).toBe('orchestrator');
      expect(result.agents[1].isValidRole).toBe(true);
    });

    it('should parse responsibilities', () => {
      const content = `# Agents Configuration

## Agent Roles

### orchestrator
- **Purpose**: Coordinate
- **Responsibilities**: Input parsing, mode selection, pipeline management
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].responsibilities).toEqual([
        'Input parsing',
        'mode selection',
        'pipeline management',
      ]);
    });

    it('should parse tools as comma-separated list', () => {
      const content = `# Agents Configuration

## Agent Roles

### developer
- **Purpose**: Write code
- **Tools**: Codebase edit, test runner, build tools
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].tools).toEqual([
        'Codebase edit',
        'test runner',
        'build tools',
      ]);
    });

    it('should parse tools as multi-line indented list', () => {
      const content = `# Agents Configuration

## Agent Roles

### my-agent
- **Purpose**: Test multi-line tools
- **Tools**:
  - gh-cli
  - vscode
  - npm
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].tools).toEqual(['gh-cli', 'vscode', 'npm']);
    });

    it('should parse responsibilities as multi-line indented list', () => {
      const content = `# Agents Configuration

## Agent Roles

### orchestrator
- **Purpose**: Coordinate
- **Responsibilities**:
  - Input parsing
  - Mode selection
  - Pipeline management
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].responsibilities).toEqual([
        'Input parsing',
        'Mode selection',
        'Pipeline management',
      ]);
    });

    it('should parse pipeline flow section', () => {
      const content = `# Agents Configuration

## Agent Roles

### orchestrator
- **Purpose**: Coordinate

## Pipeline Flow

\`\`\`
orchestrator → developer → reviewer
\`\`\`
`;

      const result = parseAgentsMd(content);

      expect(result.pipelineFlow).toBeDefined();
      expect(result.pipelineFlow).toContain('orchestrator');
    });

    it('should parse conventions section', () => {
      const content = `# Agents Configuration

## Agent Roles

### orchestrator
- **Purpose**: Coordinate

## Conventions

- **Branch naming**: feature/, fix/
- **Coverage target**: ≥80%
`;

      const result = parseAgentsMd(content);

      expect(result.conventions).toBeDefined();
      expect(result.conventions?.['branch naming']).toBe('feature/, fix/');
      expect(result.conventions?.['coverage target']).toBe('≥80%');
    });

    it('should track line numbers', () => {
      const content = `# Agents Configuration

## Agent Roles

### orchestrator
- **Purpose**: Test
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].lineNumber).toBe(5);
    });

    it('should store raw content', () => {
      const content = `# Agents Configuration

## Agent Roles

### orchestrator
- **Purpose**: Test
`;

      const result = parseAgentsMd(content);

      expect(result.rawContent).toBe(content);
    });
  });

  describe('validateParsedAgents', () => {
    it('should pass for valid agents', () => {
      const config: ParsedAgentsConfig = {
        agents: [
          {
            role: 'orchestrator',
            isValidRole: true,
            purpose: 'Coordinate',
            tools: ['gh'],
            lineNumber: 1,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const issues = validateParsedAgents(config);
      const errors = issues.filter((i) => i.severity === 'error');

      expect(errors).toHaveLength(0);
    });

    it('should error on no agents defined', () => {
      const config: ParsedAgentsConfig = {
        agents: [],
        customSections: {},
        rawContent: '',
      };

      const issues = validateParsedAgents(config, 'strict');
      const errors = issues.filter((i) => i.severity === 'error');

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('No agent definitions found');
    });

    it('should error on invalid roles in strict mode', () => {
      const config: ParsedAgentsConfig = {
        agents: [
          {
            role: 'invalid-role',
            isValidRole: false,
            lineNumber: 1,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const issues = validateParsedAgents(config, 'strict');
      const errors = issues.filter((i) => i.severity === 'error');

      expect(errors.length).toBeGreaterThan(0);
    });

    it('should warn on invalid roles in lenient mode', () => {
      const config: ParsedAgentsConfig = {
        agents: [
          {
            role: 'invalid-role',
            isValidRole: false,
            lineNumber: 1,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const issues = validateParsedAgents(config, 'lenient');
      const errors = issues.filter((i) => i.severity === 'error');
      const warnings = issues.filter((i) => i.severity === 'warning');

      expect(errors).toHaveLength(0);
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('should suggest corrections for typos', () => {
      const config: ParsedAgentsConfig = {
        agents: [
          {
            role: 'orchstrator', // typo
            isValidRole: false,
            lineNumber: 1,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const issues = validateParsedAgents(config, 'lenient');

      const issueWithSuggestion = issues.find((i) =>
        i.suggestion?.includes('orchestrator')
      );
      expect(issueWithSuggestion).toBeDefined();
    });

    it('should warn about missing purpose', () => {
      const config: ParsedAgentsConfig = {
        agents: [
          {
            role: 'orchestrator',
            isValidRole: true,
            // no purpose
            lineNumber: 1,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const issues = validateParsedAgents(config);
      const purposeWarning = issues.find((i) => i.path.includes('purpose'));

      expect(purposeWarning).toBeDefined();
      expect(purposeWarning?.severity).toBe('warning');
    });

    it('should detect duplicate roles', () => {
      const config: ParsedAgentsConfig = {
        agents: [
          {
            role: 'orchestrator',
            isValidRole: true,
            purpose: 'First',
            lineNumber: 1,
            rawContent: '',
          },
          {
            role: 'orchestrator',
            isValidRole: true,
            purpose: 'Second',
            lineNumber: 10,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const issues = validateParsedAgents(config);
      const duplicateWarning = issues.find((i) =>
        i.message.includes('defined 2 times')
      );

      expect(duplicateWarning).toBeDefined();
    });
  });

  describe('isValidAgentRole', () => {
    it('should return true for valid roles', () => {
      expect(isValidAgentRole('orchestrator')).toBe(true);
      expect(isValidAgentRole('developer')).toBe(true);
      expect(isValidAgentRole('code-reviewer')).toBe(true);
      expect(isValidAgentRole('code-judge')).toBe(true);
    });

    it('should return false for invalid roles', () => {
      expect(isValidAgentRole('invalid')).toBe(false);
      expect(isValidAgentRole('')).toBe(false);
      expect(isValidAgentRole('ORCHESTRATOR')).toBe(false);
    });
  });

  describe('getValidAgentRoles', () => {
    it('should return all valid agent roles', () => {
      const roles = getValidAgentRoles();

      expect(roles).toContain('orchestrator');
      expect(roles).toContain('developer');
      expect(roles).toContain('code-reviewer');
      expect(roles).toContain('test-creator');
      expect(roles).toContain('code-judge');
      expect(roles).toContain('docs-generator');
    });
  });

  describe('toAgentConfigs', () => {
    it('should convert parsed agents to config array', () => {
      const parsed: ParsedAgentsConfig = {
        agents: [
          {
            role: 'orchestrator',
            isValidRole: true,
            purpose: 'Coordinate pipeline',
            tools: ['gh'],
            lineNumber: 1,
            rawContent: '',
          },
          {
            role: 'invalid-role',
            isValidRole: false,
            purpose: 'Should be filtered',
            lineNumber: 5,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const configs = toAgentConfigs(parsed);

      expect(configs).toHaveLength(1);
      expect(configs[0].role).toBe('orchestrator');
      expect(configs[0].description).toBe('Coordinate pipeline');
      expect(configs[0].tools).toEqual(['gh']);
    });

    it('should handle agents without optional fields', () => {
      const parsed: ParsedAgentsConfig = {
        agents: [
          {
            role: 'orchestrator',
            isValidRole: true,
            lineNumber: 1,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const configs = toAgentConfigs(parsed);

      expect(configs[0].description).toBe('');
      expect(configs[0].tools).toEqual([]);
    });
  });

  describe('generateAgentsMdTemplate', () => {
    it('should generate valid template', () => {
      const template = generateAgentsMdTemplate();

      expect(template).toContain('# Agents Configuration');
      expect(template).toContain('## Agent Roles');
      expect(template).toContain('### orchestrator');
      expect(template).toContain('**Purpose**');
      expect(template).toContain('**Tools**');
    });

    it('should include valid agent roles', () => {
      const template = generateAgentsMdTemplate();

      // Parse the generated template and validate it
      const parsed = parseAgentsMd(template);
      const issues = validateParsedAgents(parsed);
      const errors = issues.filter((i) => i.severity === 'error');

      expect(errors).toHaveLength(0);
    });

    it('should include provider fields in template', () => {
      const template = generateAgentsMdTemplate();

      expect(template).toContain('**Provider**');
      expect(template).toContain('**Provider-Rationale**');
      expect(template).toContain('**Fallback-Provider**');
      expect(template).toContain('claude-code');
      expect(template).toContain('codex');
    });
  });

  describe('Provider Parsing', () => {
    it('should parse provider field', () => {
      const content = `# Agents Configuration

## Agent Roles

### orchestrator
- **Purpose**: Coordinate the pipeline
- **Provider**: claude-code
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].provider).toBe('claude-code');
      expect(result.agents[0].isValidProvider).toBe(true);
    });

    it('should parse provider-rationale field', () => {
      const content = `# Agents Configuration

## Agent Roles

### orchestrator
- **Purpose**: Coordinate the pipeline
- **Provider**: claude-code
- **Provider-Rationale**: Strong reasoning capabilities
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].providerRationale).toBe(
        'Strong reasoning capabilities'
      );
    });

    it('should parse fallback-provider field', () => {
      const content = `# Agents Configuration

## Agent Roles

### orchestrator
- **Purpose**: Coordinate the pipeline
- **Provider**: claude-code
- **Fallback-Provider**: codex
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].fallbackProvider).toBe('codex');
      expect(result.agents[0].isValidFallbackProvider).toBe(true);
    });

    it('should parse all provider fields together', () => {
      const content = `# Agents Configuration

## Agent Roles

### orchestrator
- **Purpose**: Coordinate the pipeline
- **Tools**: GitHub CLI
- **Provider**: claude-code
- **Provider-Rationale**: Strong reasoning and orchestration capabilities
- **Fallback-Provider**: codex

### code-reviewer
- **Purpose**: Code review
- **Provider**: codex
- **Provider-Rationale**: Independent perspective prevents self-deception
- **Fallback-Provider**: claude-code
`;

      const result = parseAgentsMd(content);

      expect(result.agents).toHaveLength(2);

      // Check orchestrator
      expect(result.agents[0].provider).toBe('claude-code');
      expect(result.agents[0].isValidProvider).toBe(true);
      expect(result.agents[0].providerRationale).toBe(
        'Strong reasoning and orchestration capabilities'
      );
      expect(result.agents[0].fallbackProvider).toBe('codex');
      expect(result.agents[0].isValidFallbackProvider).toBe(true);

      // Check reviewer
      expect(result.agents[1].provider).toBe('codex');
      expect(result.agents[1].isValidProvider).toBe(true);
      expect(result.agents[1].providerRationale).toBe(
        'Independent perspective prevents self-deception'
      );
      expect(result.agents[1].fallbackProvider).toBe('claude-code');
      expect(result.agents[1].isValidFallbackProvider).toBe(true);
    });

    it('should mark invalid provider as invalid', () => {
      const content = `# Agents Configuration

## Agent Roles

### orchestrator
- **Purpose**: Coordinate the pipeline
- **Provider**: invalid-provider
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].provider).toBe('invalid-provider');
      expect(result.agents[0].isValidProvider).toBe(false);
    });

    it('should mark invalid fallback-provider as invalid', () => {
      const content = `# Agents Configuration

## Agent Roles

### orchestrator
- **Purpose**: Coordinate the pipeline
- **Provider**: claude-code
- **Fallback-Provider**: invalid-backend
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].fallbackProvider).toBe('invalid-backend');
      expect(result.agents[0].isValidFallbackProvider).toBe(false);
    });

    it('should parse cursor provider', () => {
      const content = `# Agents Configuration

## Agent Roles

### developer
- **Purpose**: Write code
- **Provider**: cursor
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].provider).toBe('cursor');
      expect(result.agents[0].isValidProvider).toBe(true);
    });
  });

  describe('Provider Validation', () => {
    it('should error on invalid provider in strict mode', () => {
      const config: ParsedAgentsConfig = {
        agents: [
          {
            role: 'orchestrator',
            isValidRole: true,
            purpose: 'Coordinate',
            provider: 'invalid-provider',
            isValidProvider: false,
            lineNumber: 1,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const issues = validateParsedAgents(config, 'strict');
      const errors = issues.filter((i) => i.severity === 'error');

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain(
        "Unknown provider 'invalid-provider'"
      );
    });

    it('should warn on invalid provider in lenient mode', () => {
      const config: ParsedAgentsConfig = {
        agents: [
          {
            role: 'orchestrator',
            isValidRole: true,
            purpose: 'Coordinate',
            provider: 'invalid-provider',
            isValidProvider: false,
            lineNumber: 1,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const issues = validateParsedAgents(config, 'lenient');
      const errors = issues.filter((i) => i.severity === 'error');
      const warnings = issues.filter((i) => i.severity === 'warning');

      expect(errors).toHaveLength(0);
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('should suggest correction for provider typo', () => {
      const config: ParsedAgentsConfig = {
        agents: [
          {
            role: 'orchestrator',
            isValidRole: true,
            purpose: 'Coordinate',
            provider: 'claudecode', // typo - missing hyphen
            isValidProvider: false,
            lineNumber: 1,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const issues = validateParsedAgents(config, 'lenient');
      const issueWithSuggestion = issues.find((i) =>
        i.suggestion?.includes('claude-code')
      );

      expect(issueWithSuggestion).toBeDefined();
    });

    it('should error on invalid fallback-provider in strict mode', () => {
      const config: ParsedAgentsConfig = {
        agents: [
          {
            role: 'orchestrator',
            isValidRole: true,
            purpose: 'Coordinate',
            provider: 'claude-code',
            isValidProvider: true,
            fallbackProvider: 'bad-backend',
            isValidFallbackProvider: false,
            lineNumber: 1,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const issues = validateParsedAgents(config, 'strict');
      const errors = issues.filter((i) => i.severity === 'error');

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain(
        "Unknown fallback provider 'bad-backend'"
      );
    });

    it('should pass validation for valid providers', () => {
      const config: ParsedAgentsConfig = {
        agents: [
          {
            role: 'orchestrator',
            isValidRole: true,
            purpose: 'Coordinate',
            provider: 'claude-code',
            isValidProvider: true,
            fallbackProvider: 'codex',
            isValidFallbackProvider: true,
            tools: ['gh'],
            lineNumber: 1,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const issues = validateParsedAgents(config, 'strict');
      const errors = issues.filter((i) => i.severity === 'error');

      expect(errors).toHaveLength(0);
    });
  });

  describe('toAgentConfigs with Provider', () => {
    it('should include valid provider in config', () => {
      const parsed: ParsedAgentsConfig = {
        agents: [
          {
            role: 'orchestrator',
            isValidRole: true,
            purpose: 'Coordinate pipeline',
            tools: ['gh'],
            provider: 'claude-code',
            isValidProvider: true,
            providerRationale: 'Strong reasoning',
            fallbackProvider: 'codex',
            isValidFallbackProvider: true,
            lineNumber: 1,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const configs = toAgentConfigs(parsed);

      expect(configs[0].provider).toBe('claude-code');
      expect(configs[0].providerRationale).toBe('Strong reasoning');
      expect(configs[0].fallbackProvider).toBe('codex');
    });

    it('should exclude invalid provider from config', () => {
      const parsed: ParsedAgentsConfig = {
        agents: [
          {
            role: 'orchestrator',
            isValidRole: true,
            purpose: 'Coordinate pipeline',
            provider: 'invalid-provider',
            isValidProvider: false,
            lineNumber: 1,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const configs = toAgentConfigs(parsed);

      expect(configs[0].provider).toBeUndefined();
    });

    it('should include provider rationale even without valid provider', () => {
      const parsed: ParsedAgentsConfig = {
        agents: [
          {
            role: 'orchestrator',
            isValidRole: true,
            purpose: 'Coordinate pipeline',
            providerRationale: 'Some rationale',
            lineNumber: 1,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const configs = toAgentConfigs(parsed);

      expect(configs[0].providerRationale).toBe('Some rationale');
    });

    it('should include providerConfig in config', () => {
      const parsed: ParsedAgentsConfig = {
        agents: [
          {
            role: 'orchestrator',
            isValidRole: true,
            purpose: 'Coordinate pipeline',
            provider: 'claude-code',
            isValidProvider: true,
            providerConfig: {
              disableCompoundEngineering: true,
              delegation: false,
            },
            lineNumber: 1,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const configs = toAgentConfigs(parsed);

      expect(configs[0].providerConfig).toBeDefined();
      expect(configs[0].providerConfig?.disableCompoundEngineering).toBe(true);
      expect(configs[0].providerConfig?.delegation).toBe(false);
    });
  });

  describe('Provider-Config Parsing', () => {
    it('should parse delegation: false from Provider-Config', () => {
      const content = `# Agents Configuration

## Agent Roles

### developer
- **Purpose**: Write code
- **Provider**: claude-code
- **Provider-Config**:
  - delegation: false
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].providerConfig).toBeDefined();
      expect(result.agents[0].providerConfig?.delegation).toBe(false);
    });

    it('should parse delegation: true from Provider-Config', () => {
      const content = `# Agents Configuration

## Agent Roles

### orchestrator
- **Purpose**: Coordinate
- **Provider**: claude-code
- **Provider-Config**:
  - delegation: true
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].providerConfig?.delegation).toBe(true);
    });

    it('should default delegation to undefined when not specified', () => {
      const content = `# Agents Configuration

## Agent Roles

### developer
- **Purpose**: Write code
- **Provider**: claude-code
- **Provider-Config**:
  - sub-agents: architecture-strategist
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].providerConfig).toBeDefined();
      expect(result.agents[0].providerConfig?.delegation).toBeUndefined();
    });

    it('should parse disable-compound-engineering from Provider-Config', () => {
      const content = `# Agents Configuration

## Agent Roles

### developer
- **Purpose**: Write code
- **Provider**: claude-code
- **Provider-Config**:
  - disable-compound-engineering: true
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].providerConfig).toBeDefined();
      expect(result.agents[0].providerConfig?.disableCompoundEngineering).toBe(
        true
      );
    });

    it('should parse disable-compound-engineering as false', () => {
      const content = `# Agents Configuration

## Agent Roles

### orchestrator
- **Purpose**: Coordinate
- **Provider**: claude-code
- **Provider-Config**:
  - disable-compound-engineering: false
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].providerConfig?.disableCompoundEngineering).toBe(
        false
      );
    });

    it('should parse delegation and disable-compound-engineering together', () => {
      const content = `# Agents Configuration

## Agent Roles

### developer
- **Purpose**: Plan work
- **Provider**: claude-code
- **Provider-Config**:
  - delegation: false
  - disable-compound-engineering: true
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].providerConfig?.delegation).toBe(false);
      expect(result.agents[0].providerConfig?.disableCompoundEngineering).toBe(
        true
      );
    });

    it('should handle yes/no values for disable-compound-engineering', () => {
      const content = `# Agents Configuration

## Agent Roles

### developer
- **Purpose**: Write code
- **Provider**: claude-code
- **Provider-Config**:
  - disable-compound-engineering: yes
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].providerConfig?.disableCompoundEngineering).toBe(
        true
      );
    });

    it('should not set disableCompoundEngineering when not specified', () => {
      const content = `# Agents Configuration

## Agent Roles

### orchestrator
- **Purpose**: Coordinate
- **Provider**: claude-code
- **Provider-Config**:
  - delegation: true
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].providerConfig).toBeDefined();
      expect(result.agents[0].providerConfig?.delegation).toBe(true);
      expect(
        result.agents[0].providerConfig?.disableCompoundEngineering
      ).toBeUndefined();
    });

    it('should parse sub-agents from Provider-Config', () => {
      const content = `# Agents Configuration

## Agent Roles

### developer
- **Purpose**: Design systems
- **Provider**: claude-code
- **Provider-Config**:
  - sub-agents: architecture-strategist, pattern-recognition-specialist
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].providerConfig).toBeDefined();
      expect(result.agents[0].providerConfig?.subAgents).toEqual([
        'architecture-strategist',
        'pattern-recognition-specialist',
      ]);
    });

    it('should parse single sub-agent', () => {
      const content = `# Agents Configuration

## Agent Roles

### test-creator
- **Purpose**: Write tests
- **Provider**: claude-code
- **Provider-Config**:
  - sub-agents: framework-docs-researcher
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].providerConfig?.subAgents).toEqual([
        'framework-docs-researcher',
      ]);
    });

    it('should parse all provider-config options together', () => {
      const content = `# Agents Configuration

## Agent Roles

### developer
- **Purpose**: Design systems
- **Provider**: claude-code
- **Provider-Config**:
  - delegation: true
  - sub-agents: architecture-strategist
`;

      const result = parseAgentsMd(content);

      expect(result.agents[0].providerConfig?.delegation).toBe(true);
      expect(result.agents[0].providerConfig?.subAgents).toEqual([
        'architecture-strategist',
      ]);
    });
  });

  describe('subAgents Validation', () => {
    it('should accept valid sub-agent types', () => {
      const parsed: ParsedAgentsConfig = {
        agents: [
          {
            role: 'developer',
            isValidRole: true,
            purpose: 'Design systems',
            provider: 'claude-code',
            isValidProvider: true,
            providerConfig: {
              subAgents: [
                'architecture-strategist',
                'framework-docs-researcher',
              ],
            },
            lineNumber: 1,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const issues = validateParsedAgents(parsed);

      const subAgentIssues = issues.filter((i) => i.path.includes('subAgents'));
      expect(subAgentIssues).toHaveLength(0);
    });

    it('should reject invalid sub-agent types', () => {
      const parsed: ParsedAgentsConfig = {
        agents: [
          {
            role: 'developer',
            isValidRole: true,
            purpose: 'Design systems',
            provider: 'claude-code',
            isValidProvider: true,
            providerConfig: {
              subAgents: ['invalid-agent', 'architecture-strategist'] as any,
            },
            lineNumber: 1,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const issues = validateParsedAgents(parsed);

      const subAgentIssue = issues.find((i) =>
        i.message.includes('Invalid sub-agent type')
      );
      expect(subAgentIssue).toBeDefined();
      expect(subAgentIssue?.message).toContain('invalid-agent');
      expect(subAgentIssue?.suggestion).toContain('architecture-strategist');
    });

    it('should accept empty sub-agents array', () => {
      const parsed: ParsedAgentsConfig = {
        agents: [
          {
            role: 'developer',
            isValidRole: true,
            purpose: 'Write code',
            provider: 'claude-code',
            isValidProvider: true,
            providerConfig: {
              subAgents: [],
            },
            lineNumber: 1,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const issues = validateParsedAgents(parsed);

      const subAgentIssues = issues.filter((i) => i.path.includes('subAgents'));
      expect(subAgentIssues).toHaveLength(0);
    });

    it('should warn when subAgents configured for non-claude-code provider', () => {
      const parsed: ParsedAgentsConfig = {
        agents: [
          {
            role: 'developer',
            isValidRole: true,
            purpose: 'Write code',
            provider: 'cursor',
            isValidProvider: true,
            providerConfig: {
              subAgents: ['architecture-strategist'],
            },
            lineNumber: 1,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const issues = validateParsedAgents(parsed);

      const warningIssue = issues.find(
        (i) =>
          i.message.includes('has no effect') && i.message.includes('cursor')
      );
      expect(warningIssue).toBeDefined();
      expect(warningIssue?.severity).toBe('warning');
    });

    it('should pass subAgents through toAgentConfigs', () => {
      const parsed: ParsedAgentsConfig = {
        agents: [
          {
            role: 'developer',
            isValidRole: true,
            purpose: 'Design systems',
            provider: 'claude-code',
            isValidProvider: true,
            providerConfig: {
              subAgents: ['architecture-strategist'],
              delegation: true,
            },
            lineNumber: 1,
            rawContent: '',
          },
        ],
        customSections: {},
        rawContent: '',
      };

      const configs = toAgentConfigs(parsed);

      expect(configs[0].providerConfig).toBeDefined();
      expect(configs[0].providerConfig?.subAgents).toEqual([
        'architecture-strategist',
      ]);
      expect(configs[0].providerConfig?.delegation).toBe(true);
    });
  });

  describe('Model Validation', () => {
    describe('isValidModel', () => {
      it('should accept valid Anthropic aliases', () => {
        expect(isValidModel('opus')).toBe(true);
        expect(isValidModel('sonnet')).toBe(true);
        expect(isValidModel('haiku')).toBe(true);
      });

      it('should accept valid OpenAI models', () => {
        expect(isValidModel('gpt-4o')).toBe(true);
        expect(isValidModel('gpt-4o-mini')).toBe(true);
        expect(isValidModel('o1')).toBe(true);
        expect(isValidModel('o1-mini')).toBe(true);
      });

      it('should be case-insensitive', () => {
        expect(isValidModel('OPUS')).toBe(true);
        expect(isValidModel('Sonnet')).toBe(true);
        expect(isValidModel('GPT-4O')).toBe(true);
      });

      it('should reject invalid model names', () => {
        expect(isValidModel('invalid-model')).toBe(false);
        expect(isValidModel('gpt-5')).toBe(false);
        expect(isValidModel('claude-99')).toBe(false);
      });

      it('should reject typos', () => {
        expect(isValidModel('opsu')).toBe(false);
        expect(isValidModel('sonett')).toBe(false);
        expect(isValidModel('gpt-40')).toBe(false);
      });
    });

    describe('getValidModels', () => {
      it('should return all valid models', () => {
        const models = getValidModels();
        expect(models.length).toBeGreaterThan(0);
        expect(models).toContain('opus');
        expect(models).toContain('sonnet');
        expect(models).toContain('haiku');
        expect(models).toContain('gpt-4o');
      });

      it('should match VALID_MODELS constant', () => {
        expect(getValidModels()).toEqual(VALID_MODELS);
      });
    });

    describe('getCommonModelAliases', () => {
      it('should return common aliases for display', () => {
        const aliases = getCommonModelAliases();
        expect(aliases).toContain('opus');
        expect(aliases).toContain('sonnet');
        expect(aliases).toContain('haiku');
        expect(aliases).toContain('gpt-4o');
        expect(aliases).toContain('gpt-4o-mini');
      });

      it('should not include legacy models', () => {
        const aliases = getCommonModelAliases();
        expect(aliases).not.toContain('gpt-4-turbo');
        expect(aliases).not.toContain('gpt-4');
        expect(aliases).not.toContain('gpt-3.5-turbo');
      });
    });

    describe('parseAgentsMd with model field', () => {
      it('should parse model field', () => {
        const content = `# Agents

### orchestrator
- **Purpose**: Coordinate
- **Model**: sonnet
`;

        const result = parseAgentsMd(content);

        expect(result.agents[0].model).toBe('sonnet');
        expect(result.agents[0].isValidModel).toBe(true);
      });

      it('should parse model-rationale field', () => {
        const content = `# Agents

### orchestrator
- **Purpose**: Coordinate
- **Model**: opus
- **Model-Rationale**: Complex reasoning required
`;

        const result = parseAgentsMd(content);

        expect(result.agents[0].model).toBe('opus');
        expect(result.agents[0].modelRationale).toBe(
          'Complex reasoning required'
        );
      });

      it('should mark invalid models', () => {
        const content = `# Agents

### orchestrator
- **Purpose**: Coordinate
- **Model**: invalid-model
`;

        const result = parseAgentsMd(content);

        expect(result.agents[0].model).toBe('invalid-model');
        expect(result.agents[0].isValidModel).toBe(false);
      });

      it('should handle case-insensitive model names', () => {
        const content = `# Agents

### orchestrator
- **Purpose**: Coordinate
- **Model**: SONNET
`;

        const result = parseAgentsMd(content);

        expect(result.agents[0].model).toBe('SONNET');
        expect(result.agents[0].isValidModel).toBe(true);
      });
    });

    describe('validateParsedAgents with model validation', () => {
      it('should generate error for invalid model', () => {
        const content = `# Agents

### orchestrator
- **Purpose**: Coordinate
- **Model**: sonett
`;

        const parsed = parseAgentsMd(content);
        const issues = validateParsedAgents(parsed);

        const modelIssue = issues.find((i) => i.path.endsWith('.model'));
        expect(modelIssue).toBeDefined();
        expect(modelIssue?.severity).toBe('error');
        expect(modelIssue?.message).toContain("Unknown model 'sonett'");
        expect(modelIssue?.suggestion).toContain("Did you mean 'sonnet'");
      });

      it('should include lineNumber in model validation issue', () => {
        const content = `# Agents

### orchestrator
- **Purpose**: Coordinate
- **Model**: opsu
`;

        const parsed = parseAgentsMd(content);
        const issues = validateParsedAgents(parsed);

        const modelIssue = issues.find((i) => i.path.endsWith('.model'));
        expect(modelIssue?.lineNumber).toBeDefined();
        expect(modelIssue?.lineNumber).toBeGreaterThan(0);
      });

      it('should generate cost warning for expensive models', () => {
        const content = `# Agents

### orchestrator
- **Purpose**: Coordinate
- **Model**: opus
`;

        const parsed = parseAgentsMd(content);
        const issues = validateParsedAgents(parsed);

        const costWarning = issues.find(
          (i) => i.severity === 'info' && i.path.endsWith('.model')
        );
        expect(costWarning).toBeDefined();
        expect(costWarning?.message).toContain('opus');
        expect(costWarning?.suggestion).toContain('cost savings');
      });

      it('should generate cost warning for expensive OpenAI models', () => {
        const content = `# Agents

### orchestrator
- **Purpose**: Coordinate
- **Model**: o1
`;

        const parsed = parseAgentsMd(content);
        const issues = validateParsedAgents(parsed);

        const costWarning = issues.find(
          (i) => i.severity === 'info' && i.path.endsWith('.model')
        );
        expect(costWarning).toBeDefined();
        expect(costWarning?.message).toContain('o1');
        // Should suggest OpenAI alternatives, not Anthropic
        expect(costWarning?.suggestion).toContain('gpt-4o');
      });

      it('should not generate cost warning for cheaper models', () => {
        const content = `# Agents

### orchestrator
- **Purpose**: Coordinate
- **Model**: haiku
`;

        const parsed = parseAgentsMd(content);
        const issues = validateParsedAgents(parsed);

        const costWarning = issues.find(
          (i) => i.severity === 'info' && i.path.endsWith('.model')
        );
        expect(costWarning).toBeUndefined();
      });

      it('should use lenient mode for warnings instead of errors', () => {
        const content = `# Agents

### orchestrator
- **Purpose**: Coordinate
- **Model**: invalid-model
`;

        const parsed = parseAgentsMd(content);
        const issues = validateParsedAgents(parsed, 'lenient');

        const modelIssue = issues.find((i) => i.path.endsWith('.model'));
        expect(modelIssue?.severity).toBe('warning');
      });

      it('should generate error for OpenAI model with claude-code provider', () => {
        const content = `# Agents

### orchestrator
- **Purpose**: Coordinate
- **Provider**: claude-code
- **Model**: gpt-4o
`;

        const parsed = parseAgentsMd(content);
        const issues = validateParsedAgents(parsed);

        const compatibilityIssue = issues.find(
          (i) =>
            i.path.endsWith('.model') &&
            i.message.includes('not compatible with provider')
        );
        expect(compatibilityIssue).toBeDefined();
        expect(compatibilityIssue?.severity).toBe('error');
        expect(compatibilityIssue?.message).toContain("Model 'gpt-4o'");
        expect(compatibilityIssue?.message).toContain("provider 'claude-code'");
        expect(compatibilityIssue?.suggestion).toContain('Anthropic model');
      });

      it('should generate error for Anthropic model with cursor provider', () => {
        const content = `# Agents

### orchestrator
- **Purpose**: Coordinate
- **Provider**: cursor
- **Model**: sonnet
`;

        const parsed = parseAgentsMd(content);
        const issues = validateParsedAgents(parsed);

        const compatibilityIssue = issues.find(
          (i) =>
            i.path.endsWith('.model') &&
            i.message.includes('not compatible with provider')
        );
        expect(compatibilityIssue).toBeDefined();
        expect(compatibilityIssue?.severity).toBe('error');
        expect(compatibilityIssue?.message).toContain("Model 'sonnet'");
        expect(compatibilityIssue?.message).toContain("provider 'cursor'");
        expect(compatibilityIssue?.suggestion).toContain('OpenAI model');
      });

      it('should generate error for Anthropic model with codex provider', () => {
        const content = `# Agents

### orchestrator
- **Purpose**: Coordinate
- **Provider**: codex
- **Model**: opus
`;

        const parsed = parseAgentsMd(content);
        const issues = validateParsedAgents(parsed);

        const compatibilityIssue = issues.find(
          (i) =>
            i.path.endsWith('.model') &&
            i.message.includes('not compatible with provider')
        );
        expect(compatibilityIssue).toBeDefined();
        expect(compatibilityIssue?.suggestion).toContain('OpenAI model');
      });

      it('should not generate compatibility error for matching provider and model', () => {
        const content = `# Agents

### orchestrator
- **Purpose**: Coordinate
- **Provider**: claude-code
- **Model**: sonnet

### code-reviewer
- **Purpose**: Review code
- **Provider**: codex
- **Model**: gpt-4o
`;

        const parsed = parseAgentsMd(content);
        const issues = validateParsedAgents(parsed);

        const compatibilityIssues = issues.filter(
          (i) =>
            i.path.endsWith('.model') &&
            i.message.includes('not compatible with provider')
        );
        expect(compatibilityIssues.length).toBe(0);
      });

      it('should use warning severity in lenient mode for compatibility issues', () => {
        const content = `# Agents

### orchestrator
- **Purpose**: Coordinate
- **Provider**: claude-code
- **Model**: gpt-4o
`;

        const parsed = parseAgentsMd(content);
        const issues = validateParsedAgents(parsed, 'lenient');

        const compatibilityIssue = issues.find(
          (i) =>
            i.path.endsWith('.model') &&
            i.message.includes('not compatible with provider')
        );
        expect(compatibilityIssue).toBeDefined();
        expect(compatibilityIssue?.severity).toBe('warning');
      });
    });
  });
});
