import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBanner, displayBanner } from '../../src/utils/banner.js';

describe('banner', () => {
  describe('createBanner', () => {
    it('should generate Unicode block art banner with version', async () => {
      const banner = await createBanner({ version: '1.0.0' });

      // Should contain the version
      expect(banner).toContain('1.0.0');

      // Should contain Unicode block characters from ANSI Shadow font
      expect(banner).toMatch(/[█╔╗║╚╝═]/);
    });

    it('should include tagline with robot emoji', async () => {
      const banner = await createBanner({ version: '1.0.0' });

      expect(banner).toContain('AI agent orchestrator');
    });

    it('should include version warning with warning emoji', async () => {
      const banner = await createBanner({ version: '2.0.0' });

      expect(banner).toContain('2.0.0');
      expect(banner).toContain('You are installing');
    });

    it('should wrap in rounded box when showBox is true', async () => {
      const banner = await createBanner({ version: '1.0.0', showBox: true });

      // Box should have rounded corners
      expect(banner).toContain('╭');
      expect(banner).toContain('╰');
    });

    it('should not wrap in box when showBox is false', async () => {
      const banner = await createBanner({ version: '1.0.0', showBox: false });

      // Should not have box corners
      expect(banner).not.toContain('╭');
      expect(banner).not.toContain('╰');
    });

    it('should default to showBox true', async () => {
      const banner = await createBanner({ version: '1.0.0' });

      // Default should include box
      expect(banner).toContain('╭');
    });

    it('should include the initializing message', async () => {
      const banner = await createBanner({ version: '1.0.0' });

      expect(banner).toContain('Initializing AIRunX');
    });
  });

  describe('displayBanner', () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let originalIsTTY: boolean | undefined;
    let originalNoColor: string | undefined;

    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      originalIsTTY = process.stdout.isTTY;
      originalNoColor = process.env.NO_COLOR;
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
      // Restore original values
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalIsTTY,
        writable: true,
      });
      if (originalNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = originalNoColor;
      }
    });

    it('should display banner when stdout is TTY', async () => {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        writable: true,
      });
      delete process.env.NO_COLOR;

      await displayBanner('1.0.0');

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0][0];
      expect(output).toContain('1.0.0');
    });

    it('should not display banner when stdout is not TTY', async () => {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        writable: true,
      });

      await displayBanner('1.0.0');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should display simplified text when NO_COLOR is set', async () => {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        writable: true,
      });
      process.env.NO_COLOR = '1';

      await displayBanner('1.0.0');

      // Should make exactly 2 console.log calls
      expect(consoleLogSpy).toHaveBeenCalledTimes(2);
      // First call: version header with newlines
      expect(consoleLogSpy.mock.calls[0][0]).toBe('\nAIRunX v1.0.0\n');
      // Second call: tagline without trailing newline
      expect(consoleLogSpy.mock.calls[1][0]).toBe(
        'AI agent orchestrator for automated development and execution'
      );
    });
  });
});
