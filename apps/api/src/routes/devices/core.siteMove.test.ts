import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Site-move hardening on PATCH /devices/:id (topology site location W1, #7885; spec S§12):
 * an expected-source-site guard (409 before any write), a row lock + guarded UPDATE that turn a
 * concurrent move into a 409 instead of a silent overwrite, and a `device.site_move` audit.
 * The real-Postgres race is pinned in __tests__/integration/deviceSiteMoveGuard.integration.test.ts.
 */

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), execute: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'tech@harbor-dental.example', name: 'Test User' },
      scope: 'organization', orgId: 'org-123', partnerId: null, accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123', orgCondition: () => undefined, token: { mfa: true },
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    const list = c.req.header('x-restrict-site-list');
    c.set('permissions', {
      permissions: [{ resource, action }], partnerId: null, orgId: 'org-123', roleId: 'role-123', scope: 'organization',
      ...(list ? { allowedSiteIds: list.split(',') } : {}),
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../jobs/peripheralJobs', () => ({ schedulePeripheralPolicyDevice: vi.fn().mockResolvedValue('job-id') }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../services/remoteAccessPolicy', () => ({ resolveRemoteAccessForDevice: vi.fn().mockResolvedValue({ policyId: null, settings: {} }) }));
vi.mock('../../services/remoteAccessLauncher', () => ({ resolveRemoteAccessLaunch: vi.fn().mockReturnValue({ launchUrl: null, skipReason: 'no_provider_configured' }) }));
vi.mock('../agentWs', () => ({ sendCommandToAgent: vi.fn(), isAgentConnected: vi.fn().mockReturnValue(false) }));
vi.mock('../../services/commandQueue', () => ({ CommandTypes: { SELF_UNINSTALL: 'self_uninstall' }, queueCommandForExecution: vi.fn() }));
vi.mock('../agents/enrollment', () => ({ getGlobalEnrollmentSecret: vi.fn().mockReturnValue(null) }));

import { coreRoutes, DEVICE_SITE_DENORMALIZED_TABLES } from './core';
import { db } from '../../db';
import { writeRouteAudit } from '../../services/auditEvents';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const SITE_A = '77777777-7777-4777-8777-777777777777';
const SITE_B = '88888888-8888-4888-8888-888888888888';
const SITE_C = '99999999-9999-4999-8999-999999999999';
const device = { id: DEVICE_ID, orgId: 'org-123', siteId: SITE_A, hostname: 'FRONTDESK-01', displayName: null, osType: 'windows', status: 'online' };
const dialect = new PgDialect();

/**
 * Each db.select() takes the next queued result. The chain accepts any builder call
 * (from/where/limit/innerJoin/for) and resolves to that result when awaited.
 */
const selectCalls: { methods: string[]; args: unknown[][] }[] = [];
function queueSelects(results: unknown[][]) {
  const queue = [...results];
  vi.mocked(db.select).mockImplementation((() => {
    const result = queue.shift() ?? [];
    const record = { methods: [] as string[], args: [] as unknown[][] };
    selectCalls.push(record);
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'limit', 'innerJoin', 'leftJoin', 'for', 'orderBy']) {
      chain[method] = (...args: unknown[]) => { record.methods.push(method); record.args.push(args); return chain; };
    }
    chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
    return chain;
  }) as never);
}

/** The savepoint transaction: the devices UPDATE (guarded) then the denormalized loop. */
let updateReturningRows: unknown[];
let updateWheres: unknown[];
let denormalizedSiteUpdates: string[];
function rigTransaction() {
  updateWheres = []; denormalizedSiteUpdates = [];
  vi.mocked(db.transaction).mockImplementation(async (cb: any) => {
    const tx = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation((where: unknown) => { updateWheres.push(where); return { returning: vi.fn().mockResolvedValue(updateReturningRows) }; }),
        }),
      }),
      execute: vi.fn().mockImplementation(async (query: any) => { denormalizedSiteUpdates.push(String(query?.queryChunks?.[1]?.value)); return []; }),
    };
    return cb(tx);
  });
}
const lastUpdateWhereSql = () => dialect.sqlToQuery(updateWheres.at(-1) as never).sql;

const app = new Hono();
app.route('/devices', coreRoutes);
const patch = (body: unknown, headers: Record<string, string> = {}) => app.request(`/devices/${DEVICE_ID}`, {
  method: 'PATCH', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  selectCalls.length = 0;
  updateReturningRows = [{ ...device, siteId: SITE_B }];
  rigTransaction();
});

/** device lookup → destination site → row lock (current site) → source site name. */
const moveSelects = (current: { siteId: string } = { siteId: SITE_A }) =>
  queueSelects([[device], [{ id: SITE_B, orgId: 'org-123', name: 'Lakeside' }], [current], [{ name: 'Main Office' }]]);

describe('PATCH /devices/:id site-move guard', () => {
  it('rejects with 409 when expectedSiteId differs from the current site, without writing', async () => {
    queueSelects([[device]]);
    const res = await patch({ siteId: SITE_B, expectedSiteId: SITE_C });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'device_site_changed', currentSiteId: SITE_A });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('applies the expected-site guard even when siteId is not being changed', async () => {
    queueSelects([[device]]);
    const res = await patch({ displayName: 'Front desk', expectedSiteId: SITE_C });
    expect(res.status).toBe(409);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('returns 403, not a 409 that names the site, when the caller cannot access the device\'s site', async () => {
    queueSelects([[device]]);
    const res = await patch({ siteId: SITE_B, expectedSiteId: SITE_C }, { 'x-restrict-site-list': `${SITE_B},${SITE_C}` });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain(SITE_A);
  });

  it('locks the device row and returns 409 when a concurrent move already changed its site, before any write', async () => {
    moveSelects({ siteId: SITE_C });
    const res = await patch({ siteId: SITE_B });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'device_site_changed', currentSiteId: SITE_C });
    const lock = selectCalls[2]!;
    expect(lock.methods).toContain('for');
    expect(lock.args[lock.methods.indexOf('for')]![0]).toBe('update');
    expect(db.transaction).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('omits currentSiteId from the 409 when the caller cannot access the site the device moved to', async () => {
    moveSelects({ siteId: SITE_C });
    const res = await patch({ siteId: SITE_B }, { 'x-restrict-site-list': `${SITE_A},${SITE_B}` });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'device_site_changed' });
  });

  it('guards the UPDATE on the site read at the access check, even without expectedSiteId', async () => {
    moveSelects();
    updateReturningRows = []; // the guarded UPDATE matches 0 rows
    const res = await patch({ siteId: SITE_B });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('device_site_changed');
    expect(lastUpdateWhereSql()).toMatch(/"site_id" = \$\d/);
    expect(denormalizedSiteUpdates).toHaveLength(0); // savepoint rolled back before the denormalized loop
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('writes a device.site_move audit with old/new site and the trigger, alongside device.update', async () => {
    moveSelects();
    const res = await patch({ siteId: SITE_B, expectedSiteId: SITE_A });
    expect(res.status).toBe(200);
    expect(denormalizedSiteUpdates).toEqual([...DEVICE_SITE_DENORMALIZED_TABLES]);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: 'org-123', action: 'device.site_move', resourceType: 'device', resourceId: DEVICE_ID,
      details: { fromSiteId: SITE_A, fromSiteName: 'Main Office', toSiteId: SITE_B, toSiteName: 'Lakeside', expectedSiteId: SITE_A, trigger: 'manual' },
    }));
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'device.update', details: { changedFields: ['siteId'] } }));
  });

  it('records a topology_suggestion trigger and a null expectedSiteId when none was sent', async () => {
    moveSelects();
    const res = await patch({ siteId: SITE_B, siteMoveTrigger: 'topology_suggestion' });
    expect(res.status).toBe(200);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'device.site_move', details: expect.objectContaining({ expectedSiteId: null, trigger: 'topology_suggestion' }),
    }));
  });

  it('does not write device.site_move when siteId is unchanged', async () => {
    queueSelects([[device]]);
    vi.mocked(db.update).mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([device]) }) }) } as never);
    const res = await patch({ siteId: SITE_A, expectedSiteId: SITE_A, displayName: 'Front desk' });
    expect(res.status).toBe(200);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(vi.mocked(writeRouteAudit).mock.calls.map(([, event]) => event.action)).toEqual(['device.update']);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ details: { changedFields: ['displayName', 'siteId'] } }));
  });

  it('rejects a body with only the guard fields as having no updates', async () => {
    queueSelects([[device]]);
    const res = await patch({ expectedSiteId: SITE_A, siteMoveTrigger: 'manual' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown siteMoveTrigger and a non-uuid expectedSiteId with 400', async () => {
    queueSelects([[device]]);
    expect((await patch({ siteId: SITE_B, siteMoveTrigger: 'auto' })).status).toBe(400);
    expect((await patch({ siteId: SITE_B, expectedSiteId: 'site-a' })).status).toBe(400);
  });
});
