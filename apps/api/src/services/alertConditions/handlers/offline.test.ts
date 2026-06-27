import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getDeviceMock } = vi.hoisted(() => ({
  getDeviceMock: vi.fn(),
}));

// getDevice touches the db; mock the whole utils module so we can drive it.
vi.mock('../utils', () => ({
  getDevice: getDeviceMock,
}));

import { offlineHandler } from './offline';

const DEVICE_ID = 'device-1';

function makeDevice(overrides: Record<string, unknown> = {}) {
  return {
    id: DEVICE_ID,
    status: 'online',
    lastSeenAt: new Date('2026-06-24T12:00:00.000Z'),
    ...overrides,
  } as never;
}

describe('offlineHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-24T12:00:00.000Z'));
    getDeviceMock.mockReset();
  });

  it('declares the type "offline" and registers a "status" alias for legacy rows', () => {
    expect(offlineHandler.type).toBe('offline');
    expect(offlineHandler.aliases).toContain('status');
  });

  it('does NOT fire a long-duration rule just because the global detector set status=offline (issue #1982)', async () => {
    // The global ~5-min offline detector flips device.status to 'offline', but
    // lastSeenAt is only ~5 min stale. A rule configured for 60 min must NOT
    // fire yet — it has to honor its own duration, not the global threshold.
    getDeviceMock.mockResolvedValue(
      makeDevice({ status: 'offline', lastSeenAt: new Date('2026-06-24T11:55:00.000Z') })
    );

    const result = await offlineHandler.evaluate({ type: 'offline', durationMinutes: 60 }, DEVICE_ID);

    expect(result.passed).toBe(false);
  });

  it('fires once lastSeenAt exceeds the per-rule duration, regardless of the status flag (issue #1982)', async () => {
    // 70 min stale vs a 60-min rule → offline. Driven purely by lastSeenAt.
    getDeviceMock.mockResolvedValue(
      makeDevice({ status: 'offline', lastSeenAt: new Date('2026-06-24T10:50:00.000Z') })
    );

    const result = await offlineHandler.evaluate({ type: 'offline', durationMinutes: 60 }, DEVICE_ID);

    expect(result.passed).toBe(true);
    expect(result.description).toBe('Device offline for 60min');
  });

  it('does NOT pass when lastSeenAt is null (no heartbeat baseline to measure duration)', async () => {
    // A device that never reported a heartbeat has no offline-duration baseline,
    // so we can't assert it's been offline for N minutes — don't fire.
    getDeviceMock.mockResolvedValue(makeDevice({ status: 'offline', lastSeenAt: null }));

    const result = await offlineHandler.evaluate({ type: 'offline', durationMinutes: 5 }, DEVICE_ID);

    expect(result.passed).toBe(false);
  });

  it('passes when lastSeenAt is older than the canonical durationMinutes threshold', async () => {
    // 20 min stale, threshold 15 → offline
    getDeviceMock.mockResolvedValue(
      makeDevice({ status: 'online', lastSeenAt: new Date('2026-06-24T11:40:00.000Z') })
    );

    const result = await offlineHandler.evaluate({ type: 'offline', durationMinutes: 15 }, DEVICE_ID);

    expect(result.passed).toBe(true);
  });

  it('does NOT pass when lastSeenAt is within the threshold and status is online', async () => {
    // 5 min stale, threshold 15 → still online
    getDeviceMock.mockResolvedValue(
      makeDevice({ status: 'online', lastSeenAt: new Date('2026-06-24T11:55:00.000Z') })
    );

    const result = await offlineHandler.evaluate({ type: 'offline', durationMinutes: 15 }, DEVICE_ID);

    expect(result.passed).toBe(false);
  });

  it('reads the legacy "duration" field (status-alias rows) as the threshold', async () => {
    // 10 min stale; legacy condition uses `duration: 5` → should be offline.
    getDeviceMock.mockResolvedValue(
      makeDevice({ status: 'online', lastSeenAt: new Date('2026-06-24T11:50:00.000Z') })
    );

    const result = await offlineHandler.evaluate({ type: 'status', duration: 5 }, DEVICE_ID);

    expect(result.passed).toBe(true);
    // Description reflects the resolved duration, not the canonical field name.
    expect(result.description).toBe('Device offline for 5min');
  });

  it('does NOT pass a legacy "duration" row when within threshold', async () => {
    // 3 min stale; legacy condition uses `duration: 15` → still online.
    getDeviceMock.mockResolvedValue(
      makeDevice({ status: 'online', lastSeenAt: new Date('2026-06-24T11:57:00.000Z') })
    );

    const result = await offlineHandler.evaluate({ type: 'status', duration: 15 }, DEVICE_ID);

    expect(result.passed).toBe(false);
  });

  it('defaults to a 5-minute threshold when no duration field is present', async () => {
    getDeviceMock.mockResolvedValue(
      makeDevice({ status: 'online', lastSeenAt: new Date('2026-06-24T11:54:00.000Z') })
    );

    const result = await offlineHandler.evaluate({ type: 'offline' }, DEVICE_ID);

    // 6 min stale vs default 5 → offline.
    expect(result.passed).toBe(true);
    expect(result.description).toBe('Device offline for 5min');
  });

  it('prefers durationMinutes over a legacy duration when both are present', async () => {
    // 12 min stale. durationMinutes:10 (used) → offline; duration:99 (ignored) would be online.
    getDeviceMock.mockResolvedValue(
      makeDevice({ status: 'online', lastSeenAt: new Date('2026-06-24T11:48:00.000Z') })
    );

    const result = await offlineHandler.evaluate(
      { type: 'offline', durationMinutes: 10, duration: 99 },
      DEVICE_ID
    );

    expect(result.passed).toBe(true);
    expect(result.description).toBe('Device offline for 10min');
  });

  it('falls back to the 5-minute default for non-positive durations', async () => {
    // 6 min stale. durationMinutes:0 is invalid → default 5 → offline.
    getDeviceMock.mockResolvedValue(
      makeDevice({ status: 'online', lastSeenAt: new Date('2026-06-24T11:54:00.000Z') })
    );

    const result = await offlineHandler.evaluate({ type: 'offline', durationMinutes: 0 }, DEVICE_ID);

    expect(result.passed).toBe(true);
    expect(result.description).toBe('Device offline for 5min');
  });

  it('returns "Device not found" when the device does not exist', async () => {
    getDeviceMock.mockResolvedValue(null);

    const result = await offlineHandler.evaluate({ type: 'offline', durationMinutes: 5 }, DEVICE_ID);

    expect(result.passed).toBe(false);
    expect(result.description).toBe('Device not found');
  });

  describe('validate', () => {
    it('accepts a numeric durationMinutes', () => {
      expect(offlineHandler.validate({ type: 'offline', durationMinutes: 15 }, 'cond')).toEqual([]);
    });

    it('accepts a numeric legacy duration', () => {
      expect(offlineHandler.validate({ type: 'status', duration: 5 }, 'cond')).toEqual([]);
    });

    it('rejects a non-numeric durationMinutes', () => {
      const errors = offlineHandler.validate({ type: 'offline', durationMinutes: 'soon' }, 'cond');
      expect(errors).toContain('cond.durationMinutes: Must be a number');
    });

    it('rejects a non-numeric legacy duration', () => {
      const errors = offlineHandler.validate({ type: 'status', duration: 'soon' }, 'cond');
      expect(errors).toContain('cond.duration: Must be a number');
    });
  });
});
