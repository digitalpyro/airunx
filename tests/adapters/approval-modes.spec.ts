import { describe, it, expect } from 'vitest';
import { APPROVAL_MODE_FLAGS } from '../../src/adapters/constants.js';
import { APPROVAL_MODES } from '../../src/core/types.js';

describe('APPROVAL_MODES', () => {
  it('contains expected modes', () => {
    expect(APPROVAL_MODES).toEqual(['manual', 'auto', 'yolo']);
  });
});

describe('APPROVAL_MODE_FLAGS', () => {
  it('maps Codex modes correctly', () => {
    expect(APPROVAL_MODE_FLAGS.codex.manual).toEqual([]);
    expect(APPROVAL_MODE_FLAGS.codex.auto).toEqual(['--full-auto']);
    expect(APPROVAL_MODE_FLAGS.codex.yolo).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
  });

  it('maps Claude modes correctly', () => {
    expect(APPROVAL_MODE_FLAGS['claude-code'].manual).toEqual([]);
    expect(APPROVAL_MODE_FLAGS['claude-code'].auto).toEqual([
      '--dangerously-skip-permissions',
    ]);
    expect(APPROVAL_MODE_FLAGS['claude-code'].yolo).toEqual([
      '--dangerously-skip-permissions',
    ]);
  });

  it('maps Cursor modes correctly', () => {
    expect(APPROVAL_MODE_FLAGS.cursor.manual).toEqual([]);
    expect(APPROVAL_MODE_FLAGS.cursor.auto).toEqual([]);
    expect(APPROVAL_MODE_FLAGS.cursor.yolo).toEqual([]);
  });

  it('has entries for all backends', () => {
    expect(Object.keys(APPROVAL_MODE_FLAGS)).toEqual([
      'codex',
      'claude-code',
      'cursor',
    ]);
  });

  it('has entries for all approval modes in each backend', () => {
    for (const backend of Object.keys(APPROVAL_MODE_FLAGS)) {
      const backendFlags =
        APPROVAL_MODE_FLAGS[backend as keyof typeof APPROVAL_MODE_FLAGS];
      expect(Object.keys(backendFlags).sort()).toEqual(
        [...APPROVAL_MODES].sort()
      );
    }
  });
});
