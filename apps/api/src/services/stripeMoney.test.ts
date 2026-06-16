import { describe, expect, it } from 'vitest';
import { toMinorUnits, fromMinorUnits, isZeroDecimal } from './stripeMoney';

describe('stripeMoney', () => {
  describe('toMinorUnits', () => {
    it('multiplies decimal currencies by 100', () => {
      expect(toMinorUnits(10.5, 'USD')).toBe(1050);
      expect(toMinorUnits('10.50', 'usd')).toBe(1050);
      expect(toMinorUnits(0.01, 'EUR')).toBe(1);
    });

    it('does NOT multiply zero-decimal currencies (no 100x overcharge)', () => {
      expect(toMinorUnits(1000, 'JPY')).toBe(1000);
      expect(toMinorUnits('1000', 'jpy')).toBe(1000);
      expect(toMinorUnits(5000, 'KRW')).toBe(5000);
    });

    it('rounds to the nearest integer', () => {
      expect(toMinorUnits(10.005, 'USD')).toBe(1001);
      expect(toMinorUnits(1000.4, 'JPY')).toBe(1000);
    });
  });

  describe('fromMinorUnits', () => {
    it('divides decimal currencies by 100 and fixes to 2 places', () => {
      expect(fromMinorUnits(1050, 'USD')).toBe('10.50');
      expect(fromMinorUnits(1, 'eur')).toBe('0.01');
    });

    it('keeps zero-decimal currencies as-is (fixed to 2 places)', () => {
      expect(fromMinorUnits(1000, 'JPY')).toBe('1000.00');
      expect(fromMinorUnits(5000, 'krw')).toBe('5000.00');
    });
  });

  describe('isZeroDecimal', () => {
    it('detects zero-decimal currencies case-insensitively', () => {
      expect(isZeroDecimal('JPY')).toBe(true);
      expect(isZeroDecimal('jpy')).toBe(true);
      expect(isZeroDecimal('USD')).toBe(false);
      expect(isZeroDecimal('eur')).toBe(false);
    });
  });
});
