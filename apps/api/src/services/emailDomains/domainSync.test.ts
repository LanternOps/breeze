import { describe, expect, it } from 'vitest';
import { nextCheckDelayMs } from './domainSync';

const MIN = 60_000;

describe('nextCheckDelayMs (spec §6.2)', () => {
  it('polls a pending domain every 2 minutes for the first five attempts', () => {
    for (const attempts of [0, 1, 2, 3, 4]) {
      expect(nextCheckDelayMs('pending', attempts)).toBe(2 * MIN);
    }
  });

  it('slows a pending domain to 10 minutes for the next six attempts', () => {
    for (const attempts of [5, 6, 7, 8, 9, 10]) {
      expect(nextCheckDelayMs('pending', attempts)).toBe(10 * MIN);
    }
  });

  it('settles a pending domain at hourly until the provider fails it', () => {
    expect(nextCheckDelayMs('pending', 11)).toBe(60 * MIN);
    expect(nextCheckDelayMs('pending', 400)).toBe(60 * MIN);
  });

  it('polls at_risk hourly, whatever the attempt count', () => {
    expect(nextCheckDelayMs('at_risk', 0)).toBe(60 * MIN);
    expect(nextCheckDelayMs('at_risk', 99)).toBe(60 * MIN);
  });

  it('polls failed hourly so the 72h expiry sweep can fire', () => {
    expect(nextCheckDelayMs('failed', 0)).toBe(60 * MIN);
  });

  it('re-checks a verified domain daily with at most +/-10% jitter', () => {
    const day = 24 * 60 * MIN;
    expect(nextCheckDelayMs('verified', 0, () => 0)).toBe(Math.round(day * 0.9));
    expect(nextCheckDelayMs('verified', 0, () => 1)).toBe(Math.round(day * 1.1));
    expect(nextCheckDelayMs('verified', 0, () => 0.5)).toBe(day);
  });

  it('spreads verified rows rather than stacking them on one instant', () => {
    const values = new Set([0.05, 0.25, 0.45, 0.65, 0.85].map((r) => nextCheckDelayMs('verified', 0, () => r)));
    expect(values.size).toBe(5);
  });

  it('retries provisioning and removing quickly, and parks suspended for a day', () => {
    expect(nextCheckDelayMs('provisioning', 0)).toBe(MIN);
    expect(nextCheckDelayMs('removing', 0)).toBe(MIN);
    expect(nextCheckDelayMs('suspended', 0)).toBe(24 * 60 * MIN);
  });
});
