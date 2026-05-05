import { describe, it, expect } from 'vitest';
import {
  levenshteinDistance,
  getClosestMatch,
} from '../../src/utils/string-utils.js';

describe('String Utils', () => {
  describe('levenshteinDistance', () => {
    it('should return 0 for identical strings', () => {
      expect(levenshteinDistance('abc', 'abc')).toBe(0);
    });

    it('should return the length of the other string when one is empty', () => {
      expect(levenshteinDistance('', 'abc')).toBe(3);
      expect(levenshteinDistance('abc', '')).toBe(3);
    });

    it('should return 0 for two empty strings', () => {
      expect(levenshteinDistance('', '')).toBe(0);
    });

    it('should count single substitution', () => {
      expect(levenshteinDistance('cat', 'bat')).toBe(1);
    });

    it('should count single insertion', () => {
      expect(levenshteinDistance('cat', 'cats')).toBe(1);
    });

    it('should count single deletion', () => {
      expect(levenshteinDistance('cats', 'cat')).toBe(1);
    });

    it('should handle common typos', () => {
      expect(levenshteinDistance('orchestrator', 'orchstrator')).toBe(1);
      expect(levenshteinDistance('sonnet', 'sonnett')).toBe(1);
    });

    it('should handle completely different strings', () => {
      expect(levenshteinDistance('abc', 'xyz')).toBe(3);
    });
  });

  describe('getClosestMatch', () => {
    const candidates = [
      'orchestrator',
      'developer',
      'code-reviewer',
      'static-analyzer',
    ];

    it('should find exact match', () => {
      expect(getClosestMatch('orchestrator', candidates)).toBe('orchestrator');
    });

    it('should find close typo match', () => {
      expect(getClosestMatch('orchstrator', candidates)).toBe('orchestrator');
    });

    it('should be case-insensitive', () => {
      expect(getClosestMatch('DEVELOPER', candidates)).toBe('developer');
    });

    it('should return null for no match within threshold', () => {
      expect(getClosestMatch('completely-different', candidates)).toBeNull();
    });

    it('should return null for empty candidates', () => {
      expect(getClosestMatch('anything', [])).toBeNull();
    });

    it('should respect custom maxDistance', () => {
      expect(getClosestMatch('dev', candidates, 6)).toBe('developer');
      expect(getClosestMatch('dev', candidates, 2)).toBeNull();
    });
  });
});
