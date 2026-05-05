/**
 * Iteration History - Captures what approaches were tried and what gaps remain
 * Enables agents to avoid repeating failed approaches across iteration cycles.
 */

import type { StateManager } from './state-manager.js';
import type {
  IterationEntry,
  IterationHistoryState,
  WorkflowContext,
} from '../core/types.js';

// Re-export types for convenience
export type { IterationEntry, IterationHistoryState };

/**
 * Append an iteration entry to the context's iteration history.
 * Pure function for use within atomic state updates.
 */
export function appendIterationEntry(
  context: WorkflowContext,
  entry: IterationEntry
): IterationHistoryState {
  const newEntry = { ...entry, gaps: [...entry.gaps] };
  const entries = [...(context.iterationHistory?.entries || []), newEntry];
  return { ...context.iterationHistory, entries };
}

/**
 * Iteration History service
 * Records iteration attempts and formats history for agent consumption.
 */
export class IterationHistory {
  constructor(
    private stateManager: StateManager,
    private workflowId: string
  ) {}

  /**
   * Record an iteration attempt
   */
  async record(entry: IterationEntry): Promise<void> {
    await this.stateManager.update(this.workflowId, (context) => ({
      ...context,
      iterationHistory: appendIterationEntry(context, entry),
    }));
  }

  /**
   * Format history as text for agent context
   */
  async formatForAgent(): Promise<string> {
    const context = await this.stateManager.load(this.workflowId);
    const entries = context?.iterationHistory?.entries || [];

    if (entries.length === 0) {
      return 'No previous iterations.';
    }

    let output = `## Previous Iterations (${entries.length})\n\n`;

    // Show what didn't work (all non-PROCEED verdicts)
    const failed = entries.filter((e) => e.verdict !== 'PROCEED');
    if (failed.length > 0) {
      output += "### Approaches That Didn't Work\n";
      failed.forEach((e) => {
        output += `- Iteration ${e.iteration} (${e.verdict}): ${e.approach}\n`;
        if (e.gaps.length > 0) {
          output += `  Gaps: ${e.gaps.join(', ')}\n`;
        }
      });
      output += '\n';
    }

    // Count recurring gaps (normalize and deduplicate per iteration)
    const gapCounts: Record<string, number> = {};
    entries.forEach((e) => {
      const uniqueGaps = new Set(
        e.gaps.map((g) => g.trim().toLowerCase()).filter(Boolean)
      );
      uniqueGaps.forEach((gap) => {
        gapCounts[gap] = (gapCounts[gap] || 0) + 1;
      });
    });

    const recurring = Object.entries(gapCounts)
      .filter(([, count]) => count >= 2)
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      });

    if (recurring.length > 0) {
      output += '### Recurring Gaps (Address First)\n';
      recurring.forEach(([gap, count]) => {
        output += `- ${gap} (${count}x)\n`;
      });
    }

    return output;
  }

  /**
   * Get raw entries (for tool response)
   */
  async getEntries(): Promise<IterationEntry[]> {
    const context = await this.stateManager.load(this.workflowId);
    return context?.iterationHistory?.entries || [];
  }
}
