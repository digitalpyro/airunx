/**
 * Handoff Context Formatter
 *
 * Serializes previous stage outputs into a prompt-injectable string
 * for downstream agents. Supports compact (fast fidelity) and full
 * format modes with an aggregate size budget.
 */

import type { ExecutionFidelityLevel } from '../core/types.js';

/** Default aggregate budget in bytes for all handoff context */
const DEFAULT_MAX_HANDOFF_BYTES = 16 * 1024; // 16 KB

type StageOutput = {
  success: boolean;
  outputs: {
    files?: Array<{ path: string; action: string; content?: string }>;
    analysis?: string;
    recommendations?: string[];
    [key: string]: unknown;
  };
  metrics: {
    tokensUsed: number;
    duration: number;
    cost?: number;
    provider?: string;
    spawnCount?: number;
  };
  errors?: Error[];
};

export type HandoffFormat = 'compact' | 'full';

export interface HandoffFormatOptions {
  fidelityLevel: ExecutionFidelityLevel;
  maxBytes?: number;
}

/**
 * Resolve handoff format from fidelity level.
 * fast → compact, everything else → full.
 */
export function resolveHandoffFormat(
  fidelityLevel: ExecutionFidelityLevel
): HandoffFormat {
  return fidelityLevel === 'fast' ? 'compact' : 'full';
}

/**
 * Format a single stage output for handoff.
 */
function formatStageOutput(
  stageName: string,
  output: StageOutput,
  format: HandoffFormat
): string {
  const lines: string[] = [`### ${stageName}`];

  // Always include status
  lines.push(`Status: ${output.success ? 'completed' : 'error'}`);

  // For implement stage, compress to files-changed list only (no full diffs)
  if (stageName === 'implement' && output.outputs.files?.length) {
    const fileList = output.outputs.files
      .map((f) => `  - ${f.action}: ${f.path}`)
      .join('\n');
    lines.push(`Files changed:\n${fileList}`);
    if (format === 'full' && output.outputs.recommendations?.length) {
      lines.push(
        `Recommendations: ${output.outputs.recommendations.join('; ')}`
      );
    }
    return lines.join('\n');
  }

  // Analysis summary
  if (output.outputs.analysis) {
    const analysis = output.outputs.analysis;
    if (format === 'compact') {
      // Compact: first 500 chars of analysis
      const truncated =
        analysis.length > 500 ? analysis.slice(0, 500) + '...' : analysis;
      lines.push(truncated);
    } else {
      // Full: include full analysis (will be capped by aggregate budget)
      lines.push(analysis);
    }
  }

  // Files affected (always include as list)
  if (output.outputs.files?.length) {
    const fileList = output.outputs.files
      .map((f) => `  - ${f.action}: ${f.path}`)
      .join('\n');
    lines.push(`Files:\n${fileList}`);
  }

  // Recommendations (full mode only)
  if (format === 'full' && output.outputs.recommendations?.length) {
    lines.push(
      `Recommendations: ${output.outputs.recommendations.join('; ')}`
    );
  }

  return lines.join('\n');
}

/**
 * Format all previous stage outputs into a handoff context string.
 *
 * When the aggregate output exceeds the budget, earliest stages are
 * truncated first (later stages are more relevant to the current stage).
 *
 * Returns the formatted string, or undefined if there are no previous outputs.
 */
export function formatHandoffContext(
  stageOutputs: Record<string, StageOutput>,
  options: HandoffFormatOptions
): string | undefined {
  const stageNames = Object.keys(stageOutputs);
  if (stageNames.length === 0) return undefined;

  const format = resolveHandoffFormat(options.fidelityLevel);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_HANDOFF_BYTES;

  // Format each stage individually
  const formattedStages = stageNames.map((name) => ({
    name,
    text: formatStageOutput(name, stageOutputs[name], format),
  }));

  // Check if total fits within budget
  const totalSize = formattedStages.reduce((sum, s) => sum + s.text.length, 0);

  if (totalSize <= maxBytes) {
    return formattedStages.map((s) => s.text).join('\n\n');
  }

  // Truncate earliest stages first to fit within budget
  // Work backwards from the end (most recent = most relevant)
  let remaining = maxBytes;
  const result: string[] = [];

  // Reserve space for each stage, prioritizing later stages
  for (let i = formattedStages.length - 1; i >= 0; i--) {
    const stage = formattedStages[i];
    if (stage.text.length <= remaining) {
      result.unshift(stage.text);
      remaining -= stage.text.length;
    } else if (remaining > 100) {
      // Include a truncated version of this stage
      result.unshift(
        `### ${stage.name}\n[truncated — ${stage.text.length} chars, budget exceeded]`
      );
      remaining = 0;
    }
    // Skip stages that don't fit at all
  }

  return result.join('\n\n');
}
