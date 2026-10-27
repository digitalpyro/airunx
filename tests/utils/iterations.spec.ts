/**
 * iterationsRun — 0-indexed WorkflowContext.iterationCount to the 1-indexed
 * number of iterations reported to users
 */

import { describe, it, expect } from 'vitest';
import { iterationsRun } from '../../src/utils/iterations.js';

describe('iterationsRun', () => {
  it('first pass (iterationCount 0) counts as 1 iteration', () => {
    expect(iterationsRun({ iterationCount: 0, status: 'completed' })).toBe(1);
    expect(iterationsRun({ iterationCount: 0, status: 'running' })).toBe(1);
  });

  it('one re-iteration counts as 2 iterations', () => {
    expect(iterationsRun({ iterationCount: 1, status: 'completed' })).toBe(2);
  });

  it('unset iterationCount on a started run counts as 1 iteration', () => {
    expect(iterationsRun({ status: 'failed' })).toBe(1);
  });

  it('a workflow that never left initialization ran 0 iterations', () => {
    expect(iterationsRun({ iterationCount: 0, status: 'initializing' })).toBe(
      0
    );
  });
});
