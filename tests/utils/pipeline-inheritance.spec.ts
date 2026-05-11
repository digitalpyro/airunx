/**
 * Tests for Pipeline Inheritance Processor
 * Validates stages_inherit and stage_overrides functionality
 */

import { describe, it, expect } from 'vitest';
import { resolvePipelineInheritance } from '../../src/utils/pipeline-inheritance.js';
import type { RawPipelineConfig } from '../../src/core/types.js';

describe('resolvePipelineInheritance', () => {
  describe('basic inheritance', () => {
    it('should pass through pipelines without inheritance', () => {
      const rawConfig: RawPipelineConfig = {
        pipelines: {
          standard: {
            name: 'Standard Pipeline',
            stages: [
              { name: 'strategize', agent: 'developer' },
              { name: 'implement', agent: 'developer' },
            ],
          },
        },
      };

      const result = resolvePipelineInheritance(rawConfig);

      expect(result.pipelines.standard.stages).toHaveLength(2);
      expect(result.pipelines.standard.stages[0].agent).toBe('developer');
    });

    it('should inherit stages from parent pipeline', () => {
      const rawConfig: RawPipelineConfig = {
        pipelines: {
          standard: {
            name: 'Standard Pipeline',
            stages: [
              { name: 'strategize', agent: 'developer' },
              { name: 'implement', agent: 'developer' },
              { name: 'review', agent: 'code-reviewer' },
            ],
          },
          thin: {
            name: 'Thin Pipeline',
            stages_inherit: 'standard',
          },
        },
      };

      const result = resolvePipelineInheritance(rawConfig);

      expect(result.pipelines.thin.stages).toHaveLength(3);
      expect(result.pipelines.thin.stages[0].name).toBe('strategize');
      expect(result.pipelines.thin.stages[1].name).toBe('implement');
      expect(result.pipelines.thin.stages[2].name).toBe('review');
    });

    it('should inherit deliverable from parent if not specified', () => {
      const rawConfig: RawPipelineConfig = {
        pipelines: {
          standard: {
            name: 'Standard Pipeline',
            deliverable: 'pull_request',
            stages: [{ name: 'implement', agent: 'developer' }],
          },
          thin: {
            name: 'Thin Pipeline',
            stages_inherit: 'standard',
          },
        },
      };

      const result = resolvePipelineInheritance(rawConfig);

      expect(result.pipelines.thin.deliverable).toBe('pull_request');
    });

    it('should allow child to override deliverable', () => {
      const rawConfig: RawPipelineConfig = {
        pipelines: {
          standard: {
            name: 'Standard Pipeline',
            deliverable: 'pull_request',
            stages: [{ name: 'implement', agent: 'developer' }],
          },
          feature: {
            name: 'Feature Pipeline',
            deliverable: 'documentation',
            stages_inherit: 'standard',
          },
        },
      };

      const result = resolvePipelineInheritance(rawConfig);

      expect(result.pipelines.feature.deliverable).toBe('documentation');
    });
  });

  describe('stage overrides', () => {
    it('should modify existing stage properties', () => {
      const rawConfig: RawPipelineConfig = {
        pipelines: {
          standard: {
            name: 'Standard Pipeline',
            stages: [
              { name: 'implement', agent: 'developer', optional: false },
            ],
          },
          thin: {
            name: 'Thin Pipeline',
            stages_inherit: 'standard',
            stage_overrides: [{ name: 'implement', optional: true }],
          },
        },
      };

      const result = resolvePipelineInheritance(rawConfig);

      expect(result.pipelines.thin.stages[0].optional).toBe(true);
      // Agent should be preserved from parent
      expect(result.pipelines.thin.stages[0].agent).toBe('developer');
    });

    it('should insert stage before specified stage', () => {
      const rawConfig: RawPipelineConfig = {
        pipelines: {
          standard: {
            name: 'Standard Pipeline',
            stages: [
              { name: 'implement', agent: 'developer' },
              { name: 'review', agent: 'code-reviewer' },
            ],
          },
          feature: {
            name: 'Feature Pipeline',
            stages_inherit: 'standard',
            stage_overrides: [
              {
                name: 'analyze',
                agent: 'code-reviewer',
                insertBefore: 'review',
              },
            ],
          },
        },
      };

      const result = resolvePipelineInheritance(rawConfig);

      expect(result.pipelines.feature.stages).toHaveLength(3);
      expect(result.pipelines.feature.stages[0].name).toBe('implement');
      expect(result.pipelines.feature.stages[1].name).toBe('analyze');
      expect(result.pipelines.feature.stages[2].name).toBe('review');
    });

    it('should insert stage after specified stage', () => {
      const rawConfig: RawPipelineConfig = {
        pipelines: {
          standard: {
            name: 'Standard Pipeline',
            stages: [
              { name: 'implement', agent: 'developer' },
              { name: 'review', agent: 'code-reviewer' },
            ],
          },
          feature: {
            name: 'Feature Pipeline',
            stages_inherit: 'standard',
            stage_overrides: [
              {
                name: 'test',
                agent: 'test-creator',
                insertAfter: 'implement',
              },
            ],
          },
        },
      };

      const result = resolvePipelineInheritance(rawConfig);

      expect(result.pipelines.feature.stages).toHaveLength(3);
      expect(result.pipelines.feature.stages[0].name).toBe('implement');
      expect(result.pipelines.feature.stages[1].name).toBe('test');
      expect(result.pipelines.feature.stages[2].name).toBe('review');
    });
  });

  describe('error handling', () => {
    it('should throw on missing stages without inheritance', () => {
      const rawConfig: RawPipelineConfig = {
        pipelines: {
          broken: {
            name: 'Broken Pipeline',
            // No stages and no stages_inherit
          },
        },
      };

      expect(() => resolvePipelineInheritance(rawConfig)).toThrow(
        /must have at least one stage/
      );
    });

    it('should throw on circular inheritance', () => {
      const rawConfig: RawPipelineConfig = {
        pipelines: {
          standard: {
            name: 'Standard Pipeline',
            stages_inherit: 'thin',
          },
          thin: {
            name: 'Thin Pipeline',
            stages_inherit: 'standard',
          },
        },
      };

      expect(() => resolvePipelineInheritance(rawConfig)).toThrow(
        /Circular pipeline inheritance detected/
      );
    });

    it('should throw on missing parent pipeline', () => {
      const rawConfig: RawPipelineConfig = {
        pipelines: {
          thin: {
            name: 'Thin Pipeline',
            stages_inherit: 'nonexistent',
          },
        },
      };

      expect(() => resolvePipelineInheritance(rawConfig)).toThrow(
        /not found/
      );
    });

    it('should throw on insertBefore with nonexistent target', () => {
      const rawConfig: RawPipelineConfig = {
        pipelines: {
          standard: {
            name: 'Standard Pipeline',
            stages: [{ name: 'implement', agent: 'developer' }],
          },
          feature: {
            name: 'Feature Pipeline',
            stages_inherit: 'standard',
            stage_overrides: [
              {
                name: 'test',
                agent: 'test-creator',
                insertBefore: 'nonexistent',
              },
            ],
          },
        },
      };

      expect(() => resolvePipelineInheritance(rawConfig)).toThrow(
        /target stage not found/
      );
    });

    it('should throw on override of nonexistent stage', () => {
      const rawConfig: RawPipelineConfig = {
        pipelines: {
          standard: {
            name: 'Standard Pipeline',
            stages: [{ name: 'implement', agent: 'developer' }],
          },
          feature: {
            name: 'Feature Pipeline',
            stages_inherit: 'standard',
            stage_overrides: [{ name: 'nonexistent', optional: true }],
          },
        },
      };

      expect(() => resolvePipelineInheritance(rawConfig)).toThrow(
        /stage not found in parent/
      );
    });

    it('should throw when new stage has no agent', () => {
      const rawConfig: RawPipelineConfig = {
        pipelines: {
          standard: {
            name: 'Standard Pipeline',
            stages: [{ name: 'implement', agent: 'developer' }],
          },
          feature: {
            name: 'Feature Pipeline',
            stages_inherit: 'standard',
            stage_overrides: [
              {
                name: 'test',
                // No agent specified for new stage
                insertAfter: 'implement',
              },
            ],
          },
        },
      };

      expect(() => resolvePipelineInheritance(rawConfig)).toThrow(
        /must have an agent/
      );
    });
  });

  describe('multi-level inheritance', () => {
    it('should resolve chain of inheritance', () => {
      const rawConfig: RawPipelineConfig = {
        pipelines: {
          standard: {
            name: 'Standard Pipeline',
            stages: [
              { name: 'strategize', agent: 'developer' },
              { name: 'implement', agent: 'developer' },
            ],
          },
          feature: {
            name: 'Feature Pipeline',
            stages_inherit: 'standard',
            stage_overrides: [
              { name: 'review', agent: 'code-reviewer', insertAfter: 'implement' },
            ],
          },
          'mission-critical': {
            name: 'Mission Critical Pipeline',
            stages_inherit: 'feature',
            stage_overrides: [
              { name: 'judge', agent: 'code-judge', insertAfter: 'review' },
            ],
          },
        },
      };

      const result = resolvePipelineInheritance(rawConfig);

      // mission-critical should have all stages from chain
      expect(result.pipelines['mission-critical'].stages).toHaveLength(4);
      expect(result.pipelines['mission-critical'].stages.map((s) => s.name)).toEqual([
        'strategize',
        'implement',
        'review',
        'judge',
      ]);
    });
  });

  describe('global config passthrough', () => {
    it('should preserve global config', () => {
      const rawConfig: RawPipelineConfig = {
        global: {
          verdict_enum: ['ITERATE', 'PROCEED', 'BLOCK', 'FAIL'],
          handoff_schema_version: '1.0',
        },
        pipelines: {
          standard: {
            name: 'Standard Pipeline',
            stages: [{ name: 'implement', agent: 'developer' }],
          },
        },
      };

      const result = resolvePipelineInheritance(rawConfig);

      expect(result.global?.verdict_enum).toEqual([
        'ITERATE',
        'PROCEED',
        'BLOCK',
        'FAIL',
      ]);
      expect(result.global?.handoff_schema_version).toBe('1.0');
    });
  });
});
