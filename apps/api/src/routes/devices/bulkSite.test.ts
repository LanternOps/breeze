import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * POST /devices/bulk/site (#9796; spec §4.4, plan Wave D2). Exercises the REAL route, the REAL
 * authorization chokepoints (getDeviceWithOrgAndSiteCheck / getDevicesWithOrgAndSiteCheck), the
 * REAL shared move service (services/deviceSiteMove.ts), the REAL runBulkIsolated loop and the
 * REAL requireScope / requireMfa gates, over a small stateful fake database whose per-item
 * "transactions" run their after-commit hooks only when the item's callback returns.
 * The real-Postgres version (RLS, real MFA claim, real rollbacks) is
 * __tests__/integration/deviceBulkSiteMove.integration.test.ts.
 */

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SITE_A1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const SITE_A2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
const SITE_A3 = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
const SITE_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const DEV_1 = '11111111-1111-4111-8111-111111111111';
const DEV_2 = '22222222-2222-4222-8222-222222222222';
const DEV_3 = '33333333-3333-4333-8333-333333333333';
const DEV_B = '44444444-4444-4444-8444-444444444444';
const UNKNOWN = '55555555-5555-4555-8555-555555555555';

const state = vi.hoisted(() => ({
  devices: new Map<string, Record<string, unknown>>(),
  sites: new Map<string, { id: string; orgId: string; name: string }>(),
  hookStack: [] as Array<Array<() => unknown>>,
  contexts: [] as unknown[],
  commits: 0,
  reevaluated: [] as string[],
  rewrites: [] as string[],
  failRewriteFor: null as string | null,
  failCommitFor: null as string | null,
  /** Simulates a concurrent move: the row lock re-read sees this site instead. */
  concurrentMove: null as { deviceId: string; siteId: string } | null,
  auth: {} as Record<string, unknown>,
  allowedSiteIds: undefined as string[] | undefined,
  denyWrite: false,
  selectedTables: [] as unknown[],
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (ctx: unknown, fn: () => Promise<unknown>) => {
    state.contexts.push(ctx);
    const hooks: Array<() => unknown> = [];
    state.hookStack.push(hooks);
    let result: unknown;
    try {
      result = await fn();
    } finally {
      state.hookStack.pop();
    }
    // Simulates a COMMIT that fails after the item's callback returned (e.g. a deferred constraint).
    if (state.failCommitFor && (result as { id?: string } | undefined)?.id === state.failCommitFor) {
      throw new Error('commit failed: deferred constraint');
    }
    state.commits++;
    for (const hook of hooks) await hook();
    return result;
  }),
  runAfterDbContextCommit: vi.fn((_label: string, work: () => unknown) => {
    const hooks = state.hookStack.at(-1);
    if (hooks) hooks.push(work);
    else void work();
  }),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), execute: vi.fn(), transaction: vi.fn(), update: vi.fn(), insert: vi.fn(), delete: vi.fn() },
}));

vi.mock('../auth/schemas', async (original) => ({ ...await original<object>(), ENABLE_2FA: true }));

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: vi.fn((c: any, next: any) => {
      c.set('auth', state.auth);
      return next();
    }),
    requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
      if (state.denyWrite) return c.json({ error: 'Permission denied' }, 403);
      c.set('permissions', {
        permissions: [{ resource, action }], partnerId: null, orgId: ORG_A, roleId: 'r', scope: state.auth.scope,
        ...(state.allowedSiteIds ? { allowedSiteIds: state.allowedSiteIds } : {}),
      });
      return next();
    }),
  };
});

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../jobs/peripheralJobs', () => ({ schedulePeripheralPolicyDevice: vi.fn().mockResolvedValue('job') }));
vi.mock('../../jobs/deviceGroupJobs', async () => {
  const dbModule = await import('../../db');
  return {
    requestDeviceGroupReevaluationAfterCommit: vi.fn((request: { deviceId: string; reason: string }) => {
      dbModule.runAfterDbContextCommit(`deviceGroupReevaluation.${request.reason}`, () => { state.reevaluated.push(request.deviceId); });
    }),
  };
});
vi.mock('../../services/customFields/queries', () => ({ persistDeviceCustomFieldValues: vi.fn() }));
vi.mock('./core', () => ({
  rewriteDeviceSiteDenormalizedTables: vi.fn(async (_tx: unknown, deviceId: string) => {
    if (state.failRewriteFor === deviceId) throw new Error('deadlock detected');
    state.rewrites.push(deviceId);
  }),
}));

import { db } from '../../db';
import { devices as devicesTable, sites as sitesTable } from '../../db/schema';
import { writeRouteAudit } from '../../services/auditEvents';
import { schedulePeripheralPolicyDevice } from '../../jobs/peripheralJobs';
import { bulkSiteRoutes } from './bulkSite';
import { BULK_SITE_MOVE_CAP } from './schemas';
import { requirePermission } from '../../middleware/auth';

// Captured at import, when the route registered its gates (beforeEach clears mock calls).
const registeredPermissions = [...vi.mocked(requirePermission).mock.calls];

const dialect = new PgDialect();
const paramsOf = (where: unknown) => (where ? dialect.sqlToQuery(where as never).params.map(String) : []);

/** A select chain over the fake tables, keyed on the uuid params of its WHERE. */
function rigDb() {
  vi.mocked(db.select).mockImplementation(((..._fields: unknown[]) => {
    let table: unknown;
    let params: string[] = [];
    let locking = false;
    const chain: Record<string, unknown> = {
      from: (t: unknown) => { table = t; state.selectedTables.push(t); return chain; },
      where: (w: unknown) => { params = paramsOf(w); return chain; },
      limit: () => chain,
      for: () => { locking = true; return chain; },
    };
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      let rows: unknown[] = [];
      if (table === devicesTable) {
        rows = params.map((id) => state.devices.get(id)).filter(Boolean).map((row) => {
          const concurrent = state.concurrentMove;
          if (locking && concurrent && concurrent.deviceId === row!.id) {
            row!.siteId = concurrent.siteId; // the concurrent move committed first
          }
          return { ...row };
        });
      } else if (table === sitesTable) {
        const site = state.sites.get(params[0]!);
        rows = site && (!params[1] || site.orgId === params[1]) ? [{ ...site }] : [];
      }
      return Promise.resolve(rows).then(resolve, reject);
    };
    return chain;
  }) as never);

  vi.mocked(db.transaction).mockImplementation(async (cb: any) => cb({
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (w: unknown) => ({
          returning: async () => {
            const [id, guardSite] = paramsOf(w);
            const row = state.devices.get(id!);
            if (!row || row.siteId !== guardSite) return [];
            Object.assign(row, values);
            return [{ ...row }];
          },
        }),
      }),
    }),
    execute: vi.fn(),
  }));
}

const device = (id: string, orgId: string, siteId: string) => ({ id, orgId, siteId, hostname: `host-${id.slice(0, 4)}`, displayName: null, status: 'online' });

function orgAuth(over: Record<string, unknown> = {}) {
  return {
    user: { id: 'user-1', email: 'tech@example.com' }, scope: 'organization', orgId: ORG_A, partnerId: null,
    accessibleOrgIds: [ORG_A], canAccessOrg: (o: string) => o === ORG_A, orgCondition: () => undefined,
    token: { mfa: true }, ...over,
  };
}
function partnerAuth() {
  return {
    user: { id: 'user-2', email: 'msp@example.com' }, scope: 'partner', orgId: null, partnerId: 'p-1',
    accessibleOrgIds: [ORG_A, ORG_B], canAccessOrg: (o: string) => o === ORG_A || o === ORG_B, orgCondition: () => undefined,
    token: { mfa: true },
  };
}

const app = new Hono();
app.onError((err: any, c) => c.json({ error: err.message }, err.status ?? 500));
app.route('/devices', bulkSiteRoutes);
const post = (body: unknown) => app.request('/devices/bulk/site', {
  method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const entry = (id: string, expectedSiteId: string) => ({ id, expectedSiteId });
const auditActions = () => vi.mocked(writeRouteAudit).mock.calls.map(([, e]) => `${e.resourceId}:${e.action}`);

beforeEach(() => {
  vi.clearAllMocks();
  state.devices = new Map([
    [DEV_1, device(DEV_1, ORG_A, SITE_A1)],
    [DEV_2, device(DEV_2, ORG_A, SITE_A1)],
    [DEV_3, device(DEV_3, ORG_A, SITE_A3)],
    [DEV_B, device(DEV_B, ORG_B, SITE_B1)],
  ]);
  state.sites = new Map([
    [SITE_A1, { id: SITE_A1, orgId: ORG_A, name: 'Main Office' }],
    [SITE_A2, { id: SITE_A2, orgId: ORG_A, name: 'Lakeside' }],
    [SITE_A3, { id: SITE_A3, orgId: ORG_A, name: 'Warehouse' }],
    [SITE_B1, { id: SITE_B1, orgId: ORG_B, name: 'Other org HQ' }],
  ]);
  state.hookStack = [];
  state.contexts = [];
  state.commits = 0;
  state.reevaluated = [];
  state.rewrites = [];
  state.failRewriteFor = null;
  state.failCommitFor = null;
  state.concurrentMove = null;
  state.auth = orgAuth();
  state.allowedSiteIds = undefined;
  state.denyWrite = false;
  state.selectedTables = [];
  rigDb();
});

describe('POST /devices/bulk/site — happy path', () => {
  it('moves every device, one transaction each, with per-device outcomes and a summary', async () => {
    const res = await post({ siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1), entry(DEV_2, SITE_A1), entry(DEV_3, SITE_A3)] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [{ id: DEV_1, outcome: 'moved' }, { id: DEV_2, outcome: 'moved' }, { id: DEV_3, outcome: 'moved' }],
      summary: { moved: 3, total: 3 },
    });
    for (const id of [DEV_1, DEV_2, DEV_3]) expect(state.devices.get(id)!.siteId).toBe(SITE_A2);
    expect(state.rewrites).toEqual([DEV_1, DEV_2, DEV_3]);
    // 1 pre-read + 3 per-device transactions, each built from the caller's auth.
    expect(state.commits).toBe(4);
    expect(state.contexts.every((ctx: any) => ctx.scope === 'organization' && ctx.orgId === ORG_A)).toBe(true);
  });

  it('writes the two PATCH audit rows per moved device, tagged bulk, with trigger manual', async () => {
    await post({ siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1), entry(DEV_3, SITE_A3)] });
    expect(auditActions()).toEqual([`${DEV_1}:device.update`, `${DEV_1}:device.site_move`, `${DEV_3}:device.update`, `${DEV_3}:device.site_move`]);
    const siteMove = vi.mocked(writeRouteAudit).mock.calls.find(([, e]) => e.resourceId === DEV_3 && e.action === 'device.site_move')![1];
    expect(siteMove).toMatchObject({
      orgId: ORG_A, resourceType: 'device',
      details: { fromSiteId: SITE_A3, fromSiteName: 'Warehouse', toSiteId: SITE_A2, toSiteName: 'Lakeside', expectedSiteId: SITE_A3, trigger: 'manual', bulk: true },
    });
    const update = vi.mocked(writeRouteAudit).mock.calls.find(([, e]) => e.resourceId === DEV_1 && e.action === 'device.update')![1];
    expect(update.details).toEqual({ changedFields: ['siteId'], bulk: true });
  });

  it('fires group re-evaluation and peripheral reconciliation once per moved device, after its commit', async () => {
    await post({ siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1), entry(DEV_2, SITE_A2), entry(DEV_3, SITE_A3)] });
    expect(state.reevaluated).toEqual([DEV_1, DEV_3]);
    expect(vi.mocked(schedulePeripheralPolicyDevice).mock.calls.map(([id]) => id)).toEqual([DEV_1, DEV_3]);
  });

  it('already_there: a device already at the target writes nothing and gets no audit', async () => {
    const res = await post({ siteId: SITE_A1, devices: [entry(DEV_1, SITE_A1), entry(DEV_3, SITE_A3)] });
    const body = await res.json();
    expect(body.results).toEqual([{ id: DEV_1, outcome: 'already_there' }, { id: DEV_3, outcome: 'moved' }]);
    expect(body.summary).toEqual({ moved: 1, total: 2 });
    expect(auditActions()).toEqual([`${DEV_3}:device.update`, `${DEV_3}:device.site_move`]);
    expect(state.reevaluated).toEqual([DEV_3]);
  });
});

describe('POST /devices/bulk/site — isolation', () => {
  it('a stale expectedSiteId on device 2 of 3: that device conflicts, 1 and 3 move and stay committed', async () => {
    const res = await post({ siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1), entry(DEV_2, SITE_A3), entry(DEV_3, SITE_A3)] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.map((r: any) => r.outcome)).toEqual(['moved', 'conflict', 'moved']);
    expect(body.results[1]).toMatchObject({ id: DEV_2, outcome: 'conflict', currentSiteId: SITE_A1 });
    expect(body.summary).toEqual({ moved: 2, total: 3 });
    expect(state.devices.get(DEV_1)!.siteId).toBe(SITE_A2);
    expect(state.devices.get(DEV_2)!.siteId).toBe(SITE_A1);
    expect(state.devices.get(DEV_3)!.siteId).toBe(SITE_A2);
    expect(state.reevaluated).toEqual([DEV_1, DEV_3]);
    expect(auditActions().filter((a) => a.startsWith(DEV_2))).toEqual([]);
  });

  it('a concurrent move caught by the row lock re-read is a conflict for that device only', async () => {
    state.concurrentMove = { deviceId: DEV_2, siteId: SITE_A3 };
    const body = await (await post({ siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1), entry(DEV_2, SITE_A1)] })).json();
    expect(body.results).toEqual([{ id: DEV_1, outcome: 'moved' }, expect.objectContaining({ id: DEV_2, outcome: 'conflict', currentSiteId: SITE_A3 })]);
  });

  it('a conflict never names a site the caller cannot see', async () => {
    state.allowedSiteIds = [SITE_A1, SITE_A2];
    state.concurrentMove = { deviceId: DEV_2, siteId: SITE_A3 };
    const body = await (await post({ siteId: SITE_A2, devices: [entry(DEV_2, SITE_A1)] })).json();
    expect(body.results).toEqual([expect.objectContaining({ id: DEV_2, outcome: 'conflict' })]);
    expect(body.results[0]).not.toHaveProperty('currentSiteId');
    expect(JSON.stringify(body)).not.toContain(SITE_A3);
  });

  it('a thrown error mid-batch is that device\'s `error` (logged with its id), and does not undo earlier items', async () => {
    state.failRewriteFor = DEV_2;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post({ siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1), entry(DEV_2, SITE_A1), entry(DEV_3, SITE_A3)] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([
      { id: DEV_1, outcome: 'moved' },
      { id: DEV_2, outcome: 'error', message: 'Move failed' },
      { id: DEV_3, outcome: 'moved' },
    ]);
    expect(body.summary).toEqual({ moved: 2, total: 3 });
    expect(JSON.stringify(body)).not.toContain('deadlock');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining(DEV_2), expect.any(Error));
    // The failed item's post-commit work never ran; its siblings' did.
    expect(state.reevaluated).toEqual([DEV_1, DEV_3]);
    expect(auditActions().filter((a) => a.startsWith(DEV_2))).toEqual([]);
    spy.mockRestore();
  });
});

describe('POST /devices/bulk/site — audit follows the commit', () => {
  it('a device whose transaction fails at COMMIT is `error` and gets NO audit rows (audits are written only after commit)', async () => {
    state.failCommitFor = DEV_2;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await (await post({ siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1), entry(DEV_2, SITE_A1), entry(DEV_3, SITE_A3)] })).json();
    expect(body.results.map((r: any) => r.outcome)).toEqual(['moved', 'error', 'moved']);
    expect(auditActions().filter((a) => a.startsWith(DEV_2))).toEqual([]);
    expect(auditActions()).toEqual([`${DEV_1}:device.update`, `${DEV_1}:device.site_move`, `${DEV_3}:device.update`, `${DEV_3}:device.site_move`]);
    // Its post-commit work never ran either.
    expect(state.reevaluated).toEqual([DEV_1, DEV_3]);
    expect(vi.mocked(schedulePeripheralPolicyDevice).mock.calls.map(([id]) => id)).toEqual([DEV_1, DEV_3]);
    spy.mockRestore();
  });

  it('peripheral reconciliation is scheduled only after the device\'s transaction committed', async () => {
    let openAtSchedule: number | null = null;
    vi.mocked(schedulePeripheralPolicyDevice).mockImplementation(async () => { openAtSchedule = state.hookStack.length; return 'job'; });
    await post({ siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1)] });
    expect(openAtSchedule).toBe(0);
  });

  it('no audit row is written while the device\'s transaction is still open', async () => {
    let openAtAudit: number | null = null;
    vi.mocked(writeRouteAudit).mockImplementation(() => { openAtAudit = openAtAudit ?? state.hookStack.length; });
    await post({ siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1)] });
    expect(openAtAudit).toBe(0);
  });
});

describe('POST /devices/bulk/site — tenancy per device', () => {
  it('an org-scoped caller naming another org\'s device gets not_found for it (no leak), others still move', async () => {
    const body = await (await post({ siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1), entry(DEV_B, SITE_B1)] })).json();
    expect(body.results).toEqual([{ id: DEV_1, outcome: 'moved' }, { id: DEV_B, outcome: 'not_found' }]);
    expect(JSON.stringify(body)).not.toContain(SITE_B1);
    expect(state.devices.get(DEV_B)!.siteId).toBe(SITE_B1);
  });

  it('an unknown id (e.g. a discovered_assets / manual_assets id) is not_found — no other table is probed', async () => {
    const body = await (await post({ siteId: SITE_A2, devices: [entry(UNKNOWN, SITE_A1)] })).json();
    expect(body.results).toEqual([{ id: UNKNOWN, outcome: 'not_found' }]);
    expect(state.selectedTables.length).toBeGreaterThan(0);
    expect(state.selectedTables.every((t) => t === devicesTable || t === sitesTable)).toBe(true);
  });

  it('a site-scoped caller: a device whose SOURCE site is outside the allowlist is forbidden', async () => {
    state.allowedSiteIds = [SITE_A1, SITE_A2];
    const body = await (await post({ siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1), entry(DEV_3, SITE_A3)] })).json();
    expect(body.results).toEqual([{ id: DEV_1, outcome: 'moved' }, { id: DEV_3, outcome: 'forbidden', message: 'Access to this site denied' }]);
    expect(state.devices.get(DEV_3)!.siteId).toBe(SITE_A3);
  });

  it('a site-scoped caller: a TARGET outside the allowlist refuses the whole batch as site_not_found, zero writes', async () => {
    state.allowedSiteIds = [SITE_A1];
    const res = await post({ siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1)] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'site_not_found' });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('a target site the caller cannot see (another org) is site_not_found, zero writes', async () => {
    const res = await post({ siteId: SITE_B1, devices: [entry(DEV_1, SITE_A1)] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'site_not_found' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('a partner caller whose visible devices span two orgs gets 400 mixed_org with zero writes', async () => {
    state.auth = partnerAuth();
    const res = await post({ siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1), entry(DEV_B, SITE_B1)] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'mixed_org' });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
    expect(state.devices.get(DEV_1)!.siteId).toBe(SITE_A1);
  });

  it('precedence: an invisible target is site_not_found even when the devices also span two orgs', async () => {
    state.auth = partnerAuth();
    state.sites.delete(SITE_A2);
    const res = await post({ siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1), entry(DEV_B, SITE_B1)] });
    expect(await res.json()).toMatchObject({ code: 'site_not_found' });
  });

  it('precedence: mixed_org wins over site_org_mismatch', async () => {
    state.auth = partnerAuth();
    const res = await post({ siteId: SITE_B1, devices: [entry(DEV_1, SITE_A1), entry(DEV_B, SITE_B1)] });
    expect(await res.json()).toMatchObject({ code: 'mixed_org' });
  });

  it('a partner caller moving one org\'s devices within that org moves them (partner context per device)', async () => {
    state.auth = partnerAuth();
    const body = await (await post({ siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1), entry(DEV_3, SITE_A3)] })).json();
    expect(body.results).toEqual([{ id: DEV_1, outcome: 'moved' }, { id: DEV_3, outcome: 'moved' }]);
    expect(state.contexts.every((ctx: any) => ctx.scope === 'partner')).toBe(true);
  });

  it('a partner caller moving one org\'s devices to ANOTHER org\'s site gets 400 site_org_mismatch', async () => {
    state.auth = partnerAuth();
    const res = await post({ siteId: SITE_B1, devices: [entry(DEV_1, SITE_A1), entry(DEV_2, SITE_A1)] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'site_org_mismatch' });
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe('POST /devices/bulk/site — whole-batch validation (RF5)', () => {
  it('empty device list → 400, zero writes', async () => {
    const res = await post({ siteId: SITE_A2, devices: [] });
    expect(res.status).toBe(400);
    expect(db.select).not.toHaveBeenCalled();
  });

  it(`cap + 1 (${BULK_SITE_MOVE_CAP + 1}) → 400, zero reads or writes; exactly the cap is accepted`, async () => {
    expect(BULK_SITE_MOVE_CAP).toBe(100);
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`);
    const over = await post({ siteId: SITE_A2, devices: ids(BULK_SITE_MOVE_CAP + 1).map((id) => entry(id, SITE_A1)) });
    expect(over.status).toBe(400);
    expect(db.select).not.toHaveBeenCalled();
    const atCap = await post({ siteId: SITE_A2, devices: ids(BULK_SITE_MOVE_CAP).map((id) => entry(id, SITE_A1)) });
    expect(atCap.status).toBe(200);
  });

  it('a duplicate device id → 400 duplicate_device_ids, rejected whole (not deduplicated), zero reads or writes', async () => {
    const res = await post({ siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1), entry(DEV_2, SITE_A1), entry(DEV_1, SITE_A1)] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'duplicate_device_ids', duplicateIds: [DEV_1] });
    expect(db.select).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('a duplicate that differs only in case is still a duplicate', async () => {
    const res = await post({ siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1), entry(DEV_1.toUpperCase(), SITE_A1)] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'duplicate_device_ids' });
  });

  it.each([
    ['a malformed siteId', { siteId: 'not-a-uuid', devices: [entry(DEV_1, SITE_A1)] }],
    ['a malformed device id', { siteId: SITE_A2, devices: [entry('nope', SITE_A1)] }],
    ['a missing expectedSiteId', { siteId: SITE_A2, devices: [{ id: DEV_1 }] }],
    ['a null expectedSiteId', { siteId: SITE_A2, devices: [{ id: DEV_1, expectedSiteId: null }] }],
    ['an unknown body key', { siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1)], orgId: ORG_A }],
  ])('%s → 400, zero reads', async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('POST /devices/bulk/site — gates', () => {
  it('a session without MFA → 403 { code: MFA_REQUIRED }, zero reads', async () => {
    state.auth = orgAuth({ token: { mfa: false } });
    const res = await post({ siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1)] });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('the route registers the devices:write permission gate (not read, not delete)', () => {
    expect(registeredPermissions).toEqual([['devices', 'write']]);
  });

  it('a caller without devices:write → 403, zero reads', async () => {
    state.denyWrite = true;
    const res = await post({ siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1)] });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('an ai_agent principal → 403, zero reads', async () => {
    state.auth = orgAuth({ principal: { kind: 'ai_agent', agentId: 'a', runId: 'r' } });
    const res = await post({ siteId: SITE_A2, devices: [entry(DEV_1, SITE_A1)] });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });
});
