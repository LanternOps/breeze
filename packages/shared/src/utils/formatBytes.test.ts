import { describe, it, expect } from 'vitest';
import { formatBytes } from './formatBytes';

describe('formatBytes', () => {
  describe('edge cases', () => {
    it('should handle 0 bytes', () => {
      expect(formatBytes(0)).toBe('0 KB');
    });

    it('should handle negative numbers', () => {
      expect(formatBytes(-1000)).toBe('0 KB');
    });

    it('should handle Infinity', () => {
      expect(formatBytes(Infinity)).toBe('0 KB');
    });

    it('should handle NaN', () => {
      expect(formatBytes(NaN)).toBe('0 KB');
    });
  });

  describe('KB conversion', () => {
    it('should format bytes as KB', () => {
      expect(formatBytes(1024)).toBe('1 KB');
    });

    it('should format fractional KB', () => {
      expect(formatBytes(1536)).toBe('1.5 KB');
    });

    it('should format large KB values', () => {
      expect(formatBytes(512 * 1024)).toBe('512 KB');
    });
  });

  describe('MB conversion', () => {
    it('should format exactly 1 MB', () => {
      expect(formatBytes(1024 * 1024)).toBe('1 MB');
    });

    it('should format fractional MB', () => {
      expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    });

    it('should format large MB values', () => {
      expect(formatBytes(500 * 1024 * 1024)).toBe('500 MB');
    });
  });

  describe('GB conversion', () => {
    it('should format exactly 1 GB', () => {
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
    });

    it('should format fractional GB', () => {
      expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
    });

    it('should format large GB values', () => {
      expect(formatBytes(100 * 1024 * 1024 * 1024)).toBe('100 GB');
    });
  });

  describe('decimal precision', () => {
    it('should use 1 decimal by default', () => {
      expect(formatBytes(1536)).toBe('1.5 KB');
    });

    it('should support 0 decimals', () => {
      expect(formatBytes(1536, 0)).toBe('2 KB');
    });

    it('should support 2 decimals', () => {
      expect(formatBytes(1024 + 256, 2)).toBe('1.25 KB');
    });

    it('should strip trailing zeros', () => {
      expect(formatBytes(1024, 2)).toBe('1 KB');
    });
  });

  describe('boundary values', () => {
    it('should show KB just below 1 MB', () => {
      const justUnder1MB = 1024 * 1024 - 1;
      expect(formatBytes(justUnder1MB)).toContain('KB');
    });

    it('should show MB at exactly 1 MB', () => {
      const exactly1MB = 1024 * 1024;
      expect(formatBytes(exactly1MB)).toBe('1 MB');
    });

    it('should show MB just below 1 GB', () => {
      const justUnder1GB = 1024 * 1024 * 1024 - 1;
      expect(formatBytes(justUnder1GB)).toContain('MB');
    });

    it('should show GB at exactly 1 GB', () => {
      const exactly1GB = 1024 * 1024 * 1024;
      expect(formatBytes(exactly1GB)).toBe('1 GB');
    });
  });
});
