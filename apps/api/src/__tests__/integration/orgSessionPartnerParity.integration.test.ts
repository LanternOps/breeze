/**
 * Organization-session partner parity across session minters (#12246).
 *
 * Every organization-scope session must carry the partner that owns its org,
 * exactly as a password login does. Partner-wide config (org_id NULL rows)
 * is readable by an org session only through the `*_partner_wide_select` RLS
 * branches, which key on `breeze_current_partner_id()` — the session's
 * partnerId. A session minted with `partnerId: null` therefore cannot see any
 * partner-wide policy that governs its own org's devices.
 *
 * Real Postgres (RLS-enforced `breeze_app`) + Redis, real route handlers and
 * the real authMiddleware. Only the IdP network calls are stubbed.
 *
 * Run:
 *   pnpm test-stack up
 *   pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/orgSessionPartnerParity.integration.test.ts
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { decodeJwt } from 'jose';
import { and, eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import {
  configurationPolicies,
  organizations,
  organizationUsers,
  partnerUsers,
  refreshTokenFamilies,
  ssoProviders,
  ssoSessions,
  users,
} from '../../db/schema';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  assignUserToOrganization,
  assignUserToPartner,
  bootstrapAuthBinding,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { encryptSecret } from '../../services/secretCrypto';
import { authRoutes } from '../../routes/auth';
import { configPolicyRoutes } from '../../routes/configurationPolicies';

vi.mock('../../services/sso', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/sso')>();
  return {
    ...actual,
    exchangeCodeForTokens: vi.fn(),
    getUserInfo: vi.fn(),
    verifyIdTokenSignature: vi.fn(),
  };
});

import { exchangeCodeForTokens, getUserInfo, verifyIdTokenSignature } from '../../services/sso';
import { ssoRoutes } from '../../routes/sso';

// buildSsoStateCookieValue (routes/sso.ts) requires a binding secret.
process.env.APP_ENCRYPTION_KEY = 'integration-test-app-encryption-key-32-bytes!';

const ISSUER = 'https://idp.example.test';
const DEVICES_READ = [{ resource: 'devices', action: 'read' }];

type Fixture = {
  partnerId: string;
  orgId: string;
  roleId: string;
  otherPartnerId: string;
  ownPartnerPolicyName: string;
  otherPartnerPolicyName: string;
  orgPolicyName: string;
  ownPartnerPolicyId: string;
};

async function seedTenant(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  if (!role) throw new Error('role fixture failed');
  await grantRolePermissions(role.id, DEVICES_READ);

  const otherPartner = await createPartner();
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ownPartnerPolicyName = `Partner baseline ${suffix}`;
  const otherPartnerPolicyName = `Other partner baseline ${suffix}`;
  const orgPolicyName = `Org policy ${suffix}`;
  const testDb = getTestDb();
  const [ownPartnerPolicy] = await testDb
    .insert(configurationPolicies)
    .values({ orgId: null, partnerId: partner.id, name: ownPartnerPolicyName })
    .returning({ id: configurationPolicies.id });
  await testDb
    .insert(configurationPolicies)
    .values({ orgId: null, partnerId: otherPartner.id, name: otherPartnerPolicyName });
  await testDb
    .insert(configurationPolicies)
    .values({ orgId: org.id, partnerId: null, name: orgPolicyName });

  return {
    partnerId: partner.id,
    orgId: org.id,
    roleId: role.id,
    otherPartnerId: otherPartner.id,
    ownPartnerPolicyName,
    otherPartnerPolicyName,
    orgPolicyName,
    ownPartnerPolicyId: ownPartnerPolicy!.id,
  };
}

async function createOrgAxisProvider(orgId: string) {
  const [row] = await getTestDb()
    .insert(ssoProviders)
    .values({
      orgId,
      partnerId: null,
      name: 'Org Test IdP',
      type: 'oidc',
      status: 'active',
      issuer: ISSUER,
      clientId: 'test-client-id',
      clientSecret: encryptSecret('test-client-secret'),
      authorizationUrl: `${ISSUER}/authorize`,
      tokenUrl: `${ISSUER}/token`,
      userInfoUrl: `${ISSUER}/userinfo`,
      jwksUrl: `${ISSUER}/jwks`,
      enforceSSO: false,
      autoProvision: false,
    })
    .returning();
  if (!row) throw new Error('failed to create org-axis provider fixture');
  return row;
}

/** users row with no password, so the SSO callback mints directly instead of
 * parking a link ceremony (db-utils' createUser always sets a password). */
async function createPasswordlessUser(opts: { partnerId: string; orgId: string; email: string }) {
  const [row] = await getTestDb()
    .insert(users)
    .values({ partnerId: opts.partnerId, orgId: opts.orgId, email: opts.email, name: 'SSO User', passwordHash: null, status: 'active' })
    .returning();
  if (!row) throw new Error('failed to create passwordless user fixture');
  return row;
}

function idClaimsFor(sub: string, email: string, nonce: string) {
  const now = Math.floor(Date.now() / 1000);
  return { iss: ISSUER, sub, aud: 'test-client-id', exp: now + 3600, iat: now, nonce, email, email_verified: true };
}

function cookiePair(setCookieHeader: string): string {
  const pair = setCookieHeader.split(';')[0]?.trim();
  if (!pair) throw new Error(`could not parse Set-Cookie header: ${setCookieHeader}`);
  return pair;
}

type RefreshCookies = { refresh: string; csrf: string; csrfHeader: string };

function refreshCookiesFrom(res: Response): RefreshCookies {
  const all = res.headers.getSetCookie();
  const refresh = all.find((v) => v.startsWith('breeze_refresh_token='));
  const csrf = all.find((v) => v.startsWith('breeze_csrf_token='));
  if (!refresh || !csrf) throw new Error(`missing refresh/csrf cookies: ${all.join(' | ')}`);
  const csrfPair = cookiePair(csrf);
  return {
    refresh: cookiePair(refresh),
    csrf: csrfPair,
    csrfHeader: decodeURIComponent(csrfPair.split('=')[1] ?? ''),
  };
}

/** Drive GET /sso/login/:orgId → GET /sso/callback with a stubbed IdP. */
async function ssoCallback(app: Hono, orgId: string, binding: string, sub: string, email: string) {
  const loginRes = await app.request(`/sso/login/${orgId}`, { headers: { cookie: binding } });
  expect(loginRes.status).toBe(302);
  const state = new URL(loginRes.headers.get('location')!).searchParams.get('state')!;
  const [session] = await getTestDb().select().from(ssoSessions).where(eq(ssoSessions.state, state)).limit(1);
  if (!session) throw new Error(`no sso_sessions row for state ${state}`);
  const stateCookie = cookiePair(loginRes.headers.get('set-cookie')!);

  vi.mocked(verifyIdTokenSignature).mockResolvedValue(idClaimsFor(sub, email, session.nonce));
  vi.mocked(getUserInfo).mockResolvedValue({ sub, email, name: 'Org User' });

  return app.request(`/sso/callback?code=idp-auth-code&state=${state}`, {
    headers: { cookie: `${stateCookie}; ${binding}` },
  });
}

async function refresh(app: Hono, cookies: RefreshCookies, binding: string) {
  return app.request('/auth/refresh', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-breeze-csrf': cookies.csrfHeader,
      Cookie: `${cookies.refresh}; ${cookies.csrf}; ${binding}`,
    },
    body: JSON.stringify({}),
  });
}

/** Partner-wide read through a real route + authMiddleware (RLS-only filter). */
async function eligibleParentNames(app: Hono, accessToken: string, orgId: string): Promise<string[]> {
  const res = await app.request(
    `/configuration-policies/eligible-parents?ownerScope=organization&orgId=${orgId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  expect(res.status).toBe(200);
  const body = await res.json() as { data: Array<{ name: string }> };
  return body.data.map((row) => row.name);
}

function expectOrgSession(accessToken: string, fx: Fixture, userId: string) {
  const claims = decodeJwt(accessToken);
  expect(claims.sub).toBe(userId);
  expect(claims.scope).toBe('organization');
  expect(claims.orgId).toBe(fx.orgId);
  expect(claims.partnerId).toBe(fx.partnerId);
  expect(claims.roleId).toBe(fx.roleId);
  return claims;
}

describe('organization sessions carry their org\'s partner at every minter (#12246)', () => {
  let app: Hono;

  beforeEach(async () => {
    const { getRedis } = await import('../../services');
    const redis = getRedis();
    if (redis) {
      const keys = [
        ...await redis.keys('sso:login:*'),
        ...await redis.keys('ssolink:*'),
        ...await redis.keys('sso:pendinglink:*'),
      ];
      if (keys.length > 0) await redis.del(...keys);
    }
    app = new Hono();
    app.route('/sso', ssoRoutes);
    app.route('/auth', authRoutes);
    app.route('/configuration-policies', configPolicyRoutes);
    vi.mocked(exchangeCodeForTokens).mockReset().mockResolvedValue({
      access_token: 'idp-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'idp-refresh-token',
      id_token: 'header.payload.signature',
    });
  });

  afterEach(() => {
    vi.mocked(getUserInfo).mockClear();
    vi.mocked(verifyIdTokenSignature).mockClear();
  });

  it('RLS control: partner-wide rows are visible to an org context only with its own partner, and never writable', async () => {
    const fx = await seedTenant();
    const orgContext = (currentPartnerId: string | null) => ({
      scope: 'organization' as const,
      orgId: fx.orgId,
      accessibleOrgIds: [fx.orgId],
      accessiblePartnerIds: [],
      currentPartnerId,
      userId: null,
    });
    const visibleNames = (currentPartnerId: string | null) =>
      withDbAccessContext(orgContext(currentPartnerId), async () =>
        (await db.select({ name: configurationPolicies.name }).from(configurationPolicies)).map((r) => r.name));

    // Without a partner (the pre-fix SSO session shape) the partner-wide row
    // is invisible — proves RLS is live on this connection.
    const withoutPartner = await visibleNames(null);
    expect(withoutPartner).toContain(fx.orgPolicyName);
    expect(withoutPartner).not.toContain(fx.ownPartnerPolicyName);

    const withPartner = await visibleNames(fx.partnerId);
    expect(withPartner).toContain(fx.ownPartnerPolicyName);
    expect(withPartner).not.toContain(fx.otherPartnerPolicyName);

    // Read-only: the SELECT branch never widens UPDATE/DELETE targeting.
    const updated = await withDbAccessContext(orgContext(fx.partnerId), () =>
      db.update(configurationPolicies)
        .set({ name: 'hijacked' })
        .where(eq(configurationPolicies.id, fx.ownPartnerPolicyId))
        .returning({ id: configurationPolicies.id }));
    expect(updated).toHaveLength(0);
    const deleted = await withDbAccessContext(orgContext(fx.partnerId), () =>
      db.delete(configurationPolicies)
        .where(eq(configurationPolicies.id, fx.ownPartnerPolicyId))
        .returning({ id: configurationPolicies.id }));
    expect(deleted).toHaveLength(0);
    const [still] = await withSystemDbAccessContext(() =>
      db.select({ name: configurationPolicies.name }).from(configurationPolicies)
        .where(eq(configurationPolicies.id, fx.ownPartnerPolicyId)));
    expect(still?.name).toBe(fx.ownPartnerPolicyName);
  });

  it('password login (parity baseline): the org session carries the org\'s partner and reads partner-wide config', async () => {
    const fx = await seedTenant();
    const password = 'ParityBaseline123!';
    const user = await createUser({
      partnerId: fx.partnerId,
      orgId: fx.orgId,
      email: `pw-${Date.now()}@example.com`,
      password,
    });
    await assignUserToOrganization(user.id, fx.orgId, fx.roleId);
    const binding = (await bootstrapAuthBinding()).cookie;

    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: binding },
      body: JSON.stringify({ email: user.email, password }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { tokens: { accessToken: string } };
    expectOrgSession(body.tokens.accessToken, fx, user.id);

    const names = await eligibleParentNames(app, body.tokens.accessToken, fx.orgId);
    expect(names).toContain(fx.ownPartnerPolicyName);
    expect(names).toContain(fx.orgPolicyName);
    expect(names).not.toContain(fx.otherPartnerPolicyName);
  });

  it('org SSO callback: the session carries the org\'s partner, reads partner-wide config, and keeps it across refresh', async () => {
    const fx = await seedTenant();
    const user = await createPasswordlessUser({
      partnerId: fx.partnerId,
      orgId: fx.orgId,
      email: `sso-${Date.now()}@example.com`,
    });
    await assignUserToOrganization(user.id, fx.orgId, fx.roleId);
    await createOrgAxisProvider(fx.orgId);
    const binding = (await bootstrapAuthBinding()).cookie;

    const callbackRes = await ssoCallback(app, fx.orgId, binding, 'ext-sub-parity', user.email);
    expect(callbackRes.status).toBe(302);
    const location = callbackRes.headers.get('location')!;
    const code = decodeURIComponent(location.match(/#ssoCode=([^&]+)/)![1]!);

    const exchangeRes = await app.request('/sso/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: binding },
      body: JSON.stringify({ code }),
    });
    expect(exchangeRes.status).toBe(200);
    const { accessToken } = await exchangeRes.json() as { accessToken: string };

    // Immediately after login — the window the bug lived in.
    expectOrgSession(accessToken, fx, user.id);
    const names = await eligibleParentNames(app, accessToken, fx.orgId);
    expect(names).toContain(fx.ownPartnerPolicyName);
    expect(names).toContain(fx.orgPolicyName);
    expect(names).not.toContain(fx.otherPartnerPolicyName);

    // Refresh keeps every claim, and the read still works.
    const refreshRes = await refresh(app, refreshCookiesFrom(exchangeRes), binding);
    expect(refreshRes.status).toBe(200);
    const refreshed = await refreshRes.json() as { tokens: { accessToken: string } };
    expectOrgSession(refreshed.tokens.accessToken, fx, user.id);
    const namesAfterRefresh = await eligibleParentNames(app, refreshed.tokens.accessToken, fx.orgId);
    expect(namesAfterRefresh).toContain(fx.ownPartnerPolicyName);
    expect(namesAfterRefresh).not.toContain(fx.otherPartnerPolicyName);
  });

  it('org SSO link ceremony: the session minted at link confirmation carries the org\'s partner', async () => {
    const fx = await seedTenant();
    const password = 'LinkCeremony123!';
    const user = await createUser({
      partnerId: fx.partnerId,
      orgId: fx.orgId,
      email: `link-${Date.now()}@example.com`,
      password,
    });
    await assignUserToOrganization(user.id, fx.orgId, fx.roleId);
    await createOrgAxisProvider(fx.orgId);
    const binding = (await bootstrapAuthBinding()).cookie;

    // A password-holding user is never auto-linked: the callback parks a
    // pending link and sends the browser to the connect page.
    const callbackRes = await ssoCallback(app, fx.orgId, binding, 'ext-sub-link', user.email);
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get('location')).toBe('/auth/connect-sso');
    const linkCookieHeader = callbackRes.headers.getSetCookie().find((v) => v.startsWith('breeze_sso_pending_link='));
    expect(linkCookieHeader).toBeTruthy();

    const confirmRes = await app.request('/sso/link/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `${cookiePair(linkCookieHeader!)}; ${binding}` },
      body: JSON.stringify({ password }),
    });
    expect(confirmRes.status).toBe(200);
    const confirmBody = await confirmRes.json() as { tokens: { accessToken: string } };
    expectOrgSession(confirmBody.tokens.accessToken, fx, user.id);

    const names = await eligibleParentNames(app, confirmBody.tokens.accessToken, fx.orgId);
    expect(names).toContain(fx.ownPartnerPolicyName);
    expect(names).not.toContain(fx.otherPartnerPolicyName);
  });

  it('multi-org user: an org SSO session carries the partner of the provider\'s org, not the user\'s home partner', async () => {
    const home = await seedTenant();
    const second = await seedTenant();
    const user = await createPasswordlessUser({
      partnerId: home.partnerId,
      orgId: home.orgId,
      email: `multi-${Date.now()}@example.com`,
    });
    await assignUserToOrganization(user.id, home.orgId, home.roleId);
    await assignUserToOrganization(user.id, second.orgId, second.roleId);
    await createOrgAxisProvider(second.orgId);
    const binding = (await bootstrapAuthBinding()).cookie;

    const callbackRes = await ssoCallback(app, second.orgId, binding, 'ext-sub-multi', user.email);
    expect(callbackRes.status).toBe(302);
    const code = decodeURIComponent(callbackRes.headers.get('location')!.match(/#ssoCode=([^&]+)/)![1]!);
    const exchangeRes = await app.request('/sso/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: binding },
      body: JSON.stringify({ code }),
    });
    expect(exchangeRes.status).toBe(200);
    const { accessToken } = await exchangeRes.json() as { accessToken: string };
    let cookies = refreshCookiesFrom(exchangeRes);

    expectOrgSession(accessToken, second, user.id);
    const names = await eligibleParentNames(app, accessToken, second.orgId);
    expect(names).toContain(second.ownPartnerPolicyName);
    expect(names).not.toContain(home.ownPartnerPolicyName);

    // Refresh stays on the provider's org, not whichever membership row a
    // user-wide lookup happens to return first.
    for (let i = 0; i < 3; i += 1) {
      const refreshRes = await refresh(app, cookies, binding);
      expect(refreshRes.status).toBe(200);
      cookies = refreshCookiesFrom(refreshRes);
      const refreshed = await refreshRes.json() as { tokens: { accessToken: string } };
      expectOrgSession(refreshed.tokens.accessToken, second, user.id);
    }
  });
});

describe('refresh re-issues the session\'s own tenant scope', () => {
  let app: Hono;

  beforeEach(async () => {
    const { getRedis } = await import('../../services');
    const redis = getRedis();
    if (redis) {
      const keys = [
        ...await redis.keys('sso:login:*'),
        ...await redis.keys('ssolink:*'),
        ...await redis.keys('sso:pendinglink:*'),
      ];
      if (keys.length > 0) await redis.del(...keys);
    }
    app = new Hono();
    app.route('/sso', ssoRoutes);
    app.route('/auth', authRoutes);
    vi.mocked(exchangeCodeForTokens).mockReset().mockResolvedValue({
      access_token: 'idp-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'idp-refresh-token',
      id_token: 'header.payload.signature',
    });
  });

  afterEach(() => {
    vi.mocked(getUserInfo).mockClear();
    vi.mocked(verifyIdTokenSignature).mockClear();
  });

  /** An org-homed user who also holds a partner membership on the org's partner. */
  async function seedDualMembershipUser(fx: Fixture, opts: { password?: string } = {}) {
    const email = `dual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
    const user = opts.password
      ? await createUser({ partnerId: fx.partnerId, orgId: fx.orgId, email, password: opts.password })
      : await createPasswordlessUser({ partnerId: fx.partnerId, orgId: fx.orgId, email });
    await assignUserToOrganization(user.id, fx.orgId, fx.roleId);
    const partnerRole = await createRole({ scope: 'partner', partnerId: fx.partnerId });
    if (!partnerRole) throw new Error('partner role fixture failed');
    await assignUserToPartner(user.id, fx.partnerId, partnerRole.id, 'all');
    return { user, partnerRoleId: partnerRole.id };
  }

  async function orgSsoSession(fx: Fixture, userId: string, email: string, sub: string) {
    await createOrgAxisProvider(fx.orgId);
    const binding = (await bootstrapAuthBinding()).cookie;
    const callbackRes = await ssoCallback(app, fx.orgId, binding, sub, email);
    expect(callbackRes.status).toBe(302);
    const code = decodeURIComponent(callbackRes.headers.get('location')!.match(/#ssoCode=([^&]+)/)![1]!);
    const exchangeRes = await app.request('/sso/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: binding },
      body: JSON.stringify({ code }),
    });
    expect(exchangeRes.status).toBe(200);
    const { accessToken } = await exchangeRes.json() as { accessToken: string };
    expectOrgSession(accessToken, fx, userId);
    return { binding, cookies: refreshCookiesFrom(exchangeRes) };
  }

  async function passwordSession(email: string, password: string) {
    const binding = (await bootstrapAuthBinding()).cookie;
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: binding },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { tokens: { accessToken: string } };
    return { binding, cookies: refreshCookiesFrom(res), accessToken: body.tokens.accessToken };
  }

  async function familyRevokedAt(cookies: RefreshCookies): Promise<Date | null> {
    const fam = decodeJwt(decodeURIComponent(cookies.refresh.split('=')[1] ?? '')).fam as string;
    expect(fam).toBeTruthy();
    const [row] = await withSystemDbAccessContext(() =>
      db.select({ revokedAt: refreshTokenFamilies.revokedAt })
        .from(refreshTokenFamilies)
        .where(eq(refreshTokenFamilies.familyId, fam))
        .limit(1));
    if (!row) throw new Error(`no refresh_token_families row for ${fam}`);
    return row.revokedAt;
  }

  it('org SSO session for a user who also holds a partner membership stays organization-scope on the same org', async () => {
    const fx = await seedTenant();
    const { user } = await seedDualMembershipUser(fx);
    const session = await orgSsoSession(fx, user.id, user.email, 'ext-sub-dual');
    let cookies = session.cookies;

    for (let i = 0; i < 2; i += 1) {
      const refreshRes = await refresh(app, cookies, session.binding);
      expect(refreshRes.status).toBe(200);
      cookies = refreshCookiesFrom(refreshRes);
      const refreshed = await refreshRes.json() as { tokens: { accessToken: string } };
      expectOrgSession(refreshed.tokens.accessToken, fx, user.id);
    }
  });

  it('org membership removed: refresh is refused and the session is revoked, with no partner fallback', async () => {
    const fx = await seedTenant();
    const { user } = await seedDualMembershipUser(fx);
    const { binding, cookies } = await orgSsoSession(fx, user.id, user.email, 'ext-sub-dual-removed');

    await getTestDb().delete(organizationUsers).where(and(
      eq(organizationUsers.userId, user.id),
      eq(organizationUsers.orgId, fx.orgId),
    ));

    const refreshRes = await refresh(app, cookies, binding);
    expect(refreshRes.status).toBe(401);
    expect(await refreshRes.json()).not.toHaveProperty('tokens');
    expect(await familyRevokedAt(cookies)).toBeInstanceOf(Date);

    // The revocation outlasts the membership change: re-adding the org
    // membership does not revive this session (the partner membership never
    // could). The user signs in again.
    await assignUserToOrganization(user.id, fx.orgId, fx.roleId);
    const retry = await refresh(app, cookies, binding);
    expect(retry.status).toBe(401);
  });

  it('a multi-org user removed from the session\'s org is refused, not moved to their other org', async () => {
    const home = await seedTenant();
    const second = await seedTenant();
    const user = await createPasswordlessUser({
      partnerId: home.partnerId,
      orgId: home.orgId,
      email: `multi-removed-${Date.now()}@example.com`,
    });
    await assignUserToOrganization(user.id, home.orgId, home.roleId);
    await assignUserToOrganization(user.id, second.orgId, second.roleId);
    const { binding, cookies } = await orgSsoSession(second, user.id, user.email, 'ext-sub-multi-removed');

    await getTestDb().delete(organizationUsers).where(and(
      eq(organizationUsers.userId, user.id),
      eq(organizationUsers.orgId, second.orgId),
    ));

    const refreshRes = await refresh(app, cookies, binding);
    expect(refreshRes.status).toBe(401);
    expect(await refreshRes.json()).not.toHaveProperty('tokens');
    expect(await familyRevokedAt(cookies)).toBeInstanceOf(Date);
  });

  it('an inactive org refuses refresh without revoking the family', async () => {
    const fx = await seedTenant();
    const { user } = await seedDualMembershipUser(fx);
    const { binding, cookies } = await orgSsoSession(fx, user.id, user.email, 'ext-sub-inactive-org');

    await getTestDb().update(organizations).set({ status: 'suspended' }).where(eq(organizations.id, fx.orgId));

    const refreshRes = await refresh(app, cookies, binding);
    expect(refreshRes.status).toBe(401);
    expect(await refreshRes.json()).not.toHaveProperty('tokens');
    // Not a lost membership: the family stays live, and no partner session
    // was issued in its place.
    expect(await familyRevokedAt(cookies)).toBeNull();
  });

  it('partner-scope password session refreshes unchanged', async () => {
    const fx = await seedTenant();
    const password = 'PartnerAxis123!';
    const partnerRole = await createRole({ scope: 'partner', partnerId: fx.partnerId });
    if (!partnerRole) throw new Error('partner role fixture failed');
    const user = await createUser({
      partnerId: fx.partnerId,
      orgId: null,
      email: `partner-${Date.now()}@example.com`,
      password,
    });
    await assignUserToPartner(user.id, fx.partnerId, partnerRole.id, 'all');
    const session = await passwordSession(user.email, password);
    expect(decodeJwt(session.accessToken)).toMatchObject({
      scope: 'partner',
      partnerId: fx.partnerId,
      orgId: null,
      roleId: partnerRole.id,
    });
    let cookies = session.cookies;

    for (let i = 0; i < 2; i += 1) {
      const refreshRes = await refresh(app, cookies, session.binding);
      expect(refreshRes.status).toBe(200);
      cookies = refreshCookiesFrom(refreshRes);
      const refreshed = await refreshRes.json() as { tokens: { accessToken: string } };
      expect(decodeJwt(refreshed.tokens.accessToken)).toMatchObject({
        sub: user.id,
        scope: 'partner',
        partnerId: fx.partnerId,
        orgId: null,
        roleId: partnerRole.id,
      });
    }
  });

  it('partner-scope password session of a dual-membership user stays partner-scope; partner membership removed refuses refresh with no org fallback', async () => {
    const fx = await seedTenant();
    const password = 'DualPartner123!';
    const { user, partnerRoleId } = await seedDualMembershipUser(fx, { password });
    const session = await passwordSession(user.email, password);
    expect(decodeJwt(session.accessToken)).toMatchObject({
      scope: 'partner',
      partnerId: fx.partnerId,
      orgId: null,
      roleId: partnerRoleId,
    });

    const refreshRes = await refresh(app, session.cookies, session.binding);
    expect(refreshRes.status).toBe(200);
    const cookies = refreshCookiesFrom(refreshRes);
    const refreshed = await refreshRes.json() as { tokens: { accessToken: string } };
    expect(decodeJwt(refreshed.tokens.accessToken)).toMatchObject({
      scope: 'partner',
      partnerId: fx.partnerId,
      orgId: null,
    });

    await getTestDb().delete(partnerUsers).where(and(
      eq(partnerUsers.userId, user.id),
      eq(partnerUsers.partnerId, fx.partnerId),
    ));

    const denied = await refresh(app, cookies, session.binding);
    expect(denied.status).toBe(401);
    expect(await denied.json()).not.toHaveProperty('tokens');
    expect(await familyRevokedAt(cookies)).toBeInstanceOf(Date);
  });

  it('a user removed from the session\'s partner is refused, not moved to another partner membership', async () => {
    const fx = await seedTenant();
    const other = await seedTenant();
    const password = 'TwoPartners123!';
    const firstRole = await createRole({ scope: 'partner', partnerId: fx.partnerId });
    const secondRole = await createRole({ scope: 'partner', partnerId: other.partnerId });
    if (!firstRole || !secondRole) throw new Error('partner role fixture failed');
    const user = await createUser({
      partnerId: fx.partnerId,
      orgId: null,
      email: `two-partners-${Date.now()}@example.com`,
      password,
    });
    await assignUserToPartner(user.id, fx.partnerId, firstRole.id, 'all');
    const session = await passwordSession(user.email, password);
    expect(decodeJwt(session.accessToken)).toMatchObject({ scope: 'partner', partnerId: fx.partnerId });
    // A second partner membership arrives after sign-in.
    await assignUserToPartner(user.id, other.partnerId, secondRole.id, 'all');

    await getTestDb().delete(partnerUsers).where(and(
      eq(partnerUsers.userId, user.id),
      eq(partnerUsers.partnerId, fx.partnerId),
    ));

    const denied = await refresh(app, session.cookies, session.binding);
    expect(denied.status).toBe(401);
    expect(await denied.json()).not.toHaveProperty('tokens');
    expect(await familyRevokedAt(session.cookies)).toBeInstanceOf(Date);
  });

  it('single-membership org password session refreshes unchanged', async () => {
    const fx = await seedTenant();
    const password = 'SingleOrg123!';
    const user = await createUser({
      partnerId: fx.partnerId,
      orgId: fx.orgId,
      email: `single-${Date.now()}@example.com`,
      password,
    });
    await assignUserToOrganization(user.id, fx.orgId, fx.roleId);
    const session = await passwordSession(user.email, password);
    expectOrgSession(session.accessToken, fx, user.id);
    let cookies = session.cookies;

    for (let i = 0; i < 2; i += 1) {
      const refreshRes = await refresh(app, cookies, session.binding);
      expect(refreshRes.status).toBe(200);
      cookies = refreshCookiesFrom(refreshRes);
      const refreshed = await refreshRes.json() as { tokens: { accessToken: string } };
      expectOrgSession(refreshed.tokens.accessToken, fx, user.id);
    }
  });
});
