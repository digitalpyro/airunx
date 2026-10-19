/**
 * Run report file I/O — the one reader and writer for
 * `.airunx-state/reports/<workflowId>.json`.
 *
 * Shared by the runner (writes after every stage and on shutdown), the
 * heartbeat (reads a killed run's last report) and `airunx costs`. Reports
 * can carry task titles and spend, so the directory is 0700 and files 0600.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import type { RunReport } from '../core/types.js';
import { RUN_REPORTS_DIR, getRunReportPath } from './workflow-id.js';

/** Owner-only permissions for the reports directory and files */
export const RUN_REPORTS_DIR_MODE = 0o700;
export const RUN_REPORT_FILE_MODE = 0o600;

/**
 * Read a run report. Null when absent, unparsable or not report-shaped
 * (no `stages` array). Throws only on an invalid workflow ID.
 */
export function loadRunReport(
  workflowId: string,
  reportsDir: string = RUN_REPORTS_DIR
): RunReport | null {
  const path = getRunReportPath(workflowId, reportsDir);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as RunReport).stages)
    ) {
      return null;
    }
    return parsed as RunReport;
  } catch {
    return null;
  }
}

/**
 * Atomically write a run report (tmp file + rename) with owner-only
 * permissions. Returns the report path. Throws on failure (callers decide
 * whether that is fatal) or on an invalid workflow ID.
 */
export function writeRunReportFile(
  report: RunReport,
  reportsDir: string = RUN_REPORTS_DIR
): string {
  // Validates the ID (path-safe) before touching the filesystem
  const reportPath = getRunReportPath(report.workflowId, reportsDir);
  if (!existsSync(reportsDir)) {
    mkdirSync(reportsDir, { recursive: true, mode: RUN_REPORTS_DIR_MODE });
  }
  // Tighten a directory created before reports were owner-only
  chmodSync(reportsDir, RUN_REPORTS_DIR_MODE);
  const tmpPath = reportPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(report, null, 2), {
    mode: RUN_REPORT_FILE_MODE,
  });
  // `mode` only applies on create; a stale tmp file keeps its old mode
  chmodSync(tmpPath, RUN_REPORT_FILE_MODE);
  renameSync(tmpPath, reportPath);
  return reportPath;
}
