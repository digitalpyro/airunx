/**
 * Workflow ID validation and report path helpers
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import {
  RUN_REPORTS_DIR,
  WORKFLOW_ID_PATTERN,
  assertValidWorkflowId,
  generateWorkflowId,
  getRunReportPath,
  isValidWorkflowId,
} from '../../src/utils/workflow-id.js';

describe('workflow-id', () => {
  it('accepts alphanumerics, underscore and hyphen up to 64 chars', () => {
    expect(isValidWorkflowId('workflow-1778122917995-fa40845b')).toBe(true);
    expect(isValidWorkflowId('A_b-9')).toBe(true);
    expect(isValidWorkflowId('x'.repeat(64))).toBe(true);
  });

  it.each([
    '',
    'x'.repeat(65),
    '../../x',
    'a/b',
    'a\\b',
    'a.json',
    'with space',
    'nul\0byte',
  ])('rejects %j', (id) => {
    expect(isValidWorkflowId(id)).toBe(false);
    expect(() => assertValidWorkflowId(id)).toThrow(/Invalid workflow ID/);
  });

  it('rejects non-strings', () => {
    expect(isValidWorkflowId(undefined)).toBe(false);
    expect(isValidWorkflowId(42)).toBe(false);
  });

  it('generates unique IDs that match the pattern', () => {
    const a = generateWorkflowId();
    const b = generateWorkflowId();
    expect(a).toMatch(/^workflow-\d+-[0-9a-f]{8}$/);
    expect(a).toMatch(WORKFLOW_ID_PATTERN);
    expect(a).not.toBe(b);
  });

  it('builds report paths only for valid IDs', () => {
    expect(getRunReportPath('wf-1')).toBe(join(RUN_REPORTS_DIR, 'wf-1.json'));
    expect(getRunReportPath('wf-1', '/base')).toBe(join('/base', 'wf-1.json'));
    expect(() => getRunReportPath('../../etc/passwd')).toThrow(
      /Invalid workflow ID/
    );
  });
});
