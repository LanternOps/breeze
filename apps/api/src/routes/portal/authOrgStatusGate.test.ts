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

const { portalUserRow, activeOrgResult, portalUserLookupError } = vi.hoisted(() => ({
  portalUserRow: { current: null as Record<string, unknown> | null },
  activeOrgResult: { current: null as { orgId: string; partnerId: string } | null },
  portalUserLookupError: { current: null as Error | null },
}));

const resolveOrgTimezone = vi.hoisted(() =>
  vi.fn(async () => 'UTC'),
);

vi.mock('../../services/portal/timezone', () => ({
  resolveOrgTimezone,
}));

// The select mock APPLIES the projection rather than echoing the whole fixture
// row. Without that, `select({ id, orgId, ... })` is unobservable and any
// assertion about which columns the middleware hydrates is vacuous — deleting
// `contactId: portalUsers.contactId` from the real query would still return it
// (verified: the naive echo mock kept these tests green through exactly that
// mutation).
function project(columns: Record<string, unknown>): Array<Record<string, unknown>> {
  if (portalUserLookupError.current) throw portalUserLookupError.current;
  const row = portalUserRow.current;
  if (!row) return [];
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(columns)) out[key] = row[key] ?? null;
  return [out];
}

// Logout's durable signed-out record commits in its own system transaction;
// this suite exercises the route around it, so the write itself is stubbed
// (auth.logout.test.ts and portalLogoutRevocation.integration.test.ts cover it).
const revokePortalSessionDurably = vi.hoisted(() => vi.fn(async (_token: string, _userId: string) => undefined));
vi.mock('../../services/portal/sessionRevocation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/portal/sessionRevocation')>()),
  revokePortalSessionDurably,
}));

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
    authMethod: 'authMethod',
    status: 'status',
    authEpoch: 'authEpoch',
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
// W3: the access-policy resolver is mocked at its boundary; the pick,
// isSignInMethodAllowed and the error class stay real.
const resolvePolicy = vi.hoisted(() => vi.fn());
vi.mock('../../services/portalAccessPolicy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/portalAccessPolicy')>()),
  resolvePortalAccessPolicy: resolvePolicy,
}));

import { authRoutes, portalAuthMiddleware } from './auth';
import { portalSessions } from './helpers';
import { getActiveOrgTenant } from '../../services/tenantStatus';
import { PortalAccessPolicyOrgNotFoundError, pickEffectivePortalAccessPolicy } from '../../services/portalAccessPolicy';
import { PORTAL_SESSION_COOKIE_NAME } from './schemas';

const NO_ROW = { entraEnabled: null, googleEnabled: null, passwordMode: null, selfRegistrationMode: null, ssoNewPersonMode: null, ssoSessionMaxHours: null };
/** Built by the real pick with entra runnable: 'sso_only' is effective (entra on), 'allowed' is today's default. */
function policyFor(orgId: string, mode: 'allowed' | 'sso_only') {
  const org = mode === 'sso_only' ? { ...NO_ROW, entraEnabled: true, passwordMode: 'sso_only' as const } : null;
  // W4: Microsoft is effective only for an org with a proven tenant (plan D2), which entra sessions pin (D9).
  const proven = mode === 'sso_only';
  return {
    orgId, partnerId: 'partner-1', entraTenant: proven ? { tenantId: PROVEN_TENANT_ID, provenAt: '2026-11-01T00:00:00.000Z' } : null,
    ...pickEffectivePortalAccessPolicy(org, null, { entra: true, google: false, selfRegistration: false }, { entraTenantProven: proven }),
  };
}
const PROVEN_TENANT_ID = '72f988bf-86f1-41af-91ab-2d7cd011db47';

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
  app.get('/protected', (c) => c.json({
    ok: true,
    user: c.get('portalAuth').user,
    timezone: c.get('portalAuth').timezone,
  }));
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
    authEpoch: 1,
  } as any);
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
    authMethod: 'password',
    browserAccess: 'granted',
    status: 'active',
    authEpoch: 1,
  };
  activeOrgResult.current = { orgId: ORG_ID, partnerId: 'partner-1' };
  portalUserLookupError.current = null;
  resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'allowed'));
});

// Portal registration W2 (spec §6 invariant 9): a browser session requires
// browser_access='granted' as well as a password-method login, re-checked on
// every request. Same refusal as a non-password login: 401, session purged,
// and no logout exemption.
describe('portalAuthMiddleware browser_access gate (W2)', () => {
  it('session middleware: password row with browser_access none → 401 and session purged', async () => {
    seedSession();
    portalUserRow.current = { ...portalUserRow.current, browserAccess: 'none' };

    const res = await call();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Portal user not found' });
    expect(portalSessions.has(TOKEN)).toBe(false);
    expect(getActiveOrgTenant).not.toHaveBeenCalled();
  });

  it('session middleware: password row with browser_access granted → unchanged 200 path', async () => {
    seedSession();
    const res = await call();
    expect(res.status).toBe(200);
    expect(portalSessions.has(TOKEN)).toBe(true);
  });
});

describe('portalAuthMiddleware org-status gate', () => {
  it('fails closed without running downstream when the durable epoch lookup is uncertain', async () => {
    seedSession();
    portalUserLookupError.current = new Error('synthetic database uncertainty');

    const res = await call();

    expect(res.status).toBe(500);
    expect(getActiveOrgTenant).not.toHaveBeenCalled();
  });

  it('fails closed for a legacy session that has no durable epoch snapshot', async () => {
    seedSession();
    const legacy = portalSessions.get(TOKEN)!;
    delete (legacy as Partial<typeof legacy>).authEpoch;

    const res = await call();

    expect(res.status).toBe(401);
    expect(portalSessions.has(TOKEN)).toBe(false);
    expect(getActiveOrgTenant).not.toHaveBeenCalled();
    expect(resolveOrgTimezone).not.toHaveBeenCalled();
  });

  it('rejects a session minted before the durable portal auth epoch advanced', async () => {
    seedSession();
    portalUserRow.current = { ...portalUserRow.current, authEpoch: 2 };

    const res = await call();

    expect(res.status).toBe(401);
    expect(portalSessions.has(TOKEN)).toBe(false);
    expect(getActiveOrgTenant).not.toHaveBeenCalled();
  });

  it('admits an active portal user whose org is usable', async () => {
    seedSession();
    const res = await call();
    expect(res.status).toBe(200);
    expect(getActiveOrgTenant).toHaveBeenCalledWith(ORG_ID);
    // A passing gate must not disturb the session.
    expect(portalSessions.has(TOKEN)).toBe(true);
  });

  it('hydrates the organization timezone exactly once into portalAuth', async () => {
    resolveOrgTimezone.mockResolvedValue('America/Denver');
    seedSession();

    const res = await call();

    expect(res.status).toBe(200);
    expect((await res.json() as { timezone: string }).timezone).toBe('America/Denver');
    expect(resolveOrgTimezone).toHaveBeenCalledTimes(1);
    expect(resolveOrgTimezone).toHaveBeenCalledWith(ORG_ID);
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
    // `code` (sweep 2026-09-08 G5-6) lets the portal app distinguish this
    // deliberate account-disable from a generic load failure and render its
    // own "access disabled" page instead of the outage copy.
    expect(await res.json()).toEqual({
      error: 'Account is not active',
      code: 'PORTAL_ACCOUNT_INACTIVE',
    });
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

describe('portal logout session scope', () => {
  it('continues to revoke only the presented session, not every session for the user', async () => {
    seedSession();
    portalSessions.set('other-current-session', {
      token: 'other-current-session',
      portalUserId: USER_ID,
      orgId: ORG_ID,
      authEpoch: 1,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const app = new Hono();
    app.route('/', authRoutes);

    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(portalSessions.has(TOKEN)).toBe(false);
    expect(portalSessions.has('other-current-session')).toBe(true);
    expect(portalUserRow.current?.authEpoch).toBe(1);
    expect(revokePortalSessionDurably).toHaveBeenCalledTimes(1);
    expect(revokePortalSessionDurably).toHaveBeenCalledWith(TOKEN, USER_ID);
  });
});

// ---------------------------------------------------------------------------
// Portal registration W3 (#11380): the access policy, re-checked on every
// session request (inv. 9 / 11, Review Focus 1). A refused session is purged.
// ---------------------------------------------------------------------------

describe('portalAuthMiddleware access-policy gate (W3)', () => {
  const callWithCookie = () =>
    makeApp().request('/protected', { headers: { cookie: `${PORTAL_SESSION_COOKIE_NAME}=${TOKEN}` } });
  const seedWith = (extra: Record<string, unknown>) => {
    seedSession();
    portalSessions.set(TOKEN, { ...portalSessions.get(TOKEN)!, ...extra } as any);
  };

  it('admits a live password session while the policy allows password (no rows), checked once after the org gate', async () => {
    seedSession();
    const res = await call();
    expect(res.status).toBe(200);
    expect(resolvePolicy).toHaveBeenCalledTimes(1);
    expect(resolvePolicy).toHaveBeenCalledWith(ORG_ID);
    expect(vi.mocked(getActiveOrgTenant).mock.invocationCallOrder[0]!).toBeLessThan(resolvePolicy.mock.invocationCallOrder[0]!);
  });

  it('org sso_only kills a live password session on the next request: 401, purged, cookie cleared', async () => {
    seedSession();
    resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'sso_only'));
    const res = await callWithCookie();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid or expired session' });
    expect(portalSessions.has(TOKEN)).toBe(false);
    expect(res.headers.get('set-cookie') ?? '').toContain(`${PORTAL_SESSION_COOKIE_NAME}=;`);
    expect(resolveOrgTimezone).not.toHaveBeenCalled();
  });

  it('a pre-W3 session with no method is a password session (admitted when allowed, refused under sso_only)', async () => {
    seedSession();
    expect(portalSessions.get(TOKEN)).not.toHaveProperty('method');
    expect((await call()).status).toBe(200);
    resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'sso_only'));
    expect((await call()).status).toBe(401);
    expect(portalSessions.has(TOKEN)).toBe(false);
  });

  it('PortalAccessPolicyOrgNotFoundError refuses the session the same way', async () => {
    seedSession();
    resolvePolicy.mockRejectedValue(new PortalAccessPolicyOrgNotFoundError(ORG_ID));
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid or expired session' });
    expect(portalSessions.has(TOKEN)).toBe(false);
  });

  it('any other resolver failure fails closed (never admits)', async () => {
    seedSession();
    resolvePolicy.mockRejectedValue(new Error('synthetic database fault'));
    const res = await call();
    expect(res.status).toBe(500);
    expect(resolveOrgTimezone).not.toHaveBeenCalled();
  });

  it('does not consult the policy when the org gate already refused', async () => {
    seedSession();
    activeOrgResult.current = null;
    expect((await call()).status).toBe(403);
    expect(resolvePolicy).not.toHaveBeenCalled();
  });

  it('refuses and purges an in-memory session with an unknown method before any lookup', async () => {
    seedWith({ method: 'saml' });
    const res = await call();
    expect(res.status).toBe(401);
    expect(portalSessions.has(TOKEN)).toBe(false);
    expect(getActiveOrgTenant).not.toHaveBeenCalled();
    expect(resolvePolicy).not.toHaveBeenCalled();
  });

  it('a password session on an account that is not password-eligible stays "Portal user not found"', async () => {
    seedWith({ method: 'password' });
    portalUserRow.current = { ...portalUserRow.current, authMethod: 'entra' };
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Portal user not found' });
    expect(portalSessions.has(TOKEN)).toBe(false);
  });

  it('an entra session needs browser access and entra allowed, not password eligibility', async () => {
    seedWith({ method: 'entra', entraTenantId: PROVEN_TENANT_ID });
    portalUserRow.current = { ...portalUserRow.current, authMethod: 'entra' };
    resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'sso_only'));
    expect((await call()).status).toBe(200);

    // entra not effectively enabled (today's default) → refused by policy.
    resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'allowed'));
    const refused = await call();
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'Invalid or expired session' });
    expect(portalSessions.has(TOKEN)).toBe(false);
  });

  // W4 (plan D9): the absolute cap and the tenant pin are applied by the same
  // per-request gate, against the clock of the request.
  it('an entra session at the current ssoSessionMaxHours is refused and purged', async () => {
    seedWith({ method: 'entra', entraTenantId: PROVEN_TENANT_ID, createdAt: new Date(Date.now() - 2 * 3_600_000) });
    portalUserRow.current = { ...portalUserRow.current, authMethod: 'entra' };
    resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'sso_only'));
    expect((await call()).status).toBe(200);

    // The cap is lowered to 1 h: the 2 h-old session dies on its next request.
    resolvePolicy.mockImplementation(async (orgId: string) => {
      const p = policyFor(orgId, 'sso_only');
      return { ...p, effective: { ...p.effective, ssoSessionMaxHours: { value: 1, source: 'org' as const } } };
    });
    const refused = await call();
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'Invalid or expired session' });
    expect(portalSessions.has(TOKEN)).toBe(false);
  });

  it("an entra session pinned to a tenant that is no longer the org's proven one is refused and purged", async () => {
    seedWith({ method: 'entra', entraTenantId: '9b0f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d' });
    portalUserRow.current = { ...portalUserRow.current, authMethod: 'entra' };
    resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'sso_only'));
    const refused = await call();
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'Invalid or expired session' });
    expect(portalSessions.has(TOKEN)).toBe(false);
  });

  it('an entra session without a tenant pin is no session at all (refused before any lookup)', async () => {
    seedWith({ method: 'entra' });
    const res = await call();
    expect(res.status).toBe(401);
    expect(portalSessions.has(TOKEN)).toBe(false);
    expect(getActiveOrgTenant).not.toHaveBeenCalled();
    expect(resolvePolicy).not.toHaveBeenCalled();
  });

  it('an entra session without browser access is refused by the account gate', async () => {
    seedWith({ method: 'entra', entraTenantId: PROVEN_TENANT_ID });
    portalUserRow.current = { ...portalUserRow.current, authMethod: 'entra', browserAccess: 'none' };
    resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'sso_only'));
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Portal user not found' });
  });

  it('logout still works for a session refused by policy', async () => {
    seedSession();
    resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'sso_only'));
    const app = new Hono();
    app.route('/', authRoutes);

    const res = await app.request('/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(portalSessions.has(TOKEN)).toBe(false);
    expect(revokePortalSessionDurably).toHaveBeenCalledWith(TOKEN, USER_ID);
    expect(resolvePolicy).not.toHaveBeenCalled();
  });
});
