/**
 * Tests for Core Types and Schemas
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StateManager } from '../../src/orchestrator/state-manager.js';
import {
  mergeCostSummaries,
  spawnCostSummary,
} from '../../src/core/cost-accounting.js';
import {
  PIPELINE_TYPES,
  DELIVERABLE_TYPES,
  AGENT_ROLES,
  EXECUTION_FIDELITY_LEVELS,
  PipelineTypeSchema,
  DeliverableTypeSchema,
  PipelineSchema,
  AgentRoleSchema,
  ExecutionFidelityLevelSchema,
  WorkflowContextSchema,
  type WorkflowContext,
  type StageRecord,
} from '../../src/core/types.js';

describe('Core Types', () => {
  describe('PIPELINE_TYPES', () => {
    it('should contain all expected pipeline types', () => {
      expect(PIPELINE_TYPES).toContain('thin');
      expect(PIPELINE_TYPES).toContain('standard');
      expect(PIPELINE_TYPES).toContain('feature');
      expect(PIPELINE_TYPES).toContain('mission-critical');
      expect(PIPELINE_TYPES).toHaveLength(4);
    });
  });

  describe('DELIVERABLE_TYPES', () => {
    it('should contain all expected deliverable types', () => {
      expect(DELIVERABLE_TYPES).toContain('github_issue');
      expect(DELIVERABLE_TYPES).toContain('pull_request');
      expect(DELIVERABLE_TYPES).toContain('documentation');
      expect(DELIVERABLE_TYPES).toContain('report');
      expect(DELIVERABLE_TYPES).toHaveLength(4);
    });
  });

  describe('AGENT_ROLES', () => {
    it('should contain execution pipeline agents', () => {
      expect(AGENT_ROLES).toContain('developer');
      expect(AGENT_ROLES).toContain('code-reviewer');
      expect(AGENT_ROLES).toContain('static-analyzer');
      expect(AGENT_ROLES).toContain('test-creator');
      expect(AGENT_ROLES).toContain('code-judge');
      expect(AGENT_ROLES).toContain('docs-generator');
      expect(AGENT_ROLES).toContain('orchestrator');
      expect(AGENT_ROLES).toHaveLength(7);
    });
  });

  describe('EXECUTION_FIDELITY_LEVELS', () => {
    it('should contain all expected fidelity levels', () => {
      expect(EXECUTION_FIDELITY_LEVELS).toContain('fast');
      expect(EXECUTION_FIDELITY_LEVELS).toContain('standard');
      expect(EXECUTION_FIDELITY_LEVELS).toContain('thorough');
      expect(EXECUTION_FIDELITY_LEVELS).toContain('ultra');
      expect(EXECUTION_FIDELITY_LEVELS).toHaveLength(4);
    });
  });

  // NOTE: PIPELINE_MAX_ITERATIONS, PIPELINE_DEFAULT_FIDELITY, and PIPELINE_DELIVERABLES
  // constants were removed in favor of YAML config as the single source of truth.
  // See config/default/pipelines.yaml for pipeline definitions.
});

describe('Zod Schemas', () => {
  describe('PipelineTypeSchema', () => {
    it('should validate valid pipeline types', () => {
      expect(PipelineTypeSchema.parse('thin')).toBe('thin');
      expect(PipelineTypeSchema.parse('standard')).toBe('standard');
      expect(PipelineTypeSchema.parse('feature')).toBe('feature');
      expect(PipelineTypeSchema.parse('mission-critical')).toBe(
        'mission-critical'
      );
    });

    it('should reject invalid pipeline types', () => {
      expect(() => PipelineTypeSchema.parse('invalid')).toThrow();
      expect(() => PipelineTypeSchema.parse('')).toThrow();
      expect(() => PipelineTypeSchema.parse(123)).toThrow();
    });
  });

  describe('DeliverableTypeSchema', () => {
    it('should validate valid deliverable types', () => {
      expect(DeliverableTypeSchema.parse('github_issue')).toBe('github_issue');
      expect(DeliverableTypeSchema.parse('pull_request')).toBe('pull_request');
      expect(DeliverableTypeSchema.parse('documentation')).toBe(
        'documentation'
      );
      expect(DeliverableTypeSchema.parse('report')).toBe('report');
    });

    it('should reject invalid deliverable types', () => {
      expect(() => DeliverableTypeSchema.parse('pr')).toThrow();
      expect(() => DeliverableTypeSchema.parse('issue')).toThrow();
    });
  });

  describe('AgentRoleSchema', () => {
    it('should validate all agent roles', () => {
      const roles = [
        'developer',
        'code-reviewer',
        'test-creator',
        'code-judge',
        'docs-generator',
        'orchestrator',
      ];
      roles.forEach((role) => {
        expect(AgentRoleSchema.parse(role)).toBe(role);
      });
    });

    it('should reject invalid agent roles', () => {
      expect(() => AgentRoleSchema.parse('invalid-role')).toThrow();
      expect(() => AgentRoleSchema.parse('manager')).toThrow();
    });
  });

  describe('ExecutionFidelityLevelSchema', () => {
    it('should validate all fidelity levels', () => {
      expect(ExecutionFidelityLevelSchema.parse('fast')).toBe('fast');
      expect(ExecutionFidelityLevelSchema.parse('standard')).toBe('standard');
      expect(ExecutionFidelityLevelSchema.parse('thorough')).toBe('thorough');
      expect(ExecutionFidelityLevelSchema.parse('ultra')).toBe('ultra');
    });

    it('should reject invalid fidelity levels', () => {
      expect(() => ExecutionFidelityLevelSchema.parse('slow')).toThrow();
      expect(() => ExecutionFidelityLevelSchema.parse('maximum')).toThrow();
    });
  });

  describe('PipelineSchema', () => {
    it('should validate a complete pipeline definition', () => {
      const pipeline = {
        name: 'test-pipeline',
        description: 'A test pipeline',
        deliverable: 'pull_request',
        default_fidelity: 'standard',
        stages: [
          {
            name: 'stage-1',
            agent: 'developer',
            description: 'First stage',
          },
        ],
      };

      const result = PipelineSchema.parse(pipeline);
      expect(result.name).toBe('test-pipeline');
      expect(result.deliverable).toBe('pull_request');
      expect(result.stages).toHaveLength(1);
    });

    it('should default deliverable to pull_request', () => {
      const pipeline = {
        name: 'minimal-pipeline',
        stages: [
          {
            name: 'stage-1',
            agent: 'code-reviewer',
          },
        ],
      };

      const result = PipelineSchema.parse(pipeline);
      expect(result.deliverable).toBe('pull_request');
    });

    it('should reject pipeline without name', () => {
      const pipeline = {
        stages: [{ name: 'stage-1', agent: 'code-reviewer' }],
      };

      expect(() => PipelineSchema.parse(pipeline)).toThrow();
    });

    it('should reject pipeline without stages', () => {
      const pipeline = {
        name: 'empty-pipeline',
        stages: [],
      };

      expect(() => PipelineSchema.parse(pipeline)).toThrow(
        /at least one stage/
      );
    });

    it('should validate pipeline with max_iterations', () => {
      const pipeline = {
        name: 'thin',
        deliverable: 'pull_request',
        max_iterations: 3,
        stages: [{ name: 'implement', agent: 'developer' }],
      };

      const result = PipelineSchema.parse(pipeline);
      expect(result.max_iterations).toBe(3);
    });

    it('should allow pipeline without max_iterations', () => {
      const pipeline = {
        name: 'basic',
        stages: [{ name: 'implement', agent: 'developer' }],
      };

      const result = PipelineSchema.parse(pipeline);
      expect(result.max_iterations).toBeUndefined();
    });

    it('should reject negative max_iterations', () => {
      const pipeline = {
        name: 'invalid',
        max_iterations: -1,
        stages: [{ name: 'implement', agent: 'developer' }],
      };

      expect(() => PipelineSchema.parse(pipeline)).toThrow();
    });
  });
});

describe('WorkflowContext cost provenance round-trip', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const summary = mergeCostSummaries(
    spawnCostSummary({
      costUsd: 1.5,
      costProvenance: 'reported',
      billingBasis: 'api_equivalent',
      tokens: {
        inputTokens: 18_000,
        outputTokens: 2_000,
        cacheReadInputTokens: 10_000,
        cacheWriteInputTokens: 7_000,
        cacheWrite5mInputTokens: 3_000,
        cacheWrite1hInputTokens: 4_000,
        reasoningOutputTokens: 500,
      },
      tokenProvenance: 'reported',
    }),
    spawnCostSummary({
      costUsd: 0.2,
      costProvenance: 'estimated',
      billingBasis: 'billed',
      pricingVersion: 'sha256:0123456789ab',
      estimationMethods: ['chars_div_4'],
      unmodeledModifiers: ['fast_mode'],
    })
  )!;

  const stageRecord: StageRecord = {
    stage: 'implement',
    agent: 'developer',
    backend: 'claude-code',
    spawnCount: 2,
    durationMs: 1000,
    tokensUsed: 20_000,
    costUsd: 1.7,
    timestamp: '2026-10-16T10:00:00.000Z',
    status: 'completed',
    costSummary: summary,
  };

  const context: WorkflowContext = {
    id: 'wf-roundtrip',
    input: 'task',
    inputType: 'prompt',
    mode: 'pipeline',
    createdAt: new Date('2026-10-16T10:00:00.000Z'),
    status: 'completed',
    metrics: {
      tokensUsed: 20_000,
      runtime: 1,
      stagesCompleted: 1,
      totalStages: 1,
      errors: 0,
      totalCost: 1.7,
      costSummary: summary,
    },
    stageRecords: [stageRecord],
    iterationHistory: {
      entries: [
        {
          iteration: 1,
          timestamp: new Date('2026-10-16T10:01:00.000Z'),
          approach: 'first',
          verdict: 'PROCEED',
          gaps: [],
          stageRecords: [stageRecord],
        },
      ],
    },
  };

  it('keeps provenance, billing and cache fields through schema parse', () => {
    const parsed = WorkflowContextSchema.parse(
      JSON.parse(JSON.stringify(context))
    );
    expect(parsed.metrics.costSummary).toEqual(summary);
    expect(parsed.stageRecords?.[0].costSummary).toEqual(summary);
    expect(
      parsed.iterationHistory?.entries[0].stageRecords?.[0].costSummary
    ).toEqual(summary);
  });

  it('survives StateManager save + load intact', async () => {
    dir = mkdtempSync(join(tmpdir(), 'airunx-types-'));
    const manager = new StateManager(dir);
    await manager.save(context);
    const loaded = await manager.load(context.id);
    expect(loaded?.metrics.costSummary).toEqual(summary);
    expect(loaded?.stageRecords?.[0].costSummary?.tokens).toEqual(
      summary.tokens
    );
    expect(
      loaded?.iterationHistory?.entries[0].stageRecords?.[0].costSummary
    ).toEqual(summary);
  });
});
