/**
 * Wisp W05a Tasks 11 + 17 — concern routes, exercised THROUGH the W02 hub
 * (`wispRoutes`) so the inherited gates (auth → wispEnabled() 404 → partner
 * scope → ai_sessions:use → requireEntitlement('wisp')) are the real chain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({
  wispEnabled: vi.fn(() => true),
  hasPerm: vi.fn<(resource: string, action: string) => boolean>(() => true),
  hasEntitlement: vi.fn(async () => true),
  resolveGrantCeiling: vi.fn(),
  listConcernsForCeiling: vi.fn(),
  getConcernForCeiling: vi.fn(),
  snoozeConcern: vi.fn(),
  dismissConcern: vi.fn(),
  resolveConcern: vi.fn(),
  markAnswered: vi.fn(),
  writeRouteAudit: vi.fn(),
  captureException: vi.fn(),
  /** Results handed to successive `await db.select()…` chains, in order. */
  dbResults: [] as unknown[][],
  whereArgs: [] as unknown[],
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
    for (const m of ['from', 'innerJoin', 'leftJoin', 'limit', 'orderBy']) p[m] = vi.fn(() => p);
    p.where = vi.fn((cond: unknown) => { h.whereArgs.push(cond); return p; });
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
vi.mock('../services/wisp/concerns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/wisp/concerns')>()),
  listConcernsForCeiling: h.listConcernsForCeiling,
  getConcernForCeiling: h.getConcernForCeiling,
  snoozeConcern: h.snoozeConcern,
  dismissConcern: h.dismissConcern,
  resolveConcern: h.resolveConcern,
  markAnswered: h.markAnswered,
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: h.writeRouteAudit }));
vi.mock('../services/sentry', () => ({ captureException: h.captureException }));

import { wispRoutes } from './wisp';
import { CeilingViolationError, GrantInactiveError } from '../services/wisp/grantAuthority';
import { WISP_NOT_FOUND as WISP_NOT_FOUND_BODY } from './wispConcerns';
import { ConcernNotFoundError } from '../services/wisp/concerns';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const OTHER_USER = '33333333-3333-4333-8333-999999999999';
const GRANT_ID = '44444444-4444-4444-8444-444444444444';
const CONCERN_ID = '55555555-5555-4555-8555-555555555555';
const REV = '66666666-6666-4666-8666-666666666666';

const dialect = new PgDialect();
const compile = (cond: unknown) => dialect.sqlToQuery(cond as SQL);

/** The row the grant loader selects. */
const grantRow = (o: Record<string, unknown> = {}) => ({
  id: GRANT_ID, partnerId: PARTNER, grantorUserId: USER, currentRevisionId: REV, status: 'active', ...o,
});
const ceiling = { grantId: GRANT_ID, revisionId: REV, partnerId: PARTNER, grantorUserId: USER, scopeOrgId: null, partnerWide: true, orgIds: new Set([ORG]) };
const concern = (o: Record<string, unknown> = {}) => ({
  id: CONCERN_ID, partnerId: PARTNER, orgId: ORG, subject: { kind: 'ticket', id: CONCERN_ID }, summary: 'Ticket waiting 3 days',
  severity: 'medium', status: 'open', evidence: {}, outcome: null, signature: null, childConcernIds: [], approvalIntentId: null,
  createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z', resolvedAt: null, ...o,
});

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

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const daysAhead = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

/** The grant loader must pin the grant to the caller's partner. */
function expectGrantWhere(cond: unknown) {
  const q = compile(cond);
  expect(q.sql).toContain('"wisp_grants"."id"');
  expect(q.sql).toContain('"wisp_grants"."partner_id"');
  expect(q.params).toEqual(expect.arrayContaining([GRANT_ID, PARTNER]));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.dbResults.length = 0;
  h.whereArgs.length = 0;
  h.wispEnabled.mockReturnValue(true);
  h.hasPerm.mockReturnValue(true);
  h.hasEntitlement.mockResolvedValue(true);
  h.resolveGrantCeiling.mockResolvedValue(ceiling);
  h.listConcernsForCeiling.mockResolvedValue([concern()]);
  h.getConcernForCeiling.mockResolvedValue(concern());
  h.snoozeConcern.mockResolvedValue(undefined);
  h.dismissConcern.mockResolvedValue(undefined);
  h.resolveConcern.mockResolvedValue(undefined);
  h.markAnswered.mockResolvedValue(undefined);
});

describe('GET /wisp/concerns — inherited gates', () => {
  it('404 while the flag is off; nothing is read', async () => {
    h.wispEnabled.mockReturnValue(false);
    const res = await buildApp().request(`/wisp/concerns?grantId=${GRANT_ID}`);
    expect(res.status).toBe(404);
    expect(h.listConcernsForCeiling).not.toHaveBeenCalled();
  });

  it('403 without ai_sessions:use', async () => {
    h.hasPerm.mockImplementation((r, a) => !(r === 'ai_sessions' && a === 'use'));
    const res = await buildApp().request(`/wisp/concerns?grantId=${GRANT_ID}`);
    expect(res.status).toBe(403);
    expect(h.listConcernsForCeiling).not.toHaveBeenCalled();
  });

  it('403 entitlement_required when the partner lacks the wisp entitlement', async () => {
    h.hasEntitlement.mockResolvedValue(false);
    const res = await buildApp().request(`/wisp/concerns?grantId=${GRANT_ID}`);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('entitlement_required');
  });
});

describe('GET /wisp/concerns', () => {
  it('lists the own grant\'s concerns under its ceiling, passing status + orgId through', async () => {
    h.dbResults.push([grantRow()]);
    const res = await buildApp().request(`/wisp/concerns?grantId=${GRANT_ID}&status=open,snoozed&orgId=${ORG}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ concerns: [concern()] });
    expectGrantWhere(h.whereArgs[0]);
    expect(h.resolveGrantCeiling).toHaveBeenCalledWith(GRANT_ID, REV);
    expect(h.listConcernsForCeiling).toHaveBeenCalledWith(ceiling, { status: ['open', 'snoozed'], orgId: ORG });
  });

  it('400 without grantId, or with an unknown status', async () => {
    expect((await buildApp().request('/wisp/concerns')).status).toBe(400);
    expect((await buildApp().request(`/wisp/concerns?grantId=${GRANT_ID}&status=open,bogus`)).status).toBe(400);
  });

  it('another user\'s grant without partner-wide admin → 404, nothing resolved', async () => {
    h.dbResults.push([grantRow({ grantorUserId: OTHER_USER })]);
    const res = await buildApp().request(`/wisp/concerns?grantId=${GRANT_ID}`);
    expect(res.status).toBe(404);
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
    expect(h.listConcernsForCeiling).not.toHaveBeenCalled();
  });

  it('another user\'s grant WITH canManagePartnerWidePolicies → 200 (partner-admin read, w00 A1)', async () => {
    h.dbResults.push([grantRow({ grantorUserId: OTHER_USER })]);
    const res = await buildApp(asPartnerAdmin).request(`/wisp/concerns?grantId=${GRANT_ID}`);
    expect(res.status).toBe(200);
    expect(h.listConcernsForCeiling).toHaveBeenCalledWith(ceiling, { status: undefined, orgId: undefined });
  });

  it('a grant not in the caller\'s partner (no row) → the same 404', async () => {
    h.dbResults.push([]);
    const res = await buildApp(asPartnerAdmin).request(`/wisp/concerns?grantId=${GRANT_ID}`);
    expect(res.status).toBe(404);
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
  });

  it('409 grant_inactive when the grant is paused', async () => {
    h.dbResults.push([grantRow({ status: 'paused' })]);
    h.resolveGrantCeiling.mockRejectedValue(new GrantInactiveError(GRANT_ID, 'paused'));
    const res = await buildApp().request(`/wisp/concerns?grantId=${GRANT_ID}`);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('grant_inactive');
  });

  it('409 grant_inactive when the grant has no pinned revision', async () => {
    h.dbResults.push([grantRow({ currentRevisionId: null })]);
    const res = await buildApp().request(`/wisp/concerns?grantId=${GRANT_ID}`);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('grant_inactive');
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
  });

  it('500 grant_corrupt (captured) when the ceiling pin is corrupt', async () => {
    h.dbResults.push([grantRow()]);
    h.resolveGrantCeiling.mockRejectedValue(new GrantInactiveError(GRANT_ID, 'active', 'bad snapshot', 'corrupt'));
    const res = await buildApp().request(`/wisp/concerns?grantId=${GRANT_ID}`);
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('grant_corrupt');
    expect(h.captureException).toHaveBeenCalled();
  });

  it('unexpected service errors propagate (no swallow)', async () => {
    h.dbResults.push([grantRow()]);
    h.listConcernsForCeiling.mockRejectedValue(new Error('db down'));
    const res = await buildApp().request(`/wisp/concerns?grantId=${GRANT_ID}`);
    expect(res.status).toBe(500);
    expect((await res.json()).message).toBe('db down');
  });
});

describe('GET /wisp/concerns/:id (Task 17)', () => {
  it('visible → 200 { concern }', async () => {
    h.dbResults.push([grantRow()]);
    const res = await buildApp().request(`/wisp/concerns/${CONCERN_ID}?grantId=${GRANT_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ concern: concern() });
    expect(h.getConcernForCeiling).toHaveBeenCalledWith(ceiling, CONCERN_ID);
  });

  it('not visible under the ceiling → 404', async () => {
    h.dbResults.push([grantRow()]);
    h.getConcernForCeiling.mockResolvedValue(null);
    const res = await buildApp().request(`/wisp/concerns/${CONCERN_ID}?grantId=${GRANT_ID}`);
    expect(res.status).toBe(404);
  });

  it('a non-uuid id → 404 without any lookup', async () => {
    const res = await buildApp().request(`/wisp/concerns/not-a-uuid?grantId=${GRANT_ID}`);
    expect(res.status).toBe(404);
    expect(h.getConcernForCeiling).not.toHaveBeenCalled();
  });

  it('partner admin may read another tech\'s grant\'s concern; a plain tech may not', async () => {
    h.dbResults.push([grantRow({ grantorUserId: OTHER_USER })]);
    expect((await buildApp().request(`/wisp/concerns/${CONCERN_ID}?grantId=${GRANT_ID}`)).status).toBe(404);
    h.dbResults.push([grantRow({ grantorUserId: OTHER_USER })]);
    expect((await buildApp(asPartnerAdmin).request(`/wisp/concerns/${CONCERN_ID}?grantId=${GRANT_ID}`)).status).toBe(200);
  });
});

describe('POST /wisp/concerns/:id/snooze', () => {
  it('snoozes then marks answered for the own grant', async () => {
    h.dbResults.push([grantRow()]);
    const until = daysAhead(2);
    const res = await post(buildApp(), `/wisp/concerns/${CONCERN_ID}/snooze`, { grantId: GRANT_ID, until });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(h.getConcernForCeiling).toHaveBeenCalledWith(ceiling, CONCERN_ID);
    expect(h.snoozeConcern).toHaveBeenCalledWith(CONCERN_ID, { grantId: GRANT_ID, userId: USER }, new Date(until));
    expect(h.markAnswered).toHaveBeenCalledWith(CONCERN_ID, GRANT_ID, expect.any(Date));
    expect(h.snoozeConcern.mock.invocationCallOrder[0]!).toBeLessThan(h.markAnswered.mock.invocationCallOrder[0]!);
  });

  it('until 31 days ahead → 400', async () => {
    const res = await post(buildApp(), `/wisp/concerns/${CONCERN_ID}/snooze`, { grantId: GRANT_ID, until: daysAhead(31) });
    expect(res.status).toBe(400);
    expect(h.snoozeConcern).not.toHaveBeenCalled();
  });

  it('a body without grantId → 400', async () => {
    const res = await post(buildApp(), `/wisp/concerns/${CONCERN_ID}/snooze`, { until: daysAhead(1) });
    expect(res.status).toBe(400);
    expect(h.snoozeConcern).not.toHaveBeenCalled();
  });

  it('a concern outside the ceiling → 404 and the service is NOT called', async () => {
    h.dbResults.push([grantRow()]);
    h.getConcernForCeiling.mockResolvedValue(null);
    const res = await post(buildApp(), `/wisp/concerns/${CONCERN_ID}/snooze`, { grantId: GRANT_ID, until: daysAhead(1) });
    expect(res.status).toBe(404);
    expect(h.snoozeConcern).not.toHaveBeenCalled();
    expect(h.markAnswered).not.toHaveBeenCalled();
  });

  it('a partner admin cannot snooze on another tech\'s grant (personal state) → 404', async () => {
    h.dbResults.push([grantRow({ grantorUserId: OTHER_USER })]);
    const res = await post(buildApp(asPartnerAdmin), `/wisp/concerns/${CONCERN_ID}/snooze`, { grantId: GRANT_ID, until: daysAhead(1) });
    expect(res.status).toBe(404);
    expect(h.snoozeConcern).not.toHaveBeenCalled();
  });

  it('ConcernNotFoundError from the service (deleted between read and write) → 404', async () => {
    h.dbResults.push([grantRow()]);
    h.snoozeConcern.mockRejectedValue(new ConcernNotFoundError(CONCERN_ID));
    const res = await post(buildApp(), `/wisp/concerns/${CONCERN_ID}/snooze`, { grantId: GRANT_ID, until: daysAhead(1) });
    expect(res.status).toBe(404);
    expect(h.markAnswered).not.toHaveBeenCalled();
  });
});

describe('POST /wisp/concerns/:id/dismiss', () => {
  it('dismisses then marks answered', async () => {
    h.dbResults.push([grantRow()]);
    const res = await post(buildApp(), `/wisp/concerns/${CONCERN_ID}/dismiss`, { grantId: GRANT_ID });
    expect(res.status).toBe(200);
    expect(h.dismissConcern).toHaveBeenCalledWith(CONCERN_ID, { grantId: GRANT_ID, userId: USER });
    expect(h.markAnswered).toHaveBeenCalledWith(CONCERN_ID, GRANT_ID, expect.any(Date));
  });

  it('409 grant_inactive on a paused grant; nothing written', async () => {
    h.dbResults.push([grantRow()]);
    h.resolveGrantCeiling.mockRejectedValue(new GrantInactiveError(GRANT_ID, 'paused'));
    const res = await post(buildApp(), `/wisp/concerns/${CONCERN_ID}/dismiss`, { grantId: GRANT_ID });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('grant_inactive');
    expect(h.dismissConcern).not.toHaveBeenCalled();
  });

  it('a partner admin cannot dismiss on another tech\'s grant (personal state) → the same 404', async () => {
    h.dbResults.push([grantRow({ grantorUserId: OTHER_USER })]);
    const res = await post(buildApp(asPartnerAdmin), `/wisp/concerns/${CONCERN_ID}/dismiss`, { grantId: GRANT_ID });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(WISP_NOT_FOUND_BODY);
    expect(h.getConcernForCeiling).not.toHaveBeenCalled();
    expect(h.dismissConcern).not.toHaveBeenCalled();
  });

  it('409 concern_not_live for a resolved / dismissed concern; nothing written or answered', async () => {
    for (const status of ['resolved', 'dismissed'] as const) {
      h.dbResults.push([grantRow()]);
      h.getConcernForCeiling.mockResolvedValueOnce(concern({ status }));
      const res = await post(buildApp(), `/wisp/concerns/${CONCERN_ID}/dismiss`, { grantId: GRANT_ID });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('concern_not_live');
    }
    expect(h.dismissConcern).not.toHaveBeenCalled();
    expect(h.markAnswered).not.toHaveBeenCalled();
  });
});

describe('ceiling violation codes', () => {
  it('org → 404 org_out_of_reach; site/permission/tool → 403 outside_ceiling; inactive → 409', async () => {
    const cases: Array<[ 'org' | 'site' | 'permission' | 'tool' | 'inactive', number, string]> = [
      ['org', 404, 'org_out_of_reach'], ['site', 403, 'outside_ceiling'], ['permission', 403, 'outside_ceiling'],
      ['tool', 403, 'outside_ceiling'], ['inactive', 409, 'grant_inactive'],
    ];
    for (const [code, status, body] of cases) {
      h.dbResults.push([grantRow()]);
      h.resolveGrantCeiling.mockRejectedValueOnce(new CeilingViolationError(code, 'x'));
      const res = await buildApp().request(`/wisp/concerns?grantId=${GRANT_ID}`);
      expect(res.status, code).toBe(status);
      expect((await res.json()).code, code).toBe(body);
    }
  });
});

describe('POST /wisp/concerns/:id/resolve', () => {
  it('resolves with { userId } then marks answered, and audits', async () => {
    h.dbResults.push([grantRow()]);
    const res = await post(buildApp(), `/wisp/concerns/${CONCERN_ID}/resolve`, { grantId: GRANT_ID, outcome: 'Replied to the customer' });
    expect(res.status).toBe(200);
    expect(h.resolveConcern).toHaveBeenCalledWith(CONCERN_ID, { userId: USER }, 'Replied to the customer');
    expect(h.markAnswered).toHaveBeenCalledWith(CONCERN_ID, GRANT_ID, expect.any(Date));
    expect(h.resolveConcern.mock.invocationCallOrder[0]!).toBeLessThan(h.markAnswered.mock.invocationCallOrder[0]!);
    expect(h.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'wisp.concern.resolved', resourceId: CONCERN_ID, orgId: ORG, partnerId: PARTNER,
    }));
  });

  it('a non-owner of the grant → 404, even as partner admin', async () => {
    h.dbResults.push([grantRow({ grantorUserId: OTHER_USER })]);
    const res = await post(buildApp(asPartnerAdmin), `/wisp/concerns/${CONCERN_ID}/resolve`, { grantId: GRANT_ID, outcome: 'done' });
    expect(res.status).toBe(404);
    expect(h.resolveConcern).not.toHaveBeenCalled();
    expect(h.getConcernForCeiling).not.toHaveBeenCalled();
  });

  it('a concern outside the ceiling → 404, not resolved', async () => {
    h.dbResults.push([grantRow()]);
    h.getConcernForCeiling.mockResolvedValue(null);
    const res = await post(buildApp(), `/wisp/concerns/${CONCERN_ID}/resolve`, { grantId: GRANT_ID, outcome: 'done' });
    expect(res.status).toBe(404);
    expect(h.resolveConcern).not.toHaveBeenCalled();
  });

  it('an outcome over 1000 chars → 400', async () => {
    const res = await post(buildApp(), `/wisp/concerns/${CONCERN_ID}/resolve`, { grantId: GRANT_ID, outcome: 'x'.repeat(1001) });
    expect(res.status).toBe(400);
  });
});
