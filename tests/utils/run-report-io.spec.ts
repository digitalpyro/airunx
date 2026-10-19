/**
 * Run report I/O — one reader/writer, owner-only permissions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { RunReport } from '../../src/core/types.js';
import {
  loadRunReport,
  writeRunReportFile,
} from '../../src/utils/run-report-io.js';

const report = (workflowId: string): RunReport => ({
  workflowId,
  status: 'running',
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  totalDurationMs: 1,
  totalTokens: 0,
  totalCostUsd: 0,
  iterationCount: 1,
  maxIterations: 1,
  iterations: [],
  stages: [],
  timeline: [],
});

const mode = (path: string): number => statSync(path).mode & 0o777;

describe('run-report-io', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'airunx-report-io-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'creates the reports dir 0700 and the report 0600',
    () => {
      const reportsDir = join(dir, 'reports');
      const path = writeRunReportFile(report('wf-1'), reportsDir);
      expect(mode(reportsDir)).toBe(0o700);
      expect(mode(path)).toBe(0o600);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'tightens an existing world-readable dir and stale tmp file',
    () => {
      const reportsDir = join(dir, 'reports');
      mkdirSync(reportsDir, { mode: 0o755 });
      chmodSync(reportsDir, 0o755);
      writeFileSync(join(reportsDir, 'wf-2.json.tmp'), 'stale', {
        mode: 0o644,
      });
      const path = writeRunReportFile(report('wf-2'), reportsDir);
      expect(mode(reportsDir)).toBe(0o700);
      expect(mode(path)).toBe(0o600);
    }
  );

  it('round-trips a report', () => {
    writeRunReportFile(report('wf-3'), dir);
    expect(loadRunReport('wf-3', dir)?.workflowId).toBe('wf-3');
  });

  it('returns null for absent, unparsable or stage-less files', () => {
    expect(loadRunReport('missing', dir)).toBeNull();
    writeFileSync(join(dir, 'bad.json'), '{not json');
    expect(loadRunReport('bad', dir)).toBeNull();
    writeFileSync(join(dir, 'shape.json'), JSON.stringify({ workflowId: 'x' }));
    expect(loadRunReport('shape', dir)).toBeNull();
  });

  it('rejects path-escaping workflow IDs', () => {
    expect(() => loadRunReport('../x', dir)).toThrow(/Invalid workflow ID/);
    expect(() => writeRunReportFile(report('../x'), dir)).toThrow(
      /Invalid workflow ID/
    );
  });
});
