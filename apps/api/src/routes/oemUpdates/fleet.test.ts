import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import { OEM_DISPLAY_STATES, type OemDisplayState } from '../../services/oemUpdates/displayState';

// #11242: the fleet route's orchestration, scoping and SQL shape over a mocked db.
// The state rule is SQL now (oemDisplayStateSql) and is checked against Postgres in
// __tests__/integration/oemDisplayStateSql.integration.test.ts (parity matrix) and
// oemUpdatesFleet.integration.test.ts (real RLS, real plan).

type SummaryRow = Record<string, unknown>;

const h = vi.hoisted(() => ({
  auth: {
    scope: 'partner' as string,
    orgId: null as string | null,
    partnerId: 'partner-1' as string | null,
    accessibleOrgIds: ['org-1', 'org-2'] as string[] | null,
  },
  allowedSiteIds: undefined as string[] | undefined,
  /** One entry per db.execute call; the last one repeats once the queue runs out. */
  summaries: [] as Array<() => unknown[]>,
  pageRows: [] as Array<Record<string, unknown>>,
  pendingIds: [] as Array<{ id: string }>,
  selects: [] as Array<Record<string, unknown>>,
  wheres: [] as unknown[],
  joins: [] as Array<{ kind: string; table: unknown; condition: unknown }>,
  executed: [] as unknown[],
  refresh: vi.fn(),
  schedule: vi.fn(),
}));

vi.mock('../../db', () => {
  const chain = (rows: () => unknown[]) => {
    const c: Record<string, unknown> = {
      from: () => c,
      leftJoin: (table: unknown, condition: unknown) => { h.joins.push({ kind: 'left', table, condition }); return c; },
      innerJoin: (table: unknown, condition: unknown) => { h.joins.push({ kind: 'inner', table, condition }); return c; },
      where: (condition: unknown) => { h.wheres.push(condition); return c; },
      orderBy: () => c,
      limit: () => Promise.resolve(rows()),
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows()).then(resolve),
    };
    return c;
  };
  return {
    db: {
      execute: vi.fn(async (statement: unknown) => {
        h.executed.push(statement);
        const next = h.summaries.length > 1 ? h.summaries.shift()! : h.summaries[0]!;
        return next();
      }),
      select: vi.fn((shape: Record<string, unknown>) => {
        h.selects.push(shape);
        return chain(() => ('hostname' in shape ? [...h.pageRows] : h.pendingIds));
      }),
    },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: vi.fn((c: any, next: any) => {
      c.set('auth', {
        user: { id: 'user-1' },
        scope: h.auth.scope,
        orgId: h.auth.orgId,
        partnerId: h.auth.partnerId,
        accessibleOrgIds: h.auth.accessibleOrgIds,
        canAccessOrg: (orgId: string) => h.auth.accessibleOrgIds === null || h.auth.accessibleOrgIds.includes(orgId),
        orgCondition: actual.buildOrgAccessClosures(h.auth.accessibleOrgIds).orgCondition,
      });
      return next();
    }),
    requireScope: vi.fn(() => async (_c: any, next: any) => next()),
    requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
      if (c.req.header('x-deny-permission') === `${resource}:${action}`) {
        return c.json({ error: 'Permission denied' }, 403);
      }
      c.set('permissions', {
        permissions: [{ resource, action }],
        ...(h.allowedSiteIds ? { allowedSiteIds: h.allowedSiteIds } : {}),
      });
      return next();
    }),
  };
});

vi.mock('../../services/oemUpdates/policySideStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/oemUpdates/policySideStore')>()),
  refreshOemPolicySide: h.refresh,
}));

vi.mock('../../services/oemUpdates/policySideRefreshTrigger', () => ({
  scheduleOemPolicySideRefresh: h.schedule,
}));

vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));

import { oemGatesFingerprint } from '../../services/oemUpdates/policySideStore';
import { oemUpdatesFleetRoutes } from './fleet';
import { db } from '../../db';

const NOW = new Date('2027-03-01T12:00:00.000Z');
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');
const ORG = '44444444-4444-4444-8444-444444444444';

function countRows(counts: Partial<Record<OemDisplayState, number>> = {}, pending = 0): SummaryRow[] {
  return OEM_DISPLAY_STATES.map((name, index) => ({
    state: name,
    count: counts[name] ?? 0,
    // Pending is a total across the scope; one state row carries all of it.
    pending: index === 0 ? pending : 0,
    device_id: null,
    position: null,
  }));
}

function pageIdRows(ids: string[]): SummaryRow[] {
  return ids.map((id, index) => ({ state: null, count: null, pending: null, device_id: id, position: String(index + 1) }));
}

function summary(options: { counts?: Partial<Record<OemDisplayState, number>>; pending?: number; ids?: string[] } = {}): () => unknown[] {
  return () => [...countRows(options.counts, options.pending ?? 0), ...pageIdRows(options.ids ?? [])];
}

function pageRow(deviceId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deviceId,
    hostname: `host-${deviceId}`,
    orgId: 'org-1',
    orgName: 'Org One',
    siteId: 'site-1',
    siteName: 'Site One',
    deviceStatus: 'online',
    lane: 'dell',
    displayState: 'up_to_date',
    lastOutcome: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    rebootPendingSince: null,
    reason: null,
    ...overrides,
  };
}

function app(): Hono {
  const root = new Hono();
  root.route('/oem-updates', oemUpdatesFleetRoutes);
  return root;
}

async function getFleet(query = ''): Promise<{ status: number; body: any }> {
  const response = await app().request(`/oem-updates/fleet${query}`);
  return { status: response.status, body: await response.json() };
}

const render = (statement: unknown) => new PgDialect().sqlToQuery(statement as never);

/** Statement 1 as Postgres would receive it. The scope condition lives inside it. */
function statementOne(call = 0): { sql: string; params: unknown[] } {
  expect(h.executed.length).toBeGreaterThan(call);
  return render(h.executed[call]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
  h.auth = { scope: 'partner', orgId: null, partnerId: 'partner-1', accessibleOrgIds: ['org-1', 'org-2'] };
  h.allowedSiteIds = undefined;
  h.summaries = [summary()];
  h.pageRows = [];
  h.pendingIds = [];
  h.selects = [];
  h.wheres = [];
  h.joins = [];
  h.executed = [];
  h.refresh.mockReset();
  h.refresh.mockResolvedValue({ upserted: 0, pages: 1, failedPages: 0 });
  h.schedule.mockReset();
  vi.mocked(db.execute).mockClear();
  vi.mocked(db.select).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('GET /oem-updates/fleet: who can read what', () => {
  it('needs devices:read', async () => {
    const response = await app().request('/oem-updates/fleet', { headers: { 'x-deny-permission': 'devices:read' } });
    expect(response.status).toBe(403);
    expect(db.execute).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('scopes a partner caller to its orgs', async () => {
    await getFleet();
    expect(statementOne().params).toEqual(expect.arrayContaining(['org-1', 'org-2']));
  });

  it('scopes an org caller to its own org', async () => {
    h.auth = { scope: 'organization', orgId: 'org-1', partnerId: null, accessibleOrgIds: ['org-1'] };
    await getFleet();
    const { params } = statementOne();
    expect(params).toContain('org-1');
    expect(params).not.toContain('org-2');
  });

  it('refuses an org the caller cannot reach', async () => {
    const { status } = await getFleet('?orgId=33333333-3333-4333-8333-333333333333');
    expect(status).toBe(403);
    expect(db.execute).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('asks a system caller to name an org rather than walk the whole platform', async () => {
    h.auth = { scope: 'system', orgId: null, partnerId: null, accessibleOrgIds: null };
    const { status } = await getFleet();
    expect(status).toBe(400);
    expect(db.execute).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('keeps a site-restricted caller to their sites', async () => {
    h.allowedSiteIds = ['site-1'];
    await getFleet();
    const { sql, params } = statementOne();
    expect(params).toContain('site-1');
    expect(sql).toContain('"site_id" in');
  });

  it('shows a caller restricted to no sites nothing', async () => {
    h.allowedSiteIds = [];
    await getFleet();
    expect(statementOne().sql).toMatch(/\band false\b/);
  });

  it('leaves out ephemeral, parked and decommissioned devices', async () => {
    await getFleet();
    const { sql, params } = statementOne();
    expect(sql).toContain('"is_ephemeral"');
    expect(sql).toContain('NOT IN (SELECT holding_org.id');
    expect(sql).toContain('"status" <>');
    expect(params).toEqual(expect.arrayContaining([false, 'unassigned_pool', 'decommissioned']));
  });
});

describe('GET /oem-updates/fleet: filters and paging', () => {
  it('rejects a state, lane or page outside the vocabulary', async () => {
    expect((await getFleet('?state=broken')).status).toBe(400);
    expect((await getFleet('?lane=acer')).status).toBe(400);
    expect((await getFleet('?limit=0')).status).toBe(400);
    expect((await getFleet('?limit=201')).status).toBe(400);
    expect((await getFleet('?offset=-1')).status).toBe(400);
    expect((await getFleet('?orgId=nope')).status).toBe(400);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('orgId narrows the query', async () => {
    // Reachable among others, so only the filter itself can narrow to it.
    h.auth.accessibleOrgIds = [ORG, 'org-2'];
    await getFleet(`?orgId=${ORG}`);
    const { sql, params } = statementOne();
    expect(sql).toContain('"devices"."org_id" = ');
    expect(params.filter((param) => param === ORG)).toHaveLength(2);
  });

  it('total is the selected state\'s count, or the sum without a state', async () => {
    h.summaries = [summary({ counts: { up_to_date: 5, overdue: 3, failing: 2 } })];

    const all = await getFleet();
    expect(all.body.total).toBe(10);

    const overdue = await getFleet('?state=overdue');
    expect(overdue.body.total).toBe(3);
    expect(overdue.body.counts).toEqual(all.body.counts);
  });

  it('state and lane filters reach statement 1, and counts still cover every state', async () => {
    const counts = { up_to_date: 4, overdue: 2, failing: 1, not_managed: 6 };
    h.summaries = [summary({ counts, ids: ['d-1', 'd-2'] })];
    h.pageRows = [pageRow('d-1'), pageRow('d-2')];

    const { status, body } = await getFleet('?state=overdue&lane=hp&limit=25&offset=50');

    expect(status).toBe(200);
    const { sql, params } = statementOne();
    expect(sql).toContain('fleet.state = $');
    expect(sql).toContain('fleet.lane = $');
    expect(params).toEqual(expect.arrayContaining(['overdue', 'hp', 25, 50]));
    expect(body.counts).toEqual({
      up_to_date: 4, overdue: 2, failing: 1, not_supported: 0, not_managed: 6, waiting_for_reboot: 0, reboot_overdue: 0,
    });
    expect(body.total).toBe(2);
    expect(body.devices).toHaveLength(2);
  });

  it('without a state or lane statement 1 filters on neither', async () => {
    await getFleet();
    const { sql, params } = statementOne();
    expect(sql).not.toContain('fleet.state = $');
    expect(sql).not.toContain('fleet.lane = $');
    expect(params).toEqual(expect.arrayContaining([50, 0]));
  });

  it('the page keeps statement 1\'s hostname order', async () => {
    h.summaries = [() => [
      ...countRows({ up_to_date: 3 }),
      // Rows of the union arrive in any order; `position` is the hostname order.
      { state: null, count: null, pending: null, device_id: 'd-c', position: '3' },
      { state: null, count: null, pending: null, device_id: 'd-a', position: '1' },
      { state: null, count: null, pending: null, device_id: 'd-b', position: '2' },
    ]];
    h.pageRows = [pageRow('d-b'), pageRow('d-c'), pageRow('d-a')];

    const { body } = await getFleet();

    expect(body.devices.map((device: any) => device.deviceId)).toEqual(['d-a', 'd-b', 'd-c']);
  });

  it('an empty page issues one statement', async () => {
    h.summaries = [summary({ counts: { up_to_date: 3 } })];

    const { status, body } = await getFleet('?offset=100');

    expect(status).toBe(200);
    expect(body.devices).toEqual([]);
    expect(body.total).toBe(3);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('the page statement is bounded to the ids statement 1 chose', async () => {
    h.summaries = [summary({ counts: { up_to_date: 2 }, ids: ['d-1', 'd-2'] })];
    h.pageRows = [pageRow('d-1'), pageRow('d-2')];

    await getFleet();

    expect(h.wheres).toHaveLength(1);
    const where = render(h.wheres[0]);
    expect(where.sql).toContain('"devices"."id" in');
    expect(where.params).toEqual(['d-1', 'd-2']);
  });

  it('a row carries what the view shows and no more', async () => {
    h.summaries = [summary({ counts: { failing: 1 }, ids: ['device-1'] })];
    h.pageRows = [pageRow('device-1', {
      lane: 'dell',
      displayState: 'failing',
      lastOutcome: 'failed',
      lastAttemptAt: LONG_AGO,
      reason: 'release_gave_up',
      // Columns the view must not leak even if a row carried them.
      partnerId: 'partner-1',
      osType: 'windows',
    })];

    const { body } = await getFleet();

    expect(body.devices[0]).toEqual({
      deviceId: 'device-1',
      hostname: 'host-device-1',
      orgId: 'org-1',
      orgName: 'Org One',
      siteId: 'site-1',
      siteName: 'Site One',
      deviceStatus: 'online',
      lane: 'dell',
      displayState: 'failing',
      lastOutcome: 'failed',
      lastAttemptAt: LONG_AGO.toISOString(),
      lastSuccessAt: null,
      rebootPendingSince: null,
      scheduleNotHandedBack: true,
    });
  });
});

describe('GET /oem-updates/fleet: statements per request', () => {
  it('issues exactly two statements whatever the scope size when nothing is pending', async () => {
    const ids = Array.from({ length: 50 }, (_, index) => `d-${String(index).padStart(3, '0')}`);
    h.summaries = [summary({ counts: { up_to_date: 6000, overdue: 3000, failing: 1000 }, ids })];
    h.pageRows = ids.map((id) => pageRow(id));

    const { status, body } = await getFleet('?limit=50');

    expect(status).toBe(200);
    expect(body.total).toBe(10_000);
    expect(body.devices).toHaveLength(50);
    expect(body).not.toHaveProperty('pendingRefresh');
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.select).toHaveBeenCalledTimes(1);
    expect('hostname' in h.selects[0]!).toBe(true);
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.schedule).not.toHaveBeenCalled();
  });
});

describe('GET /oem-updates/fleet: the policy side', () => {
  it('flag off leaves the policy side out of the join and never refreshes', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    h.summaries = [summary({ counts: { not_managed: 4 }, pending: 4, ids: ['d-1'] })];
    h.pageRows = [pageRow('d-1', { displayState: 'not_managed', lane: null })];

    const { status, body } = await getFleet();

    expect(status).toBe(200);
    expect(body).not.toHaveProperty('pendingRefresh');
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.schedule).not.toHaveBeenCalled();
    expect(db.execute).toHaveBeenCalledTimes(1);

    const one = statementOne();
    expect(one.sql).toMatch(/left join "device_oem_policy_side" on \("device_oem_policy_side"\."device_id" = "devices"\."id" and false\)/i);
    expect(one.sql).not.toContain('gates_fingerprint');

    // The page statement joins it the same way.
    const pageJoin = h.joins
      .map((join) => render(join.condition))
      .find((rendered) => rendered.sql.includes('device_oem_policy_side'));
    expect(pageJoin).toBeDefined();
    expect(pageJoin!.sql).toContain('false');
    expect(pageJoin!.sql).not.toContain('gates_fingerprint');
  });

  it('a few pending devices are refreshed in-request and then counted', async () => {
    h.summaries = [
      summary({ counts: { not_managed: 3 }, pending: 3, ids: ['d-1'] }),
      summary({ counts: { up_to_date: 3 }, pending: 0, ids: ['d-1'] }),
    ];
    h.pendingIds = [{ id: 'p-1' }, { id: 'p-2' }, { id: 'p-3' }];
    h.pageRows = [pageRow('d-1')];

    const { status, body } = await getFleet();

    expect(status).toBe(200);
    // The pending-id select is the one without a hostname; the page is the other.
    expect(db.select).toHaveBeenCalledTimes(2);
    expect(Object.keys(h.selects[0]!)).toEqual(['id']);
    expect('hostname' in h.selects[1]!).toBe(true);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledWith({ now: NOW, scope: { deviceIds: ['p-1', 'p-2', 'p-3'] }, source: 'fleet-request' });
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(h.schedule).not.toHaveBeenCalled();
    expect(body).not.toHaveProperty('pendingRefresh');
    // Counted after the refresh, not before.
    expect(body.counts.up_to_date).toBe(3);
    expect(body.counts.not_managed).toBe(0);
  });

  it('refreshes at the limit and enqueues one past it', async () => {
    h.summaries = [summary({ counts: { not_managed: 500 }, pending: 500 }), summary({ counts: { up_to_date: 500 } })];
    await getFleet();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.schedule).not.toHaveBeenCalled();

    h.refresh.mockReset();
    h.refresh.mockResolvedValue({ upserted: 0, pages: 1, failedPages: 0 });
    h.summaries = [summary({ counts: { not_managed: 501 }, pending: 501 })];
    const { body } = await getFleet();
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.schedule).toHaveBeenCalledTimes(1);
    expect(body.pendingRefresh).toBe(501);
  });

  it('more than 500 pending enqueues a scope refresh and returns pendingRefresh', async () => {
    h.summaries = [summary({ counts: { not_managed: 900 }, pending: 900 })];

    // Partner caller, no org named: the whole partner.
    let result = await getFleet();
    expect(h.schedule).toHaveBeenLastCalledWith({ partnerId: 'partner-1' }, 'fleet-pending');
    expect(result.body.pendingRefresh).toBe(900);

    // An org named in the query narrows the refresh to it.
    h.auth.accessibleOrgIds = [ORG, 'org-2'];
    result = await getFleet(`?orgId=${ORG}`);
    expect(h.schedule).toHaveBeenLastCalledWith({ orgId: ORG }, 'fleet-pending');
    expect(result.body.pendingRefresh).toBe(900);

    // An org caller refreshes its own org.
    h.auth = { scope: 'organization', orgId: 'org-1', partnerId: null, accessibleOrgIds: ['org-1'] };
    result = await getFleet();
    expect(h.schedule).toHaveBeenLastCalledWith({ orgId: 'org-1' }, 'fleet-pending');
    expect(result.body.pendingRefresh).toBe(900);

    expect(h.schedule).toHaveBeenCalledTimes(3);
    expect(h.refresh).not.toHaveBeenCalled();
    // Counted from the one statement: no pending-id select, no second pass.
    expect(db.select).not.toHaveBeenCalled();
    expect(db.execute).toHaveBeenCalledTimes(3);
  });

  it('a refresh that leaves devices pending reports them', async () => {
    h.summaries = [
      summary({ counts: { not_managed: 2 }, pending: 2 }),
      summary({ counts: { not_managed: 2 }, pending: 2 }),
    ];
    h.pendingIds = [{ id: 'p-1' }, { id: 'p-2' }];

    const { body } = await getFleet();

    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(body.pendingRefresh).toBe(2);
    // One refresh per request: a device that stays pending does not loop it.
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it('devices the in-request refresh failed on go to the worker', async () => {
    h.summaries = [
      summary({ counts: { not_managed: 2 }, pending: 2 }),
      summary({ counts: { not_managed: 2 }, pending: 2 }),
    ];
    h.pendingIds = [{ id: 'p-1' }, { id: 'p-2' }];
    h.refresh.mockResolvedValue({ upserted: 0, pages: 1, failedPages: 1 });

    const { body } = await getFleet();

    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.refresh).mock.calls[0]![0]).toMatchObject({ source: 'fleet-request' });
    expect(h.schedule).toHaveBeenCalledWith({ partnerId: 'partner-1' }, 'fleet-pending');
    expect(body.pendingRefresh).toBe(2);
  });

  it('a failed refresh that still left nothing pending asks the worker for nothing', async () => {
    h.summaries = [
      summary({ counts: { not_managed: 2 }, pending: 2 }),
      summary({ counts: { up_to_date: 2 }, pending: 0 }),
    ];
    h.pendingIds = [{ id: 'p-1' }, { id: 'p-2' }];
    h.refresh.mockResolvedValue({ upserted: 2, pages: 2, failedPages: 1 });

    const { body } = await getFleet();

    expect(h.schedule).not.toHaveBeenCalled();
    expect(body.pendingRefresh).toBeUndefined();
  });

  it('a row with a stale gates fingerprint counts as pending', async () => {
    await getFleet();

    const one = statementOne();
    // Only a row computed under this process's gates and not past its rollover joins;
    // every other row has no policy side in the statement, so it is counted pending.
    const join = /left join "device_oem_policy_side" on \("device_oem_policy_side"\."device_id" = "devices"\."id" and \("device_oem_policy_side"\."gates_fingerprint" = \$(\d+) and \("device_oem_policy_side"\."refresh_after" is null or "device_oem_policy_side"\."refresh_after" > \$(\d+)\)\)\)/i.exec(one.sql);
    expect(join).not.toBeNull();
    // The fingerprint is this process's, and the rollover is compared to the request's clock.
    expect(one.params[Number(join![1]) - 1]).toBe(oemGatesFingerprint());
    expect(new Date(one.params[Number(join![2]) - 1] as string)).toEqual(NOW);
    expect(one.sql).toContain('"device_oem_policy_side"."device_id" IS NULL AS pending');
  });
});
