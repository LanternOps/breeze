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
 *      The raw token is captured by calling `storePortalInviteToken()`
 *      directly (the invite route never echoes it back — it only reaches
 *      the invitee via `sendPortalInvite` email, which integration tests
 *      don't have a mailbox to intercept).
 *   4. bulk-invite must not re-invite a `status='disabled'` row (closes a
 *      gap not covered by the mocked unit test — `bulkWhere` excludes
 *      `disabled` rows at the SQL predicate level, which a mocked
 *      `db.select` can't exercise).
 */
import './setup';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { portalUsers } from '../../db/schema';
import { authMiddleware } from '../../middleware/auth';
import { registerOrgPortalUsersRoutes } from '../../routes/orgPortalUsers';
import { portalRoutes } from '../../routes/portal';
import { storePortalInviteToken } from '../../routes/portal/helpers';
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
    const rawToken = await storePortalInviteToken(portalUserId);
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

    const disabledRow = await fetchPortalUser(disabledUser!.id);
    expect(disabledRow!.status).toBe('disabled');
    expect(disabledRow!.invitedBy).toBeNull();

    const pendingRow = await fetchPortalUser(pendingUser!.id);
    expect(pendingRow!.status).toBe('invited');
    expect(pendingRow!.invitedBy).toBe(envA.user.id);
    expect(pendingRow!.invitedAt).not.toBeNull();
  });
});
