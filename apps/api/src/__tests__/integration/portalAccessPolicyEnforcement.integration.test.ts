/**
 * Portal registration W3 (#11380), Task 6: the portal access policy enforced
 * at use — live browser sessions, login, forgot-password, reset and
 * accept-invite — against real Postgres as breeze_app through the real portal
 * router (Review Focus 1 and 4; spec §6 invariants 7, 8, 9 and 11).
 *
 * W3 ships with every sign-in capability off, so `sso_only` can never be
 * effective in production yet. These cases switch entra on through the
 * NODE_ENV=test capability seam, then seed policy rows as superuser (the
 * write path and its validation are Task 3/4's suites).
 *
 * Sessions and tokens use the in-memory backend (PORTAL_USE_REDIS is false
 * under NODE_ENV=test); the Redis purge path is covered in
 * routes/portal/auth.logout.test.ts.
 *
 * Run (shared test DB — hold the mutex):
 *   cd apps/api && lockf /tmp/w3a-itest.lock npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/portalAccessPolicyEnforcement.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';

// Capture the reset links the route emails, so a reset is redeemed with the
// very token forgot-password issued.
const { sentResets } = vi.hoisted(() => ({ sentResets: [] as Array<{ to: string; resetUrl: string }> }));
vi.mock('../../services/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/email')>()),
  getEmailService: () => ({
    sendPasswordReset: async (msg: { to: string; resetUrl: string }) => { sentResets.push({ to: msg.to, resetUrl: msg.resetUrl }); },
    sendPortalInvite: async () => undefined,
  }),
}));

import { clientAiTenantMappings, portalAccessPolicies, portalUsers } from '../../db/schema';
import { portalRoutes } from '../../routes/portal';
import { issuePortalCapabilityToken } from '../../routes/portal/capabilityTokens';
import { portalInviteTokens, portalRateLimitBuckets, portalResetTokens, portalSessions } from '../../routes/portal/helpers';
import { __testOnly } from '../../services/portalAccessPolicy';
import { hashPassword } from '../../services/password';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'PortalPolicyPass1!';
const NEW_PASSWORD = 'PortalPolicyNew2!';

const app = (() => {
  const a = new Hono();
  a.route('/portal', portalRoutes);
  return a;
})();

const post = (path: string, body: Record<string, unknown>) =>
  app.request(`/portal${path}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
const login = (email: string, password: string, orgId?: string) =>
  post('/auth/login', { email, password, ...(orgId ? { orgId } : {}) });
const profile = (token: string) => app.request('/portal/profile', { headers: { Authorization: `Bearer ${token}` } });

type PolicySeed = Partial<typeof portalAccessPolicies.$inferInsert>;
/** Superuser seed: bypasses RLS (the write path and its validation are other suites'). */
async function seedPolicy(values: PolicySeed): Promise<void> {
  await getTestDb().insert(portalAccessPolicies).values(values);
}

async function seedAccount(orgId: string, email: string, over: Partial<typeof portalUsers.$inferInsert> = {}) {
  const [row] = await getTestDb().insert(portalUsers).values({
    orgId, email, passwordHash: await hashPassword(PASSWORD), authMethod: 'password', status: 'active', browserAccess: 'granted', ...over,
  }).returning({ id: portalUsers.id, authEpoch: portalUsers.authEpoch });
  return row!;
}

async function readAccount(id: string) {
  const [row] = await getTestDb().select({
    status: portalUsers.status, passwordHash: portalUsers.passwordHash, authEpoch: portalUsers.authEpoch,
  }).from(portalUsers).where(eq(portalUsers.id, id));
  return row!;
}

async function loginToken(email: string, orgId: string): Promise<string> {
  const res = await login(email, PASSWORD, orgId);
  expect(res.status).toBe(200);
  const token = (await res.json()).accessToken as string;
  expect(portalSessions.get(token)).toMatchObject({ method: 'password' });
  return token;
}

async function setup() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  // W4 (#11381) D2: Microsoft is effective only for an org with a proven Entra tenant,
  // so every org here has one (its loss is portalAccessPolicyResolver's / portalSessionCaps' case).
  await getTestDb().insert(clientAiTenantMappings).values({
    orgId: org.id, entraTenantId: randomUUID(), provenAt: new Date(), provenVia: 'proof_run',
    provenEvidence: { via: 'proof_run', adminOid: randomUUID(), runId: randomUUID() },
  });
  return { partnerId: partner.id, orgId: org.id };
}

beforeEach(() => {
  __testOnly.setCapabilities({ entra: true, google: false, selfRegistration: false });
  portalSessions.clear();
  portalResetTokens.clear();
  portalInviteTokens.clear();
  portalRateLimitBuckets.clear();
  sentResets.length = 0;
});

afterEach(() => __testOnly.setCapabilities(null));

describe('portal access policy enforced at use (real DB + router)', () => {
  it('org sso_only (entra on) kills a live password session on the next request and purges it', async () => {
    const { orgId } = await setup();
    await seedAccount(orgId, 'live@acme.example');
    const token = await loginToken('live@acme.example', orgId);
    expect((await profile(token)).status).toBe(200);

    await seedPolicy({ orgId, entraEnabled: true, passwordMode: 'sso_only' });

    const refused = await profile(token);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'Invalid or expired session' });
    expect(portalSessions.has(token)).toBe(false);

    // Purged, not merely refused: lifting the policy does not revive it.
    await getTestDb().delete(portalAccessPolicies).where(eq(portalAccessPolicies.orgId, orgId));
    expect((await profile(token)).status).toBe(401);
  });

  it('inherited partner sso_only kills a password session on the next request', async () => {
    const { partnerId, orgId } = await setup();
    const other = await setup(); // another partner's org: untouched by this partner's default
    await seedAccount(orgId, 'inherit@acme.example');
    await seedAccount(other.orgId, 'other@acme.example');
    const token = await loginToken('inherit@acme.example', orgId);
    const otherToken = await loginToken('other@acme.example', other.orgId);

    await seedPolicy({ partnerId, entraEnabled: true, passwordMode: 'sso_only' });

    const refused = await profile(token);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'Invalid or expired session' });
    expect(portalSessions.has(token)).toBe(false);
    expect((await profile(otherToken)).status).toBe(200);
  });

  it('fallback re-allows password login when the partner turns entra off under an org sso_only', async () => {
    const { partnerId, orgId } = await setup();
    await seedAccount(orgId, 'fallback@acme.example');
    await seedPolicy({ partnerId, entraEnabled: true });
    await seedPolicy({ orgId, passwordMode: 'sso_only' }); // entra inherited from the partner

    const wrong = await login('fallback@acme.example', 'WrongPolicyPass9!', orgId);
    const refused = await login('fallback@acme.example', PASSWORD, orgId);
    expect(refused.status).toBe(401);
    expect(await refused.text()).toBe(await wrong.text());
    expect(portalSessions.size).toBe(0);

    // The partner turns entra off: no SSO method is effective, so the org's
    // sso_only falls back to allowed (spec §4) and password works again.
    await getTestDb().update(portalAccessPolicies).set({ entraEnabled: false })
      .where(and(isNull(portalAccessPolicies.orgId), eq(portalAccessPolicies.partnerId, partnerId)));
    const res = await login('fallback@acme.example', PASSWORD, orgId);
    expect(res.status).toBe(200);
    expect((await profile((await res.json()).accessToken)).status).toBe(200);
  });

  it('no policy rows: login, session, reset and accept-invite behave exactly as before W3', async () => {
    const { orgId } = await setup();
    const acct = await seedAccount(orgId, 'plain@acme.example');

    const token = await loginToken('plain@acme.example', orgId);
    expect((await profile(token)).status).toBe(200);

    // forgot → the emailed token → reset → the new password signs in.
    expect((await post('/auth/forgot-password', { email: 'plain@acme.example', orgId })).status).toBe(200);
    expect(sentResets).toHaveLength(1);
    const resetToken = new URL(sentResets[0]!.resetUrl).searchParams.get('token')!;
    const reset = await post('/auth/reset-password', { token: resetToken, password: NEW_PASSWORD });
    expect(reset.status).toBe(200);
    expect((await readAccount(acct.id)).authEpoch).toBe(acct.authEpoch + 1);
    expect((await login('plain@acme.example', NEW_PASSWORD, orgId)).status).toBe(200);

    // accept-invite activates an invited row and mints a working password session.
    const invited = await seedAccount(orgId, 'invited@acme.example', { status: 'invited', passwordHash: null });
    const inviteToken = await issuePortalCapabilityToken({
      purpose: 'invite', portalUserId: invited.id, orgId, email: 'invited@acme.example', authEpoch: invited.authEpoch,
    });
    const accepted = await post('/auth/accept-invite', { token: inviteToken, password: NEW_PASSWORD });
    expect(accepted.status).toBe(200);
    const acceptedToken = (await accepted.json()).accessToken as string;
    expect(portalSessions.get(acceptedToken)).toMatchObject({ method: 'password' });
    expect((await profile(acceptedToken)).status).toBe(200);
    expect((await readAccount(invited.id)).status).toBe('active');
  });

  it('every password-path endpoint refuses for an sso_only org (login, forgot, reset, accept-invite)', async () => {
    const { orgId } = await setup();
    const acct = await seedAccount(orgId, 'sso@acme.example');
    const invited = await seedAccount(orgId, 'sso-invited@acme.example', { status: 'invited', passwordHash: null });
    // Tokens outstanding from before the policy change.
    const resetToken = await issuePortalCapabilityToken({
      purpose: 'reset', portalUserId: acct.id, orgId, email: 'sso@acme.example', authEpoch: acct.authEpoch,
    });
    const inviteToken = await issuePortalCapabilityToken({
      purpose: 'invite', portalUserId: invited.id, orgId, email: 'sso-invited@acme.example', authEpoch: invited.authEpoch,
    });
    const before = await readAccount(acct.id);

    await seedPolicy({ orgId, entraEnabled: true, passwordMode: 'sso_only' });

    // Login: the byte-identical 401 of a wrong password, no session.
    const wrong = await login('sso@acme.example', 'WrongPolicyPass9!', orgId);
    const refused = await login('sso@acme.example', PASSWORD, orgId);
    expect(refused.status).toBe(401);
    expect(await refused.text()).toBe(await wrong.text());
    expect(portalSessions.size).toBe(0);

    // Forgot: the uniform 200 of an unknown address, and nothing issued or sent.
    const unknown = await post('/auth/forgot-password', { email: 'nobody@acme.example', orgId });
    const forgot = await post('/auth/forgot-password', { email: 'sso@acme.example', orgId });
    expect(forgot.status).toBe(200);
    expect(await forgot.text()).toBe(await unknown.text());
    expect(sentResets).toHaveLength(0);
    expect(portalResetTokens.size).toBe(1); // only the token minted before the change

    // Reset: the generic 400, password hash and epoch unchanged.
    const reset = await post('/auth/reset-password', { token: resetToken, password: NEW_PASSWORD });
    expect(reset.status).toBe(400);
    expect(await reset.json()).toEqual({ error: 'Invalid or expired reset token' });
    expect(await readAccount(acct.id)).toEqual(before);

    // Accept-invite: the generic 400, the account stays invited with no password.
    const accept = await post('/auth/accept-invite', { token: inviteToken, password: NEW_PASSWORD });
    expect(accept.status).toBe(400);
    expect(await accept.json()).toEqual({ error: 'Invalid or expired invite' });
    expect(await readAccount(invited.id)).toMatchObject({ status: 'invited', passwordHash: null, authEpoch: invited.authEpoch });
  });
});
