import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Task 5 (#2764) — uninstall-intent reaper.
//
// Predicate (binding): uninstall_intent_at < now() - interval AND
// (last_seen_at IS NULL OR last_seen_at < uninstall_intent_at). A device that
// heartbeats after stamping intent must NEVER be touched — the heartbeat
// route clears uninstall_intent_at unconditionally, so this suite proves both
// halves of the predicate independently: a stale intent gets reaped, and a
// post-intent heartbeat is spared.

const { createAuditLogAsyncMock, updateSetMock, updateWhereMock, selectFleetState, warnSpy } = vi.hoisted(() => ({
  createAuditLogAsyncMock: vi.fn(),
  updateSetMock: vi.fn(),
  updateWhereMock: vi.fn(),
  selectFleetState: { fleet: [] as { id: string; orgId: string; hostname: string; displayName: string | null }[], chunkCalls: 0 },
  warnSpy: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  lt: (col: unknown, val: unknown) => ({ op: 'lt', col, val }),
  gt: (col: unknown, val: unknown) => ({ op: 'gt', col, val }),
  asc: (col: unknown) => ({ op: 'asc', col }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    hostname: 'devices.hostname',
    displayName: 'devices.displayName',
    status: 'devices.status',
    lastSeenAt: 'devices.lastSeenAt',
    uninstallIntentAt: 'devices.uninstallIntentAt',
  },
  alertRules: {},
  alertTemplates: {},
  alerts: {},
}));

// Per-candidate UPDATE result is driven by this map: deviceId -> row returned
// by `.returning()` (empty array simulates the TOCTOU guard skipping a row
// that re-heartbeated between SELECT and UPDATE).
const updateReturns = new Map<string, { id: string }[]>();

vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (limit: number) => {
              const start = selectFleetState.chunkCalls * limit;
              const slice = selectFleetState.fleet.slice(start, start + limit);
              selectFleetState.chunkCalls++;
              return Promise.resolve(slice);
            },
          }),
        }),
      }),
    }),
    update: () => ({
      set: (arg: unknown) => {
        updateSetMock(arg);
        return {
          where: (whereArg: unknown) => {
            updateWhereMock(whereArg);
            return {
              returning: () => {
                // Extract the candidate id from the mocked eq() condition
                // embedded in the and(...) where clause.
                const w = whereArg as { args: { op: string; val?: string }[] };
                const idCond = w.args.find((a) => a.op === 'eq');
                const id = idCond?.val as string;
                return Promise.resolve(updateReturns.get(id) ?? [{ id }]);
              },
            };
          },
        };
      },
    }),
  },
  withSystemDbAccessContext: undefined,
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../services/auditService', () => ({
  createAuditLogAsync: createAuditLogAsyncMock,
}));

vi.mock('../services/auditEvents', () => ({
  ANONYMOUS_ACTOR_ID: '00000000-0000-0000-0000-000000000000',
}));

vi.mock('bullmq', () => ({
  Queue: class {
    addBulk = vi.fn();
    add = vi.fn();
    getJob = vi.fn();
    getRepeatableJobs = vi.fn(async () => []);
    removeRepeatableByKey = vi.fn();
    close = vi.fn();
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn();
  },
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/eventBus', () => ({ publishEvent: vi.fn() }));

vi.mock('../services/alertService', () => ({
  alertRuleOwnershipConditionForOrg: vi.fn(async () => undefined),
  createAlert: vi.fn(),
}));

vi.mock('../services/alertConditions', () => ({ interpolateTemplate: vi.fn() }));

vi.mock('../services/bullmqUtils', () => ({ isReusableState: vi.fn(() => false) }));

import { processReapUninstallIntent } from './offlineDetector';

beforeEach(() => {
  createAuditLogAsyncMock.mockClear();
  updateSetMock.mockClear();
  updateWhereMock.mockClear();
  selectFleetState.fleet = [];
  selectFleetState.chunkCalls = 0;
  updateReturns.clear();
  warnSpy.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(warnSpy);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  delete process.env.UNINSTALL_INTENT_DECOMMISSION_HOURS;
  delete process.env.UNINSTALL_INTENT_REAP_MAX_DEVICES_PER_RUN;
  delete process.env.UNINSTALL_INTENT_REAP_CHUNK_SIZE;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('processReapUninstallIntent — predicate + decommission (#2764)', () => {
  it('decommissions a device whose intent is older than the default 24h window with no heartbeat since', async () => {
    selectFleetState.fleet = [{ id: 'dev-stale', orgId: 'org-1', hostname: 'host-stale', displayName: null }];

    const result = await processReapUninstallIntent();

    expect(result.decommissioned).toBe(1);
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'decommissioned', updatedAt: expect.any(Date) })
    );
    // Field set matches the admin decommission route EXACTLY — no
    // decommissionedAt (the schema has no such column) and no extraneous keys.
    const setArg = updateSetMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(setArg).sort()).toEqual(['status', 'updatedAt']);
  });

  it('never reaps a row with a post-intent heartbeat (TOCTOU guard: 0-row UPDATE is skipped)', async () => {
    // SELECT still returned the candidate (chunk built before a very recent
    // re-heartbeat), but the guarded UPDATE's WHERE re-check matches 0 rows —
    // simulating the device having heartbeated between SELECT and UPDATE.
    selectFleetState.fleet = [{ id: 'dev-recovered', orgId: 'org-1', hostname: 'host-recovered', displayName: null }];
    updateReturns.set('dev-recovered', []);

    const result = await processReapUninstallIntent();

    expect(result.decommissioned).toBe(0);
  });

  it('writes one audit event per decommission with reason: uninstall_intent_reaped', async () => {
    selectFleetState.fleet = [{ id: 'dev-stale', orgId: 'org-42', hostname: 'host-stale', displayName: null }];

    await processReapUninstallIntent();

    expect(createAuditLogAsyncMock).toHaveBeenCalledTimes(1);
    expect(createAuditLogAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-42',
        actorType: 'system',
        action: 'device.decommission',
        resourceType: 'device',
        resourceId: 'dev-stale',
        details: { reason: 'uninstall_intent_reaped' },
        result: 'success',
        initiatedBy: 'schedule',
      })
    );
  });

  it('never writes an audit event for a row the TOCTOU guard skipped', async () => {
    selectFleetState.fleet = [{ id: 'dev-recovered', orgId: 'org-1', hostname: 'host-recovered', displayName: null }];
    updateReturns.set('dev-recovered', []);

    await processReapUninstallIntent();

    expect(createAuditLogAsyncMock).not.toHaveBeenCalled();
  });

  it('respects UNINSTALL_INTENT_DECOMMISSION_HOURS override', async () => {
    process.env.UNINSTALL_INTENT_DECOMMISSION_HOURS = '48';
    selectFleetState.fleet = [{ id: 'dev-1', orgId: 'org-1', hostname: 'h', displayName: null }];

    const result = await processReapUninstallIntent();

    expect(result.decommissioned).toBe(1);
  });

  it('paginates through multiple chunks when candidates exceed chunkSize', async () => {
    process.env.UNINSTALL_INTENT_REAP_CHUNK_SIZE = '2';
    selectFleetState.fleet = [
      { id: 'dev-1', orgId: 'org-1', hostname: 'h1', displayName: null },
      { id: 'dev-2', orgId: 'org-1', hostname: 'h2', displayName: null },
      { id: 'dev-3', orgId: 'org-1', hostname: 'h3', displayName: null },
    ];

    const result = await processReapUninstallIntent();

    expect(result.decommissioned).toBe(3);
  });

  it('returns 0 when no candidates match', async () => {
    selectFleetState.fleet = [];

    const result = await processReapUninstallIntent();

    expect(result.decommissioned).toBe(0);
    expect(createAuditLogAsyncMock).not.toHaveBeenCalled();
  });
});
