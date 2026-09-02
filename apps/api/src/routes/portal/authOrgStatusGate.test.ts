/**
 * Org-status gate on `portalAuthMiddleware` (org-lifecycle Wave 2, Task 3 C2).
 *
 * A portal session is an opaque Redis/in-memory token, so none of the fences
 * the rest of the platform relies on reach it: the auth-epoch bump only kills
 * JWTs, and the session record itself carries no org state. Before this gate,
 * a portal user kept full read/write access to an org that had been suspended,
 * offboarded, archived, or fenced into `merging` for an org merge — and during
 * a merge those writes land under the loser org after the fence, where they
 * are stranded by the re-tenant or destroyed by the erasure that follows.
 *
 * These tests drive the real middleware and assert the gate is the thing
 * rejecting the request (403 + the session purged), not the pre-existing
 * portal_users status check.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { portalUserRow, activeOrgResult } = vi.hoisted(() => ({
  portalUserRow: { current: null as Record<string, unknown> | null },
  activeOrgResult: { current: null as { orgId: string; partnerId: string } | null },
}));

// The select mock APPLIES the projection rather than echoing the whole fixture
// row. Without that, `select({ id, orgId, ... })` is unobservable and any
// assertion about which columns the middleware hydrates is vacuous — deleting
// `contactId: portalUsers.contactId` from the real query would still return it
// (verified: the naive echo mock kept these tests green through exactly that
// mutation).
function project(columns: Record<string, unknown>): Array<Record<string, unknown>> {
  const row = portalUserRow.current;
  if (!row) return [];
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(columns)) out[key] = row[key] ?? null;
  return [out];
}

vi.mock('../../db', () => ({
  db: {
    select: (columns: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(project(columns)) }),
      }),
    }),
  },
  withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
}));
vi.mock('../../db/schema', () => ({
  discoveredAssetTypeEnum: { enumValues: [] },
  portalUsers: {
    id: 'id',
    orgId: 'orgId',
    email: 'email',
    name: 'name',
    contactId: 'contactId',
    receiveNotifications: 'receiveNotifications',
    status: 'status',
  },
  portalBranding: { orgId: 'orgId', enablePasswordReset: 'enablePasswordReset' },
}));
vi.mock('../../services/email', () => ({ getEmailService: () => null }));

// The gate delegates the whole "is this org usable" question to the shared
// tenant-status machinery, so the test drives THAT boundary rather than
// re-implementing status rules it must never diverge from.
vi.mock('../../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async () => activeOrgResult.current),
  isUsableOrgStatus: (s: string) => s === 'active' || s === 'trial',
  invalidateAgentTenantCache: vi.fn(async () => undefined),
}));

import { portalAuthMiddleware } from './auth';
import { portalSessions } from './helpers';
import { getActiveOrgTenant } from '../../services/tenantStatus';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const USER_ID = '11111111-2222-4333-8444-555566667777';
const TOKEN = 'portal-session-token-for-gate-test';
const CONTACT_ID = '99999999-8888-4777-8666-555544443333';

function makeApp() {
  const app = new Hono();
  app.use('/protected', portalAuthMiddleware);
  // Echoes the hydrated context so the contact link (#3258 W03) is asserted on
  // what the REAL middleware produced, not on a hand-built fixture. Every
  // portal ticket read is `submitted_by = me OR requester_contact_id = my
  // contact`, so an un-hydrated contactId is a silently narrowed query, not a
  // type error.
  app.get('/protected', (c) => c.json({ ok: true, user: c.get('portalAuth').user }));
  return app;
}

const call = () =>
  makeApp().request('/protected', { headers: { Authorization: `Bearer ${TOKEN}` } });

function seedSession() {
  portalSessions.set(TOKEN, {
    token: TOKEN,
    portalUserId: USER_ID,
    orgId: ORG_ID,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  portalSessions.clear();
  portalUserRow.current = {
    id: USER_ID,
    orgId: ORG_ID,
    email: 'cust@acme.example',
    name: 'Cust',
    contactId: CONTACT_ID,
    receiveNotifications: true,
    status: 'active',
  };
  activeOrgResult.current = { orgId: ORG_ID, partnerId: 'partner-1' };
});

describe('portalAuthMiddleware org-status gate', () => {
  it('admits an active portal user whose org is usable', async () => {
    seedSession();
    const res = await call();
    expect(res.status).toBe(200);
    expect(getActiveOrgTenant).toHaveBeenCalledWith(ORG_ID);
    // A passing gate must not disturb the session.
    expect(portalSessions.has(TOKEN)).toBe(true);
  });

  it("rejects a session whose org is fenced for a merge ('merging')", async () => {
    seedSession();
    // getActiveOrgTenant returns null for any non-usable status, `merging`
    // included — that is exactly the merge fence reaching the portal.
    activeOrgResult.current = null;
    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Organization is not available' });
  });

  it('purges the surviving session so the next request cannot retry', async () => {
    seedSession();
    activeOrgResult.current = null;
    await call();
    expect(portalSessions.has(TOKEN)).toBe(false);
  });

  it('rejects before doing any work when the org is unavailable, even for an active user', async () => {
    seedSession();
    activeOrgResult.current = null;
    const res = await call();
    // Distinguishes the ORG gate from the pre-existing portal_users gate:
    // the user row is 'active', so a 403 here can only come from the org check.
    expect(portalUserRow.current?.status).toBe('active');
    expect(res.status).toBe(403);
    expect(await res.json()).not.toEqual({ error: 'Account is not active' });
  });

  it('still rejects a disabled portal user before consulting the org', async () => {
    seedSession();
    portalUserRow.current = { ...portalUserRow.current, status: 'disabled' };
    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Account is not active' });
    expect(getActiveOrgTenant).not.toHaveBeenCalled();
  });
  // ---- #3258 W03: the contact link is HYDRATED onto portalAuth ----

  it('hydrates the linked contact id onto portalAuth.user', async () => {
    seedSession();
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json() as { user: { contactId: string | null } };
    expect(body.user.contactId).toBe(CONTACT_ID);
  });

  it('hydrates contactId as null (not undefined) for a login with no contact', async () => {
    seedSession();
    portalUserRow.current = { ...portalUserRow.current, contactId: null };
    const res = await call();
    const body = await res.json() as { user: Record<string, unknown> };
    // `undefined` and `null` diverge downstream: portalTicketOwnership drops
    // the contact arm on null, and a MISSING key is how a stale session object
    // sneaks past a required field.
    expect(Object.prototype.hasOwnProperty.call(body.user, 'contactId')).toBe(true);
    expect(body.user.contactId).toBeNull();
  });
});
