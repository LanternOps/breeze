import { describe, expect, it } from 'vitest';
import { multiplyToCurrency } from './currency';
import { billedLaborMinutes, hundredthsToHours, laborAmount, laborHours, laborHundredths } from './laborMath';

/** [minutes, hours, amount at 135.00/h, amount at 100.00/h] — #9561, by design. */
const TABLE: ReadonlyArray<readonly [number, string, string, string]> = [
  [1, '0.02', '2.70', '2.00'],
  [20, '0.33', '44.55', '33.00'],
  [25, '0.42', '56.70', '42.00'],
  [30, '0.50', '67.50', '50.00'],
  [59, '0.98', '132.30', '98.00'],
  [61, '1.02', '137.70', '102.00'],
];

describe('labour rule (#9561)', () => {
  it.each(TABLE)('%i min → %s h; %s at 135.00/h; %s at 100.00/h', (minutes, hours, at135, at100) => {
    expect(laborHours(minutes)).toBe(hours);
    expect(laborAmount(minutes, '135.00', 'USD')).toBe(at135);
    expect(laborAmount(minutes, '100.00', 'USD')).toBe(at100);
    // Numeric rates (the billables export passes a parsed number) agree.
    expect(laborAmount(minutes, 135, 'USD')).toBe(at135);
  });

  it('rounds the HOURS, not the minutes, and not the product: 25 min at 135 is 56.70, not 56.25', () => {
    expect(laborAmount(25, '135.00', 'USD')).toBe('56.70');
  });

  it('zero-decimal currencies round once at the major unit: 20 min × 1,000 JPY = 330', () => {
    expect(laborAmount(20, '1000.00', 'JPY')).toBe('330.00');
  });

  it('rounds the product half-up exactly (0.02 h × 7.25 = 0.145 → 0.15, never through a double)', () => {
    expect(laborAmount(1, '7.25', 'USD')).toBe('0.15');
  });

  it('is identical to the pre-#9561 inline copies for every minute count up to a week', () => {
    for (let m = 0; m <= 10_080; m++) {
      const legacyHours = (m / 60).toFixed(2);
      expect(laborHours(m)).toBe(legacyHours);
      expect(laborHundredths(m)).toBe(Math.round((m * 100) / 60));
    }
    for (const rate of ['135.00', '99.99', '0.01', '1000.00']) {
      for (let m = 0; m <= 1_440; m++) {
        expect(laborAmount(m, rate, 'USD')).toBe(multiplyToCurrency((m / 60).toFixed(2), rate, 'USD'));
      }
    }
  });

  it('formats hundredths without float noise, and never as -0.00', () => {
    expect(hundredthsToHours(0)).toBe('0.00');
    expect(hundredthsToHours(5)).toBe('0.05');
    expect(hundredthsToHours(9_900)).toBe('99.00');
    expect(hundredthsToHours(-2)).toBe('-0.02');
    expect(laborHours(-0.1)).toBe('0.00');
  });

  it('refuses a non-finite duration rather than billing NaN', () => {
    expect(() => laborHours(Number.NaN)).toThrow(/finite/);
    expect(() => laborAmount(Number.POSITIVE_INFINITY, '135.00', 'USD')).toThrow(/finite/);
  });

  it('bills billable_minutes when stamped, else the duration, else 0', () => {
    expect(billedLaborMinutes({ billableMinutes: 60, durationMinutes: 5 })).toBe(60);
    expect(billedLaborMinutes({ billableMinutes: null, durationMinutes: 25 })).toBe(25);
    expect(billedLaborMinutes({ billableMinutes: 0, durationMinutes: 25 })).toBe(0);
    expect(billedLaborMinutes({ billableMinutes: null, durationMinutes: null })).toBe(0);
    expect(billedLaborMinutes({})).toBe(0);
  });
});
