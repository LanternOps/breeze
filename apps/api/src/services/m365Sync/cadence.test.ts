import { describe, expect, it } from 'vitest';
import { applyCadence, nextInterval, nextSyncAt } from './cadence';

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

describe('nextInterval (spec §5.7)', () => {
  const cases: Array<[string, Parameters<typeof nextInterval>, number]> = [
    ['success at the default stays at the default', ['users', 21_600, 'success', signals()], 21_600],
    ['success above the default decays 25% toward it', ['users', 43_200, 'success', signals()], 37_800],
    ['success below the default decays 25% toward it (upward)', ['users', 7_200, 'success', signals()], 10_800],
    ['truncated doubles', ['users', 21_600, 'partial', signals({ truncated: true })], 43_200],
    ['slow executor (>60s) doubles even on success', ['users', 21_600, 'success', signals({ latencyMs: 61_000 })], 43_200],
    ['exactly 60s is not slow', ['users', 21_600, 'success', signals({ latencyMs: 60_000 })], 21_600],
    ['truncated wins over the success decay', ['users', 43_200, 'success', signals({ truncated: true })], 86_400],
    ['throttled multiplies by 1.5', ['users', 3_600, 'throttled', signals()], 5_400],
    ['executor sync_capacity multiplies by 1.5', ['users', 3_600, 'error', signals({ capacity: true })], 5_400],
    ['doubling clamps to the domain max', ['users', 172_800, 'partial', signals({ truncated: true })], 172_800],
    ['a stored interval below the floor is clamped up', ['users', 600, 'error', signals()], 3_600],
    ['unlicensed jumps straight to the domain max', ['signin_activity', 86_400, 'success', signals({ unlicensed: true })], 604_800],
    ['sign-in bounds are its own, not the shared ones', ['signin_activity', 86_400, 'partial', signals({ truncated: true })], 172_800],
    ['sign-in can never decay below its 24h floor', ['signin_activity', 86_400, 'success', signals()], 86_400],
    ['a non-truncated partial leaves the interval alone', ['users', 21_600, 'partial', signals()], 21_600],
    ['needs_consent leaves the interval alone', ['users', 21_600, 'needs_consent', signals()], 21_600],
    ['a terminal error leaves the interval alone', ['users', 21_600, 'error', signals()], 21_600],
  ];

  it.each(cases)('%s', (_name, args, expected) => {
    expect(nextInterval(...args)).toBe(expected);
  });

  it('never returns a non-integer', () => {
    expect(Number.isInteger(nextInterval('users', 3_601, 'throttled', signals()))).toBe(true);
  });
});

describe('applyCadence (spec §5.7)', () => {
  it('schedules the NEW interval through the shared jitter helper', () => {
    const out = applyCadence('users', { intervalSeconds: 43_200 }, 'success', signals(), () => 0.5);
    expect(out.intervalSeconds).toBe(37_800);
    expect(out.nextSyncAt).toEqual(new Date(NOW.getTime() + 37_800_000));
  });

  it('spreads a cohort across the full ±10% band', () => {
    const early = applyCadence('users', { intervalSeconds: 21_600 }, 'success', signals(), () => 0);
    const late = applyCadence('users', { intervalSeconds: 21_600 }, 'success', signals(), () => 1);
    expect(early.nextSyncAt!.getTime() - NOW.getTime()).toBe(21_600_000 * 0.9);
    expect(late.nextSyncAt!.getTime() - NOW.getTime()).toBe(Math.round(21_600_000 * 1.1));
  });

  it('unschedules on needs_consent', () => {
    const out = applyCadence('ca_policies', { intervalSeconds: 86_400 }, 'needs_consent', signals(), () => 0.5);
    expect(out).toEqual({ intervalSeconds: 86_400, nextSyncAt: null });
  });

  it('unschedules on a connection auth failure', () => {
    const out = applyCadence('users', { intervalSeconds: 21_600 }, 'error', signals({ authFailure: true }), () => 0.5);
    expect(out.nextSyncAt).toBeNull();
  });

  it('still schedules a non-auth terminal error so the ticker retries on cadence', () => {
    const out = applyCadence('users', { intervalSeconds: 21_600 }, 'error', signals(), () => 0.5);
    expect(out.nextSyncAt).not.toBeNull();
  });

  it('derives next_sync_at from signals.now, not from a clock read inside the seam', () => {
    const other = new Date('2027-01-01T00:00:00.000Z');
    // 86 400 s is skus' default, so the success decay leaves it where it is.
    const { nextSyncAt: due } = applyCadence('skus', { intervalSeconds: 86_400 }, 'success', signals({ now: other }), () => 0.5);
    expect(due!.getTime()).toBe(other.getTime() + 86_400 * 1000);
  });

  it('accepts all six signals, so W05 has every one of them available', () => {
    expect(() => applyCadence('signin_activity', { intervalSeconds: 86400 }, 'partial',
      signals({ truncated: true, capacity: true, unlicensed: true, authFailure: true }))).not.toThrow();
  });
});
