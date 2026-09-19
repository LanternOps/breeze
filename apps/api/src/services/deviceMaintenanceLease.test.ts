import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/schema')>();
  return { ...actual };
});

import {
  MAINTENANCE_ENTRY_ALLOWED_STATUSES,
  MaintenanceLeaseError,
  applyMaintenanceEntry,
  clearMaintenanceLease,
} from './deviceMaintenanceLease';

const NOW = new Date('2026-09-02T12:00:00.000Z');
const DEVICE = '00000000-0000-4000-8000-000000000001';
const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const OTHER_ACTOR = '00000000-0000-4000-8000-0000000000bb';
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

/**
 * Stub tx that records the ORDER of operations, so "locked SELECT first" and
 * "exactly one UPDATE" are assertions, not hopes.
 */
function makeTx(row: Record<string, unknown> | null) {
  const calls: string[] = [];
  const captured: Array<Record<string, unknown>> = [];
  const forUpdate = vi.fn(async () => { calls.push('select-for-update'); return row ? [row] : []; });
  const select = vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => ({ for: forUpdate })) })) })),
  }));
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      captured.push(values);
      calls.push('update');
      return { where: vi.fn(() => ({ returning: vi.fn(async () => [{ ...row, ...values, id: DEVICE }]) })) };
    }),
  }));
  return { tx: { select, update } as any, calls, captured, forUpdate, update };
}

const baseRow = (over: Record<string, unknown> = {}) => ({
  id: DEVICE,
  orgId: 'org-1',
  siteId: 'site-1',
  hostname: 'host-a',
  status: 'online',
  lastSeenAt: minutesAgo(1),
  maintenanceStartedAt: null,
  maintenanceUntil: null,
  maintenanceReason: null,
  maintenanceStartedBy: null,
  ...over,
});

describe('applyMaintenanceEntry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('locks the device row BEFORE writing and issues exactly one UPDATE', async () => {
    const { tx, calls, update } = makeTx(baseRow());
    await applyMaintenanceEntry(tx, { deviceId: DEVICE, reason: 'scheduled patching', durationHours: 2, actorUserId: ACTOR, now: NOW });
    expect(calls).toEqual(['select-for-update', 'update']);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('enters maintenance when there is no lease: sets started_at/by, until, reason and status', async () => {
    const { tx, captured } = makeTx(baseRow());
    const result = await applyMaintenanceEntry(tx, { deviceId: DEVICE, reason: 'scheduled patching', durationHours: 2, actorUserId: ACTOR, now: NOW });
    expect(result.action).toBe('enable');
    expect(result.previousUntil).toBeNull();
    expect(result.until).toEqual(hoursFromNow(2));
    expect(captured[0]).toMatchObject({
      status: 'maintenance',
      maintenanceStartedAt: NOW,
      maintenanceStartedBy: ACTOR,
      maintenanceUntil: hoursFromNow(2),
      maintenanceReason: 'scheduled patching',
    });
  });

  it('treats an EXPIRED lease as a fresh entry and re-stamps the actor', async () => {
    const { tx, captured } = makeTx(baseRow({
      status: 'maintenance',
      maintenanceUntil: new Date(NOW.getTime() - 3_600_000),
      maintenanceStartedAt: minutesAgo(600),
      maintenanceReason: 'old reason',
      maintenanceStartedBy: OTHER_ACTOR,
    }));
    const result = await applyMaintenanceEntry(tx, { deviceId: DEVICE, reason: 'scheduled patching', durationHours: 2, actorUserId: ACTOR, now: NOW });
    expect(result.action).toBe('enable');
    expect(captured[0]).toMatchObject({ maintenanceStartedBy: ACTOR, maintenanceStartedAt: NOW });
  });

  it('EXTENDS an active lease from NOW, not from the old until, and never compounds', async () => {
    const { tx, captured } = makeTx(baseRow({
      status: 'maintenance',
      maintenanceUntil: hoursFromNow(1),
      maintenanceStartedAt: minutesAgo(60),
      maintenanceReason: 'old reason',
      maintenanceStartedBy: OTHER_ACTOR,
    }));
    const result = await applyMaintenanceEntry(tx, { deviceId: DEVICE, reason: 'still patching', durationHours: 2, actorUserId: ACTOR, now: NOW });
    expect(result.action).toBe('extend');
    expect(result.previousUntil).toEqual(hoursFromNow(1));
    expect(result.previousReason).toBe('old reason');
    // now + 2h, NOT (now + 1h) + 2h — a state-independent outcome is what
    // closes the grant TOCTOU (D6): the grant means one thing whatever the
    // row's prior state.
    expect(result.until).toEqual(hoursFromNow(2));
    expect(captured[0]).toMatchObject({ maintenanceUntil: hoursFromNow(2), maintenanceReason: 'still patching' });
  });

  it('keeps started_at and started_by IMMUTABLE across an extension', async () => {
    const originalStart = minutesAgo(60);
    const { tx, captured } = makeTx(baseRow({
      status: 'maintenance',
      maintenanceUntil: hoursFromNow(1),
      maintenanceStartedAt: originalStart,
      maintenanceReason: 'old reason',
      maintenanceStartedBy: OTHER_ACTOR,
    }));
    const result = await applyMaintenanceEntry(tx, { deviceId: DEVICE, reason: 'still patching', durationHours: 2, actorUserId: ACTOR, now: NOW });
    expect(result.startedAt).toEqual(originalStart);
    expect(captured[0]).not.toHaveProperty('maintenanceStartedAt');
    expect(captured[0]).not.toHaveProperty('maintenanceStartedBy');
  });

  it('extends a device whose heartbeat already overwrote status to online (lease, not status, decides)', async () => {
    const { tx } = makeTx(baseRow({
      status: 'online',
      maintenanceUntil: hoursFromNow(1),
      maintenanceStartedAt: minutesAgo(60),
      maintenanceReason: 'old reason',
      maintenanceStartedBy: OTHER_ACTOR,
    }));
    const result = await applyMaintenanceEntry(tx, { deviceId: DEVICE, reason: 'still patching', durationHours: 2, actorUserId: ACTOR, now: NOW });
    expect(result.action).toBe('extend');
  });

  it('throws not_found and writes nothing when the locked select returns no row', async () => {
    const { tx, update } = makeTx(null);
    await expect(applyMaintenanceEntry(tx, { deviceId: DEVICE, reason: 'scheduled patching', durationHours: 2, actorUserId: ACTOR, now: NOW }))
      .rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect(update).not.toHaveBeenCalled();
  });

  it('throws decommissioned (400) and writes nothing', async () => {
    const { tx, update } = makeTx(baseRow({ status: 'decommissioned' }));
    await expect(applyMaintenanceEntry(tx, { deviceId: DEVICE, reason: 'scheduled patching', durationHours: 2, actorUserId: ACTOR, now: NOW }))
      .rejects.toMatchObject({ code: 'decommissioned', status: 400 });
    expect(update).not.toHaveBeenCalled();
  });

  it.each(['quarantined', 'pending', 'updating'])(
    'throws state_conflict (409) for status %s and writes nothing — enter-then-exit must not launder it',
    async (status) => {
      const { tx, update } = makeTx(baseRow({ status }));
      await expect(applyMaintenanceEntry(tx, { deviceId: DEVICE, reason: 'scheduled patching', durationHours: 2, actorUserId: ACTOR, now: NOW }))
        .rejects.toMatchObject({ code: 'state_conflict', status: 409, deviceStatus: status });
      expect(update).not.toHaveBeenCalled();
    });

  it('exposes exactly the three allowed entry statuses', () => {
    expect([...MAINTENANCE_ENTRY_ALLOWED_STATUSES]).toEqual(['online', 'offline', 'maintenance']);
  });
});

describe('clearMaintenanceLease', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves status from FRESH evidence: recently seen -> online', async () => {
    const { tx, captured } = makeTx(baseRow({
      status: 'maintenance', lastSeenAt: minutesAgo(1),
      maintenanceUntil: hoursFromNow(1), maintenanceStartedAt: minutesAgo(60), maintenanceReason: 'r', maintenanceStartedBy: ACTOR,
    }));
    const result = await clearMaintenanceLease(tx, { deviceId: DEVICE, now: NOW });
    expect(result.changed).toBe(true);
    expect(result.resolvedStatus).toBe('online');
    expect(captured[0]).toMatchObject({
      status: 'online', maintenanceUntil: null, maintenanceReason: null,
      maintenanceStartedAt: null, maintenanceStartedBy: null,
    });
  });

  it('resolves status from FRESH evidence: not seen for 10 minutes -> offline (never resurrects a stale online)', async () => {
    const { tx, captured } = makeTx(baseRow({
      status: 'maintenance', lastSeenAt: minutesAgo(10),
      maintenanceUntil: hoursFromNow(1), maintenanceStartedAt: minutesAgo(60), maintenanceReason: 'r', maintenanceStartedBy: ACTOR,
    }));
    const result = await clearMaintenanceLease(tx, { deviceId: DEVICE, now: NOW });
    expect(result.resolvedStatus).toBe('offline');
    expect(captured[0]).toMatchObject({ status: 'offline' });
  });

  it('leaves a non-maintenance status untouched while still clearing the lease', async () => {
    const { tx, captured } = makeTx(baseRow({
      status: 'updating', lastSeenAt: minutesAgo(1),
      maintenanceUntil: hoursFromNow(1), maintenanceStartedAt: minutesAgo(60), maintenanceReason: 'r', maintenanceStartedBy: ACTOR,
    }));
    const result = await clearMaintenanceLease(tx, { deviceId: DEVICE, now: NOW });
    expect(result.changed).toBe(true);
    expect(result.resolvedStatus).toBe('updating');
    expect(captured[0]).not.toHaveProperty('status');
    expect(captured[0]).toMatchObject({ maintenanceUntil: null });
  });

  it('is a no-op with changed:false when there is no lease and status is not maintenance', async () => {
    const { tx, update } = makeTx(baseRow({ status: 'online' }));
    const result = await clearMaintenanceLease(tx, { deviceId: DEVICE, now: NOW });
    expect(result.changed).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('still exits a device stuck at status maintenance with an expired lease', async () => {
    const { tx, captured } = makeTx(baseRow({
      status: 'maintenance', lastSeenAt: minutesAgo(1),
      maintenanceUntil: new Date(NOW.getTime() - 3_600_000), maintenanceStartedAt: minutesAgo(600), maintenanceReason: 'r', maintenanceStartedBy: ACTOR,
    }));
    const result = await clearMaintenanceLease(tx, { deviceId: DEVICE, now: NOW });
    expect(result.changed).toBe(true);
    expect(captured[0]).toMatchObject({ status: 'online' });
  });

  it('throws not_found and writes nothing when the device is gone', async () => {
    const { tx, update } = makeTx(null);
    await expect(clearMaintenanceLease(tx, { deviceId: DEVICE, now: NOW })).rejects.toMatchObject({ code: 'not_found' });
    expect(update).not.toHaveBeenCalled();
  });
});

// MaintenanceLeaseError is imported for its type identity in the throws above;
// assert the class is the one the route will `instanceof` against.
describe('MaintenanceLeaseError', () => {
  it('is a real Error subclass carrying code/status/deviceStatus', () => {
    const err = new MaintenanceLeaseError('state_conflict', 409, 'nope', 'quarantined');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MaintenanceLeaseError');
    expect({ code: err.code, status: err.status, deviceStatus: err.deviceStatus })
      .toEqual({ code: 'state_conflict', status: 409, deviceStatus: 'quarantined' });
  });
});
