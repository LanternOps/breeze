import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  deviceCommands: {
    id: 'deviceCommands.id',
    deviceId: 'deviceCommands.deviceId',
    status: 'deviceCommands.status',
    type: 'deviceCommands.type',
    targetRole: 'deviceCommands.targetRole',
    createdAt: 'deviceCommands.createdAt',
    executedAt: 'deviceCommands.executedAt',
    deliverBy: 'deviceCommands.deliverBy',
    submittedOrgId: 'deviceCommands.submittedOrgId',
    createdBy: 'deviceCommands.createdBy',
    payload: 'deviceCommands.payload',
    completedAt: 'deviceCommands.completedAt',
    result: 'deviceCommands.result',
  },
  peripheralPolicyDeviceStates: {
    deviceId: 'peripheralPolicyDeviceStates.deviceId',
    deliveryStatus: 'peripheralPolicyDeviceStates.deliveryStatus',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    status: 'devices.status',
    partnerId: 'devices.partnerId',
  },
  users: {
    id: 'users.id',
    status: 'users.status',
  },
}));

// Spy on inArray/notInArray/gt/isNull (pass-through to the real implementation)
// so both the #2774 drain-mode type filter and the #5128 deliver-by predicate
// are assertable without mocking all of drizzle.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    inArray: vi.fn((...args: Parameters<typeof actual.inArray>) => actual.inArray(...args)),
    notInArray: vi.fn((...args: Parameters<typeof actual.notInArray>) => actual.notInArray(...args)),
    gt: vi.fn((...args: Parameters<typeof actual.gt>) => actual.gt(...args)),
    isNull: vi.fn((...args: Parameters<typeof actual.isNull>) => actual.isNull(...args)),
    // #5128: spied so the deliver_by predicate's DISJUNCTION is assertable —
    // `and(...)` in its place would call isNull/gt identically but withhold
    // every row that has a deadline.
    or: vi.fn((...args: Parameters<typeof actual.or>) => actual.or(...args)),
  };
});

const { partitionClaimableMock } = vi.hoisted(() => ({ partitionClaimableMock: vi.fn() }));

vi.mock('./commandClaimEligibility', () => ({
  partitionClaimable: partitionClaimableMock,
  POWER_STATE_BARRIER_TYPES: new Set(['reboot', 'shutdown', 'reboot_safe_mode']),
  typeHolds: {},
}));

import { gt, inArray, isNull, notInArray, or } from 'drizzle-orm';

import { db } from '../db';
import {
  claimPendingCommandForDelivery,
  claimPendingCommandsForDevice,
  releaseClaimedCommandDelivery,
} from './commandDispatch';

const DEVICE_ROW = { id: 'dev-1', orgId: 'org-1', status: 'online', partnerId: 'partner-1' };

// #5128: the claim transaction now issues two extra lookups (the device row for
// claim-time eligibility, then a count of in-flight rows for the power-state
// barrier), so `where()` exposes BOTH the pending-scan chain
// (`.orderBy().limit().for()`) and a directly-awaitable `.limit()`.
function selectChain(pending: unknown[], opts: { device?: unknown; inFlight?: number } = {}) {
  const device = 'device' in opts ? opts.device : DEVICE_ROW;
  // Shared across every `where()` invocation: the device-row lookup consumes
  // the first queued value, the in-flight-count lookup the second. A fresh
  // `vi.fn()` per `where()` call would reset the once-queue and hand the
  // device row back to both lookups instead of advancing.
  const limit = vi.fn()
    .mockResolvedValueOnce(device === undefined ? [] : [device])
    .mockResolvedValueOnce([{ inFlight: opts.inFlight ?? 0 }]);
  return vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(() => ({
          limit: vi.fn(() => ({ for: vi.fn().mockResolvedValue(pending) })),
        })),
        limit,
      })),
    })),
  }));
}

describe('command dispatch helpers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    partitionClaimableMock.mockImplementation(async (_tx: unknown, _dev: unknown, rows: any[]) => ({
      claimable: rows,
      cancelled: [],
      held: [],
    }));
  });

  it('claims a pending command for delivery only when the conditional update succeeds', async () => {
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'cmd-1' }]),
        }),
      }),
    } as any);

    const result = await claimPendingCommandForDelivery('cmd-1', new Date('2026-03-31T00:00:00Z'));

    expect(result).toEqual({
      id: 'cmd-1',
      executedAt: new Date('2026-03-31T00:00:00Z'),
    });
  });

  it('returns only commands that were successfully claimed from pending state', async () => {
    const returning = vi.fn()
      .mockResolvedValueOnce([{ id: 'cmd-1', deviceId: 'dev-1', status: 'sent', createdAt: new Date('2026-03-31T00:00:00Z') }])
      .mockResolvedValueOnce([]);

    const tx = {
      select: selectChain([
        { id: 'cmd-1', deviceId: 'dev-1', status: 'pending', createdAt: new Date('2026-03-31T00:00:00Z') },
        { id: 'cmd-2', deviceId: 'dev-1', status: 'pending', createdAt: new Date('2026-03-31T00:00:01Z') },
      ]),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning,
          }),
        }),
      }),
    };

    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const claimed = await claimPendingCommandsForDevice(
      'dev-1', 10, 'agent', undefined, { peripheralPolicyProtocolVersion: 2 },
    );

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe('cmd-1');
    // No drain allowlist → no type filter applied.
    expect(vi.mocked(inArray)).not.toHaveBeenCalledWith('deviceCommands.type', expect.anything());
  });

  // #2774 — during an offboarding drain the claim narrows to self_uninstall.
  it('applies the type allowlist to the claim query when provided', async () => {
    const tx = {
      select: selectChain([]),
      update: vi.fn(),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const claimed = await claimPendingCommandsForDevice(
      'dev-1', 10, 'agent', ['self_uninstall'], { peripheralPolicyProtocolVersion: 2 },
    );

    expect(claimed).toEqual([]);
    expect(vi.mocked(inArray)).toHaveBeenCalledWith('deviceCommands.type', ['self_uninstall']);
  });

  it('does not mutate unrelated protocol work during a self-uninstall-only claim', async () => {
    const tx = {
      select: selectChain([]),
      update: vi.fn(),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const claimed = await claimPendingCommandsForDevice(
      'dev-1',
      10,
      'agent',
      ['self_uninstall'],
    );

    expect(claimed).toEqual([]);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('cancels queued peripheral v2 work when the claiming heartbeat omits capability 2', async () => {
    const cancelWhere = vi.fn().mockResolvedValue(undefined);
    const rejectWhere = vi.fn().mockResolvedValue(undefined);
    const tx = {
      select: selectChain([]),
      update: vi.fn()
        .mockReturnValueOnce({ set: vi.fn().mockReturnValue({ where: cancelWhere }) })
        .mockReturnValueOnce({ set: vi.fn().mockReturnValue({ where: rejectWhere }) }),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const claimed = await claimPendingCommandsForDevice(
      'dev-1',
      10,
      'agent',
      undefined,
      { peripheralPolicyProtocolVersion: 0 },
    );

    expect(claimed).toEqual([]);
    expect(tx.update).toHaveBeenCalledTimes(2);
    expect(cancelWhere).toHaveBeenCalledTimes(1);
    expect(rejectWhere).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notInArray)).toHaveBeenCalledWith(
      'deviceCommands.type',
      ['peripheral_policy_sync_v2', 'agent_rollback_v1', 'pam_apply_v2', 'pam_cleanup_v2'],
    );
  });

  it('withholds rollback when this heartbeat does not report protocol v1', async () => {
    const tx = {
      select: selectChain([]),
      update: vi.fn(),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    await claimPendingCommandsForDevice('dev-1', 10, 'agent', undefined, {
      peripheralPolicyProtocolVersion: 2,
      rollbackProtocolVersion: 0,
      pamLifetimeProtocolVersion: 2,
    });

    expect(vi.mocked(notInArray)).toHaveBeenCalledWith(
      'deviceCommands.type',
      ['agent_rollback_v1'],
    );
  });

  it('withholds PAM lifetime commands when this heartbeat does not report protocol v2', async () => {
    const tx = {
      select: selectChain([]),
      update: vi.fn(),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    await claimPendingCommandsForDevice('dev-1', 10, 'agent', undefined, {
      peripheralPolicyProtocolVersion: 2,
      rollbackProtocolVersion: 1,
      pamLifetimeProtocolVersion: 0,
    });

    expect(vi.mocked(notInArray)).toHaveBeenCalledWith(
      'deviceCommands.type',
      ['pam_apply_v2', 'pam_cleanup_v2'],
    );
  });

  it('releases a claimed command back to pending state', async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where,
      }),
    } as any);

    await releaseClaimedCommandDelivery('cmd-1', new Date('2026-03-31T00:00:00Z'));

    expect(where).toHaveBeenCalledTimes(1);
  });

  // #5128: the pending-scan predicate must exclude rows whose deadline has
  // already passed — those belong to the reaper, not to a claiming heartbeat.
  it('excludes a command whose deliver_by has already passed from the claim query', async () => {
    const tx = {
      select: selectChain([]),
      update: vi.fn(),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    await claimPendingCommandsForDevice('dev-1', 10, 'agent', undefined, {
      peripheralPolicyProtocolVersion: 2,
    });

    expect(vi.mocked(gt)).toHaveBeenCalledWith('deviceCommands.deliverBy', expect.any(Date));
    expect(vi.mocked(isNull)).toHaveBeenCalledWith('deviceCommands.deliverBy');

    // Asserting the two helpers were CALLED is not enough: swapping the `or(...)`
    // that joins them for an `and(...)` calls both identically while excluding
    // every row that HAS a deliver_by from delivery. Compile the actual joined
    // predicate and require the DISJUNCTION.
    expect(vi.mocked(or)).toHaveBeenCalled();
    const deadlineArm = vi.mocked(or).mock.results[0]!.value;
    const { sql: sqlText } = new PgDialect().sqlToQuery(deadlineArm as never);
    expect(sqlText).toMatch(/is null or /i);
    expect(sqlText).toMatch(/> \$/);
  });

  // #5128 §G: claim-time eligibility can veto rows the pending scan returned
  // (e.g. the device moved org since the command was queued) — only the rows
  // it marks claimable may proceed to the per-row claim UPDATE.
  it('claims only the rows claim-time eligibility returns', async () => {
    const pendingRows = [
      { id: 'cmd-1', deviceId: 'dev-1', status: 'pending', createdAt: new Date('2026-03-31T00:00:00Z') },
      { id: 'cmd-2', deviceId: 'dev-1', status: 'pending', createdAt: new Date('2026-03-31T00:00:01Z') },
    ];
    partitionClaimableMock.mockResolvedValue({
      claimable: [pendingRows[0]],
      cancelled: [{ id: 'cmd-2', reason: 'device_moved_org' }],
      held: [],
    });

    const returning = vi.fn().mockResolvedValue([
      { id: 'cmd-1', deviceId: 'dev-1', status: 'sent', createdAt: new Date('2026-03-31T00:00:00Z') },
    ]);
    const tx = {
      select: selectChain(pendingRows),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning }),
        }),
      }),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const claimed = await claimPendingCommandsForDevice(
      'dev-1', 10, 'agent', undefined, { peripheralPolicyProtocolVersion: 2 },
    );

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe('cmd-1');
    expect(returning).toHaveBeenCalledTimes(1);
  });

  // #5128: if the device vanished (deleted / moved) between the pending scan
  // and the eligibility check, nothing in the batch may be delivered.
  it('returns nothing when the device row has vanished mid-claim', async () => {
    const tx = {
      select: selectChain(
        [{ id: 'cmd-1', deviceId: 'dev-1', status: 'pending', createdAt: new Date('2026-03-31T00:00:00Z') }],
        { device: undefined },
      ),
      update: vi.fn(),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const claimed = await claimPendingCommandsForDevice(
      'dev-1', 10, 'agent', undefined, { peripheralPolicyProtocolVersion: 2 },
    );

    expect(claimed).toEqual([]);
    expect(tx.update).not.toHaveBeenCalled();
    expect(partitionClaimableMock).not.toHaveBeenCalled();
  });

  // #5128: the power-state barrier inside partitionClaimable needs the count
  // of already-`sent` rows for this device/role — that count must reach it.
  it('passes the in-flight sent count to claim-time eligibility', async () => {
    const pendingRows = [
      { id: 'cmd-1', deviceId: 'dev-1', status: 'pending', createdAt: new Date('2026-03-31T00:00:00Z') },
    ];
    const returning = vi.fn().mockResolvedValue([
      { id: 'cmd-1', deviceId: 'dev-1', status: 'sent', createdAt: new Date('2026-03-31T00:00:00Z') },
    ]);
    const tx = {
      select: selectChain(pendingRows, { inFlight: 3 }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning }),
        }),
      }),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    await claimPendingCommandsForDevice(
      'dev-1', 10, 'agent', undefined, { peripheralPolicyProtocolVersion: 2 },
    );

    expect(partitionClaimableMock).toHaveBeenCalledWith(
      tx,
      DEVICE_ROW,
      pendingRows,
      { inFlight: 3 },
    );
  });

  // #5128: the single-command delivery UPDATE carries the same deadline
  // predicate as the batch scan, so a stale row can't be delivered directly.
  it('the single-command claim refuses a row past its delivery deadline', async () => {
    const where = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'cmd-1' }]),
    });
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where }),
    } as any);

    await claimPendingCommandForDelivery('cmd-1', new Date('2026-03-31T00:00:00Z'));

    expect(where).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gt)).toHaveBeenCalledWith('deviceCommands.deliverBy', expect.any(Date));
    expect(vi.mocked(isNull)).toHaveBeenCalledWith('deviceCommands.deliverBy');
  });
});
