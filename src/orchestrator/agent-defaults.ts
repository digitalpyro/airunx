/**
 * Default Agent Configurations
 *
 * Single source of truth for agent defaults when AGENTS.md doesn't define a role.
 * Sorted alphabetically to match AGENT_ROLES in types.ts for consistency.
 */

import type { AgentRole } from '../core/types.js';

/**
 * Default agent definition (without systemPrompt, which is built dynamically)
 */
export interface DefaultAgentConfig {
  capabilities: string[];
  contextRequired: string[];
  defaultPrompt: string;
}

/**
 * Default agent configurations - single source of truth for agent defaults.
 * Used when AGENTS.md doesn't define a role.
 * Sorted alphabetically to match AGENT_ROLES in types.ts for consistency.
 */
export const DEFAULT_AGENT_CONFIGS: Record<AgentRole, DefaultAgentConfig> = {
  'code-judge': {
    capabilities: [
      'quality-assessment',
      'iteration-decisions',
      'acceptance-criteria',
    ],
    contextRequired: [
      'verification-results',
      'acceptance-criteria',
      'iteration-count',
    ],
    defaultPrompt:
      'You are a quality judge agent responsible for evaluating whether work meets acceptance criteria and deciding if iteration is needed.',
  },
  'code-reviewer': {
    capabilities: ['code-review', 'quality-checks', 'best-practices'],
    contextRequired: ['code-changes', 'standards'],
    defaultPrompt:
      'You are a code reviewer agent responsible for ensuring code quality, security, and adherence to best practices.',
  },
  developer: {
    capabilities: [
      'architecture',
      'design',
      'strategic-planning',
      'coding',
      'implementation',
      'debugging',
    ],
    contextRequired: [
      'requirements',
      'constraints',
      'design',
      'files',
      'git-context',
    ],
    defaultPrompt:
      'You are a developer agent responsible for both strategic design and implementation. You produce working, secure, well-designed code.',
  },
  'docs-generator': {
    capabilities: ['documentation', 'api-docs', 'readme'],
    contextRequired: ['code', 'changes'],
    defaultPrompt:
      'You are a documentation generator agent responsible for creating and updating project documentation.',
  },
  orchestrator: {
    capabilities: ['planning', 'coordination', 'decision-making'],
    contextRequired: ['task', 'fidelity'],
    defaultPrompt:
      'You are an orchestrator agent responsible for planning and coordinating work across multiple specialized agents.',
  },
  'static-analyzer': {
    capabilities: [
      'static-analysis',
      'linting',
      'type-checking',
      'test-failure-interpretation',
    ],
    contextRequired: ['code-files', 'test-output'],
    defaultPrompt:
      'You are a static analysis agent responsible for running automated checks on code and interpreting test failures. When tests fail with snapshot assertions, you identify the snapshot files that need updating.',
  },
  'test-creator': {
    capabilities: ['test-design', 'test-implementation', 'coverage'],
    contextRequired: ['code', 'requirements'],
    defaultPrompt:
      'You are a test creation agent responsible for writing comprehensive test suites.',
  },
};
