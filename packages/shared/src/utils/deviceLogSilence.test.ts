import { describe, it, expect } from 'vitest';
import { DEVICE_LOG_SILENCE_THRESHOLD_MS, isDeviceLogSilent } from './deviceLogSilence';

const NOW = new Date('2026-10-01T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();

describe('isDeviceLogSilent', () => {
  it('is false for an offline device even with a stale last_log_at', () => {
    expect(
      isDeviceLogSilent({ status: 'offline', lastLogAt: hoursAgo(100) }, NOW),
    ).toBe(false);
  });

  it('is false for an online device whose logs are recent', () => {
    expect(
      isDeviceLogSilent({ status: 'online', lastLogAt: hoursAgo(1) }, NOW),
    ).toBe(false);
  });

  it('is true for an online device with no logs for over the threshold', () => {
    expect(
      isDeviceLogSilent({ status: 'online', lastLogAt: hoursAgo(7) }, NOW),
    ).toBe(true);
  });

  it('is at the exact threshold boundary (inclusive)', () => {
    const exact = new Date(NOW.getTime() - DEVICE_LOG_SILENCE_THRESHOLD_MS).toISOString();
    expect(isDeviceLogSilent({ status: 'online', lastLogAt: exact }, NOW)).toBe(true);
  });

  it('treats a device that never shipped a log as silent once enrolled long enough', () => {
    expect(
      isDeviceLogSilent(
        { status: 'online', lastLogAt: null, enrolledAt: hoursAgo(7) },
        NOW,
      ),
    ).toBe(true);
  });

  it('gives a freshly enrolled device with no logs yet a grace period', () => {
    expect(
      isDeviceLogSilent(
        { status: 'online', lastLogAt: null, enrolledAt: hoursAgo(1) },
        NOW,
      ),
    ).toBe(false);
  });

  it('treats a null lastLogAt with no enrolledAt as silent (conservative default)', () => {
    expect(
      isDeviceLogSilent({ status: 'online', lastLogAt: null }, NOW),
    ).toBe(true);
  });
});
