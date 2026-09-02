import { describe, expect, it } from 'vitest';
import { DEFAULT_OFFLINE_THRESHOLD_MINUTES, resolveLivenessStatus } from './deviceLiveness';

const NOW = new Date('2026-09-02T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe('deviceLiveness', () => {
  it('pins the offline threshold at the value offlineDetector shipped with', () => {
    // The six offlineDetector suites assert behaviour derived from this number;
    // moving it is a fleet-wide change, not a refactor.
    expect(DEFAULT_OFFLINE_THRESHOLD_MINUTES).toBe(5);
  });

  it('treats a device seen inside the threshold as online', () => {
    expect(resolveLivenessStatus(minutesAgo(1), NOW)).toBe('online');
  });

  it('treats a device seen exactly at the threshold as online (inclusive boundary)', () => {
    expect(resolveLivenessStatus(minutesAgo(DEFAULT_OFFLINE_THRESHOLD_MINUTES), NOW)).toBe('online');
  });

  it('treats a device seen one second past the threshold as offline', () => {
    expect(resolveLivenessStatus(new Date(minutesAgo(DEFAULT_OFFLINE_THRESHOLD_MINUTES).getTime() - 1000), NOW)).toBe('offline');
  });

  it('treats a device that has never been seen as offline', () => {
    expect(resolveLivenessStatus(null, NOW)).toBe('offline');
    expect(resolveLivenessStatus(undefined, NOW)).toBe('offline');
  });

  it('treats a future last_seen_at as online rather than throwing (clock skew)', () => {
    expect(resolveLivenessStatus(new Date(NOW.getTime() + 60_000), NOW)).toBe('online');
  });
});
