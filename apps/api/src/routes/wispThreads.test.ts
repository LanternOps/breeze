/**
 * Wisp W04 Task 6 / 6b — thread routes, exercised THROUGH the W02 hub
 * (`wispRoutes`) so the inherited gates (auth → wispEnabled() 404 → partner
 * scope → ai_sessions:use → requireEntitlement('wisp')) are the real chain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => {
  class WispThreadError extends Error {
    constructor(public readonly code: string, message = code) {
      super(message);
      this.name = 'WispThreadError';
    }
  }
  return {
    WispThreadError,
    wispEnabled: vi.fn(() => true),
    captureEnabled: vi.fn(() => true),
    hasPerm: vi.fn<(resource: string, action: string) => boolean>(() => true),
    hasEntitlement: vi.fn(async () => true),
    getActiveGrantForUser: vi.fn(),
    wideningAvailable: vi.fn(async () => false),
    spendSummary: vi.fn(),
    getOrCreateThread: vi.fn(),
    setThreadFocus: vi.fn(),
    resolveGrantCeiling: vi.fn(),
    addThreadAttachment: vi.fn(),
    listThreadAttachments: vi.fn(),
    writeRouteAudit: vi.fn(),
    captureException: vi.fn(),
    /** Results handed to successive `await db.select()…` chains, in order. */
    dbResults: [] as unknown[][],
    whereArgs: [] as unknown[],
    orderByArgs: [] as unknown[][],
  };
});

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
  aiArtifactCaptureEnabled: () => h.captureEnabled(),
}));
vi.mock('../services/entitlements', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasEntitlement: h.hasEntitlement,
}));
vi.mock('../db', () => {
  const chain = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'leftJoin', 'limit']) p[m] = vi.fn(() => p);
    p.where = vi.fn((cond: unknown) => { h.whereArgs.push(cond); return p; });
    p.orderBy = vi.fn((...args: unknown[]) => { h.orderByArgs.push(args); return p; });
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(h.dbResults.shift() ?? []).then(res, rej);
    return p;
  };
  return {
    db: { select: vi.fn(() => chain()) },
    runAfterDbContextCommit: (_label: string, work: () => unknown) => { void work(); },
  };
});
vi.mock('../db/partnerAxisRead', () => ({
  readOwnPartnerAxisRows: async (_partnerId: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../services/wisp/grants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/wisp/grants')>()),
  getActiveGrantForUser: h.getActiveGrantForUser,
  wideningAvailable: h.wideningAvailable,
}));
vi.mock('../services/wisp/budget', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/wisp/budget')>()),
  spendSummary: h.spendSummary,
}));
vi.mock('../services/wisp/threads', () => ({
  getOrCreateThread: h.getOrCreateThread,
  setThreadFocus: h.setThreadFocus,
  WispThreadError: h.WispThreadError,
}));
vi.mock('../services/wisp/grantAuthority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/wisp/grantAuthority')>()),
  resolveGrantCeiling: h.resolveGrantCeiling,
}));
vi.mock('../services/wisp/threadAttachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/wisp/threadAttachments')>()),
  addThreadAttachment: h.addThreadAttachment,
  listThreadAttachments: h.listThreadAttachments,
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: h.writeRouteAudit }));
vi.mock('../services/sentry', () => ({ captureException: h.captureException }));

import { wispRoutes } from './wisp';
import { CeilingViolationError, GrantInactiveError } from '../services/wisp/grantAuthority';
import { ThreadAttachmentError, THREAD_ATTACHMENT_MAX_BYTES, THREAD_ATTACHMENT_MESSAGES } from '../services/wisp/threadAttachments';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const ORG2 = '22222222-2222-4222-8222-999999999999';
const USER = '33333333-3333-4333-8333-333333333333';
const GRANT_ID = '44444444-4444-4444-8444-444444444444';
const THREAD_ID = '55555555-5555-4555-8555-555555555555';
const REV = '66666666-6666-4666-8666-666666666666';
const ARTIFACT = '77777777-7777-4777-8777-777777777777';
const ATT_ID = '88888888-8888-4888-8888-888888888888';
const S1 = '99999999-9999-4999-8999-999999999991';
const S2 = '99999999-9999-4999-8999-999999999992';

const dialect = new PgDialect();
const compile = (cond: unknown) => dialect.sqlToQuery(cond as SQL);

const grant = (o: Record<string, unknown> = {}) => ({
  id: GRANT_ID, partnerId: PARTNER, orgId: null, grantorUserId: USER, grantee: 'wisp', currentRevisionId: REV,
  status: 'active', pausedReason: null, expiresAt: new Date('2027-04-01T00:00:00Z'), budgetCentsPerDay: 200, floorTickMinutes: 30, ...o,
});
const thread = (o: Record<string, unknown> = {}) => ({
  id: THREAD_ID, grantId: GRANT_ID, partnerId: PARTNER, summary: 'did things', summaryUpdatedAt: null,
  lastSessionId: null, focusOrgId: null, createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-02T00:00:00Z'), ...o,
});
/** The row `loadOwnThread` selects (thread columns + the owning grant's). */
const ownRow = (o: Record<string, unknown> = {}) => ({
  ...thread(),
  grantOrgId: null, grantStatus: 'active', grantRevisionId: REV, ...o,
});
const ceiling = { grantId: GRANT_ID, revisionId: REV, partnerId: PARTNER, orgIds: new Set([ORG]) };
const attachment = (o: Record<string, unknown> = {}) => ({
  id: ATT_ID, threadId: THREAD_ID, orgId: ORG, artifactId: ARTIFACT, label: 'notes.txt', addedByUserId: USER,
  contentType: 'text/plain', bytes: 11, expiresAt: new Date('2026-11-01T00:00:00Z'), createdAt: new Date('2026-10-02T00:00:00Z'), ...o,
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
      partnerOrgAccess: 'all',
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

const json = (app: Hono, method: string, path: string, body: unknown) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const multipart = (app: Hono, path: string, bytes: Uint8Array<ArrayBuffer> | string, filename = 'notes.txt', label?: string) => {
  const form = new FormData();
  form.append('file', new File([bytes], filename, { type: 'application/octet-stream' }));
  if (label !== undefined) form.append('label', label);
  return app.request(path, { method: 'POST', body: form });
};

/** The ownership predicate must pin the thread to the CALLER's own grant. */
function expectOwnershipWhere(cond: unknown) {
  const q = compile(cond);
  expect(q.sql).toContain('"wisp_threads"."id"');
  expect(q.sql).toContain('"wisp_grants"."grantor_user_id"');
  expect(q.sql).toContain('"wisp_threads"."partner_id"');
  expect(q.params).toEqual(expect.arrayContaining([THREAD_ID, USER, PARTNER]));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.dbResults.length = 0;
  h.whereArgs.length = 0;
  h.orderByArgs.length = 0;
  h.wispEnabled.mockReturnValue(true);
  h.captureEnabled.mockReturnValue(true);
  h.hasPerm.mockReturnValue(true);
  h.hasEntitlement.mockResolvedValue(true);
  h.wideningAvailable.mockResolvedValue(false);
  h.resolveGrantCeiling.mockResolvedValue(ceiling);
  h.spendSummary.mockResolvedValue({ spentTodayCents: 42, budgetCentsPerDay: 200, budgetResetsAt: new Date('2026-10-25T00:00:00Z') });
});

describe('GET /wisp/thread', () => {
  it('is 404 when wispEnabled() is false (entitled or not)', async () => {
    h.wispEnabled.mockReturnValue(false);
    for (const entitled of [true, false]) {
      h.hasEntitlement.mockResolvedValue(entitled);
      const res = await buildApp().request('/wisp/thread');
      expect(res.status).toBe(404);
    }
    expect(h.hasEntitlement).not.toHaveBeenCalled();
    expect(h.getActiveGrantForUser).not.toHaveBeenCalled();
  });

  it('is 403 entitlement_required when the partner lacks wisp', async () => {
    h.hasEntitlement.mockResolvedValue(false);
    const res = await buildApp().request('/wisp/thread');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'entitlement_required', error: 'Wisp', featureKey: 'wisp' });
    expect(h.hasEntitlement).toHaveBeenCalledWith(PARTNER, 'wisp');
    expect(h.getActiveGrantForUser).not.toHaveBeenCalled();
  });

  it('is 404 no_active_grant when the user has no grant for the scope', async () => {
    h.getActiveGrantForUser.mockResolvedValue(null);
    const res = await buildApp().request(`/wisp/thread?orgId=${ORG}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'no_active_grant' });
    expect(h.getActiveGrantForUser).toHaveBeenCalledWith(USER, { partnerId: PARTNER, orgId: ORG });
    expect(h.getOrCreateThread).not.toHaveBeenCalled();
  });

  it('a malformed orgId is 400', async () => {
    expect((await buildApp().request('/wisp/thread?orgId=nope')).status).toBe(400);
  });

  it.each([true, false])('returns the thread for the caller\'s own active grant and wideningAvailable=%s from W02', async (widening) => {
    h.getActiveGrantForUser.mockResolvedValue(grant());
    h.getOrCreateThread.mockResolvedValue(thread());
    h.wideningAvailable.mockResolvedValue(widening);
    const res = await buildApp().request('/wisp/thread');
    expect(res.status).toBe(200);
    expect(h.getActiveGrantForUser).toHaveBeenCalledWith(USER, { partnerId: PARTNER, orgId: null });
    expect(h.getOrCreateThread).toHaveBeenCalledWith(GRANT_ID);
    expect(h.wideningAvailable).toHaveBeenCalledWith(GRANT_ID);
    expect(h.spendSummary).toHaveBeenCalledWith(GRANT_ID);
    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      thread: {
        id: THREAD_ID, grantId: GRANT_ID, summary: 'did things', summaryUpdatedAt: null, lastSessionId: null,
        focusOrgId: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
      },
      focusOrgName: null,
      grant: {
        id: GRANT_ID, status: 'active', orgId: null, expiresAt: '2027-04-01T00:00:00.000Z',
        currentRevisionId: REV, budgetCentsPerDay: 200, floorTickMinutes: 30,
        // w00 A32 spend meter — field names are the cross-wave contract.
        spentTodayCents: 42, budgetResetsAt: '2026-10-25T00:00:00.000Z',
      },
      wideningAvailable: widening,
    });
  });

  it('returns thread.focusOrgId and focusOrgName (no org read when unfocused)', async () => {
    h.getActiveGrantForUser.mockResolvedValue(grant());
    h.getOrCreateThread.mockResolvedValue(thread({ focusOrgId: ORG }));
    h.dbResults.push([{ name: 'Acme Dental' }]);
    const res = await buildApp().request('/wisp/thread');
    const body = await res.json() as { data: { thread: { focusOrgId: string }; focusOrgName: string } };
    expect(body.data.thread.focusOrgId).toBe(ORG);
    expect(body.data.focusOrgName).toBe('Acme Dental');
    // The name read is pinned to the focus org AND the caller's partner.
    const q = compile(h.whereArgs[0]);
    expect(q.params).toEqual(expect.arrayContaining([ORG, PARTNER]));

    h.whereArgs.length = 0;
    h.getOrCreateThread.mockResolvedValue(thread());
    const unfocused = await (await buildApp().request('/wisp/thread')).json() as { data: { focusOrgName: unknown } };
    expect(unfocused.data.focusOrgName).toBeNull();
    expect(h.whereArgs).toHaveLength(0);
  });

  it('org-scoped tokens get 403 from requireScope (no entitlement lookup, no grant lookup)', async () => {
    const res = await buildApp({ scope: 'organization', orgId: ORG, partnerId: null }).request('/wisp/thread');
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('entitlement_required');
    expect(h.hasEntitlement).not.toHaveBeenCalled();
    expect(h.getActiveGrantForUser).not.toHaveBeenCalled();
  });

  it('is 403 without ai_sessions:use', async () => {
    h.hasPerm.mockImplementation((r, a) => !(r === 'ai_sessions' && a === 'use'));
    expect((await buildApp().request('/wisp/thread')).status).toBe(403);
    expect(h.getActiveGrantForUser).not.toHaveBeenCalled();
  });
});

describe('GET /wisp/thread/:id/sessions', () => {
  it('lists attached sessions newest first, pinned to the caller\'s own grant', async () => {
    h.dbResults.push([ownRow()]);
    h.dbResults.push([
      { sessionId: S2, orgId: ORG, attachedAt: new Date('2026-10-03T00:00:00Z'), title: 'second', status: 'active' },
      { sessionId: S1, orgId: ORG, attachedAt: new Date('2026-10-02T00:00:00Z'), title: null, status: 'closed' },
    ]);
    const res = await buildApp().request(`/wisp/thread/${THREAD_ID}/sessions`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [
        { sessionId: S2, orgId: ORG, attachedAt: '2026-10-03T00:00:00.000Z', title: 'second', status: 'active' },
        { sessionId: S1, orgId: ORG, attachedAt: '2026-10-02T00:00:00.000Z', title: null, status: 'closed' },
      ],
      nextCursor: null,
    });
    expectOwnershipWhere(h.whereArgs[0]);
    const listWhere = compile(h.whereArgs[1]);
    expect(listWhere.sql).toContain('"wisp_thread_sessions"."thread_id"');
    expect(listWhere.params).toContain(THREAD_ID);
    const order = h.orderByArgs[0]!.map((a) => compile(a).sql).join(', ');
    expect(order).toMatch(/"wisp_thread_sessions"."attached_at" desc/);
  });

  it('returns a nextCursor when there is another page, and accepts it back', async () => {
    h.dbResults.push([ownRow()]);
    h.dbResults.push([
      { sessionId: S2, orgId: ORG, attachedAt: new Date('2026-10-03T00:00:00Z'), title: null, status: 'active' },
      { sessionId: S1, orgId: ORG, attachedAt: new Date('2026-10-02T00:00:00Z'), title: null, status: 'active' },
    ]);
    const res = await buildApp().request(`/wisp/thread/${THREAD_ID}/sessions?limit=1`);
    const body = await res.json() as { data: unknown[]; nextCursor: string };
    expect(body.data).toHaveLength(1);
    expect(typeof body.nextCursor).toBe('string');

    h.whereArgs.length = 0;
    h.dbResults.push([ownRow()], []);
    const next = await buildApp().request(`/wisp/thread/${THREAD_ID}/sessions?limit=1&cursor=${encodeURIComponent(body.nextCursor)}`);
    expect(next.status).toBe(200);
    expect(compile(h.whereArgs[1]).params).toContain(S2);
    expect((await buildApp().request(`/wisp/thread/${THREAD_ID}/sessions?cursor=garbage`)).status).toBe(400);
  });

  it('refuses another user\'s thread with an existence-neutral 404 (and a non-uuid id)', async () => {
    h.dbResults.push([]);
    const res = await buildApp().request(`/wisp/thread/${THREAD_ID}/sessions`);
    expect(res.status).toBe(404);
    const missingBody = await res.json();
    expectOwnershipWhere(h.whereArgs[0]);
    const bad = await buildApp().request('/wisp/thread/not-a-uuid/sessions');
    expect(bad.status).toBe(404);
    // Same body for "not a uuid", "not yours" and "does not exist".
    expect(await bad.json()).toEqual(missingBody);
    expect(h.whereArgs).toHaveLength(1);
  });
});

describe('PATCH /wisp/thread/:id/focus', () => {
  it('calls setThreadFocus(thread.id, orgId, ceiling) and audits wisp.thread.focus_changed { from, to }', async () => {
    h.dbResults.push([ownRow()], [{ name: 'Acme Dental' }]);
    h.setThreadFocus.mockResolvedValue(thread({ focusOrgId: ORG }));
    const res = await json(buildApp(), 'PATCH', `/wisp/thread/${THREAD_ID}/focus`, { orgId: ORG });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { focusOrgId: ORG, focusOrgName: 'Acme Dental' } });
    expect(h.resolveGrantCeiling).toHaveBeenCalledWith(GRANT_ID, REV);
    expect(h.setThreadFocus).toHaveBeenCalledWith(THREAD_ID, ORG, ceiling);
    expect(h.writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(h.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'wisp.thread.focus_changed', resourceType: 'wisp_thread', resourceId: THREAD_ID,
      partnerId: PARTNER, details: { from: null, to: ORG },
    }));
    expectOwnershipWhere(h.whereArgs[0]);
  });

  it('null clears the focus', async () => {
    h.dbResults.push([ownRow({ focusOrgId: ORG })]);
    h.setThreadFocus.mockResolvedValue(thread({ focusOrgId: null }));
    const res = await json(buildApp(), 'PATCH', `/wisp/thread/${THREAD_ID}/focus`, { orgId: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { focusOrgId: null, focusOrgName: null } });
    expect(h.setThreadFocus).toHaveBeenCalledWith(THREAD_ID, null, ceiling);
    expect(h.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ details: { from: ORG, to: null } }));
  });

  it('CeilingViolationError → 403 wisp_outside_ceiling, no audit', async () => {
    h.dbResults.push([ownRow()]);
    h.setThreadFocus.mockRejectedValue(new CeilingViolationError('org', 'outside'));
    const res = await json(buildApp(), 'PATCH', `/wisp/thread/${THREAD_ID}/focus`, { orgId: ORG2 });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'wisp_outside_ceiling', detail: 'org' });
    expect(h.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('GrantInactiveError → 409 grant_inactive, setThreadFocus not reached', async () => {
    h.dbResults.push([ownRow()]);
    h.resolveGrantCeiling.mockRejectedValue(new GrantInactiveError(GRANT_ID, 'paused'));
    const res = await json(buildApp(), 'PATCH', `/wisp/thread/${THREAD_ID}/focus`, { orgId: ORG });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'grant_inactive' });
    expect(h.setThreadFocus).not.toHaveBeenCalled();
  });

  it('a CORRUPT grant pin → 500 grant_corrupt with plain copy, logged and captured (never a quiet grant_inactive)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.dbResults.push([ownRow()]);
    const corrupt = new GrantInactiveError(GRANT_ID, 'active', 'malformed ceiling snapshot', 'corrupt');
    h.resolveGrantCeiling.mockRejectedValue(corrupt);
    const res = await json(buildApp(), 'PATCH', `/wisp/thread/${THREAD_ID}/focus`, { orgId: ORG });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: 'grant_corrupt', error: "This Wisp grant can't be used. Turn Wisp off and on again." });
    expect(h.captureException).toHaveBeenCalledWith(corrupt, undefined, expect.objectContaining({ grantId: GRANT_ID }));
    expect(errSpy.mock.calls.some((args) => String(args[0]).includes(GRANT_ID))).toBe(true);
    expect(h.setThreadFocus).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('a CORRUPT pin thrown by setThreadFocus is the same 500 grant_corrupt', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.dbResults.push([ownRow()]);
    h.setThreadFocus.mockRejectedValue(new GrantInactiveError(GRANT_ID, 'active', 'x', 'corrupt'));
    const res = await json(buildApp(), 'PATCH', `/wisp/thread/${THREAD_ID}/focus`, { orgId: ORG });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'grant_corrupt' });
    expect(h.captureException).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('a grant with no current revision is 409 grant_inactive without resolving a ceiling', async () => {
    h.dbResults.push([ownRow({ grantRevisionId: null })]);
    const res = await json(buildApp(), 'PATCH', `/wisp/thread/${THREAD_ID}/focus`, { orgId: ORG });
    expect(res.status).toBe(409);
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
  });

  it('on another user\'s thread is 404 (no ceiling resolved, no write)', async () => {
    h.dbResults.push([]);
    const res = await json(buildApp(), 'PATCH', `/wisp/thread/${THREAD_ID}/focus`, { orgId: ORG });
    expect(res.status).toBe(404);
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
    expect(h.setThreadFocus).not.toHaveBeenCalled();
    expectOwnershipWhere(h.whereArgs[0]);
  });

  it('rejects a body without orgId or with a non-uuid (400)', async () => {
    expect((await json(buildApp(), 'PATCH', `/wisp/thread/${THREAD_ID}/focus`, {})).status).toBe(400);
    expect((await json(buildApp(), 'PATCH', `/wisp/thread/${THREAD_ID}/focus`, { orgId: 'x' })).status).toBe(400);
  });
});

describe('POST /wisp/thread/:id/attachments (6b)', () => {
  const path = `/wisp/thread/${THREAD_ID}/attachments`;

  it('multipart → 201 with the artifact id; classified from the bytes, audited', async () => {
    h.dbResults.push([ownRow({ focusOrgId: ORG })]);
    h.addThreadAttachment.mockResolvedValue(attachment({ contentType: 'text/csv', label: 'export.csv' }));
    const res = await multipart(buildApp(), path, 'a,b\n1,2\n', 'export.csv');
    expect(res.status).toBe(201);
    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ id: ATT_ID, artifactId: ARTIFACT, orgId: ORG, label: 'export.csv', contentType: 'text/csv' });
    expect(h.addThreadAttachment).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG, ceiling, text: 'a,b\n1,2\n', label: 'export.csv', contentType: 'text/csv', addedByUserId: USER,
      thread: expect.objectContaining({ id: THREAD_ID, grantId: GRANT_ID, partnerId: PARTNER }),
    }));
    expect(h.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'wisp.thread.attachment_added', resourceType: 'wisp_thread_attachment', resourceId: ATT_ID, orgId: ORG,
      details: { artifactId: ARTIFACT, bytes: 11, contentType: 'text/csv' },
    }));
  });

  it('uses the grant org when the thread is unfocused (org-scoped grant) and the label field over the filename', async () => {
    h.dbResults.push([ownRow({ grantOrgId: ORG })]);
    h.addThreadAttachment.mockResolvedValue(attachment());
    const res = await multipart(buildApp(), path, 'hello', 'x.txt', 'My notes');
    expect(res.status).toBe(201);
    expect(h.addThreadAttachment).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, label: 'My notes' }));
  });

  it('binary bytes → 415 even when the filename claims text', async () => {
    h.dbResults.push([ownRow({ focusOrgId: ORG })]);
    const res = await multipart(buildApp(), path, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), 'notes.txt');
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ code: 'unsupported_type' });
    expect(h.addThreadAttachment).not.toHaveBeenCalled();
  });

  it('> 5 MiB → 413 too_large without calling the store', async () => {
    h.dbResults.push([ownRow({ focusOrgId: ORG })]);
    const res = await multipart(buildApp(), path, 'a'.repeat(THREAD_ATTACHMENT_MAX_BYTES + 1));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: 'too_large' });
    expect(h.addThreadAttachment).not.toHaveBeenCalled();
  });

  it('a body past the route body limit is refused 413 before it is buffered (no thread read)', async () => {
    const res = await multipart(buildApp(), path, 'a'.repeat(7 * 1024 * 1024));
    expect(res.status).toBe(413);
    expect(h.addThreadAttachment).not.toHaveBeenCalled();
  });

  it('an unfocused partner-wide thread → 409 focus_required', async () => {
    h.dbResults.push([ownRow()]);
    const res = await multipart(buildApp(), path, 'hello');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'focus_required' });
    expect(h.addThreadAttachment).not.toHaveBeenCalled();
  });

  it('json { text, label } → 201', async () => {
    h.dbResults.push([ownRow({ focusOrgId: ORG })]);
    h.addThreadAttachment.mockResolvedValue(attachment({ label: 'pasted' }));
    const res = await json(buildApp(), 'POST', path, { text: 'pasted text', label: 'pasted' });
    expect(res.status).toBe(201);
    expect(h.addThreadAttachment).toHaveBeenCalledWith(expect.objectContaining({ text: 'pasted text', label: 'pasted', contentType: 'text/plain' }));
  });

  it('json with a NUL byte → 415; empty → 400; missing label → 400', async () => {
    h.dbResults.push([ownRow({ focusOrgId: ORG })], [ownRow({ focusOrgId: ORG })], [ownRow({ focusOrgId: ORG })]);
    expect((await json(buildApp(), 'POST', path, { text: 'a\u0000b', label: 'x' })).status).toBe(415);
    expect((await json(buildApp(), 'POST', path, { text: '   ', label: 'x' })).status).toBe(400);
    expect((await json(buildApp(), 'POST', path, { text: 'hi' })).status).toBe(400);
    expect(h.addThreadAttachment).not.toHaveBeenCalled();
  });

  it.each([
    ['too_many', 409],
    ['too_large', 413],
    ['unsupported_type', 415],
    ['empty', 400],
    ['org_outside_ceiling', 403],
    ['outside_ceiling', 403],
    ['store_unavailable', 503],
  ] as const)('ThreadAttachmentError %s → %i with the fixed user-facing copy, never the internal message', async (code, status) => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.dbResults.push([ownRow({ focusOrgId: ORG })]);
    const internal = `internal detail for ${code}: grant ${GRANT_ID} org ${ORG}`;
    h.addThreadAttachment.mockRejectedValue(new ThreadAttachmentError(code, internal));
    const res = await json(buildApp(), 'POST', path, { text: 'hello', label: 'x' });
    expect(res.status).toBe(status);
    const body = await res.json() as { code: string; error: string };
    expect(body).toEqual({ code, error: THREAD_ATTACHMENT_MESSAGES[code] });
    expect(body.error).not.toContain(GRANT_ID);
    expect(h.writeRouteAudit).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('store_unavailable is reported (cause captured + logged); a client-side refusal is not', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cause = new Error('S3 PUT timed out');
    h.dbResults.push([ownRow({ focusOrgId: ORG })]);
    h.addThreadAttachment.mockRejectedValueOnce(new ThreadAttachmentError('store_unavailable', 'the attachment store is unavailable', { cause }));
    expect((await json(buildApp(), 'POST', path, { text: 'hello', label: 'x' })).status).toBe(503);
    expect(h.captureException).toHaveBeenCalledTimes(1);
    expect(h.captureException).toHaveBeenCalledWith(cause);
    expect(errSpy).toHaveBeenCalled();

    h.captureException.mockClear();
    h.dbResults.push([ownRow({ focusOrgId: ORG })]);
    h.addThreadAttachment.mockRejectedValueOnce(new ThreadAttachmentError('too_many', 'a thread holds at most 20 attachments'));
    expect((await json(buildApp(), 'POST', path, { text: 'hello', label: 'x' })).status).toBe(409);
    expect(h.captureException).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('a CORRUPT grant pin → 500 grant_corrupt (captured), nothing stored', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.dbResults.push([ownRow({ focusOrgId: ORG })]);
    h.resolveGrantCeiling.mockRejectedValueOnce(new GrantInactiveError(GRANT_ID, 'active', 'revision of another grant', 'corrupt'));
    const res = await json(buildApp(), 'POST', path, { text: 'hello', label: 'x' });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'grant_corrupt' });
    expect(h.captureException).toHaveBeenCalledTimes(1);
    expect(h.addThreadAttachment).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('GrantInactiveError (resolve) and an inactive CeilingViolationError (store) → 409 grant_inactive', async () => {
    h.dbResults.push([ownRow({ focusOrgId: ORG })]);
    h.resolveGrantCeiling.mockRejectedValueOnce(new GrantInactiveError(GRANT_ID, 'revoked'));
    const a = await json(buildApp(), 'POST', path, { text: 'hello', label: 'x' });
    expect(a.status).toBe(409);
    expect(await a.json()).toMatchObject({ code: 'grant_inactive' });

    h.dbResults.push([ownRow({ focusOrgId: ORG })]);
    h.addThreadAttachment.mockRejectedValueOnce(new CeilingViolationError('inactive', 'paused'));
    const b = await json(buildApp(), 'POST', path, { text: 'hello', label: 'x' });
    expect(b.status).toBe(409);
    expect(await b.json()).toMatchObject({ code: 'grant_inactive' });
  });

  it('503 store_unavailable when artifact capture is disabled', async () => {
    h.captureEnabled.mockReturnValue(false);
    h.dbResults.push([ownRow({ focusOrgId: ORG })]);
    const res = await json(buildApp(), 'POST', path, { text: 'hello', label: 'x' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'store_unavailable' });
    expect(h.addThreadAttachment).not.toHaveBeenCalled();
  });

  it('another user\'s thread → 404 before anything else', async () => {
    h.dbResults.push([]);
    const res = await json(buildApp(), 'POST', path, { text: 'hello', label: 'x' });
    expect(res.status).toBe(404);
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
    expect(h.addThreadAttachment).not.toHaveBeenCalled();
    expectOwnershipWhere(h.whereArgs[0]);
  });
});

describe('GET /wisp/thread/:id/attachments (6b)', () => {
  it('lists live attachments newest first (service order kept), hiding orgs the caller cannot reach', async () => {
    h.dbResults.push([ownRow()]);
    h.listThreadAttachments.mockResolvedValue([
      attachment({ id: 'b', createdAt: new Date('2026-10-03T00:00:00Z') }),
      attachment({ id: 'x', orgId: ORG2 }),
      attachment({ id: 'a', createdAt: new Date('2026-10-01T00:00:00Z') }),
    ]);
    const res = await buildApp().request(`/wisp/thread/${THREAD_ID}/attachments`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ id: string; createdAt: string; expiresAt: string }> };
    expect(body.data.map((a) => a.id)).toEqual(['b', 'a']);
    expect(body.data[0]!.createdAt).toBe('2026-10-03T00:00:00.000Z');
    expect(h.listThreadAttachments).toHaveBeenCalledWith(THREAD_ID);
  });

  it('another user\'s thread → 404', async () => {
    h.dbResults.push([]);
    const res = await buildApp().request(`/wisp/thread/${THREAD_ID}/attachments`);
    expect(res.status).toBe(404);
    expect(h.listThreadAttachments).not.toHaveBeenCalled();
  });
});
