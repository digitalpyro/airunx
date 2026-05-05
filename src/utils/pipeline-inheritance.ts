/**
 * Pipeline Inheritance Processor
 *
 * Resolves stages_inherit and stage_overrides to produce fully-resolved pipeline configurations.
 * This allows DRY pipeline definitions where pipelines can inherit from others.
 *
 */

import type {
  Pipeline,
  PipelineConfig,
  PipelineStage,
  RawPipeline,
  RawPipelineConfig,
} from '../core/types.js';
import { createLogger } from './logger.js';

const logger = createLogger('pipeline-inheritance');

/**
 * Resolve pipeline inheritance for all pipelines in the config.
 * Pipelines must be resolved in dependency order (parents before children).
 */
export function resolvePipelineInheritance(
  rawConfig: RawPipelineConfig
): PipelineConfig {
  const resolved: Record<string, Pipeline> = {};
  const rawPipelines = rawConfig.pipelines;

  // Build dependency graph and resolve in order
  const resolutionOrder = getResolutionOrder(rawPipelines);

  for (const pipelineName of resolutionOrder) {
    const rawPipeline = rawPipelines[pipelineName];
    resolved[pipelineName] = resolveSinglePipeline(
      pipelineName,
      rawPipeline,
      resolved
    );
  }

  return {
    global: rawConfig.global,
    pipelines: resolved,
  };
}

/**
 * Get the order in which pipelines should be resolved (topological sort).
 * Parents must be resolved before children.
 */
function getResolutionOrder(pipelines: Record<string, RawPipeline>): string[] {
  const visited = new Set<string>();
  const result: string[] = [];

  function visit(name: string, visiting: Set<string>): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(
        `Circular pipeline inheritance detected: ${Array.from(visiting).join(' -> ')} -> ${name}`
      );
    }

    const pipeline = pipelines[name];
    if (!pipeline) {
      throw new Error(`Pipeline '${name}' not found`);
    }

    visiting.add(name);

    // Visit parent first if it exists
    if (pipeline.stages_inherit) {
      visit(pipeline.stages_inherit, visiting);
    }

    visiting.delete(name);
    visited.add(name);
    result.push(name);
  }

  // Visit all pipelines
  for (const name of Object.keys(pipelines)) {
    visit(name, new Set());
  }

  return result;
}

/**
 * Resolve a single pipeline, using already-resolved parent if inheriting.
 */
function resolveSinglePipeline(
  name: string,
  raw: RawPipeline,
  resolved: Record<string, Pipeline>
): Pipeline {
  // If no inheritance, pipeline must have its own stages
  // Note: Schema validates stages OR stages_inherit is present; we check for empty array here
  if (!raw.stages_inherit) {
    if (!raw.stages || raw.stages.length === 0) {
      throw new Error(`Pipeline '${name}' must have at least one stage`);
    }

    // Validate all stages have agents (required for non-override stages)
    for (const stage of raw.stages) {
      if (!stage.agent) {
        throw new Error(
          `Stage '${stage.name}' in pipeline '${name}' must have an agent`
        );
      }
    }

    return {
      name: raw.name,
      description: raw.description,
      deliverable: raw.deliverable ?? 'pull_request',
      default_fidelity: raw.default_fidelity,
      max_iterations: raw.max_iterations,
      timeout_minutes: raw.timeout_minutes,
      stages: raw.stages as PipelineStage[],
    };
  }

  // Inherit from parent
  const parentName = raw.stages_inherit;
  const parent = resolved[parentName];

  if (!parent) {
    throw new Error(
      `Pipeline '${name}' inherits from '${parentName}' which is not resolved yet`
    );
  }

  logger.debug(`Pipeline '${name}' inheriting from '${parentName}'`);

  // Clone parent stages
  let stages: PipelineStage[] = parent.stages.map((s) => ({ ...s }));

  // Apply stage overrides
  if (raw.stage_overrides) {
    stages = applyStageOverrides(stages, raw.stage_overrides, name);
  }

  return {
    name: raw.name,
    description: raw.description,
    deliverable: raw.deliverable ?? parent.deliverable,
    default_fidelity: raw.default_fidelity ?? parent.default_fidelity,
    max_iterations: raw.max_iterations ?? parent.max_iterations,
    timeout_minutes: raw.timeout_minutes ?? parent.timeout_minutes,
    stages,
  };
}

/**
 * Apply stage overrides to inherited stages.
 * Supports:
 * - Modifying existing stages (matched by name)
 * - Inserting new stages (via insert_before/insert_after)
 */
function applyStageOverrides(
  stages: PipelineStage[],
  overrides: PipelineStage[],
  pipelineName: string
): PipelineStage[] {
  const result = [...stages];

  for (const override of overrides) {
    if (override.insert_before) {
      // Insert new stage before specified stage
      const targetIdx = result.findIndex(
        (s) => s.name === override.insert_before
      );
      if (targetIdx === -1) {
        throw new Error(
          `Cannot insert stage '${override.name}' before '${override.insert_before}' in pipeline '${pipelineName}': target stage not found`
        );
      }

      // Validate new stage has agent
      if (!override.agent) {
        throw new Error(
          `New stage '${override.name}' (insert_before: ${override.insert_before}) must have an agent`
        );
      }

      // Remove insert_before from the stage object
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { insert_before: _insertBefore, ...cleanStage } = override;
      result.splice(targetIdx, 0, cleanStage as PipelineStage);
      logger.debug(
        `Inserted stage '${override.name}' before '${override.insert_before}'`
      );
    } else if (override.insert_after) {
      // Insert new stage after specified stage
      const targetIdx = result.findIndex(
        (s) => s.name === override.insert_after
      );
      if (targetIdx === -1) {
        throw new Error(
          `Cannot insert stage '${override.name}' after '${override.insert_after}' in pipeline '${pipelineName}': target stage not found`
        );
      }

      // Validate new stage has agent
      if (!override.agent) {
        throw new Error(
          `New stage '${override.name}' (insert_after: ${override.insert_after}) must have an agent`
        );
      }

      // Remove insert_after from the stage object
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { insert_after: _insertAfter, ...cleanStage } = override;
      result.splice(targetIdx + 1, 0, cleanStage as PipelineStage);
      logger.debug(
        `Inserted stage '${override.name}' after '${override.insert_after}'`
      );
    } else {
      // Modify existing stage
      const existingIdx = result.findIndex((s) => s.name === override.name);
      if (existingIdx === -1) {
        throw new Error(
          `Cannot override stage '${override.name}' in pipeline '${pipelineName}': stage not found in parent`
        );
      }

      // Merge override with existing stage (override takes precedence)
      // Strip insert_before/insert_after to prevent them being added to modified stages
      /* eslint-disable @typescript-eslint/no-unused-vars */
      const {
        insert_before: _ib,
        insert_after: _ia,
        ...cleanOverride
      } = override;
      /* eslint-enable @typescript-eslint/no-unused-vars */
      result[existingIdx] = {
        ...result[existingIdx],
        ...Object.fromEntries(
          Object.entries(cleanOverride).filter(([_, v]) => v !== undefined)
        ),
      } as PipelineStage;
      logger.debug(`Modified stage '${override.name}'`);
    }
  }

  return result;
}
