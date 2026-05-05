/**
 * Tests for JSON utility functions
 */

import { describe, it, expect } from 'vitest';
import { parseJsonc, extractJsonObjects, extractFirstJsonObject } from '../../src/utils/json-utils.js';

describe('parseJsonc', () => {
  it('parses valid JSON', () => {
    expect(parseJsonc('{"key": "value"}')).toEqual({ key: 'value' });
  });

  it('parses trailing commas in objects', () => {
    expect(parseJsonc('{"key": "value",}')).toEqual({ key: 'value' });
  });

  it('parses trailing commas in arrays', () => {
    expect(parseJsonc('{"arr": [1, 2, 3,]}')).toEqual({ arr: [1, 2, 3] });
  });

  it('parses single-line comments', () => {
    expect(parseJsonc('{"key": "value" // comment\n}')).toEqual({ key: 'value' });
  });

  it('parses block comments', () => {
    expect(parseJsonc('{"key": /* comment */ "value"}')).toEqual({ key: 'value' });
  });

  it('parses comments before JSON', () => {
    expect(parseJsonc('// header\n{"key": "value"}')).toEqual({ key: 'value' });
  });

  it('preserves comment-like strings in values', () => {
    expect(parseJsonc('{"url": "http://example.com"}')).toEqual({ url: 'http://example.com' });
  });

  it('handles nested trailing commas', () => {
    const result = parseJsonc('{"folders": [{"path": "./a",}, {"path": "./b",}],}');
    expect(result).toEqual({ folders: [{ path: './a' }, { path: './b' }] });
  });

  it('returns undefined for empty content', () => {
    expect(parseJsonc('')).toBeUndefined();
  });

  it('returns undefined for truly invalid JSON', () => {
    // jsonc-parser returns undefined for invalid content, doesn't throw
    expect(parseJsonc('not json at all')).toBeUndefined();
  });
});

describe('extractJsonObjects', () => {
  it('extracts valid JSON objects from text', () => {
    const text = 'Some text {"key": "value"} more text';
    const result = extractJsonObjects(text);
    expect(result).toEqual(['{"key": "value"}']);
  });

  it('extracts multiple JSON objects', () => {
    const text = '{"a": 1} some text {"b": 2}';
    const result = extractJsonObjects(text);
    expect(result).toEqual(['{"a": 1}', '{"b": 2}']);
  });

  it('handles nested objects', () => {
    const text = '{"outer": {"inner": "value"}}';
    const result = extractJsonObjects(text);
    expect(result).toEqual(['{"outer": {"inner": "value"}}']);
  });
});

describe('extractFirstJsonObject', () => {
  it('returns the first valid JSON object', () => {
    const text = 'prefix {"key": "value"} suffix';
    const result = extractFirstJsonObject<{ key: string }>(text);
    expect(result).toEqual({ key: 'value' });
  });

  it('returns null when no valid JSON found', () => {
    const result = extractFirstJsonObject('no json here');
    expect(result).toBeNull();
  });
});
