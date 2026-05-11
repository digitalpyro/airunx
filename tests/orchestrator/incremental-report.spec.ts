/**
 * Incremental Run Report tests
 *
 * Verifies that run reports written mid-pipeline are valid JSON
 * and use atomic writes (tmp + rename) to prevent partial reads.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  renameSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Simulates the atomic write pattern used by writeRunReport in langgraph-runner.ts.
 * This validates the same write logic without requiring the full LangGraphRunner.
 */
function writeReportAtomically(
  reportsDir: string,
  workflowId: string,
  report: Record<string, unknown>
): string {
  if (!existsSync(reportsDir)) {
    mkdirSync(reportsDir, { recursive: true });
  }
  const reportPath = join(reportsDir, `${workflowId}.json`);
  const tmpPath = reportPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(report, null, 2));
  renameSync(tmpPath, reportPath);
  return reportPath;
}

describe('Incremental Run Report', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `airunx-report-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should produce valid JSON after partial completion (2 of 7 stages)', () => {
    const report = {
      workflowId: 'workflow-test-123',
      taskTitle: 'Test task',
      pipelineName: 'Thin Pipeline',
      status: 'running',
      startedAt: '2026-05-11T00:00:00.000Z',
      completedAt: new Date().toISOString(),
      totalDurationMs: 30000,
      totalTokens: 15000,
      totalCostUsd: 1.5,
      iterationCount: 1,
      maxIterations: 2,
      iterations: [],
      stages: [
        {
          stage: 'orchestrate',
          agent: 'orchestrator',
          backend: 'claude-code',
          spawnCount: 1,
          durationMs: 12000,
          tokensUsed: 8000,
          costUsd: 0.8,
          timestamp: '2026-05-11T00:00:00.000Z',
          status: 'completed',
        },
        {
          stage: 'strategize',
          agent: 'developer',
          backend: 'claude-code',
          spawnCount: 3,
          durationMs: 18000,
          tokensUsed: 7000,
          costUsd: 0.7,
          timestamp: '2026-05-11T00:00:12.000Z',
          status: 'completed',
        },
      ],
      timeline: [
        {
          timestamp: '2026-05-11T00:00:12.000Z',
          event: 'orchestrate complete (12.0s)',
          durationMs: 12000,
        },
        {
          timestamp: '2026-05-11T00:00:30.000Z',
          event: 'strategize complete (18.0s)',
          durationMs: 18000,
        },
      ],
    };

    const reportPath = writeReportAtomically(testDir, 'workflow-test-123', report);

    // File exists
    expect(existsSync(reportPath)).toBe(true);

    // No tmp file left behind
    expect(existsSync(reportPath + '.tmp')).toBe(false);

    // Valid JSON
    const content = readFileSync(reportPath, 'utf-8');
    const parsed = JSON.parse(content);

    // Correct structure
    expect(parsed.workflowId).toBe('workflow-test-123');
    expect(parsed.status).toBe('running'); // Not 'completed' — partial
    expect(parsed.stages).toHaveLength(2); // Only 2 of 7 stages
    expect(parsed.totalCostUsd).toBe(1.5);
    expect(parsed.totalTokens).toBe(15000);
    expect(parsed.timeline).toHaveLength(2);
  });

  it('should overwrite previous report on subsequent stage completion', () => {
    // First write: 1 stage
    const report1 = {
      workflowId: 'workflow-overwrite',
      status: 'running',
      totalCostUsd: 0.5,
      stages: [{ stage: 'orchestrate', costUsd: 0.5 }],
    };
    const reportPath = writeReportAtomically(testDir, 'workflow-overwrite', report1);

    // Second write: 2 stages
    const report2 = {
      workflowId: 'workflow-overwrite',
      status: 'running',
      totalCostUsd: 1.2,
      stages: [
        { stage: 'orchestrate', costUsd: 0.5 },
        { stage: 'strategize', costUsd: 0.7 },
      ],
    };
    writeReportAtomically(testDir, 'workflow-overwrite', report2);

    // Should have the latest version
    const parsed = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(parsed.totalCostUsd).toBe(1.2);
    expect(parsed.stages).toHaveLength(2);
  });

  it('should handle concurrent reads during atomic write', () => {
    // Write initial report
    const report = {
      workflowId: 'workflow-concurrent',
      status: 'running',
      totalCostUsd: 2.0,
    };
    const reportPath = writeReportAtomically(testDir, 'workflow-concurrent', report);

    // Simulate reading while a new write is in progress (tmp exists)
    const tmpPath = reportPath + '.tmp';
    writeFileSync(tmpPath, '{"partial": true}'); // Simulates in-progress write

    // Reader should get the previous complete version, not the tmp
    const parsed = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(parsed.workflowId).toBe('workflow-concurrent');
    expect(parsed.totalCostUsd).toBe(2.0);

    // Clean up simulated tmp
    rmSync(tmpPath, { force: true });
  });
});
