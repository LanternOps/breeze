/**
 * Wisp W05a Task 11 — watch routes, exercised THROUGH the W02 hub
 * (`wispRoutes`) so the inherited gates are the real chain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const h = vi.hoisted(() => ({
  wispEnabled: vi.fn(() => true),
  hasPerm: vi.fn<(resource: string, action: string) => boolean>(() => true),
  hasEntitlement: vi.fn(async () => true),
  resolveGrantCeiling: vi.fn(),
  createWatch: vi.fn(),
  listWatches: vi.fn(),
  deleteWatch: vi.fn(),
  writeRouteAudit: vi.fn(),
  captureException: vi.fn(),
  dbResults: [] as unknown[][],
}));

vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
    requireScope: actual.requireScope,
    requirePermission: (resource: string, action: string) => async (
      c: { json: (body: unknown, status: number) => Response },
      next: () => Promise<void>,
    ) => (h.hasPerm(resource, action) ? next() : c.json({ error: 'Permission denied' }, 403)),
    requireMfa: () => async (_c: unknown, next: () => Promise<void>) => next(),
  };
});
vi.mock('../middleware/userRateLimit', () => ({
  userRateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../config/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  wispEnabled: () => h.wispEnabled(),
}));
vi.mock('../services/entitlements', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasEntitlement: h.hasEntitlement,
}));
vi.mock('../db', () => {
  const chain = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'leftJoin', 'limit', 'orderBy', 'where']) p[m] = vi.fn(() => p);
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(h.dbResults.shift() ?? []).then(res, rej);
    return p;
  };
  return {
    db: { select: vi.fn(() => chain()) },
    runAfterDbContextCommit: (_label: string, work: () => unknown) => { void work(); },
  };
});
vi.mock('../services/wisp/grantAuthority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/wisp/grantAuthority')>()),
  resolveGrantCeiling: h.resolveGrantCeiling,
  inSystemContext: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../services/wisp/watches', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/wisp/watches')>()),
  createWatch: h.createWatch,
  listWatches: h.listWatches,
  deleteWatch: h.deleteWatch,
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: h.writeRouteAudit }));
vi.mock('../services/sentry', () => ({ captureException: h.captureException }));

import { wispRoutes } from './wisp';
import { CeilingViolationError, GrantInactiveError } from '../services/wisp/grantAuthority';
import { WatchLimitReachedError } from '../services/wisp/watches';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const ORG_OUT = '22222222-2222-4222-8222-999999999999';
const USER = '33333333-3333-4333-8333-333333333333';
const OTHER_USER = '33333333-3333-4333-8333-999999999999';
const GRANT_ID = '44444444-4444-4444-8444-444444444444';
const WATCH_ID = '77777777-7777-4777-8777-777777777777';
const REV = '66666666-6666-4666-8666-666666666666';

const grantRow = (o: Record<string, unknown> = {}) => ({
  id: GRANT_ID, partnerId: PARTNER, grantorUserId: USER, currentRevisionId: REV, status: 'active', ...o,
});
const ceiling = { grantId: GRANT_ID, revisionId: REV, partnerId: PARTNER, grantorUserId: USER, scopeOrgId: null, partnerWide: true, orgIds: new Set([ORG]) };
const watch = (o: Record<string, unknown> = {}) => ({
  id: WATCH_ID, partnerId: PARTNER, orgId: ORG, grantId: GRANT_ID, kind: 'ticket_waiting', params: {}, cadenceMinutes: 60,
  status: 'active', stoppedReason: null, lastRanAt: null, nextDueAt: '2026-10-24T01:00:00.000Z', createdAt: '2026-10-24T00:00:00.000Z', ...o,
});
const body = (o: Record<string, unknown> = {}) => ({ grantId: GRANT_ID, orgId: ORG, kind: 'ticket_waiting', params: {}, cadenceMinutes: 60, ...o });

function buildApp(authOverrides: Record<string, unknown> = {}): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      principal: { kind: 'user_session' },
      scope: 'partner',
      partnerId: PARTNER,
      orgId: null,
      accessibleOrgIds: [ORG],
      partnerOrgAccess: 'selected',
      user: { id: USER, email: 'tech@example.test', name: 'Tech', isPlatformAdmin: false },
      token: { sid: 'sid', mfa: true },
      canAccessOrg: (id: string) => id === ORG,
      orgCondition: () => undefined,
      ...authOverrides,
    } as never);
    await next();
  });
  app.route('/wisp', wispRoutes);
  app.onError((err, c) => (err instanceof HTTPException ? err.getResponse() : c.json({ error: 'boom', message: err.message }, 500)));
  return app;
}
const asPartnerAdmin = { partnerOrgAccess: 'all' };
const post = (app: Hono, path: string, b: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

beforeEach(() => {
  vi.clearAllMocks();
  h.dbResults.length = 0;
  h.wispEnabled.mockReturnValue(true);
  h.hasPerm.mockReturnValue(true);
  h.hasEntitlement.mockResolvedValue(true);
  h.resolveGrantCeiling.mockResolvedValue(ceiling);
  h.createWatch.mockResolvedValue(watch());
  h.listWatches.mockResolvedValue([watch()]);
  h.deleteWatch.mockResolvedValue(true);
});

describe('GET /wisp/watches', () => {
  it('404 while the flag is off', async () => {
    h.wispEnabled.mockReturnValue(false);
    expect((await buildApp().request(`/wisp/watches?grantId=${GRANT_ID}`)).status).toBe(404);
    expect(h.listWatches).not.toHaveBeenCalled();
  });

  it('403 without ai_sessions:use', async () => {
    h.hasPerm.mockReturnValue(false);
    expect((await buildApp().request(`/wisp/watches?grantId=${GRANT_ID}`)).status).toBe(403);
  });

  it('lists the own grant\'s watches', async () => {
    h.dbResults.push([grantRow()]);
    const res = await buildApp().request(`/wisp/watches?grantId=${GRANT_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ watches: [watch()] });
    expect(h.listWatches).toHaveBeenCalledWith(ceiling);
  });

  it('another tech\'s grant: 404 for a plain tech, 200 for a partner-wide admin', async () => {
    h.dbResults.push([grantRow({ grantorUserId: OTHER_USER })]);
    expect((await buildApp().request(`/wisp/watches?grantId=${GRANT_ID}`)).status).toBe(404);
    h.dbResults.push([grantRow({ grantorUserId: OTHER_USER })]);
    expect((await buildApp(asPartnerAdmin).request(`/wisp/watches?grantId=${GRANT_ID}`)).status).toBe(200);
  });

  it('400 without grantId', async () => {
    expect((await buildApp().request('/wisp/watches')).status).toBe(400);
  });
});

describe('POST /wisp/watches', () => {
  it('201 { watch }; the service gets the input without grantId', async () => {
    h.dbResults.push([grantRow()]);
    const res = await post(buildApp(), '/wisp/watches', body({ params: { minHours: 24 } }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ watch: watch() });
    expect(h.createWatch).toHaveBeenCalledWith(ceiling, { orgId: ORG, kind: 'ticket_waiting', params: { minHours: 24 }, cadenceMinutes: 60 });
    expect(h.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'wisp.watch.created', resourceId: WATCH_ID }));
  });

  it('cadenceMinutes: 14 → 400', async () => {
    const res = await post(buildApp(), '/wisp/watches', body({ cadenceMinutes: 14 }));
    expect(res.status).toBe(400);
    expect(h.createWatch).not.toHaveBeenCalled();
  });

  it('a paused grant → 409 grant_inactive', async () => {
    h.dbResults.push([grantRow({ status: 'paused' })]);
    h.resolveGrantCeiling.mockRejectedValue(new GrantInactiveError(GRANT_ID, 'paused'));
    const res = await post(buildApp(), '/wisp/watches', body());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('grant_inactive');
    expect(h.createWatch).not.toHaveBeenCalled();
  });

  it('the per-grant limit → 409 watch_limit_reached', async () => {
    h.dbResults.push([grantRow()]);
    h.createWatch.mockRejectedValue(new WatchLimitReachedError(GRANT_ID));
    const res = await post(buildApp(), '/wisp/watches', body());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('watch_limit_reached');
  });

  it('an org outside the ceiling → 404 (non-enumerating)', async () => {
    h.dbResults.push([grantRow()]);
    h.createWatch.mockRejectedValue(new CeilingViolationError('org', 'outside'));
    const res = await post(buildApp(), '/wisp/watches', body({ orgId: ORG_OUT }));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('org_out_of_reach');
  });

  it('a partner admin cannot create on another tech\'s grant → 404', async () => {
    h.dbResults.push([grantRow({ grantorUserId: OTHER_USER })]);
    const res = await post(buildApp(asPartnerAdmin), '/wisp/watches', body());
    expect(res.status).toBe(404);
    expect(h.createWatch).not.toHaveBeenCalled();
  });
});

describe('DELETE /wisp/watches/:id', () => {
  const del = (app: Hono, id = WATCH_ID, q = `?grantId=${GRANT_ID}`) => app.request(`/wisp/watches/${id}${q}`, { method: 'DELETE' });

  it('204 when the grant owned the watch', async () => {
    h.dbResults.push([grantRow()]);
    const res = await del(buildApp());
    expect(res.status).toBe(204);
    expect(h.deleteWatch).toHaveBeenCalledWith(ceiling, WATCH_ID);
  });

  it('another grant\'s watch (service deletes nothing) → 404', async () => {
    h.dbResults.push([grantRow()]);
    h.deleteWatch.mockResolvedValue(false);
    expect((await del(buildApp())).status).toBe(404);
  });

  it('a non-owned grant → 404 even as partner admin; nothing deleted', async () => {
    h.dbResults.push([grantRow({ grantorUserId: OTHER_USER })]);
    expect((await del(buildApp(asPartnerAdmin))).status).toBe(404);
    expect(h.deleteWatch).not.toHaveBeenCalled();
  });

  it('a non-uuid id → 404; a missing grantId → 400', async () => {
    expect((await del(buildApp(), 'nope')).status).toBe(404);
    expect((await del(buildApp(), WATCH_ID, '')).status).toBe(400);
    expect(h.deleteWatch).not.toHaveBeenCalled();
  });
});
