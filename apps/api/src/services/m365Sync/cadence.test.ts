import { describe, expect, it } from 'vitest';
import { applyCadence, nextSyncAt } from './cadence';

const NOW = new Date('2026-09-08T00:00:00.000Z');
const signals = (over = {}) => ({
  truncated: false, latencyMs: 1200, capacity: false,
  unlicensed: false, authFailure: false, now: NOW, ...over,
});

describe('nextSyncAt', () => {
  it('applies at most +/-10% jitter around the interval', () => {
    expect(nextSyncAt(NOW, 3600, () => 0).getTime() - NOW.getTime()).toBe(3600 * 1000 * 0.9);
    expect(nextSyncAt(NOW, 3600, () => 1).getTime() - NOW.getTime()).toBe(Math.round(3600 * 1000 * 1.1));
    expect(nextSyncAt(NOW, 3600, () => 0.5).getTime() - NOW.getTime()).toBe(3600 * 1000);
  });

  it('spreads two orgs on the same interval, so a cohort does not re-converge', () => {
    expect(nextSyncAt(NOW, 3600, () => 0.1).getTime()).not.toBe(nextSyncAt(NOW, 3600, () => 0.9).getTime());
  });
});

describe('applyCadence (W04 stub — W05 replaces the body)', () => {
  it('returns the STORED interval unchanged on every outcome', () => {
    for (const outcome of ['success', 'partial', 'needs_consent', 'throttled', 'error'] as const) {
      expect(applyCadence('users', { intervalSeconds: 21600 }, outcome, signals(), () => 0.5))
        .toEqual({ intervalSeconds: 21600, nextSyncAt: new Date(NOW.getTime() + 21600 * 1000) });
    }
  });

  it('derives next_sync_at from signals.now, not from a clock read inside the seam', () => {
    const other = new Date('2027-01-01T00:00:00.000Z');
    const { nextSyncAt: due } = applyCadence('skus', { intervalSeconds: 3600 }, 'success', signals({ now: other }), () => 0.5);
    expect(due!.getTime()).toBe(other.getTime() + 3600 * 1000);
  });

  it('accepts all six signals, so W05 has every one of them available', () => {
    expect(() => applyCadence('signin_activity', { intervalSeconds: 86400 }, 'partial',
      signals({ truncated: true, capacity: true, unlicensed: true, authFailure: true }))).not.toThrow();
  });
});
