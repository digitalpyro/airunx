/**
 * Stage timing formatter for performance visibility
 * Displays per-stage execution times at workflow completion
 */

import type { StageTiming } from '../../core/types.js';

/** Width for the time column display (e.g., "  123.4s") */
const TIME_COLUMN_WIDTH = 8;

/**
 * Print stage timing breakdown for performance visibility.
 * Call this after workflow execution with the context's stageTiming array.
 */
export function printStageTimings(timings: StageTiming[]): void {
  if (!timings.length) return;

  console.log('\n=== Stage Timing ===');
  let total = 0;
  const padLength = Math.max(
    timings.reduce((maxLen, t) => Math.max(maxLen, t.stage.length), 0),
    'Total'.length
  );

  for (const t of timings) {
    total += t.duration;
    const timeStr = `${(t.duration / 1000).toFixed(1)}s`;
    console.log(
      `  ${t.stage.padEnd(padLength)} ${timeStr.padStart(TIME_COLUMN_WIDTH)}`
    );
  }

  console.log(`  ${'─'.repeat(padLength + 1 + TIME_COLUMN_WIDTH)}`);
  const totalTimeStr = `${(total / 1000).toFixed(1)}s`;
  console.log(
    `  ${'Total'.padEnd(padLength)} ${totalTimeStr.padStart(TIME_COLUMN_WIDTH)}`
  );
}
