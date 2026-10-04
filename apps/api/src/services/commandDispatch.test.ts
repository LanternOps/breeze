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
  organizations: {
    id: 'organizations.id',
    type: 'organizations.type',
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

const revalidateCommandForDeliveryMock = vi.hoisted(() => vi.fn<() => Promise<string | null>>(async () => null));
vi.mock('./commandClaimEligibility', () => ({
  partitionClaimable: partitionClaimableMock,
  POWER_STATE_BARRIER_TYPES: new Set(['reboot', 'shutdown', 'reboot_safe_mode']),
  typeHolds: {},
  // The delivery-time revalidation seam. Registered for real by
  // services/topology/diagnosticDispatch; here it defaults to "deliver" so the
  // existing dispatch assertions keep exercising the claim path itself.
  registerCommandRevalidation: vi.fn(),
  revalidateCommandForDelivery: revalidateCommandForDeliveryMock,
}));

import { gt, inArray, isNull, notInArray, or } from 'drizzle-orm';

import { db } from '../db';
import {
  claimPendingCommandForDelivery,
  claimPendingCommandsForDevice,
  releaseClaimedCommandDelivery,
  expireRefusedClaimedCommandDelivery,
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
  const where = vi.fn(() => ({
    orderBy: vi.fn(() => ({
      limit: vi.fn(() => ({ for: vi.fn().mockResolvedValue(pending) })),
    })),
    limit,
  }));
  // The device-row lookup joins `organizations` for the org type.
  return vi.fn(() => ({
    from: vi.fn(() => ({ where, innerJoin: vi.fn(() => ({ where })) })),
  }));
}

/**
 * The single-command (WebSocket push) claim reads its candidate row inside a
 * savepoint transaction, joined to the device and its org and locked
 * `FOR UPDATE OF device_commands SKIP LOCKED`, then hands it to the SAME
 * claim-time eligibility (`partitionClaimable`) the heartbeat batch uses. The
 * savepoint's tx is `db` itself here.
 */
const DEFAULT_CANDIDATE = {
  id: 'cmd-1',
  type: 'script',
  deviceId: 'dev-1',
  payload: null,
  createdBy: 'user-1',
  submittedOrgId: 'org-1',
  deliverBy: null,
  targetRole: 'agent',
  deviceOrgId: 'org-1',
  deviceStatus: 'online',
  orgType: 'customer',
};
let candidateFor: ReturnType<typeof vi.fn>;
function stubSingleClaimCandidate(
  row: Record<string, unknown> | null = {},
  opts: { inFlight?: number } = {},
) {
  const candidate = row === null ? null : { ...DEFAULT_CANDIDATE, ...row };
  candidateFor = vi.fn().mockResolvedValue(candidate ? [candidate] : []);
  // `.limit(1)` is either locked (`.for(...)`, the candidate read) or awaited
  // directly (the in-flight count for the power-state barrier).
  const where = vi.fn(() => ({
    limit: vi.fn(() => Object.assign(Promise.resolve([{ inFlight: opts.inFlight ?? 0 }]), { for: candidateFor })),
  }));
  const joined: Record<string, unknown> = { where };
  joined.innerJoin = vi.fn(() => joined);
  vi.mocked(db.select).mockReturnValue({ from: vi.fn(() => joined) } as any);
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(db));
}

describe('command dispatch helpers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    revalidateCommandForDeliveryMock.mockResolvedValue(null);
    partitionClaimableMock.mockImplementation(async (_tx: unknown, _dev: unknown, rows: any[]) => ({
      claimable: rows,
      cancelled: [],
      held: [],
    }));
  });

  it('claims a pending command for delivery only when the conditional update succeeds', async () => {
    stubSingleClaimCandidate();
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

  it('expires a refused claim so no heartbeat claims it again and the reaper reports why', async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockReturnValue({ where });
    vi.mocked(db.update).mockReturnValue({ set } as any);
    const claimedAt = new Date('2026-03-31T00:00:00Z');
    const before = Date.now();

    await expireRefusedClaimedCommandDelivery('cmd-1', claimedAt, 'destination no longer resolves');

    const setArg = set.mock.calls[0]![0] as {
      status: string;
      executedAt: null;
      deliverBy: Date;
      result: Record<string, unknown>;
    };
    expect(setArg.status).toBe('pending');
    expect(setArg.executedAt).toBeNull();
    // A deadline at "now" is excluded by every claim query (deliver_by > now)
    // and picked up by the reaper's delivery clock, which owns propagation to
    // restore jobs and DR executions.
    expect(setArg.deliverBy.getTime()).toBeGreaterThanOrEqual(before);
    expect(setArg.deliverBy.getTime()).toBeLessThanOrEqual(Date.now());
    expect(setArg.result).toEqual({ deliveryRefusal: 'destination no longer resolves' });
    // CAS on the observed claim, exactly like a release.
    const { params } = new PgDialect().sqlToQuery(where.mock.calls[0]![0] as never);
    expect(params).toEqual(expect.arrayContaining([
      'deviceCommands.id', 'cmd-1',
      'deviceCommands.status', 'sent',
      'deviceCommands.executedAt',
    ]));
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

  it('records why delivery was deferred when a released command carries a reason, and nothing otherwise', async () => {
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update).mockReturnValue({ set } as any);

    await releaseClaimedCommandDelivery('cmd-1', new Date('2026-03-31T00:00:00Z'), 'index still being prepared');
    expect(set).toHaveBeenLastCalledWith({
      status: 'pending',
      executedAt: null,
      result: { deliveryDeferred: 'index still being prepared' },
    });

    await releaseClaimedCommandDelivery('cmd-1', new Date('2026-03-31T00:00:00Z'));
    expect(set).toHaveBeenLastCalledWith({ status: 'pending', executedAt: null });
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
    stubSingleClaimCandidate();
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
  it('the batch claim hands the device org type to claim-time eligibility', async () => {
    const pendingRows = [
      { id: 'cmd-1', deviceId: 'dev-1', status: 'pending', createdAt: new Date('2026-03-31T00:00:00Z') },
    ];
    const parkedDevice = { ...DEVICE_ROW, orgType: 'unassigned_pool' };
    partitionClaimableMock.mockResolvedValue({
      claimable: [],
      cancelled: [{ id: 'cmd-1', reason: 'device_pending_assignment' }],
      held: [],
    });
    const tx = {
      select: selectChain(pendingRows, { device: parkedDevice }),
      update: vi.fn(),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const claimed = await claimPendingCommandsForDevice(
      'dev-1', 10, 'agent', undefined, { peripheralPolicyProtocolVersion: 2 },
    );

    expect(claimed).toEqual([]);
    expect(partitionClaimableMock).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ orgType: 'unassigned_pool' }),
      pendingRows,
      { inFlight: 0 },
    );
  });

  describe('the WebSocket push claim applies the heartbeat claim-time eligibility', () => {
    function stubSentUpdate() {
      const set = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'cmd-1' }]) }),
      });
      vi.mocked(db.update).mockReturnValue({ set } as any);
      return set;
    }

    it('hands the candidate and the device\'s CURRENT org/status/org type to partitionClaimable on the claim tx', async () => {
      stubSingleClaimCandidate({ deviceOrgId: 'org-2', deviceStatus: 'online', orgType: 'customer' });
      stubSentUpdate();

      await claimPendingCommandForDelivery('cmd-1', new Date('2026-03-31T00:00:00Z'));

      expect(partitionClaimableMock).toHaveBeenCalledTimes(1);
      const [tx, device, rows] = partitionClaimableMock.mock.calls[0]!;
      expect(tx).toBe(db);
      expect(device).toEqual({ id: 'dev-1', orgId: 'org-2', status: 'online', orgType: 'customer' });
      expect(rows).toEqual([
        expect.objectContaining({ id: 'cmd-1', type: 'script', createdBy: 'user-1', submittedOrgId: 'org-1' }),
      ]);
      // Locked like the heartbeat scan, and only the command row.
      expect(candidateFor).toHaveBeenCalledWith('update', expect.objectContaining({ skipLocked: true }));
    });

    it('does not push a command whose requester is no longer active', async () => {
      stubSingleClaimCandidate();
      partitionClaimableMock.mockResolvedValue({
        claimable: [],
        cancelled: [{ id: 'cmd-1', reason: 'requester_inactive' }],
        held: [],
      });
      const set = stubSentUpdate();

      expect(await claimPendingCommandForDelivery('cmd-1', new Date('2026-03-31T00:00:00Z'))).toBeNull();
      expect(set).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'sent' }));
    });

    it('does not push a command queued before the device moved to another org', async () => {
      stubSingleClaimCandidate({ submittedOrgId: 'org-1', deviceOrgId: 'org-2' });
      partitionClaimableMock.mockResolvedValue({
        claimable: [],
        cancelled: [{ id: 'cmd-1', reason: 'device_moved_org' }],
        held: [],
      });
      const set = stubSentUpdate();

      expect(await claimPendingCommandForDelivery('cmd-1', new Date('2026-03-31T00:00:00Z'))).toBeNull();
      expect(set).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'sent' }));
    });

    it('leaves a held command pending (not pushed, not cancelled)', async () => {
      stubSingleClaimCandidate({ type: 'install_patches' });
      partitionClaimableMock.mockResolvedValue({
        claimable: [],
        cancelled: [],
        held: [{ id: 'cmd-1', reason: 'held_maintenance_suppression' }],
      });
      const set = stubSentUpdate();

      expect(await claimPendingCommandForDelivery('cmd-1', new Date('2026-03-31T00:00:00Z'))).toBeNull();
      expect(set).not.toHaveBeenCalled();
    });

    it('passes the device\'s in-flight count for a power-state command', async () => {
      stubSingleClaimCandidate({ type: 'reboot' }, { inFlight: 2 });
      partitionClaimableMock.mockResolvedValue({
        claimable: [],
        cancelled: [],
        held: [{ id: 'cmd-1', reason: 'power_state_barrier' }],
      });
      stubSentUpdate();

      expect(await claimPendingCommandForDelivery('cmd-1', new Date('2026-03-31T00:00:00Z'))).toBeNull();
      expect(partitionClaimableMock.mock.calls[0]![3]).toEqual({ inFlight: 2 });
    });

    it('control: a command every check admits is still pushed', async () => {
      stubSingleClaimCandidate();
      const set = stubSentUpdate();

      const at = new Date('2026-03-31T00:00:00Z');
      expect(await claimPendingCommandForDelivery('cmd-1', at)).toEqual({ id: 'cmd-1', executedAt: at });
      expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent', executedAt: at }));
    });

    it('returns null without consulting eligibility when the row is gone, locked or not pending', async () => {
      stubSingleClaimCandidate(null);
      const set = stubSentUpdate();

      expect(await claimPendingCommandForDelivery('cmd-1')).toBeNull();
      expect(partitionClaimableMock).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
    });
  });
  it('a parked device claimed under the removal allowlist hands its refused rows to eligibility to cancel', async () => {
    const refusedRows = [{ id: 'cmd-script', type: 'script', deviceId: 'dev-1', status: 'pending' }];
    const allowedRows = [{ id: 'cmd-uninstall', type: 'self_uninstall', deviceId: 'dev-1', status: 'pending' }];
    const parkedDevice = { ...DEVICE_ROW, orgType: 'unassigned_pool' };
    const forMock = vi.fn()
      .mockResolvedValueOnce(refusedRows) // the refused-work scan
      .mockResolvedValueOnce(allowedRows); // the allowlisted pending scan
    const limit = vi.fn()
      .mockResolvedValueOnce([parkedDevice]) // parked check (org type)
      .mockResolvedValueOnce([parkedDevice]) // claim-time eligibility device read
      .mockResolvedValueOnce([{ inFlight: 0 }]);
    const where = vi.fn(() => ({
      orderBy: vi.fn(() => ({ limit: vi.fn(() => ({ for: forMock })) })),
      limit,
    }));
    const tx = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where, innerJoin: vi.fn(() => ({ where })) })) })),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([allowedRows[0]]) }),
        }),
      }),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
    partitionClaimableMock.mockImplementation(async (_tx: unknown, _dev: unknown, rows: any[]) => ({
      claimable: rows.filter((r) => r.type === 'self_uninstall'),
      cancelled: rows.filter((r) => r.type !== 'self_uninstall').map((r) => ({ id: r.id, reason: 'device_pending_assignment' })),
      held: [],
    }));

    const claimed = await claimPendingCommandsForDevice(
      'dev-1', 10, 'agent', ['self_uninstall'], { peripheralPolicyProtocolVersion: 2 },
    );

    expect(partitionClaimableMock).toHaveBeenCalledWith(tx, parkedDevice, refusedRows);
    expect(vi.mocked(notInArray)).toHaveBeenCalledWith('deviceCommands.type', ['self_uninstall']);
    expect(claimed.map((c: any) => c.id)).toEqual(['cmd-uninstall']);
  });

  it('a drain allowlist on a device in an ordinary org leaves refused rows alone', async () => {
    const tx = { select: selectChain([]), update: vi.fn() };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    await claimPendingCommandsForDevice('dev-1', 10, 'agent', ['self_uninstall'], { peripheralPolicyProtocolVersion: 2 });

    expect(partitionClaimableMock).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });
});
