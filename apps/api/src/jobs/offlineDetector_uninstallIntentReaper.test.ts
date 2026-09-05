import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Task 5 (#2764) — uninstall-intent reaper.
//
// Predicate (binding): uninstall_intent_at < now() - interval AND
// (last_seen_at IS NULL OR last_seen_at < uninstall_intent_at). A device that
// heartbeats after stamping intent must NEVER be touched — the heartbeat
// route clears uninstall_intent_at unconditionally, so this suite proves both
// halves of the predicate independently: a stale intent gets reaped, and a
// post-intent heartbeat is spared.

interface FleetDevice {
  id: string;
  orgId: string;
  hostname: string;
  displayName: string | null;
  /** Defaults to 'online' when omitted — matches a live, non-terminal device. */
  status?: string;
}

const { createAuditLogAsyncMock, updateSetMock, updateWhereMock, selectFleetState, warnSpy } = vi.hoisted(() => ({
  createAuditLogAsyncMock: vi.fn(),
  updateSetMock: vi.fn(),
  updateWhereMock: vi.fn(),
  selectFleetState: { fleet: [] as { id: string; orgId: string; hostname: string; displayName: string | null; status?: string }[], chunkCalls: 0 },
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
  notInArray: (col: unknown, vals: unknown[]) => ({ op: 'notInArray', col, vals }),
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
    possibleReplacementOfDeviceId: 'devices.possibleReplacementOfDeviceId',
  },
  alertRules: {},
  alertTemplates: {},
  alerts: {},
}));

// Per-candidate UPDATE result is driven by this map: deviceId -> row returned
// by `.returning()` (empty array simulates the TOCTOU guard skipping a row
// that re-heartbeated between SELECT and UPDATE).
const updateReturns = new Map<string, { id: string }[]>();

/**
 * Walks a mocked and()/notInArray() condition tree to find the status
 * exclusion list, so the SELECT mock can apply it for real — proving the
 * status filter actually excludes already-terminal rows, not just asserting
 * on the WHERE shape.
 */
function findNotInArrayVals(condition: unknown, col: string): string[] | null {
  if (!condition || typeof condition !== 'object') return null;
  const c = condition as { op?: string; col?: unknown; vals?: unknown; args?: unknown[] };
  if (c.op === 'notInArray' && c.col === col) return c.vals as string[];
  if (c.op === 'and' && Array.isArray(c.args)) {
    for (const arg of c.args) {
      const found = findNotInArrayVals(arg, col);
      if (found) return found;
    }
  }
  return null;
}

vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => ({
          orderBy: () => ({
            limit: (limit: number) => {
              const excludedStatuses = findNotInArrayVals(condition, 'devices.status') ?? [];
              const eligible = selectFleetState.fleet.filter(
                (d) => !excludedStatuses.includes(d.status ?? 'online')
              );
              const start = selectFleetState.chunkCalls * limit;
              const slice = eligible.slice(start, start + limit);
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

vi.mock('../services/offlineEffectsStore', () => ({
  persistOfflineTransition: vi.fn(async () => ['effect-id']),
  findDueOfflineEffects: vi.fn(async () => []),
  pruneOfflineEffects: vi.fn(async () => 0),
}));
vi.mock('../services/offlineTransitionEffects', () => ({ processOfflineEffect: vi.fn() }));

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

  it('the guarded UPDATE WHERE clause carries the exact binding predicate (both halves) plus the status exclusion', async () => {
    const before = Date.now();
    selectFleetState.fleet = [{ id: 'dev-stale', orgId: 'org-1', hostname: 'host-stale', displayName: null }];

    await processReapUninstallIntent();
    const after = Date.now();

    const whereArg = updateWhereMock.mock.calls[0]![0] as { op: string; args: unknown[] };
    expect(whereArg.op).toBe('and');
    // eq(devices.id, candidate.id)
    expect(whereArg.args).toContainEqual({ op: 'eq', col: 'devices.id', val: 'dev-stale' });
    // lt(uninstall_intent_at, cutoff) — first half of the binding predicate.
    // Asserts the ACTUAL cutoff value, not just that some Date was passed —
    // catches the hours→ms math being wrong (e.g. minutes instead of hours,
    // or a hardcoded 24 that ignores the env override).
    const ltCond = whereArg.args.find(
      (a) => (a as { op: string; col: unknown }).op === 'lt' && (a as { col: unknown }).col === 'devices.uninstallIntentAt'
    ) as { val: Date } | undefined;
    expect(ltCond).toBeDefined();
    const expectedCutoffMs = 24 * 60 * 60 * 1000;
    expect(ltCond!.val.getTime()).toBeGreaterThanOrEqual(before - expectedCutoffMs - 1000);
    expect(ltCond!.val.getTime()).toBeLessThanOrEqual(after - expectedCutoffMs + 1000);
    // or(isNull(last_seen_at), lt(last_seen_at, uninstall_intent_at)) — second half.
    expect(whereArg.args).toContainEqual({
      op: 'or',
      args: [
        { op: 'isNull', col: 'devices.lastSeenAt' },
        { op: 'lt', col: 'devices.lastSeenAt', val: 'devices.uninstallIntentAt' },
      ],
    });
    // status exclusion — NOT part of the spec's binding predicate, but
    // required so an already-decommissioned row can't be re-reaped forever
    // (finding #1, review round).
    expect(whereArg.args).toContainEqual({
      op: 'notInArray',
      col: 'devices.status',
      vals: ['decommissioned', 'quarantined'],
    });
  });

  it('respects UNINSTALL_INTENT_DECOMMISSION_HOURS in the actual cutoff math (not hardcoded 24)', async () => {
    process.env.UNINSTALL_INTENT_DECOMMISSION_HOURS = '48';
    const before = Date.now();
    selectFleetState.fleet = [{ id: 'dev-1', orgId: 'org-1', hostname: 'h', displayName: null }];

    await processReapUninstallIntent();
    const after = Date.now();

    const whereArg = updateWhereMock.mock.calls[0]![0] as { op: string; args: unknown[] };
    const ltCond = whereArg.args.find(
      (a) => (a as { op: string; col: unknown }).op === 'lt' && (a as { col: unknown }).col === 'devices.uninstallIntentAt'
    ) as { val: Date } | undefined;
    expect(ltCond).toBeDefined();
    const expectedCutoffMs = 48 * 60 * 60 * 1000;
    expect(ltCond!.val.getTime()).toBeGreaterThanOrEqual(before - expectedCutoffMs - 1000);
    expect(ltCond!.val.getTime()).toBeLessThanOrEqual(after - expectedCutoffMs + 1000);
  });

  it('excludes an already-decommissioned row from the scan entirely (real filtering, not just WHERE shape) — never re-reaped/re-audited', async () => {
    selectFleetState.fleet = [
      { id: 'dev-already-gone', orgId: 'org-1', hostname: 'host-gone', displayName: null, status: 'decommissioned' },
    ];

    const result = await processReapUninstallIntent();

    expect(result.decommissioned).toBe(0);
    expect(updateSetMock).not.toHaveBeenCalled();
    expect(createAuditLogAsyncMock).not.toHaveBeenCalled();
  });

  it('excludes an already-quarantined row from the scan', async () => {
    selectFleetState.fleet = [
      { id: 'dev-quarantined', orgId: 'org-1', hostname: 'host-q', displayName: null, status: 'quarantined' },
    ];

    const result = await processReapUninstallIntent();

    expect(result.decommissioned).toBe(0);
    expect(updateSetMock).not.toHaveBeenCalled();
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

  // #2764: reaping the old device answers the "is this new device a
  // replacement for it?" question the web banner/badge asks, so the linkage on
  // the OTHER (newer) rows must be cleared or the prompt persists forever.
  describe('replacement-linkage resolution', () => {
    it('clears possible_replacement_of_device_id on rows pointing at each reaped device, scoped to its org', async () => {
      selectFleetState.fleet = [{ id: 'dev-stale', orgId: 'org-42', hostname: 'host-stale', displayName: null }];

      await processReapUninstallIntent();

      // Second write of the pair: status flip, then linkage clear.
      expect(updateSetMock).toHaveBeenCalledTimes(2);
      expect(updateSetMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ possibleReplacementOfDeviceId: null, updatedAt: expect.any(Date) })
      );

      const whereArg = updateWhereMock.mock.calls[1]![0] as { op: string; args: unknown[] };
      expect(whereArg.op).toBe('and');
      expect(whereArg.args).toContainEqual({
        op: 'eq',
        col: 'devices.possibleReplacementOfDeviceId',
        val: 'dev-stale',
      });
      // Same org scoping as the surrounding per-candidate writes.
      expect(whereArg.args).toContainEqual({ op: 'eq', col: 'devices.orgId', val: 'org-42' });
    });

    it('does not clear linkage for a row the TOCTOU guard skipped', async () => {
      selectFleetState.fleet = [{ id: 'dev-recovered', orgId: 'org-1', hostname: 'host-recovered', displayName: null }];
      updateReturns.set('dev-recovered', []);

      await processReapUninstallIntent();

      // Only the (0-row) status-flip attempt ran; no linkage write followed.
      expect(updateSetMock).toHaveBeenCalledTimes(1);
      expect(updateSetMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ possibleReplacementOfDeviceId: null })
      );
    });
  });
});
