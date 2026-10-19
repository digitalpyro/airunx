/**
 * Tests for ScriptCleanup audit-log retention
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  ScriptCleanup,
  selectExpiredAuditLogs,
} from '../../src/utils/script-cleanup.js';
import { getAuditLogsMaxAgeDays } from '../../src/cli/commands/cleanup.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function auditFile(daysAgo: number, now: Date = new Date()): string {
  const date = new Date(now.getTime() - daysAgo * MS_PER_DAY);
  return `audit-${date.toISOString().slice(0, 10)}.jsonl`;
}

describe('selectExpiredAuditLogs', () => {
  const now = new Date('2026-10-16T12:00:00Z');

  it('selects files older than N days and keeps newer ones', () => {
    const files = [
      'audit-2026-09-01.jsonl',
      'audit-2026-09-15.jsonl',
      'audit-2026-09-16.jsonl',
      'audit-2026-10-15.jsonl',
      'audit-2026-10-16.jsonl',
    ];
    expect(selectExpiredAuditLogs(files, 30, now)).toEqual([
      'audit-2026-09-01.jsonl',
      'audit-2026-09-15.jsonl',
    ]);
  });

  it('keeps the current UTC day even with 0 days', () => {
    const files = ['audit-2026-10-15.jsonl', 'audit-2026-10-16.jsonl'];
    expect(selectExpiredAuditLogs(files, 0, now)).toEqual([
      'audit-2026-10-15.jsonl',
    ]);
  });

  it('ignores non-matching, invalid, and future-dated names', () => {
    const files = [
      'audit-2020-01-01.json',
      'audit-2020-01-01.jsonl.bak',
      'notes-2020-01-01.jsonl',
      'audit-2020-02-31.jsonl',
      'audit-2027-01-01.jsonl',
      'README.md',
    ];
    expect(selectExpiredAuditLogs(files, 0, now)).toEqual([]);
  });
});

describe('ScriptCleanup audit logs', () => {
  let baseDir: string;
  let auditDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'airunx-cleanup-'));
    auditDir = path.join(baseDir, '.airunx-state', 'audit');
    await mkdir(auditDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  async function seed(files: string[]): Promise<void> {
    await Promise.all(
      files.map((file) => writeFile(path.join(auditDir, file), '{}\n'))
    );
  }

  const baseOptions = {
    worktrees: false,
    debugFilesMaxAgeDays: 0,
  };

  it('removes files older than N days and keeps newer ones', async () => {
    const old = auditFile(45);
    const recent = auditFile(5);
    await seed([old, recent]);

    const result = await new ScriptCleanup(baseDir).cleanup({
      ...baseOptions,
      auditLogsMaxAgeDays: 30,
    });

    expect(result.auditLogsRemoved).toBe(1);
    expect(result.auditLogFiles).toEqual([old]);
    expect(await readdir(auditDir)).toEqual([recent]);
  });

  it("keeps today's file with a retention of 0 days", async () => {
    const today = auditFile(0);
    const yesterday = auditFile(1);
    await seed([today, yesterday]);

    const result = await new ScriptCleanup(baseDir).cleanup({
      ...baseOptions,
      auditLogsMaxAgeDays: 0,
    });

    expect(result.auditLogFiles).toEqual([yesterday]);
    expect(await readdir(auditDir)).toEqual([today]);
  });

  it('lists files on dry run without deleting them', async () => {
    const old = auditFile(60);
    await seed([old]);

    const result = await new ScriptCleanup(baseDir).cleanup({
      ...baseOptions,
      auditLogsMaxAgeDays: 30,
      dryRun: true,
    });

    expect(result.auditLogsRemoved).toBe(1);
    expect(result.auditLogFiles).toEqual([old]);
    expect(await readdir(auditDir)).toEqual([old]);
  });

  it('leaves non-matching files in the audit dir untouched', async () => {
    const old = auditFile(60);
    const others = ['notes.txt', 'audit-old.jsonl', 'audit-2020-01-01.json'];
    await seed([old, ...others]);

    await new ScriptCleanup(baseDir).cleanup({
      ...baseOptions,
      auditLogsMaxAgeDays: 0,
    });

    expect((await readdir(auditDir)).sort()).toEqual([...others].sort());
  });

  it('skips audit cleanup when no retention is requested', async () => {
    const old = auditFile(60);
    await seed([old]);

    const result = await new ScriptCleanup(baseDir).cleanup(baseOptions);

    expect(result.auditLogsRemoved).toBe(0);
    expect(await readdir(auditDir)).toEqual([old]);
  });

  it('is a no-op when the audit dir does not exist', async () => {
    await rm(auditDir, { recursive: true });

    const result = await new ScriptCleanup(baseDir).cleanup({
      ...baseOptions,
      auditLogsMaxAgeDays: 30,
    });

    expect(result.auditLogsRemoved).toBe(0);
    expect(result.errors).toEqual([]);
  });
});

describe('cleanup --audit-logs option parsing', () => {
  it('is disabled unless --audit-logs or --all is given', () => {
    expect(getAuditLogsMaxAgeDays({})).toBeUndefined();
    expect(getAuditLogsMaxAgeDays({ debugFiles: true })).toBeUndefined();
  });

  it('includes audit logs in --all with the 30-day default', () => {
    expect(getAuditLogsMaxAgeDays({ all: true })).toBe(30);
  });

  it('defaults a bare --audit-logs to 30 days', () => {
    expect(getAuditLogsMaxAgeDays({ auditLogs: true })).toBe(30);
  });

  it('accepts an explicit day count, including 0', () => {
    expect(getAuditLogsMaxAgeDays({ auditLogs: '7' })).toBe(7);
    expect(getAuditLogsMaxAgeDays({ auditLogs: '0', all: true })).toBe(0);
  });

  it('rejects negative or non-integer values', () => {
    expect(() => getAuditLogsMaxAgeDays({ auditLogs: '-1' })).toThrow();
    expect(() => getAuditLogsMaxAgeDays({ auditLogs: 'abc' })).toThrow();
  });
});
