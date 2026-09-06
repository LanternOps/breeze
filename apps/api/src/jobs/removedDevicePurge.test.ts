import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const {
  addMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerCloseMock,
  dbSelectMock,
  dbTransactionMock,
  getOrgPurgeRemovedAfterDaysMock,
  purgeRemovedDeviceMock,
  createAuditLogMock,
  invalidateOrgDeviceCountMock,
  recordRetentionRunMock,
  captureExceptionMock,
  attachWorkerObservabilityMock,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(async () => []),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  dbSelectMock: vi.fn(),
  dbTransactionMock: vi.fn(),
  getOrgPurgeRemovedAfterDaysMock: vi.fn(),
  purgeRemovedDeviceMock: vi.fn(),
  createAuditLogMock: vi.fn(async (..._args: unknown[]) => undefined),
  invalidateOrgDeviceCountMock: vi.fn(async (..._args: unknown[]) => undefined),
  recordRetentionRunMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  attachWorkerObservabilityMock: vi.fn(),
  capturedWorkerProcessor: { current: null as null | ((job: unknown) => Promise<unknown>) },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = (...args: unknown[]) => addMock(...(args as []));
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (...args: unknown[]) => removeRepeatableByKeyMock(...(args as []));
    close = () => queueCloseMock();
  },
  Worker: class {
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>) {
      capturedWorkerProcessor.current = processor;
    }
    on = vi.fn();
    close = () => workerCloseMock();
  },
  Job: class {},
}));

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => dbSelectMock(...(args as [])),
    transaction: (...args: unknown[]) => dbTransactionMock(...(args as [])),
  },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));

vi.mock('../services/deviceLifecyclePolicy', () => ({
  getOrgPurgeRemovedAfterDays: (...args: unknown[]) => getOrgPurgeRemovedAfterDaysMock(...(args as [])),
}));

// The real DeviceLifecycleError class — the job branches on `instanceof`, so a
// hand-rolled stand-in would let a broken branch pass.
vi.mock('../services/deviceLifecycle', async (orig) => {
  const actual = await orig<typeof import('../services/deviceLifecycle')>();
  return {
    ...actual,
    purgeRemovedDevice: (...args: unknown[]) => purgeRemovedDeviceMock(...(args as [])),
  };
});

vi.mock('../services/auditService', () => ({
  createAuditLog: (...args: unknown[]) => createAuditLogMock(...(args as [])),
}));

vi.mock('../services/agentOrgRateLimit', () => ({
  invalidateOrgDeviceCount: (...args: unknown[]) => invalidateOrgDeviceCountMock(...(args as [])),
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: () => ({}),
  getRedis: () => ({}),
}));

// PARTIAL: the real `deviceLifecycle` module is imported below (for the real
// DeviceLifecycleError class), and its transitive graph reaches routes/metrics,
// which needs this module's other exports.
vi.mock('../services/retentionMetrics', async (orig) => ({
  ...(await orig<typeof import('../services/retentionMetrics')>()),
  recordRetentionRun: (...args: unknown[]) => recordRetentionRunMock(...(args as [])),
}));

vi.mock('../services/sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...(args as [])),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: (...args: unknown[]) => attachWorkerObservabilityMock(...(args as [])),
}));

import {
  runRemovedDevicePurgeOnce,
  purgeOneRemovedDevice,
  REMOVED_DEVICE_PURGE_MAX_PER_ORG_PER_RUN,
  initializeRemovedDevicePurge,
  shutdownRemovedDevicePurge,
} from './removedDevicePurge';
import { DeviceLifecycleError } from '../services/deviceLifecycle';
import { jobSchedule } from './scheduleRegistry';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface DeviceRow {
  id: string;
  hostname: string | null;
  orgId: string;
  decommissionedAt: Date;
}

/** What the per-device `SELECT ... FOR UPDATE` re-check sees under the lock. */
interface LockedRow {
  org_id: string;
  decommissioned_at: Date | null;
}

/**
 * Scripts the two query shapes the job issues, keyed by the ORDER they run in:
 * one org-list select, then one device-select per org that has a policy.
 *
 * `deviceWheres` records the compiled WHERE of each device query so an
 * eligibility assertion cannot pass against a predicate that selects the wrong
 * rows. `lockedStatements` records every `tx.execute` so the per-device
 * re-check cannot be silently deleted.
 *
 * The tx double serves the locked row from the SCRIPTED DEVICE by default, so
 * the ordinary path exercises the real re-check rather than bypassing it; a
 * test simulating a race overrides one device's locked row via `lockRowFor`.
 */
const deviceWheres: unknown[] = [];
const deviceLimits: number[] = [];
const lockedStatements: unknown[] = [];
const scriptedDevices = new Map<string, DeviceRow>();
const lockRowOverrides = new Map<string, LockedRow | null>();

/** The device id bound into a `... WHERE id = $1 FOR UPDATE` statement. */
function executedDeviceId(query: unknown): string | undefined {
  const { params } = new PgDialect().sqlToQuery(query as SQL);
  return params.find((p): p is string => typeof p === 'string');
}

function makeTx() {
  return {
    execute: async (query: unknown) => {
      lockedStatements.push(query);
      const id = executedDeviceId(query);
      if (id !== undefined && lockRowOverrides.has(id)) {
        const override = lockRowOverrides.get(id);
        return override ? [override] : [];
      }
      const scripted = id === undefined ? undefined : scriptedDevices.get(id);
      return scripted
        ? [{ org_id: scripted.orgId, decommissioned_at: scripted.decommissionedAt }]
        : [];
    },
  };
}

function rigQueries(orgIds: string[], devicesByCall: DeviceRow[][]) {
  for (const batch of devicesByCall) {
    for (const d of batch) scriptedDevices.set(d.id, d);
  }
  let call = 0;
  dbSelectMock.mockImplementation(() => {
    const index = call++;
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.from = self;
    chain.where = (cond: unknown) => {
      deviceWheres.push(cond);
      return chain;
    };
    chain.orderBy = self;
    chain.limit = async (n: number) => {
      deviceLimits.push(n);
      return devicesByCall[index - 1] ?? [];
    };
    chain.then = (resolve: (v: unknown) => unknown) =>
      resolve(index === 0 ? orgIds.map((id) => ({ orgId: id })) : (devicesByCall[index - 1] ?? []));
    return chain;
  });
  dbTransactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(makeTx()));
}

function device(
  id: string,
  overrides: { hostname?: string | null; orgId?: string; decommissionedAt?: Date } = {},
): DeviceRow {
  return {
    id,
    hostname: overrides.hostname ?? `host-${id}`,
    orgId: overrides.orgId ?? ORG_A,
    // Comfortably older than any cutoff the tests use.
    decommissionedAt: overrides.decommissionedAt ?? new Date('2026-01-01T00:00:00.000Z'),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  deviceWheres.length = 0;
  deviceLimits.length = 0;
  lockedStatements.length = 0;
  scriptedDevices.clear();
  lockRowOverrides.clear();
  purgeRemovedDeviceMock.mockResolvedValue({ linkGroupId: null, linkGroupDissolved: false });
});

describe('runRemovedDevicePurgeOnce', () => {
  it('never selects or purges anything for an org with no policy — FAIL CLOSED', async () => {
    rigQueries([ORG_A], []);
    getOrgPurgeRemovedAfterDaysMock.mockResolvedValue(null);

    const result = await runRemovedDevicePurgeOnce();

    expect(result.orgsChecked).toBe(1);
    expect(result.orgsWithPolicy).toBe(0);
    expect(result.purged).toBe(0);
    // Not merely "purged nothing": the eligibility query must never run, so a
    // future bug in the predicate cannot delete for an org that never opted in.
    expect(deviceWheres).toHaveLength(0);
    expect(purgeRemovedDeviceMock).not.toHaveBeenCalled();
  });

  it('purges exactly the devices the eligibility query returned, and audits each one', async () => {
    rigQueries([ORG_A], [[device('dev-1'), device('dev-2')]]);
    getOrgPurgeRemovedAfterDaysMock.mockResolvedValue(30);

    const result = await runRemovedDevicePurgeOnce();

    expect(result.orgsWithPolicy).toBe(1);
    expect(result.purged).toBe(2);
    expect(purgeRemovedDeviceMock).toHaveBeenCalledTimes(2);
    expect(purgeRemovedDeviceMock.mock.calls.map((c) => c[1])).toEqual(['dev-1', 'dev-2']);

    // The devices row is permanently gone, so these audit entries are the ONLY
    // durable record that a background job deleted a customer's device.
    expect(createAuditLogMock).toHaveBeenCalledTimes(2);
    expect(createAuditLogMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      orgId: ORG_A,
      actorType: 'system',
      // `audit_logs.actor_id` is uuid NOT NULL — the job names itself in details.
      actorId: '00000000-0000-0000-0000-000000000000',
      action: 'device.permanent_delete',
      resourceType: 'device',
      resourceId: 'dev-1',
      resourceName: 'host-dev-1',
      result: 'success',
      details: expect.objectContaining({
        job: 'removed-device-purge',
        retentionPolicy: true,
        purgeRemovedAfterDays: 30,
      }),
    }));
  });

  it('scopes eligibility to the org, to removed devices, to a non-null stamp, and to the cutoff', async () => {
    rigQueries([ORG_A], [[]]);
    getOrgPurgeRemovedAfterDaysMock.mockResolvedValue(30);

    const now = new Date('2026-03-01T00:00:00.000Z');
    await runRemovedDevicePurgeOnce(now);

    expect(deviceWheres).toHaveLength(1);
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const compiled = new PgDialect().sqlToQuery(deviceWheres[0] as never);
    const text = `${compiled.sql} :: ${JSON.stringify(compiled.params)}`;

    expect(text).toContain(ORG_A);
    expect(text).toContain('decommissioned');
    // `decommissioned_at IS NOT NULL` is load-bearing: a row whose removal time
    // is unknown must never be purged, and `NULL < cutoff` is NULL (not true),
    // so the explicit guard is belt-and-braces for a future predicate rewrite.
    expect(compiled.sql).toMatch(/decommissioned_at["\s]*is not null/i);
    // 30 days before `now`, not before "today".
    expect(text).toContain('2026-01-30T00:00:00.000Z');
  });

  it('counts an UNINSTALL_PENDING refusal as a skip and keeps going', async () => {
    rigQueries([ORG_A], [[device('dev-1'), device('dev-2')]]);
    getOrgPurgeRemovedAfterDaysMock.mockResolvedValue(30);
    purgeRemovedDeviceMock
      .mockRejectedValueOnce(new DeviceLifecycleError('UNINSTALL_PENDING', 'still queued'))
      .mockResolvedValueOnce({ linkGroupId: null, linkGroupDissolved: false });

    const result = await runRemovedDevicePurgeOnce();

    expect(result.skippedUninstallPending).toBe(1);
    expect(result.purged).toBe(1);
    expect(result.failed).toBe(0);
    // The skipped device gets no audit row — nothing was deleted.
    expect(createAuditLogMock).toHaveBeenCalledTimes(1);
    expect(createAuditLogMock.mock.calls[0]![0]).toMatchObject({ resourceId: 'dev-2' });
  });

  it('counts a NOT_REMOVED / NOT_FOUND race as a skip, not a failure', async () => {
    rigQueries([ORG_A], [[device('dev-1'), device('dev-2')]]);
    getOrgPurgeRemovedAfterDaysMock.mockResolvedValue(30);
    purgeRemovedDeviceMock
      .mockRejectedValueOnce(new DeviceLifecycleError('NOT_REMOVED', 'restored meanwhile'))
      .mockRejectedValueOnce(new DeviceLifecycleError('NOT_FOUND', 'already gone'));

    const result = await runRemovedDevicePurgeOnce();

    // A device restored between the SELECT and the lock is the system working:
    // the operator's Restore beat the job, and that is not an error.
    expect(result.skippedRaced).toBe(2);
    expect(result.failed).toBe(0);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('counts an unexpected error as a failure, reports it, and still purges the rest', async () => {
    rigQueries([ORG_A], [[device('dev-1'), device('dev-2')]]);
    getOrgPurgeRemovedAfterDaysMock.mockResolvedValue(30);
    purgeRemovedDeviceMock
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockResolvedValueOnce({ linkGroupId: null, linkGroupDissolved: false });

    const result = await runRemovedDevicePurgeOnce();

    expect(result.failed).toBe(1);
    expect(result.purged).toBe(1);
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it('skips an org whose policy lookup throws and moves to the next one — never purges on an unresolved policy', async () => {
    // Only ONE device select is scripted: ORG_A must never issue one at all.
    rigQueries([ORG_A, ORG_B], [[device('dev-1', { orgId: ORG_B })]]);
    getOrgPurgeRemovedAfterDaysMock
      .mockRejectedValueOnce(new Error('policy read failed'))
      .mockResolvedValueOnce(30);

    const result = await runRemovedDevicePurgeOnce();

    expect(result.orgsFailed).toBe(1);
    expect(result.orgsChecked).toBe(2);
    expect(result.purged).toBe(1);
    // ORG_A issued no eligibility query at all.
    expect(deviceWheres).toHaveLength(1);
  });

  // ------------------------------------------------------------------
  // The per-device re-check under the lock.
  //
  // The candidate SELECT is unlocked and covers up to 200 devices purged
  // SEQUENTIALLY, so minutes can pass between "this device is eligible" and
  // "this device is being deleted". `purgeRemovedDevice` re-checks `status`
  // under its own lock, but nothing re-checked the two facts that made the
  // device eligible in the first place: which org it is in, and whether its
  // removal is still past the window.
  // ------------------------------------------------------------------

  it('re-reads the device under a lock before purging it, not just its status', async () => {
    rigQueries([ORG_A], [[device('dev-1')]]);
    getOrgPurgeRemovedAfterDaysMock.mockResolvedValue(30);

    await runRemovedDevicePurgeOnce();

    // Without this, dropping the re-check entirely would still leave every
    // other assertion in this block satisfiable by the scripted defaults.
    const locked = lockedStatements.map((q) => new PgDialect().sqlToQuery(q as SQL).sql).join(' | ');
    expect(locked).toMatch(/FOR UPDATE/i);
    expect(locked).toMatch(/org_id/i);
    expect(locked).toMatch(/decommissioned_at/i);
  });

  it('refuses a device that moved to another org between the SELECT and the lock', async () => {
    rigQueries([ORG_A], [[device('dev-1'), device('dev-2')]]);
    getOrgPurgeRemovedAfterDaysMock.mockResolvedValue(30);
    lockRowOverrides.set('dev-1', {
      org_id: ORG_B,
      decommissioned_at: new Date('2026-01-01T00:00:00.000Z'),
    });

    const result = await runRemovedDevicePurgeOnce();

    // move-org happened in the window. Deleting it here would destroy a device
    // under a retention policy its CURRENT owner never agreed to, and audit the
    // deletion against the wrong tenant.
    expect(result.skippedRaced).toBe(1);
    expect(result.purged).toBe(1);
    expect(purgeRemovedDeviceMock).toHaveBeenCalledTimes(1);
    expect(purgeRemovedDeviceMock.mock.calls[0]![1]).toBe('dev-2');
    expect(createAuditLogMock).toHaveBeenCalledTimes(1);
    expect(createAuditLogMock.mock.calls[0]![0]).toMatchObject({ resourceId: 'dev-2' });
  });

  it('refuses a device that was restored and re-removed inside the window', async () => {
    rigQueries([ORG_A], [[device('dev-1'), device('dev-2')]]);
    getOrgPurgeRemovedAfterDaysMock.mockResolvedValue(30);
    // Still `decommissioned`, so the status re-check passes — but removed again
    // moments ago, which puts it far inside the 30-day window.
    lockRowOverrides.set('dev-1', { org_id: ORG_A, decommissioned_at: new Date() });

    const result = await runRemovedDevicePurgeOnce();

    expect(result.skippedRaced).toBe(1);
    expect(result.purged).toBe(1);
    expect(purgeRemovedDeviceMock.mock.calls.map((c) => c[1])).toEqual(['dev-2']);
  });

  it('refuses a device whose removal stamp was cleared under the lock', async () => {
    rigQueries([ORG_A], [[device('dev-1')]]);
    getOrgPurgeRemovedAfterDaysMock.mockResolvedValue(30);
    lockRowOverrides.set('dev-1', { org_id: ORG_A, decommissioned_at: null });

    const result = await runRemovedDevicePurgeOnce();

    expect(result.skippedRaced).toBe(1);
    expect(result.purged).toBe(0);
    expect(purgeRemovedDeviceMock).not.toHaveBeenCalled();
  });

  it('counts a device that vanished under the lock as a race, not a failure', async () => {
    rigQueries([ORG_A], [[device('dev-1')]]);
    getOrgPurgeRemovedAfterDaysMock.mockResolvedValue(30);
    lockRowOverrides.set('dev-1', null); // FOR UPDATE returns no row

    const result = await runRemovedDevicePurgeOnce();

    expect(result.skippedRaced).toBe(1);
    expect(result.failed).toBe(0);
    expect(purgeRemovedDeviceMock).not.toHaveBeenCalled();
  });

  it('caps the number of devices it will purge for one org in one run', async () => {
    rigQueries([ORG_A], [[]]);
    getOrgPurgeRemovedAfterDaysMock.mockResolvedValue(30);

    await runRemovedDevicePurgeOnce();

    expect(deviceLimits).toEqual([REMOVED_DEVICE_PURGE_MAX_PER_ORG_PER_RUN]);
  });

  it('reports an incomplete run when the per-org cap was hit, so a backlog cannot look like a clean drain', async () => {
    const full = Array.from({ length: REMOVED_DEVICE_PURGE_MAX_PER_ORG_PER_RUN }, (_, i) =>
      device(`dev-${i}`),
    );
    rigQueries([ORG_A], [full]);
    getOrgPurgeRemovedAfterDaysMock.mockResolvedValue(30);

    const result = await runRemovedDevicePurgeOnce();

    expect(result.orgsCapped).toBe(1);
    expect(recordRetentionRunMock).toHaveBeenCalledWith(
      'removed_device_purge',
      expect.objectContaining({ incomplete: true }),
    );
  });

  it('reports a complete run when nothing was capped, skipped or failed', async () => {
    rigQueries([ORG_A], [[device('dev-1')]]);
    getOrgPurgeRemovedAfterDaysMock.mockResolvedValue(30);

    await runRemovedDevicePurgeOnce();

    expect(recordRetentionRunMock).toHaveBeenCalledWith(
      'removed_device_purge',
      { rowsDeleted: 1, incomplete: false },
    );
  });

  it('invalidates the org device-count cache once per org that actually purged, never for one that did not', async () => {
    rigQueries([ORG_A, ORG_B], [[device('dev-1'), device('dev-2')], []]);
    getOrgPurgeRemovedAfterDaysMock.mockResolvedValue(30);

    await runRemovedDevicePurgeOnce();

    expect(invalidateOrgDeviceCountMock).toHaveBeenCalledTimes(1);
    expect(invalidateOrgDeviceCountMock).toHaveBeenCalledWith(expect.anything(), ORG_A);
  });

  it('does not let a failed audit write turn a completed deletion into a failed run', async () => {
    rigQueries([ORG_A], [[device('dev-1')]]);
    getOrgPurgeRemovedAfterDaysMock.mockResolvedValue(30);
    createAuditLogMock.mockRejectedValueOnce(new Error('audit insert failed'));

    const result = await runRemovedDevicePurgeOnce();

    // The delete already committed; nothing after it may throw the run away.
    expect(result.purged).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('purges each device in its OWN transaction so one failure cannot roll back the others', async () => {
    rigQueries([ORG_A], [[device('dev-1'), device('dev-2'), device('dev-3')]]);
    getOrgPurgeRemovedAfterDaysMock.mockResolvedValue(30);

    await runRemovedDevicePurgeOnce();

    expect(dbTransactionMock).toHaveBeenCalledTimes(3);
  });
});

describe('purgeOneRemovedDevice', () => {
  it('is exported so a caller can prove the re-check independently of a whole sweep', () => {
    expect(purgeOneRemovedDevice).toBeTypeOf('function');
  });

  it('reports ORG_CHANGED without touching the device when the locked row names another org', async () => {
    rigQueries([], []);
    scriptedDevices.set('dev-1', device('dev-1', { orgId: ORG_B }));

    const outcome = await purgeOneRemovedDevice({
      deviceId: 'dev-1',
      orgId: ORG_A,
      cutoff: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(outcome).toBe('ORG_CHANGED');
    expect(purgeRemovedDeviceMock).not.toHaveBeenCalled();
  });

  it('reports NO_LONGER_ELIGIBLE when the locked stamp is no longer past the cutoff', async () => {
    rigQueries([], []);
    scriptedDevices.set(
      'dev-1',
      device('dev-1', { decommissionedAt: new Date('2026-06-02T00:00:00.000Z') }),
    );

    const outcome = await purgeOneRemovedDevice({
      deviceId: 'dev-1',
      orgId: ORG_A,
      cutoff: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(outcome).toBe('NO_LONGER_ELIGIBLE');
    expect(purgeRemovedDeviceMock).not.toHaveBeenCalled();
  });

  it('purges when the locked row still satisfies both facts that made it eligible', async () => {
    rigQueries([], []);
    scriptedDevices.set('dev-1', device('dev-1'));

    const outcome = await purgeOneRemovedDevice({
      deviceId: 'dev-1',
      orgId: ORG_A,
      cutoff: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(outcome).toBeNull();
    expect(purgeRemovedDeviceMock).toHaveBeenCalledTimes(1);
  });
});

describe('removedDevicePurge worker registration', () => {
  it('registers on an allocated cron slot, not an epoch-aligned every:', async () => {
    await initializeRemovedDevicePurge();

    expect(addMock).toHaveBeenCalledTimes(1);
    const options = addMock.mock.calls[0]![2] as { repeat?: { pattern?: string; every?: number } };
    expect(options.repeat?.pattern).toBe(jobSchedule('removed-device-purge'));
    expect(options.repeat?.every).toBeUndefined();
    await shutdownRemovedDevicePurge();
  });

  it('the registered Worker actually runs the sweep — the queue is not wired to a no-op', async () => {
    rigQueries([], []);
    await initializeRemovedDevicePurge();

    expect(capturedWorkerProcessor.current).toBeTypeOf('function');
    const result = (await capturedWorkerProcessor.current!({ data: {} })) as { orgsChecked: number };
    expect(result.orgsChecked).toBe(0);
    expect(dbSelectMock).toHaveBeenCalled();
    await shutdownRemovedDevicePurge();
  });

  it('clears stale repeatable entries before registering, so a changed cadence does not double-run', async () => {
    getRepeatableJobsMock.mockResolvedValueOnce([{ key: 'stale-key' }] as never);

    await initializeRemovedDevicePurge();

    expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('stale-key');
    await shutdownRemovedDevicePurge();
  });
});
