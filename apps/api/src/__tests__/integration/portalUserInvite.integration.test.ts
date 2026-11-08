/**
 * Real-driver integration coverage for the customer-portal invite→accept
 * lifecycle (MSP-facing invite routes + public portal accept-invite/login),
 * plus cross-tenant (RLS) isolation on the MSP-facing invite endpoints.
 *
 * Runs under vitest.integration.config.ts — connects as the unprivileged
 * `breeze_app` role (rolbypassrls=f), so RLS is genuinely enforced. If
 * .env.test is missing the symlink, these tests pass vacuously on a
 * BYPASSRLS admin connection (see memory: worktree_env_test_rls_vacuous).
 *
 * Harness mirrored from:
 *   apps/api/src/__tests__/integration/portal-routes-rls.integration.test.ts
 *     (public portal app: `app.route('/portal', portalRoutes)`,
 *      `getTestDb()` superuser seeding, real login round-trip)
 *   apps/api/src/__tests__/integration/update-rings-partner-scope.integration.test.ts
 *     (MSP-facing route app built directly from a route-registration
 *      function + `authMiddleware`, `createAccessToken` mfa:true tokens for
 *      requireMfa()-gated writes, cross-partner 404 assertions)
 *
 * Coverage:
 *   1. Partner-scoped tech invites a new email → `portal_users` row with
 *      status='invited', invited_by set (Task 6/7 route).
 *   2. The same tech cannot list/invite portal users for an org outside
 *      their partner — RLS hides the org row so the route 404s before any
 *      write is attempted (no existence-oracle leak).
 *   3. Consuming the stored invite token via POST /portal/auth/accept-invite
 *      flips the row to status='active' with a non-null password_hash, and
 *      a subsequent POST /portal/auth/login with that password succeeds.
 *      The raw token is minted by calling `issuePortalCapabilityToken()`
 *      directly (bound to the row's org, address and current epoch, as the
 *      invite route does) (the invite route never echoes it back — it only reaches
 *      the invitee via `sendPortalInvite` email, which integration tests
 *      don't have a mailbox to intercept).
 *   4. bulk-invite must not re-invite a `status='disabled'` row (closes a
 *      gap not covered by the mocked unit test — `bulkWhere` excludes
 *      `disabled` rows at the SQL predicate level, which a mocked
 *      `db.select` can't exercise), nor an Entra JIT identity.
 */
import './setup';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

// W2: capture the invite link the ROUTE emails, so the end-to-end cases below
// redeem the very token the MSP invite issued (purpose-bound to the org, the
// address and the row's epoch at that moment) instead of minting their own.
const { sentInvites } = vi.hoisted(() => ({ sentInvites: [] as Array<{ to: string; inviteUrl: string }> }));
vi.mock('../../services/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/email')>()),
  getEmailService: () => ({
    sendPortalInvite: async (msg: { to: string; inviteUrl: string }) => { sentInvites.push({ to: msg.to, inviteUrl: msg.inviteUrl }); },
    sendPasswordReset: async () => undefined,
  }),
}));
import { db, withSystemDbAccessContext } from '../../db';
import { portalUsers } from '../../db/schema';
import { authMiddleware } from '../../middleware/auth';
import { registerOrgPortalUsersRoutes } from '../../routes/orgPortalUsers';
import { portalRoutes } from '../../routes/portal';
import { issuePortalCapabilityToken } from '../../routes/portal/capabilityTokens';
import { portalSessions } from '../../routes/portal/helpers';
import { createAccessToken } from '../../services/jwt';
import { createPartner, createOrganization, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const NEW_PORTAL_PASSWORD = 'NewPortalPass456!';

function buildMspApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  registerOrgPortalUsersRoutes(app);
  return app;
}

function buildPortalApp(): Hono {
  const app = new Hono();
  app.route('/portal', portalRoutes);
  return app;
}

/** Mint an mfa:true token for a `setupTestEnvironment({ scope: 'partner' })`
 *  env — the invite/bulk-invite/resend/delete/patch routes all gate on
 *  requireMfa(). */
async function mfaTokenFor(env: Awaited<ReturnType<typeof setupTestEnvironment>>): Promise<string> {
  return createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: null,
    partnerId: env.partner.id,
    scope: 'partner',
    mfa: true,
    // Epoch claims (core-auth PR 1): authMiddleware rejects access tokens
    // missing aep/mep/sid or stale vs users.auth_epoch/mfa_epoch (DB default 1).
    aep: 1,
    mep: 1,
    sid: 'it-session',
  });
}

async function fetchPortalUser(userId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .select({
        id: portalUsers.id,
        orgId: portalUsers.orgId,
        email: portalUsers.email,
        status: portalUsers.status,
        passwordHash: portalUsers.passwordHash,
        authMethod: portalUsers.authMethod,
        invitedBy: portalUsers.invitedBy,
        invitedAt: portalUsers.invitedAt,
      })
      .from(portalUsers)
      .where(eq(portalUsers.id, userId))
  );
  return row ?? null;
}

describe('portal user invite→accept — end-to-end + tenant isolation', () => {
  it('partner-scoped tech invites a new email → portal_users row is invited with invited_by set', async () => {
    const envA = await setupTestEnvironment({ scope: 'partner' });
    const mfaToken = await mfaTokenFor(envA);
    const app = buildMspApp();

    const res = await app.request(`/organizations/${envA.organization.id}/portal-users/invite`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mfaToken}`, ...JSON_HEADERS },
      body: JSON.stringify({ email: 'new@acme.example' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('invited');
    expect(body.data.email).toBe('new@acme.example');

    // The write ran through the breeze_app pool under the tech's partner-scope
    // DB access context — read it back under system scope to prove it's a real
    // row, not just an echoed response.
    const row = await fetchPortalUser(body.data.id);
    expect(row).not.toBeNull();
    expect(row!.orgId).toBe(envA.organization.id);
    expect(row!.status).toBe('invited');
    expect(row!.invitedBy).toBe(envA.user.id);
    expect(row!.invitedAt).not.toBeNull();
    expect(row!.passwordHash).toBeNull();
  });

  it('a partner-scoped tech cannot list or invite portal users for an org outside their partner (404, RLS-hidden)', async () => {
    const envA = await setupTestEnvironment({ scope: 'partner' });
    const mfaToken = await mfaTokenFor(envA);

    // Unrelated partner + org — envA has no membership/access to either.
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    const app = buildMspApp();

    const listRes = await app.request(`/organizations/${orgB.id}/portal-users`, {
      headers: { Authorization: `Bearer ${envA.token}` },
    });
    expect(listRes.status).toBe(404);

    const inviteRes = await app.request(`/organizations/${orgB.id}/portal-users/invite`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mfaToken}`, ...JSON_HEADERS },
      body: JSON.stringify({ email: 'cross-tenant@evil.example' }),
    });
    expect(inviteRes.status).toBe(404);

    // No row was ever created for org B — the write never happened, it
    // wasn't just hidden from the response.
    const leaked = await withSystemDbAccessContext(() =>
      db.select({ id: portalUsers.id }).from(portalUsers).where(eq(portalUsers.orgId, orgB.id))
    );
    expect(leaked).toHaveLength(0);
  });

  it('accept-invite activates the row (status=active, password_hash set) and the new password logs in', async () => {
    const envA = await setupTestEnvironment({ scope: 'partner' });
    const mfaToken = await mfaTokenFor(envA);
    const mspApp = buildMspApp();

    const inviteRes = await mspApp.request(`/organizations/${envA.organization.id}/portal-users/invite`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mfaToken}`, ...JSON_HEADERS },
      body: JSON.stringify({ email: 'accept-me@acme.example' }),
    });
    expect(inviteRes.status).toBe(200);
    const invited = await inviteRes.json();
    const portalUserId = invited.data.id as string;

    // The invite route never echoes the raw token (it's only delivered via
    // sendPortalInvite email, which this harness has no mailbox to
    // intercept). Mint a fresh one directly against the same in-memory
    // token store the route itself uses (PORTAL_USE_REDIS is false under
    // NODE_ENV=test) — this is the sanctioned escape hatch for exercising
    // accept-invite without a real email transport.
    const [invitedRow] = await getTestDb().select({ authEpoch: portalUsers.authEpoch }).from(portalUsers).where(eq(portalUsers.id, portalUserId));
    const rawToken = await issuePortalCapabilityToken({
      purpose: 'invite', portalUserId, orgId: envA.organization.id, email: 'accept-me@acme.example', authEpoch: invitedRow!.authEpoch,
    });
    expect(rawToken).toBeTruthy();

    const portalApp = buildPortalApp();
    const acceptRes = await portalApp.request('/portal/auth/accept-invite', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: rawToken, password: NEW_PORTAL_PASSWORD }),
    });
    expect(acceptRes.status).toBe(200);
    const acceptBody = await acceptRes.json();
    expect(acceptBody.accessToken).toBeTruthy();
    expect(acceptBody.user.email).toBe('accept-me@acme.example');

    const row = await fetchPortalUser(portalUserId);
    expect(row!.status).toBe('active');
    expect(row!.passwordHash).not.toBeNull();

    const loginRes = await portalApp.request('/portal/auth/login', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: 'accept-me@acme.example', password: NEW_PORTAL_PASSWORD, orgId: envA.organization.id }),
    });
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json();
    expect(loginBody.accessToken).toBeTruthy();
  });

  it('never converts an Entra identity through single-invite or invite acceptance', async () => {
    const envA = await setupTestEnvironment({ scope: 'partner' });
    const mfaToken = await mfaTokenFor(envA);
    const admin = getTestDb();
    const [entraUser] = await admin.insert(portalUsers).values({
      orgId: envA.organization.id,
      email: 'entra-invite@acme.example',
      passwordHash: null,
      authMethod: 'entra',
      entraOid: `oid-${Date.now()}`,
      entraTenantId: `tenant-${Date.now()}`,
      status: 'active',
    }).returning();

    const mspApp = buildMspApp();
    const inviteRes = await mspApp.request(`/organizations/${envA.organization.id}/portal-users/invite`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mfaToken}`, ...JSON_HEADERS },
      body: JSON.stringify({ email: entraUser!.email }),
    });
    expect(inviteRes.status).toBe(409);

    // Even a token minted for the Entra row (bound to its real org, address
    // and epoch) is refused at consume: an invite never converts an add-in login.
    const rawToken = await issuePortalCapabilityToken({
      purpose: 'invite', portalUserId: entraUser!.id, orgId: envA.organization.id, email: entraUser!.email, authEpoch: entraUser!.authEpoch,
    });
    const acceptRes = await buildPortalApp().request('/portal/auth/accept-invite', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: rawToken, password: NEW_PORTAL_PASSWORD }),
    });
    expect(acceptRes.status).toBe(400);
    const after = await fetchPortalUser(entraUser!.id);
    expect(after!.authMethod).toBe('entra');
    expect(after!.passwordHash).toBeNull();
    expect(after!.status).toBe('active');
  });

  it('bulk-invite skips a disabled portal_users row but re-invites a pending one', async () => {
    const envA = await setupTestEnvironment({ scope: 'partner' });
    const mfaToken = await mfaTokenFor(envA);
    const admin = getTestDb();

    // Disabled, password-less row — must NOT be flipped back to 'invited'.
    const [disabledUser] = await admin
      .insert(portalUsers)
      .values({
        orgId: envA.organization.id,
        email: 'disabled@acme.example',
        passwordHash: null,
        status: 'disabled',
      })
      .returning();

    // Already-pending row with no password — bulk-invite's candidate set,
    // should get re-invited (invitedBy/invitedAt refreshed).
    const [pendingUser] = await admin
      .insert(portalUsers)
      .values({
        orgId: envA.organization.id,
        email: 'pending@acme.example',
        passwordHash: null,
        status: 'invited',
      })
      .returning();

    const [entraUser] = await admin
      .insert(portalUsers)
      .values({
        orgId: envA.organization.id,
        email: 'entra-bulk@acme.example',
        passwordHash: null,
        authMethod: 'entra',
        entraOid: `bulk-oid-${Date.now()}`,
        entraTenantId: `bulk-tenant-${Date.now()}`,
        status: 'active',
      })
      .returning();

    const app = buildMspApp();
    const res = await app.request(`/organizations/${envA.organization.id}/portal-users/bulk-invite`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mfaToken}`, ...JSON_HEADERS },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const invitedIds = body.data.map((r: { id: string }) => r.id);
    expect(invitedIds).toContain(pendingUser!.id);
    expect(invitedIds).not.toContain(disabledUser!.id);
    expect(invitedIds).not.toContain(entraUser!.id);

    const disabledRow = await fetchPortalUser(disabledUser!.id);
    expect(disabledRow!.status).toBe('disabled');
    expect(disabledRow!.invitedBy).toBeNull();

    const pendingRow = await fetchPortalUser(pendingUser!.id);
    expect(pendingRow!.status).toBe('invited');
    expect(pendingRow!.invitedBy).toBe(envA.user.id);
    expect(pendingRow!.invitedAt).not.toBeNull();

    const entraRow = await fetchPortalUser(entraUser!.id);
    expect(entraRow!.authMethod).toBe('entra');
    expect(entraRow!.status).toBe('active');
    expect(entraRow!.invitedBy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Portal registration W2: state machine + purpose-bound tokens, end to end
// ---------------------------------------------------------------------------

describe('portal account foundations (W2) — real Postgres, breeze_app', () => {
  beforeEach(() => { sentInvites.length = 0; });

  const tokenFromLastInvite = (to: string): string => {
    const sent = [...sentInvites].reverse().find((m) => m.to === to);
    expect(sent, `no invite emailed to ${to}`).toBeDefined();
    return new URL(sent!.inviteUrl).searchParams.get('token')!;
  };

  async function inviteAs(env: Awaited<ReturnType<typeof setupTestEnvironment>>, email: string) {
    const res = await buildMspApp().request(`/organizations/${env.organization.id}/portal-users/invite`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await mfaTokenFor(env)}`, ...JSON_HEADERS },
      body: JSON.stringify({ email }),
    });
    expect(res.status).toBe(200);
    return (await res.json()).data.id as string;
  }

  const accept = (token: string) => buildPortalApp().request('/portal/auth/accept-invite', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token, password: NEW_PORTAL_PASSWORD }),
  });

  it('invite → accept-invite → login still works end to end under purpose-bound tokens', async () => {
    const envA = await setupTestEnvironment({ scope: 'partner' });
    const portalUserId = await inviteAs(envA, 'e2e@acme.example');

    const [row] = await getTestDb().select({ browserAccess: portalUsers.browserAccess, status: portalUsers.status })
      .from(portalUsers).where(eq(portalUsers.id, portalUserId));
    expect(row).toEqual({ browserAccess: 'granted', status: 'invited' });

    const acceptRes = await accept(tokenFromLastInvite('e2e@acme.example'));
    expect(acceptRes.status).toBe(200);
    const session = (await acceptRes.json()).accessToken as string;

    const profile = await buildPortalApp().request('/portal/profile', { headers: { Authorization: `Bearer ${session}` } });
    expect(profile.status).toBe(200);

    const loginRes = await buildPortalApp().request('/portal/auth/login', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ email: 'e2e@acme.example', password: NEW_PORTAL_PASSWORD, orgId: envA.organization.id }),
    });
    expect(loginRes.status).toBe(200);
  });

  // Review Focus 4: the invite link double-clicked / opened in two tabs.
  it('two concurrent accepts of one invite link: exactly one activation and one session', async () => {
    const envA = await setupTestEnvironment({ scope: 'partner' });
    const portalUserId = await inviteAs(envA, 'double@acme.example');
    const token = tokenFromLastInvite('double@acme.example');
    const sessionsBefore = [...portalSessions.values()].filter((s) => s.portalUserId === portalUserId).length;

    const [a, b] = await Promise.all([accept(token), accept(token)]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect([...portalSessions.values()].filter((s) => s.portalUserId === portalUserId)).toHaveLength(sessionsBefore + 1);
    const row = await fetchPortalUser(portalUserId);
    expect(row!.status).toBe('active');
  });

  it('a re-invite invalidates the earlier link (the token is bound to the epoch it was issued at)', async () => {
    const envA = await setupTestEnvironment({ scope: 'partner' });
    await inviteAs(envA, 'twice@acme.example');
    const first = tokenFromLastInvite('twice@acme.example');
    await inviteAs(envA, 'twice@acme.example');
    const second = tokenFromLastInvite('twice@acme.example');
    expect(second).not.toBe(first);

    const stale = await accept(first);
    expect(stale.status).toBe(400);
    expect(await stale.json()).toEqual({ error: 'Invalid or expired invite' });
    expect((await accept(second)).status).toBe(200);
  });

  it('a disabled-then-reactivated credential-less user lands on invited, and a resent invite works (Review Focus 5)', async () => {
    const envA = await setupTestEnvironment({ scope: 'partner' });
    const portalUserId = await inviteAs(envA, 'comeback@acme.example');
    const preDisable = tokenFromLastInvite('comeback@acme.example');
    const mfa = await mfaTokenFor(envA);
    const patch = (status: string) => buildMspApp().request(`/organizations/${envA.organization.id}/portal-users/${portalUserId}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${mfa}`, ...JSON_HEADERS }, body: JSON.stringify({ status }),
    });

    expect((await patch('disabled')).status).toBe(200);
    const reactivated = await patch('active');
    expect(reactivated.status).toBe(200);
    expect((await reactivated.json()).data.status).toBe('invited');
    expect((await fetchPortalUser(portalUserId))!.status).toBe('invited');

    // The link emailed before the disable is dead (epoch moved twice).
    expect((await accept(preDisable)).status).toBe(400);

    const resend = await buildMspApp().request(`/organizations/${envA.organization.id}/portal-users/${portalUserId}/resend-invite`, {
      method: 'POST', headers: { Authorization: `Bearer ${mfa}` },
    });
    expect(resend.status).toBe(200);
    expect((await accept(tokenFromLastInvite('comeback@acme.example'))).status).toBe(200);
  });

  it('PATCH status active on an invited user is refused (409) and changes nothing', async () => {
    const envA = await setupTestEnvironment({ scope: 'partner' });
    const portalUserId = await inviteAs(envA, 'not-yet@acme.example');
    const [before] = await getTestDb().select({ authEpoch: portalUsers.authEpoch }).from(portalUsers).where(eq(portalUsers.id, portalUserId));
    const res = await buildMspApp().request(`/organizations/${envA.organization.id}/portal-users/${portalUserId}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${await mfaTokenFor(envA)}`, ...JSON_HEADERS }, body: JSON.stringify({ status: 'active' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PORTAL_ACCOUNT_TRANSITION_REFUSED');
    const [after] = await getTestDb().select({ status: portalUsers.status, authEpoch: portalUsers.authEpoch }).from(portalUsers).where(eq(portalUsers.id, portalUserId));
    expect(after).toEqual({ status: 'invited', authEpoch: before!.authEpoch });
  });

  it('bulk invite in an org with an add-in (entra) login leaves that login untouched (status, epoch, browser_access)', async () => {
    const envA = await setupTestEnvironment({ scope: 'partner' });
    const admin = getTestDb();
    const [entra] = await admin.insert(portalUsers).values({
      orgId: envA.organization.id, email: 'addin@acme.example', authMethod: 'entra',
      entraOid: `oid-${Date.now()}`, entraTenantId: `tid-${Date.now()}`, status: 'active', browserAccess: 'none',
    }).returning();
    // A legacy credential-less ACTIVE password row (pre-#3258 inbound email shape): bulk invite's target.
    const [legacy] = await admin.insert(portalUsers).values({
      orgId: envA.organization.id, email: 'legacy@acme.example', authMethod: 'password', status: 'active',
    }).returning();
    const res = await buildMspApp().request(`/organizations/${envA.organization.id}/portal-users/bulk-invite`, {
      method: 'POST', headers: { Authorization: `Bearer ${await mfaTokenFor(envA)}`, ...JSON_HEADERS }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.map((r: { id: string }) => r.id)).toEqual([legacy!.id]);

    const [entraAfter] = await admin.select({ status: portalUsers.status, authEpoch: portalUsers.authEpoch, browserAccess: portalUsers.browserAccess, invitedBy: portalUsers.invitedBy })
      .from(portalUsers).where(eq(portalUsers.id, entra!.id));
    expect(entraAfter).toEqual({ status: 'active', authEpoch: entra!.authEpoch, browserAccess: 'none', invitedBy: null });
    const [legacyAfter] = await admin.select({ status: portalUsers.status, authEpoch: portalUsers.authEpoch, browserAccess: portalUsers.browserAccess })
      .from(portalUsers).where(eq(portalUsers.id, legacy!.id));
    expect(legacyAfter).toEqual({ status: 'invited', authEpoch: legacy!.authEpoch + 1, browserAccess: 'granted' });
    expect((await accept(tokenFromLastInvite('legacy@acme.example'))).status).toBe(200);
  });

  it('every migrated password login keeps its browser session: fixture-inserted password row (trigger → granted) logs in and GET /portal/profile is 200', async () => {
    const envA = await setupTestEnvironment({ scope: 'partner' });
    const { hashPassword } = await import('../../services/password');
    const hash = await hashPassword(NEW_PORTAL_PASSWORD);
    // Raw SQL with no browser_access column: what every pre-W2 row and an old
    // binary's insert look like. The fill trigger supplies 'granted'.
    const [row] = await getTestDb().execute<{ id: string; browser_access: string }>(sql`
      INSERT INTO portal_users (org_id, email, password_hash, auth_method, status)
      VALUES (${envA.organization.id}, 'veteran@acme.example', ${hash}, 'password', 'active')
      RETURNING id, browser_access`);
    expect(row!.browser_access).toBe('granted');

    const loginRes = await buildPortalApp().request('/portal/auth/login', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ email: 'veteran@acme.example', password: NEW_PORTAL_PASSWORD, orgId: envA.organization.id }),
    });
    expect(loginRes.status).toBe(200);
    const session = (await loginRes.json()).accessToken as string;
    const profile = await buildPortalApp().request('/portal/profile', { headers: { Authorization: `Bearer ${session}` } });
    expect(profile.status).toBe(200);
  });
});
