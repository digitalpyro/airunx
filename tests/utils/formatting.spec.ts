import { describe, it, expect } from 'vitest';
import {
  formatDuration,
  formatDurationHuman,
} from '../../src/utils/formatting.js';

describe('Formatting', () => {
  describe('formatDuration', () => {
    it('should format zero', () => {
      expect(formatDuration(0)).toBe('00:00:00');
    });

    it('should format seconds', () => {
      expect(formatDuration(5000)).toBe('00:00:05');
      expect(formatDuration(30000)).toBe('00:00:30');
    });

    it('should format minutes', () => {
      expect(formatDuration(60000)).toBe('00:01:00');
      expect(formatDuration(90000)).toBe('00:01:30');
    });

    it('should format hours', () => {
      expect(formatDuration(3600000)).toBe('01:00:00');
      expect(formatDuration(3661000)).toBe('01:01:01');
    });

    it('should format large durations', () => {
      expect(formatDuration(86400000)).toBe('24:00:00');
    });
  });

  describe('formatDurationHuman', () => {
    it('should show milliseconds for short durations', () => {
      expect(formatDurationHuman(0)).toBe('0ms');
      expect(formatDurationHuman(500)).toBe('500ms');
      expect(formatDurationHuman(999)).toBe('999ms');
    });

    it('should show seconds for durations under a minute', () => {
      expect(formatDurationHuman(1000)).toBe('1.0s');
      expect(formatDurationHuman(5500)).toBe('5.5s');
      expect(formatDurationHuman(59999)).toBe('60.0s');
    });

    it('should show minutes and seconds', () => {
      expect(formatDurationHuman(60000)).toBe('1m 0s');
      expect(formatDurationHuman(90000)).toBe('1m 30s');
      expect(formatDurationHuman(3599000)).toBe('59m 59s');
    });

    it('should show hours and minutes for long durations', () => {
      expect(formatDurationHuman(3600000)).toBe('1h 0m');
      expect(formatDurationHuman(5400000)).toBe('1h 30m');
    });
  });
});
