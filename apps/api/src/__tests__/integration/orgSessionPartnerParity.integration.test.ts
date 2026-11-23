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
 * Since #12462 W03a the app layer reads more narrowly than RLS: an org session
 * lists, opens or names an MSP-managed (partner-owned) policy only when it
 * applies to the session's organization (`policyReadCondition`, plan D14). So
 * the partner baselines below are assigned at the partner level, which applies
 * them to every customer org of their partner, and an unassigned partner policy
 * checks that the narrowing is the read rule and not a lost partner: RLS still
 * returns it, the route does not. Effective configuration does not go through
 * the read rule; the last case resolves it for a device under the same session.
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
import { eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configPolicyMonitoringSettings,
  configurationPolicies,
  ssoProviders,
  ssoSessions,
  users,
} from '../../db/schema';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  assignUserToOrganization,
  bootstrapAuthBinding,
  createOrganization,
  createDevice,
  createPartner,
  createRole,
  createSite,
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
  unassignedPartnerPolicyName: string;
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
  const unassignedPartnerPolicyName = `Unassigned partner policy ${suffix}`;
  const testDb = getTestDb();
  const [ownPartnerPolicy] = await testDb
    .insert(configurationPolicies)
    .values({ orgId: null, partnerId: partner.id, name: ownPartnerPolicyName })
    .returning({ id: configurationPolicies.id });
  const [otherPartnerPolicy] = await testDb
    .insert(configurationPolicies)
    .values({ orgId: null, partnerId: otherPartner.id, name: otherPartnerPolicyName })
    .returning({ id: configurationPolicies.id });
  await testDb
    .insert(configurationPolicies)
    .values({ orgId: org.id, partnerId: null, name: orgPolicyName });
  // Partner-owned, assigned nowhere, no children: hidden from an org session
  // by the read rule (#12462 W03a) although RLS returns it.
  await testDb
    .insert(configurationPolicies)
    .values({ orgId: null, partnerId: partner.id, name: unassignedPartnerPolicyName });
  // Each baseline governs every customer org of its own partner (D14 clause
  // 1). The other partner's baseline is assigned too, so its exclusion below
  // is by partner, not by being unassigned.
  await testDb.insert(configPolicyAssignments).values([
    { configPolicyId: ownPartnerPolicy!.id, level: 'partner', targetId: partner.id, priority: 0 },
    { configPolicyId: otherPartnerPolicy!.id, level: 'partner', targetId: otherPartner.id, priority: 0 },
  ]);

  return {
    partnerId: partner.id,
    orgId: org.id,
    roleId: role.id,
    otherPartnerId: otherPartner.id,
    ownPartnerPolicyName,
    otherPartnerPolicyName,
    orgPolicyName,
    unassignedPartnerPolicyName,
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

/**
 * Partner-wide read through a real route + authMiddleware: RLS, then the W03a
 * read rule (an MSP-managed policy must apply to the org).
 */
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
    // RLS does not apply the read rule: the unassigned partner policy is
    // visible here and hidden only by the route (see the login cases).
    expect(withPartner).toContain(fx.unassignedPartnerPolicyName);

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
    // #12462 W03a: a partner policy that applies to no org is not offered.
    expect(names).not.toContain(fx.unassignedPartnerPolicyName);
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
    expect(names).not.toContain(fx.unassignedPartnerPolicyName);

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

    expectOrgSession(accessToken, second, user.id);
    const names = await eligibleParentNames(app, accessToken, second.orgId);
    expect(names).toContain(second.ownPartnerPolicyName);
    expect(names).not.toContain(home.ownPartnerPolicyName);
    expect(names).not.toContain(second.unassignedPartnerPolicyName);
  });

  it('org session resolves its device\'s effective configuration from the partner baseline', async () => {
    // Session parity for delivery: the same org session that reads the
    // baseline also gets it in a device's effective configuration. The
    // resolver has its own ownership clause and does not go through the W03a
    // read rule (resolveEffectiveConfigWithExecutor).
    const fx = await seedTenant();
    const testDb = getTestDb();
    const [link] = await testDb
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: fx.ownPartnerPolicyId, featureType: 'monitors', inlineSettings: { items: [], checkIntervalSeconds: 611 } })
      .returning();
    await testDb.insert(configPolicyMonitoringSettings).values({ featureLinkId: link!.id, checkIntervalSeconds: 611 });
    const site = await createSite({ orgId: fx.orgId });
    const device = await createDevice({ orgId: fx.orgId, siteId: site!.id });

    const password = 'EffectiveParity123!';
    const user = await createUser({ partnerId: fx.partnerId, orgId: fx.orgId, email: `eff-${Date.now()}@example.com`, password });
    await assignUserToOrganization(user.id, fx.orgId, fx.roleId);
    const binding = (await bootstrapAuthBinding()).cookie;
    const login = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: binding },
      body: JSON.stringify({ email: user.email, password }),
    });
    expect(login.status).toBe(200);
    const { tokens } = await login.json() as { tokens: { accessToken: string } };
    expectOrgSession(tokens.accessToken, fx, user.id);

    const res = await app.request(`/configuration-policies/effective/${device.id}`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      features: Record<string, { sourcePolicyId: string; sourceLevel: string }>;
      inheritanceChain: Array<{ policyId: string }>;
      policyOwners: Record<string, string>;
    };
    expect(body.features.monitors?.sourcePolicyId).toBe(fx.ownPartnerPolicyId);
    expect(body.features.monitors?.sourceLevel).toBe('partner');
    expect(body.inheritanceChain.some((e) => e.policyId === fx.ownPartnerPolicyId)).toBe(true);
    expect(body.policyOwners[fx.ownPartnerPolicyId]).toBe('partner');
  });
});
