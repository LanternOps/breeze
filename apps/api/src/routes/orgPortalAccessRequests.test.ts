import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

/**
 * Route tests for the portal access-request queue (portal registration W3
 * #11380, Task 8). The Task 7 service is mocked here (its SQL is proven on
 * real Postgres in portalAccessRequests.integration.test.ts, which also runs
 * these routes through the real router); these pin the HTTP contract: gates,
 * validation, error mapping, sequential batch decisions, audit rows and which
 * email each decision sends (OD3).
 */
const h = vi.hoisted(() => {
  const organizations = { id: 'organizations.id', name: 'organizations.name', partnerId: 'organizations.partner_id', deletedAt: 'organizations.deleted_at' };
  const partners = { id: 'partners.id', name: 'partners.name' };
  const store = {
    // What the org lookup returns (the fake does not evaluate WHERE clauses).
    orgs: [] as Array<{ id: string; partnerId: string }>,
    // What the org + partner name read for the decision emails returns.
    branding: [] as Array<{ orgName: string | null; partnerName: string | null }>,
  };
  const chain = (rows: () => unknown[]) => ({
    where: () => ({ limit: async (n: number) => rows().slice(0, n) }),
  });
  const db = {
    select: vi.fn(() => ({
      from: () => ({ ...chain(() => store.orgs), leftJoin: () => chain(() => store.branding) }),
    })),
    // The request-transaction check /decide runs after an unexpected failure.
    execute: vi.fn(async () => []),
  };
  return {
    organizations,
    partners,
    store,
    db,
    authRef: { current: null as any },
    auditSpy: vi.fn(),
    approve: vi.fn(),
    deny: vi.fn(),
    list: vi.fn(),
    summarize: vi.fn(),
    issueAndSendInvite: vi.fn(),
    sendApproved: vi.fn(),
    sendDeclined: vi.fn(),
    emailConfigured: { current: true },
    // How many withDbTransaction savepoints are open right now. The email mocks
    // record it, so a decision email sent outside its own savepoint reds a test.
    txDepth: { current: 0 },
    sendDepths: [] as number[],
  };
});

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!h.authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', h.authRef.current);
    await next();
  }),
  // Real-shaped gates: each denies when the stub auth lacks what it checks, so a
  // dropped requireScope / requirePermission / requireMfa / requirePartner reds a test.
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    if (!scopes.includes(c.get('auth').scope)) return c.json({ error: 'Insufficient permissions' }, 403);
    await next();
  },
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    const perms: string[] | undefined = c.get('auth').perms;
    if (perms && !perms.includes(`${resource}:${action}`)) return c.json({ error: 'Permission denied' }, 403);
    await next();
  },
  requireMfa: () => async (c: any, next: any) => {
    if (c.get('auth').mfa === false) return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
    await next();
  },
  requirePartner: async (c: any, next: any) => {
    if (!c.get('auth')?.partnerId) return c.json({ error: 'Partner context required' }, 403);
    await next();
  },
}));

vi.mock('../db', () => ({
  db: h.db,
  hasDbAccessContext: () => true,
  withDbTransaction: async (fn: () => Promise<unknown>) => {
    h.txDepth.current += 1;
    try { return await fn(); } finally { h.txDepth.current -= 1; }
  },
  withDbTransactionIfHeld: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContextIsolated: (fn: () => unknown) => fn(),
}));

vi.mock('../db/schema', () => ({
  organizations: h.organizations,
  partners: h.partners,
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => h.auditSpy(...args),
}));

vi.mock('../services/portalAccessRequests', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/portalAccessRequests')>()),
  approvePortalAccessRequest: (...args: unknown[]) => h.approve(...args),
  denyPortalAccessRequest: (...args: unknown[]) => h.deny(...args),
  listPortalAccessRequests: (...args: unknown[]) => h.list(...args),
  summarizePendingPortalAccessRequests: (...args: unknown[]) => h.summarize(...args),
}));

vi.mock('../services/email', () => ({
  getEmailService: () => (h.emailConfigured.current
    ? { sendPortalAccessApproved: h.sendApproved, sendPortalAccessDeclined: h.sendDeclined }
    : null),
}));

vi.mock('./orgPortalUsers', () => ({
  issueAndSendInvite: (...args: unknown[]) => h.issueAndSendInvite(...args),
}));

vi.mock('./portal/helpers', () => ({
  buildPortalUrl: (path: string) => `https://portal.example${path}`,
}));

import { authMiddleware } from '../middleware/auth';
import { PortalAccessRequestError } from '../services/portalAccessRequests';
import { PORTAL_ACCOUNT_TRANSITION_REFUSED, PortalAccountTransitionError } from '../services/portalAccountState';
import { registerOrgPortalAccessRequestRoutes } from './orgPortalAccessRequests';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const OTHER_ORG_ID = '7c0a1f7e-9999-4222-8333-444455556666';
const REQ_1 = '0d3c2b1a-0000-4000-8000-000000000001';
const REQ_2 = '0d3c2b1a-0000-4000-8000-000000000002';
const REQ_3 = '0d3c2b1a-0000-4000-8000-000000000003';
const PU_1 = '5e5e5e5e-0000-4000-8000-000000000001';
const PU_3 = '5e5e5e5e-0000-4000-8000-000000000003';

const BASE = `/organizations/${ORG_ID}/portal-access-requests`;
const SUMMARY = '/partners/me/portal-access-requests/summary';

const FULL_ADMIN = {
  scope: 'partner',
  user: { id: 'u-1', name: 'Tess', email: 'tess@msp.example' },
  partnerId: 'p-1',
  orgId: null,
  partnerOrgAccess: 'all',
  canAccessOrg: (_id: string) => true,
};
const SELECTED = {
  ...FULL_ADMIN,
  user: { id: 'u-2', name: 'Sam', email: 'sam@msp.example' },
  partnerOrgAccess: 'selected',
  canAccessOrg: (id: string) => id === ORG_ID,
};
const NO_MFA = { ...FULL_ADMIN, mfa: false };
const SYSTEM = { ...FULL_ADMIN, scope: 'system', partnerId: null, canAccessOrg: () => true };

function makeApp() {
  const app = new Hono();
  app.use('*', authMiddleware as any);
  registerOrgPortalAccessRequestRoutes(app);
  return app;
}

const post = (path: string, body?: unknown) => makeApp().request(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

function approved(outcome: 'account_created' | 'invite_pending' | 'browser_access_granted', extra: Record<string, unknown> = {}) {
  return { outcome, portalUserId: PU_1, email: 'ada@customer.example', name: 'Ada', authEpoch: 3, source: 'entra', ...extra };
}

const accountExists = () => new PortalAccessRequestError(
  'PORTAL_ACCESS_REQUEST_ACCOUNT_EXISTS', 409, 'A portal account with this email already exists in this organization.',
);
const notPending = () => new PortalAccessRequestError(
  'PORTAL_ACCESS_REQUEST_NOT_PENDING', 409, 'This access request has already been decided or has expired.',
);
const notFound = () => new PortalAccessRequestError('PORTAL_ACCESS_REQUEST_NOT_FOUND', 404, 'Access request not found.');

function auditActions(): string[] {
  return h.auditSpy.mock.calls.map((call) => (call[1] as { action: string }).action);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.authRef.current = FULL_ADMIN;
  h.store.orgs = [{ id: ORG_ID, partnerId: 'p-1' }];
  h.store.branding = [{ orgName: 'Acme Co', partnerName: 'MSP Co' }];
  h.emailConfigured.current = true;
  h.txDepth.current = 0;
  h.sendDepths.length = 0;
  h.approve.mockReset();
  h.deny.mockReset();
  h.list.mockReset();
  h.summarize.mockReset();
  h.auditSpy.mockReset();
  h.issueAndSendInvite.mockReset().mockImplementation(async () => { h.sendDepths.push(h.txDepth.current); return true; });
  h.sendApproved.mockReset().mockImplementation(async () => { h.sendDepths.push(h.txDepth.current); });
  h.sendDeclined.mockReset().mockImplementation(async () => { h.sendDepths.push(h.txDepth.current); });
});

/** A Drizzle-shaped query failure: its message carries the statement and its bound values. */
function queryFailure(value: string): Error {
  return Object.assign(new Error(`Failed query: select "id" from "partners" where "email" = $1\nparams: ${value}`), {
    cause: Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
  });
}

/** Everything console.error was called with, as one string. */
function logged(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.flat().map((v) => (v instanceof Error ? `${v.message}\n${String(v.cause)}` : String(v))).join('\n');
}

describe('GET /organizations/:id/portal-access-requests', () => {
  it('GET pending lists live requests only; expired rows read status expired under ?status=decided', async () => {
    const live = { id: REQ_1, email: 'a@c.example', status: 'pending' };
    const expired = { id: REQ_2, email: 'b@c.example', status: 'expired' };
    h.list.mockImplementation(async (_orgId: string, opts: { status: string }) => (
      opts.status === 'pending' ? { items: [live], hasMore: false } : { items: [expired], hasMore: true }
    ));

    const pending = await makeApp().request(BASE);
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ data: [live], hasMore: false });
    // No ?status means the live queue.
    expect(h.list).toHaveBeenLastCalledWith(ORG_ID, { status: 'pending' });

    const decided = await makeApp().request(`${BASE}?status=decided&limit=50`);
    expect(decided.status).toBe(200);
    expect(await decided.json()).toEqual({ data: [expired], hasMore: true });
    expect(h.list).toHaveBeenLastCalledWith(ORG_ID, { status: 'decided', limit: 50 });
  });

  it('a bad ?status or limit is a 400, not a 500, and reads nothing', async () => {
    expect((await makeApp().request(`${BASE}?status=everything`)).status).toBe(400);
    expect((await makeApp().request(`${BASE}?limit=0`)).status).toBe(400);
    expect((await makeApp().request(`${BASE}?limit=201`)).status).toBe(400);
    expect(h.list).not.toHaveBeenCalled();
  });

  it('an org the selected-orgs caller cannot reach is a 404 and reads nothing', async () => {
    h.authRef.current = SELECTED;
    const res = await makeApp().request(`/organizations/${OTHER_ORG_ID}/portal-access-requests`);
    expect(res.status).toBe(404);
    expect(h.list).not.toHaveBeenCalled();
  });

  it('a missing ORGS_READ permission is refused', async () => {
    h.authRef.current = { ...FULL_ADMIN, perms: ['organizations:write'] };
    expect((await makeApp().request(BASE)).status).toBe(403);
    expect(h.list).not.toHaveBeenCalled();
  });
});

describe('POST approve / deny', () => {
  it('approve self sends the invite email; approve entra sends the approved email; deny sends the declined email', async () => {
    // self → invite_pending → the normal invite (OD3), never the "you can sign in" email.
    h.approve.mockResolvedValueOnce(approved('invite_pending', { source: 'self', authEpoch: 7 }));
    const self = await post(`${BASE}/${REQ_1}/approve`);
    expect(self.status).toBe(200);
    expect(await self.json()).toEqual({ data: { outcome: 'invite_pending', portalUserId: PU_1 }, emailSent: true });
    expect(h.approve).toHaveBeenLastCalledWith({ orgId: ORG_ID, requestId: REQ_1, deciderUserId: 'u-1' });
    expect(h.issueAndSendInvite).toHaveBeenCalledTimes(1);
    expect(h.issueAndSendInvite.mock.calls[0]!.slice(1)).toEqual([
      ORG_ID, { id: PU_1, email: 'ada@customer.example', authEpoch: 7 }, 'Acme Co', 'Tess',
    ]);
    expect(h.sendApproved).not.toHaveBeenCalled();

    // entra → account_created → the approved email with the portal sign-in link.
    h.approve.mockResolvedValueOnce(approved('account_created', { portalUserId: PU_3 }));
    const entra = await post(`${BASE}/${REQ_2}/approve`);
    expect(entra.status).toBe(200);
    expect(await entra.json()).toEqual({ data: { outcome: 'account_created', portalUserId: PU_3 }, emailSent: true });
    expect(h.sendApproved).toHaveBeenCalledWith({
      to: 'ada@customer.example',
      loginUrl: 'https://portal.example/login',
      orgName: 'Acme Co',
      partnerId: 'p-1',
      partnerName: 'MSP Co',
    });
    expect(h.issueAndSendInvite).toHaveBeenCalledTimes(1);

    // addin_user → browser_access_granted → the approved email too.
    h.approve.mockResolvedValueOnce(approved('browser_access_granted', { source: 'addin_user' }));
    expect((await post(`${BASE}/${REQ_3}/approve`)).status).toBe(200);
    expect(h.sendApproved).toHaveBeenCalledTimes(2);

    // deny → the neutral declined email.
    h.deny.mockResolvedValueOnce({ email: 'bob@customer.example', source: 'google' });
    const denied = await post(`${BASE}/${REQ_1}/deny`);
    expect(denied.status).toBe(200);
    expect(await denied.json()).toEqual({ data: { status: 'denied' }, emailSent: true });
    expect(h.deny).toHaveBeenLastCalledWith({ orgId: ORG_ID, requestId: REQ_1, deciderUserId: 'u-1' });
    expect(h.sendDeclined).toHaveBeenCalledWith({
      to: 'bob@customer.example', orgName: 'Acme Co', partnerId: 'p-1', partnerName: 'MSP Co',
    });

    expect(auditActions()).toEqual([
      'organization.portal_user.access_request.approve',
      'organization.portal_user.access_request.approve',
      'organization.portal_user.access_request.approve',
      'organization.portal_user.access_request.deny',
    ]);
    expect(h.auditSpy.mock.calls[0]![1]).toEqual({
      orgId: ORG_ID,
      action: 'organization.portal_user.access_request.approve',
      resourceType: 'portal_access_request',
      resourceId: REQ_1,
      details: { source: 'self', outcome: 'invite_pending', portalUserId: PU_1, email: 'ada@customer.example' },
    });
    expect(h.auditSpy.mock.calls[3]![1]).toEqual({
      orgId: ORG_ID,
      action: 'organization.portal_user.access_request.deny',
      resourceType: 'portal_access_request',
      resourceId: REQ_1,
      details: { source: 'google', outcome: 'denied', portalUserId: null, email: 'bob@customer.example' },
    });
  });

  it('approve maps ACCOUNT_EXISTS to 409 with code and writes no audit', async () => {
    h.approve.mockRejectedValueOnce(accountExists());
    const res = await post(`${BASE}/${REQ_1}/approve`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'A portal account with this email already exists in this organization.',
      code: 'PORTAL_ACCESS_REQUEST_ACCOUNT_EXISTS',
    });
    expect(h.auditSpy).not.toHaveBeenCalled();
    expect(h.sendApproved).not.toHaveBeenCalled();
    expect(h.issueAndSendInvite).not.toHaveBeenCalled();
  });

  it('approve maps PortalAccountTransitionError to its status and code', async () => {
    h.approve.mockRejectedValueOnce(new PortalAccountTransitionError(
      PORTAL_ACCOUNT_TRANSITION_REFUSED, 409, 'access_request_approve', 'epoch_moved',
      'This account changed while it was being approved. Try again.',
    ));
    const res = await post(`${BASE}/${REQ_1}/approve`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'This account changed while it was being approved. Try again.',
      code: PORTAL_ACCOUNT_TRANSITION_REFUSED,
    });
    expect(h.auditSpy).not.toHaveBeenCalled();
  });

  it('approve for a request in another org → 404 PORTAL_ACCESS_REQUEST_NOT_FOUND', async () => {
    // The service reads the request by (id, org_id) together: a sibling org's id is not found.
    h.approve.mockImplementation(async ({ orgId }: { orgId: string }) => {
      if (orgId === ORG_ID) throw notFound();
      return approved('account_created');
    });
    const res = await post(`${BASE}/${REQ_2}/approve`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Access request not found.', code: 'PORTAL_ACCESS_REQUEST_NOT_FOUND' });
    expect(h.approve).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_ID, requestId: REQ_2 }));
    expect(h.auditSpy).not.toHaveBeenCalled();

    // And an org outside the caller's reach is refused before the service runs.
    h.authRef.current = SELECTED;
    h.approve.mockClear();
    const hidden = await post(`/organizations/${OTHER_ORG_ID}/portal-access-requests/${REQ_2}/approve`);
    expect(hidden.status).toBe(404);
    expect(h.approve).not.toHaveBeenCalled();
  });

  it.each(['approve', 'deny'] as const)('%s: an unexpected plain Error from the service is a 500 with no audit row and no email', async (action) => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      h[action].mockRejectedValueOnce(new Error('connection reset by peer'));
      const res = await post(`${BASE}/${REQ_1}/${action}`);
      expect(res.status).toBe(500);
      expect(h.auditSpy).not.toHaveBeenCalled();
      expect(h.sendApproved).not.toHaveBeenCalled();
      expect(h.sendDeclined).not.toHaveBeenCalled();
      expect(h.issueAndSendInvite).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('deny of a decided request → 409 NOT_PENDING, no audit, no email', async () => {
    h.deny.mockRejectedValueOnce(notPending());
    const res = await post(`${BASE}/${REQ_1}/deny`);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PORTAL_ACCESS_REQUEST_NOT_PENDING');
    expect(h.auditSpy).not.toHaveBeenCalled();
    expect(h.sendDeclined).not.toHaveBeenCalled();
  });

  it('a failed email send is logged and does not undo the approval', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.approve.mockResolvedValueOnce(approved('account_created'));
    h.sendApproved.mockRejectedValueOnce(new Error('smtp down'));
    const res = await post(`${BASE}/${REQ_1}/approve`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { outcome: 'account_created', portalUserId: PU_1 }, emailSent: false });
    expect(auditActions()).toEqual(['organization.portal_user.access_request.approve']);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('each decision email runs in its own savepoint, so a failed DB read on the send path leaves the decision standing (emailSent false)', async () => {
    // The send path reads the database (the partner-lane sender lookup,
    // issueAndSendInvite's branding read). In the request transaction a failed
    // read there would roll the decision back at commit (#11203), so each send
    // runs inside withDbTransaction with the catch outside it.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fail = async () => { h.sendDepths.push(h.txDepth.current); throw queryFailure('secret-sender@msp.example'); };
    h.sendApproved.mockImplementation(fail);
    h.sendDeclined.mockImplementation(fail);
    h.issueAndSendInvite.mockImplementation(fail);
    h.approve
      .mockResolvedValueOnce(approved('account_created'))
      .mockResolvedValueOnce(approved('invite_pending', { source: 'self' }));
    h.deny.mockResolvedValueOnce({ email: 'bob@customer.example', source: 'google' });

    const entra = await post(`${BASE}/${REQ_1}/approve`);
    expect(entra.status).toBe(200);
    expect(await entra.json()).toEqual({ data: { outcome: 'account_created', portalUserId: PU_1 }, emailSent: false });
    const self = await post(`${BASE}/${REQ_2}/approve`);
    expect(self.status).toBe(200);
    expect(await self.json()).toEqual({ data: { outcome: 'invite_pending', portalUserId: PU_1 }, emailSent: false });
    const denied = await post(`${BASE}/${REQ_3}/deny`);
    expect(denied.status).toBe(200);
    expect(await denied.json()).toEqual({ data: { status: 'denied' }, emailSent: false });

    // Every send ran one savepoint deep, and the catch sat outside it.
    expect(h.sendDepths).toEqual([1, 1, 1]);
    expect(h.txDepth.current).toBe(0);
    expect(auditActions()).toEqual([
      'organization.portal_user.access_request.approve',
      'organization.portal_user.access_request.approve',
      'organization.portal_user.access_request.deny',
    ]);
    // Logged without the statement's bound values.
    expect(logged(errSpy)).not.toContain('secret-sender@msp.example');
    errSpy.mockRestore();
  });

  it('a throwing audit write after the decision is logged; the response and the email still go out', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.auditSpy.mockImplementation(() => { throw new Error('audit params blew up'); });
    h.approve.mockResolvedValueOnce(approved('account_created'));
    const res = await post(`${BASE}/${REQ_1}/approve`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { outcome: 'account_created', portalUserId: PU_1 }, emailSent: true });
    expect(h.sendApproved).toHaveBeenCalledTimes(1);

    h.deny.mockResolvedValueOnce({ email: 'bob@customer.example', source: 'self' });
    const denied = await post(`${BASE}/${REQ_2}/deny`);
    expect(denied.status).toBe(200);
    expect(await denied.json()).toEqual({ data: { status: 'denied' }, emailSent: true });
    expect(h.sendDeclined).toHaveBeenCalledTimes(1);
    expect(logged(errSpy)).toContain('audit params blew up');
    errSpy.mockRestore();
  });

  it('no email service configured: the decision stands and emailSent is false', async () => {
    h.emailConfigured.current = false;
    h.deny.mockResolvedValueOnce({ email: 'bob@customer.example', source: 'self' });
    const res = await post(`${BASE}/${REQ_1}/deny`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: 'denied' }, emailSent: false });
    expect(auditActions()).toEqual(['organization.portal_user.access_request.deny']);
  });

  it('a system-scope caller sends from the platform sender (partnerId null, from the verified auth context)', async () => {
    h.authRef.current = SYSTEM;
    h.approve.mockResolvedValueOnce(approved('account_created'));
    expect((await post(`${BASE}/${REQ_1}/approve`)).status).toBe(200);
    expect(h.sendApproved).toHaveBeenCalledWith(expect.objectContaining({ partnerId: null }));
  });

  it('a malformed :requestId or :id is a 400, not a 500, and the service never runs', async () => {
    expect((await post(`${BASE}/not-a-uuid/approve`)).status).toBe(400);
    expect((await post(`${BASE}/not-a-uuid/deny`)).status).toBe(400);
    expect((await post(`/organizations/not-a-uuid/portal-access-requests/${REQ_1}/approve`)).status).toBe(400);
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.deny).not.toHaveBeenCalled();
  });

  it('approve without MFA → requireMfa refusal', async () => {
    h.authRef.current = NO_MFA;
    for (const path of [`${BASE}/${REQ_1}/approve`, `${BASE}/${REQ_1}/deny`]) {
      const res = await post(path);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('MFA_REQUIRED');
    }
    const decide = await post(`${BASE}/decide`, { requestIds: [REQ_1], decision: 'approve' });
    expect(decide.status).toBe(403);
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.deny).not.toHaveBeenCalled();
  });

  it('a missing ORGS_WRITE permission is refused', async () => {
    h.authRef.current = { ...FULL_ADMIN, perms: ['organizations:read'] };
    expect((await post(`${BASE}/${REQ_1}/approve`)).status).toBe(403);
    expect(h.approve).not.toHaveBeenCalled();
  });
});

describe('POST /organizations/:id/portal-access-requests/decide', () => {
  it('decide processes ids in ascending id order, one at a time, and reports results in the input order', async () => {
    const events: string[] = [];
    h.approve.mockImplementation(async ({ requestId }: { requestId: string }) => {
      events.push(`start:${requestId}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`end:${requestId}`);
      if (requestId === REQ_2) throw notPending();
      return requestId === REQ_1
        ? approved('account_created', { portalUserId: PU_1 })
        : approved('invite_pending', { portalUserId: PU_3, source: 'self', email: 'cy@customer.example' });
    });

    const res = await post(`${BASE}/decide`, { requestIds: [REQ_3, REQ_1, REQ_2], decision: 'approve' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [
        { requestId: REQ_3, result: 'approved' },
        { requestId: REQ_1, result: 'approved' },
        { requestId: REQ_2, result: 'PORTAL_ACCESS_REQUEST_NOT_PENDING' },
      ],
    });
    // Ascending id order whatever the client sent (two overlapping batches then
    // take the request row locks in the same order and cannot deadlock), and
    // sequential, never Promise.all: each call finishes before the next starts.
    expect(events).toEqual([
      `start:${REQ_1}`, `end:${REQ_1}`, `start:${REQ_2}`, `end:${REQ_2}`, `start:${REQ_3}`, `end:${REQ_3}`,
    ]);
    // One audit row per decided request, none for the refused one.
    expect(h.auditSpy.mock.calls.map((call) => (call[1] as { resourceId: string }).resourceId)).toEqual([REQ_1, REQ_3]);
    expect(auditActions()).toEqual([
      'organization.portal_user.access_request.approve',
      'organization.portal_user.access_request.approve',
    ]);
    expect(h.sendApproved).toHaveBeenCalledTimes(1);
    expect(h.issueAndSendInvite).toHaveBeenCalledTimes(1);
    expect(h.issueAndSendInvite.mock.calls[0]![2]).toEqual({ id: PU_3, email: 'cy@customer.example', authEpoch: 3 });
  });

  it('decide deny reports each id and sends one declined email per denied request', async () => {
    h.deny
      .mockResolvedValueOnce({ email: 'a@customer.example', source: 'self' })
      .mockRejectedValueOnce(notFound());
    const res = await post(`${BASE}/decide`, { requestIds: [REQ_1, REQ_2], decision: 'deny' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [
        { requestId: REQ_1, result: 'denied' },
        { requestId: REQ_2, result: 'PORTAL_ACCESS_REQUEST_NOT_FOUND' },
      ],
    });
    expect(h.deny.mock.calls.map((call) => (call[0] as { requestId: string }).requestId)).toEqual([REQ_1, REQ_2]);
    expect(auditActions()).toEqual(['organization.portal_user.access_request.deny']);
    expect(h.sendDeclined).toHaveBeenCalledTimes(1);
    expect(h.approve).not.toHaveBeenCalled();
  });

  it('an unexpected per-id failure is INTERNAL_ERROR and the batch completes: every committed decision is audited and emailed', async () => {
    // A handler's throw is NOT a rollback: Hono turns it into a 500 and the
    // request transaction commits whatever was decided before it. So the loop
    // must catch everything and finish, or earlier approvals commit unannounced.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.approve.mockImplementation(async ({ requestId }: { requestId: string }) => {
      if (requestId === REQ_2) throw queryFailure('secret-row@customer.example');
      return requestId === REQ_1
        ? approved('account_created', { portalUserId: PU_1, email: 'ada@customer.example' })
        : approved('account_created', { portalUserId: PU_3, email: 'cy@customer.example' });
    });
    const res = await post(`${BASE}/decide`, { requestIds: [REQ_1, REQ_2, REQ_3], decision: 'approve' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [
        { requestId: REQ_1, result: 'approved' },
        { requestId: REQ_2, result: 'INTERNAL_ERROR' },
        { requestId: REQ_3, result: 'approved' },
      ],
    });
    expect(h.approve).toHaveBeenCalledTimes(3);
    expect(h.auditSpy.mock.calls.map((call) => (call[1] as { resourceId: string }).resourceId)).toEqual([REQ_1, REQ_3]);
    expect(h.sendApproved.mock.calls.map((call) => (call[0] as { to: string }).to))
      .toEqual(['ada@customer.example', 'cy@customer.example']);
    // Logged with the id, without the statement's bound values.
    expect(logged(errSpy)).toContain(REQ_2);
    expect(logged(errSpy)).not.toContain('secret-row@customer.example');
    errSpy.mockRestore();
  });

  it('after an unexpected failure that broke the request transaction, nothing is announced: 500, no audit, no email', async () => {
    // An id's savepoint normally contains its failure. A lost connection does
    // not: then nothing will commit, and an audit row (written on its own
    // connection) or an email would announce decisions that roll back.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.approve.mockImplementation(async ({ requestId }: { requestId: string }) => {
      if (requestId === REQ_2) throw new Error('write CONNECTION_CLOSED');
      return approved('account_created');
    });
    h.db.execute.mockRejectedValueOnce(new Error('write CONNECTION_CLOSED'));
    const res = await post(`${BASE}/decide`, { requestIds: [REQ_1, REQ_2, REQ_3], decision: 'approve' });
    expect(res.status).toBe(500);
    expect(h.approve).toHaveBeenCalledTimes(3);
    expect(h.db.execute).toHaveBeenCalledTimes(1);
    expect(h.auditSpy).not.toHaveBeenCalled();
    expect(h.sendApproved).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('a batch with only refusals and successes runs no transaction check', async () => {
    h.deny.mockResolvedValueOnce({ email: 'a@customer.example', source: 'self' }).mockRejectedValueOnce(notPending());
    expect((await post(`${BASE}/decide`, { requestIds: [REQ_1, REQ_2], decision: 'deny' })).status).toBe(200);
    expect(h.db.execute).not.toHaveBeenCalled();
  });

  it('a duplicate id (in any letter case) is decided once and every occurrence reports that result', async () => {
    h.deny.mockImplementation(async ({ requestId }: { requestId: string }) => {
      if (requestId === REQ_2) throw notFound();
      return { email: 'a@customer.example', source: 'self' };
    });
    const upper = REQ_1.toUpperCase();
    const res = await post(`${BASE}/decide`, { requestIds: [REQ_2, upper, REQ_2, REQ_1], decision: 'deny' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [
        { requestId: REQ_2, result: 'PORTAL_ACCESS_REQUEST_NOT_FOUND' },
        { requestId: upper, result: 'denied' },
        { requestId: REQ_2, result: 'PORTAL_ACCESS_REQUEST_NOT_FOUND' },
        { requestId: REQ_1, result: 'denied' },
      ],
    });
    expect(h.deny.mock.calls.map((call) => (call[0] as { requestId: string }).requestId)).toEqual([REQ_1, REQ_2]);
    expect(auditActions()).toEqual(['organization.portal_user.access_request.deny']);
    expect(h.sendDeclined).toHaveBeenCalledTimes(1);
  });

  it('a decide batch sends every email in its own savepoint and a throwing audit does not stop the rest', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.auditSpy.mockImplementationOnce(() => { throw new Error('audit params blew up'); });
    h.sendApproved.mockImplementationOnce(async () => { h.sendDepths.push(h.txDepth.current); throw queryFailure('x@y.example'); });
    h.approve.mockImplementation(async ({ requestId }: { requestId: string }) => (
      requestId === REQ_3
        ? approved('invite_pending', { portalUserId: PU_3, source: 'self' })
        : approved('account_created', { portalUserId: PU_1 })
    ));
    const res = await post(`${BASE}/decide`, { requestIds: [REQ_1, REQ_2, REQ_3], decision: 'approve' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.map((d: { result: string }) => d.result)).toEqual(['approved', 'approved', 'approved']);
    expect(h.auditSpy).toHaveBeenCalledTimes(3);
    expect(h.sendApproved).toHaveBeenCalledTimes(2);
    expect(h.issueAndSendInvite).toHaveBeenCalledTimes(1);
    expect(h.sendDepths).toEqual([1, 1, 1]);
    errSpy.mockRestore();
  });

  it('decide with 101 ids → 400', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `0d3c2b1a-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const res = await post(`${BASE}/decide`, { requestIds: ids, decision: 'approve' });
    expect(res.status).toBe(400);
    expect(h.approve).not.toHaveBeenCalled();
  });

  it('decide refuses an empty list, a bad decision and a non-uuid id with 400', async () => {
    expect((await post(`${BASE}/decide`, { requestIds: [], decision: 'approve' })).status).toBe(400);
    expect((await post(`${BASE}/decide`, { requestIds: [REQ_1], decision: 'maybe' })).status).toBe(400);
    expect((await post(`${BASE}/decide`, { requestIds: ['nope'], decision: 'deny' })).status).toBe(400);
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.deny).not.toHaveBeenCalled();
  });

  it('/decide and /:requestId/approve route to their own handlers', async () => {
    h.approve.mockResolvedValue(approved('account_created'));
    const decide = await post(`${BASE}/decide`, { requestIds: [REQ_1], decision: 'approve' });
    expect(await decide.json()).toEqual({ data: [{ requestId: REQ_1, result: 'approved' }] });
    const single = await post(`${BASE}/${REQ_2}/approve`);
    expect((await single.json()).data).toEqual({ outcome: 'account_created', portalUserId: PU_1 });
    expect(h.approve.mock.calls.map((call) => (call[0] as { requestId: string }).requestId)).toEqual([REQ_1, REQ_2]);
  });
});

describe('GET /partners/me/portal-access-requests/summary', () => {
  it('summary counts pending per accessible org only (selected-orgs partner user)', async () => {
    h.authRef.current = SELECTED;
    h.summarize.mockResolvedValueOnce({
      pendingTotal: 7,
      orgs: [
        { orgId: ORG_ID, orgName: 'Acme Co', pending: 3 },
        { orgId: OTHER_ORG_ID, orgName: 'Hidden Co', pending: 4 },
      ],
    });
    const res = await makeApp().request(SUMMARY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { pendingTotal: 3, orgs: [{ orgId: ORG_ID, orgName: 'Acme Co', pending: 3 }] },
    });
  });

  it('a full-access partner user sees every org the service returns', async () => {
    const summary = { pendingTotal: 5, orgs: [{ orgId: ORG_ID, orgName: 'Acme Co', pending: 5 }] };
    h.summarize.mockResolvedValueOnce(summary);
    const res = await makeApp().request(SUMMARY);
    expect(await res.json()).toEqual({ data: summary });
  });

  it('is partner-scope only', async () => {
    h.authRef.current = SYSTEM;
    expect((await makeApp().request(SUMMARY)).status).toBe(403);
    h.authRef.current = { ...FULL_ADMIN, perms: [] };
    expect((await makeApp().request(SUMMARY)).status).toBe(403);
    expect(h.summarize).not.toHaveBeenCalled();
  });
});
