/**
 * Real-DB end-to-end partner-axis SSO login + Connect SSO link flow (#2183).
 *
 * Exercises the actual route handlers (`ssoRoutes`) against real Postgres +
 * Redis, through the full HTTP surface: GET /sso/login/partner/:partnerId →
 * GET /sso/callback → POST /sso/exchange, plus the authenticated Connect SSO
 * link round-trip (POST /sso/link/start/:providerId → GET /sso/callback).
 * Only the IdP network calls are stubbed (exchangeCodeForTokens,
 * getUserInfo, verifyIdTokenSignature) — everything else (state/nonce/PKCE
 * generation, cookie binding, DB reads/writes, RLS, JWT minting, rate
 * limiting) is real, the same pattern used by routes/sso.test.ts's mocked-db
 * unit suite but here against the genuine `breeze_app` RLS-enforced pool.
 *
 * Also includes org-axis coverage: ONE callback-only case (see "org-axis
 * callback" test below) regression-locking the TWO `withSystemDbAccessContext`
 * fixes to the callback's shared plumbing (the provider read, and the
 * org-membership read in the org branch of the token-payload switch) — both
 * shared by BOTH axes, so a partner-only suite wouldn't catch a regression on
 * the org side. That case seeds `sso_sessions` directly to keep the callback
 * isolated from the initiation route. The FULL org path — GET /sso/check/:orgId
 * → GET /sso/login/:orgId → callback — is covered by the #2195 tests below,
 * which regression-lock the initiation/check system-context fixes (those
 * routes' bare reads 0-rowed under breeze_app RLS, so org SSO could never
 * even start in production-shaped deployments).
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run:
 *   pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/ssoPartnerLogin.integration.test.ts
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { decodeJwt } from 'jose';
import { and, eq } from 'drizzle-orm';
import { createHmac } from 'crypto';
import { getTestDb } from './setup';
import { ssoProviders, ssoSessions, userSsoIdentities, users } from '../../db/schema';
import {
  createPartner,
  createOrganization,
  createRole,
  createUser,
  assignUserToPartner,
  assignUserToOrganization,
} from './db-utils';
import { encryptSecret } from '../../services/secretCrypto';
import { createAccessToken } from '../../services/jwt';
import { loginRoutes } from '../../routes/auth/login';

vi.mock('../../services/sso', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/sso')>();
  return {
    ...actual,
    exchangeCodeForTokens: vi.fn(),
    getUserInfo: vi.fn(),
    verifyIdTokenSignature: vi.fn(),
  };
});

import { exchangeCodeForTokens, getUserInfo, verifyIdTokenSignature, generateState, generateNonce } from '../../services/sso';
import { ssoRoutes } from '../../routes/sso';

// buildSsoStateCookieValue (routes/sso.ts) requires one of these to be set —
// .env.test doesn't provide either, so the login-initiation route 500s
// ("SSO login binding secret is not configured") without it.
process.env.APP_ENCRYPTION_KEY = 'integration-test-app-encryption-key-32-bytes!';

const ISSUER = 'https://idp.example.test';

async function createPartnerAxisProvider(
  partnerId: string,
  opts: { trustsIdpMfa?: boolean; status?: 'active' | 'inactive' | 'testing'; enforceSSO?: boolean } = {},
) {
  const db = getTestDb();
  const [row] = await db
    .insert(ssoProviders)
    .values({
      orgId: null,
      partnerId,
      name: 'Partner IdP',
      type: 'oidc',
      status: opts.status ?? 'active',
      issuer: ISSUER,
      clientId: 'test-client-id',
      clientSecret: encryptSecret('test-client-secret'),
      authorizationUrl: `${ISSUER}/authorize`,
      tokenUrl: `${ISSUER}/token`,
      userInfoUrl: `${ISSUER}/userinfo`,
      jwksUrl: `${ISSUER}/jwks`,
      trustsIdpMfa: opts.trustsIdpMfa ?? false,
      enforceSSO: opts.enforceSSO ?? false,
      autoProvision: false,
    })
    .returning();
  if (!row) throw new Error('failed to create partner-axis provider fixture');
  return row;
}

/** Org-axis sibling of createPartnerAxisProvider (#2195). */
async function createOrgAxisProvider(
  orgId: string,
  opts: { status?: 'active' | 'inactive' | 'testing'; enforceSSO?: boolean; name?: string; createdAt?: Date } = {},
) {
  const db = getTestDb();
  const [row] = await db
    .insert(ssoProviders)
    .values({
      orgId,
      partnerId: null,
      name: opts.name ?? 'Org Test IdP',
      type: 'oidc',
      status: opts.status ?? 'active',
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      issuer: ISSUER,
      clientId: 'test-client-id',
      clientSecret: encryptSecret('test-client-secret'),
      authorizationUrl: `${ISSUER}/authorize`,
      tokenUrl: `${ISSUER}/token`,
      userInfoUrl: `${ISSUER}/userinfo`,
      jwksUrl: `${ISSUER}/jwks`,
      enforceSSO: opts.enforceSSO ?? false,
      autoProvision: false,
    })
    .returning();
  if (!row) throw new Error('failed to create org-axis provider fixture');
  return row;
}

/** Insert a user row directly (bypassing db-utils' createUser, which always
 * hashes a password) so passwordHash can be left null for SSO-only staff. */
async function createPasswordlessUser(opts: { partnerId: string; orgId?: string | null; email: string; name?: string }) {
  const db = getTestDb();
  const [row] = await db
    .insert(users)
    .values({
      partnerId: opts.partnerId,
      orgId: opts.orgId ?? null,
      email: opts.email,
      name: opts.name ?? 'Test User',
      passwordHash: null,
      status: 'active',
    })
    .returning();
  if (!row) throw new Error('failed to create passwordless user fixture');
  return row;
}

function extractStateFromLocation(location: string): string {
  const url = new URL(location);
  const state = url.searchParams.get('state');
  if (!state) throw new Error(`no state param in redirect location: ${location}`);
  return state;
}

/** Pull just the `name=value` pair out of a Set-Cookie header, discarding
 * attributes (Path/HttpOnly/SameSite/Max-Age), for use as a Cookie header
 * on the follow-up callback request. */
function extractCookiePair(setCookieHeader: string): string {
  const first = setCookieHeader.split(',')[0] ?? setCookieHeader;
  const pair = first.split(';')[0]?.trim();
  if (!pair) throw new Error(`could not parse Set-Cookie header: ${setCookieHeader}`);
  return pair;
}

function extractSsoCodeFromLocation(location: string): string {
  const match = location.match(/#ssoCode=([^&]+)/);
  if (!match || !match[1]) throw new Error(`no #ssoCode fragment in redirect location: ${location}`);
  return decodeURIComponent(match[1]);
}

/** Reproduces routes/sso.ts's buildSsoStateCookieValue (not exported) so a
 * directly-seeded session (see the callback-only org-axis test) can present a
 * browser-binding cookie the callback will accept without going through the
 * initiation route — keeping that case a pure callback regression lock. */
function buildTestSsoStateCookie(state: string): string {
  const secret = process.env.APP_ENCRYPTION_KEY!;
  const value = createHmac('sha256', secret).update(`sso-login-state:${state}`).digest('hex');
  return `breeze_sso_state=${encodeURIComponent(value)}`;
}

describe('SSO partner-axis login + Connect SSO link — real-DB e2e (#2183)', () => {
  let app: Hono;

  beforeEach(async () => {
    // Flush the SSO login rate-limit buckets between tests: the pure-IP
    // bucket (sso:login:ip:*, 30/5min) is shared across BOTH initiation
    // routes and real Redis persists across test files — enough accumulated
    // initiations in one CI window would start 429ing unrelated tests.
    const { getRedis } = await import('../../services');
    const redis = getRedis();
    if (redis) {
      const keys = await redis.keys('sso:login:*');
      if (keys.length > 0) await redis.del(...keys);
    }
    app = new Hono();
    app.route('/sso', ssoRoutes);
    // Mounted for the enforceSSO-non-suppression case below, which drives a
    // real POST /auth/login to prove a status='testing' provider never gates
    // password auth (only status='active' + enforceSSO does, via ssoPolicy.ts).
    app.route('/auth', loginRoutes);
    vi.mocked(exchangeCodeForTokens).mockReset().mockResolvedValue({
      access_token: 'idp-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'idp-refresh-token',
      id_token: 'header.payload.signature',
    });
  });

  afterEach(() => {
    vi.mocked(exchangeCodeForTokens).mockClear();
    vi.mocked(getUserInfo).mockClear();
    vi.mocked(verifyIdTokenSignature).mockClear();
  });

  it('full partner-axis login mints a scope:partner token for the linked user', async () => {
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const user = await createPasswordlessUser({
      partnerId: partner.id,
      email: `tech-${Date.now()}@example.com`,
    });
    await assignUserToPartner(user.id, partner.id, role.id, 'all');
    const provider = await createPartnerAxisProvider(partner.id);

    // Step 1: GET /sso/login/partner/:partnerId → 302 to IdP, session row
    // created, state cookie set.
    const loginRes = await app.request(`/sso/login/partner/${partner.id}`);
    expect(loginRes.status).toBe(302);
    const location = loginRes.headers.get('location');
    expect(location).toBeTruthy();
    expect(location).toContain(ISSUER);

    const setCookie = loginRes.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('breeze_sso_state=');

    const state = extractStateFromLocation(location!);
    const db = getTestDb();
    const [sessionRow] = await db.select().from(ssoSessions).where(eq(ssoSessions.state, state)).limit(1);
    expect(sessionRow).toBeDefined();
    expect(sessionRow?.providerId).toBe(provider.id);
    expect(sessionRow?.linkUserId).toBeNull();

    // Step 2: GET /sso/callback with matching state/cookie + stubbed IdP
    // responses asserting the user's email → 302 with #ssoCode=.
    vi.mocked(verifyIdTokenSignature).mockResolvedValue({
      iss: ISSUER,
      sub: 'external-sub-tech-1',
      aud: 'test-client-id',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      nonce: sessionRow!.nonce,
      email: user.email,
      email_verified: true,
    });
    vi.mocked(getUserInfo).mockResolvedValue({
      sub: 'external-sub-tech-1',
      email: user.email,
      name: user.name ?? 'Tech',
    });

    const callbackRes = await app.request(`/sso/callback?code=idp-auth-code&state=${state}`, {
      headers: { cookie: extractCookiePair(setCookie!) },
    });
    expect(callbackRes.status).toBe(302);
    const callbackLocation = callbackRes.headers.get('location');
    expect(callbackLocation).toBeTruthy();
    expect(callbackLocation).toContain('#ssoCode=');

    // The session row was atomically claimed (deleted) by the callback.
    const [claimedSession] = await db.select().from(ssoSessions).where(eq(ssoSessions.state, state)).limit(1);
    expect(claimedSession).toBeUndefined();

    // Step 3: POST /sso/exchange { code } → accessToken with the expected
    // scope:'partner' claims.
    const ssoCode = extractSsoCodeFromLocation(callbackLocation!);
    const exchangeRes = await app.request('/sso/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: ssoCode }),
    });
    expect(exchangeRes.status).toBe(200);
    const exchangeBody = await exchangeRes.json();
    expect(exchangeBody.accessToken).toBeDefined();

    const payload = decodeJwt(exchangeBody.accessToken);
    expect(payload.scope).toBe('partner');
    expect(payload.partnerId).toBe(partner.id);
    expect(payload.orgId).toBeNull();
    expect(payload.roleId).toBe(role.id);
    expect(payload.mfa).toBe(false);
    expect(payload.sub).toBe(user.id);

    // The identity link + last-login stamp were persisted under system
    // context (bare reads would silently 0-row under RLS — see PR sweep notes).
    const [identity] = await db
      .select()
      .from(userSsoIdentities)
      .where(eq(userSsoIdentities.providerId, provider.id))
      .limit(1);
    expect(identity?.userId).toBe(user.id);
    expect(identity?.externalId).toBe('external-sub-tech-1');
  });

  it('an org-bound user with the same email domain never resolves through the partner provider (email-match exclusion)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await createPartnerAxisProvider(partner.id);

    // orgId set → excluded by the partner-axis email condition
    // (partnerId match AND orgId IS NULL), even though the email matches
    // exactly and the partner is the same as the provider's.
    const orgBoundUser = await createPasswordlessUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `org-bound-${Date.now()}@example.com`,
    });

    const state = await initiatePartnerLogin(app, partner.id);
    vi.mocked(verifyIdTokenSignature).mockResolvedValue(idClaimsFor('external-sub-org-bound', orgBoundUser.email, state.nonce));
    vi.mocked(getUserInfo).mockResolvedValue({ sub: 'external-sub-org-bound', email: orgBoundUser.email, name: 'Org Bound' });

    const callbackRes = await app.request(`/sso/callback?code=idp-auth-code&state=${state.state}`, {
      headers: { cookie: state.cookiePair },
    });
    expect(callbackRes.status).toBe(302);
    const location = callbackRes.headers.get('location');
    expect(location).toContain('/login?error=invite_required');
  });

  it('mint gate: a pre-linked org-bound user with partner membership is still rejected at token mint (no_partner_access)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const provider = await createPartnerAxisProvider(partner.id);

    const orgBoundUser = await createPasswordlessUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `mint-gate-${Date.now()}@example.com`,
    });
    // Give the org-bound user a partner_users membership too, so membership
    // is NOT what blocks this — the mint-gate's `user.orgId != null` check
    // must fire first, independent of membership.
    await assignUserToPartner(orgBoundUser.id, partner.id, role.id, 'all');

    const db = getTestDb();
    await db.insert(userSsoIdentities).values({
      userId: orgBoundUser.id,
      providerId: provider.id,
      externalId: 'external-sub-mint-gate',
      email: orgBoundUser.email,
    });

    const state = await initiatePartnerLogin(app, partner.id);
    vi.mocked(verifyIdTokenSignature).mockResolvedValue(idClaimsFor('external-sub-mint-gate', orgBoundUser.email, state.nonce));
    vi.mocked(getUserInfo).mockResolvedValue({ sub: 'external-sub-mint-gate', email: orgBoundUser.email, name: 'Mint Gate' });

    const callbackRes = await app.request(`/sso/callback?code=idp-auth-code&state=${state.state}`, {
      headers: { cookie: state.cookiePair },
    });
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get('location')).toContain('/login?error=no_partner_access');
  });

  it('Connect SSO: password-holding partner tech gets sso_link_required at login, then links, then SSO login succeeds', async () => {
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const provider = await createPartnerAxisProvider(partner.id);

    // V holds a password already — never auto-linked at login.
    const db = getTestDb();
    const [passwordUser] = await db
      .insert(users)
      .values({
        partnerId: partner.id,
        orgId: null,
        email: `v-${Date.now()}@example.com`,
        name: 'V Tech',
        passwordHash: '$2b$10$abcdefghijklmnopqrstuuC0zQx1Y0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0', // bcrypt-shaped, never verified in this flow
        status: 'active',
      })
      .returning();
    if (!passwordUser) throw new Error('failed to create password-holding user fixture');
    await assignUserToPartner(passwordUser.id, partner.id, role.id, 'all');

    // (a) Login-path callback asserting V's email → sso_link_required.
    const firstLogin = await initiatePartnerLogin(app, partner.id);
    vi.mocked(verifyIdTokenSignature).mockResolvedValue(idClaimsFor('external-sub-v', passwordUser.email, firstLogin.nonce));
    vi.mocked(getUserInfo).mockResolvedValue({ sub: 'external-sub-v', email: passwordUser.email, name: 'V Tech' });

    const firstCallback = await app.request(`/sso/callback?code=idp-auth-code&state=${firstLogin.state}`, {
      headers: { cookie: firstLogin.cookiePair },
    });
    expect(firstCallback.status).toBe(302);
    expect(firstCallback.headers.get('location')).toContain('/login?error=sso_link_required');

    // (b) Authenticated POST /sso/link/start/:providerId as V (mfa:true in
    // the test token, since requireMfa() gates the link-start route).
    const vToken = await createAccessToken({
      sub: passwordUser.id,
      email: passwordUser.email,
      roleId: role.id,
      orgId: null,
      partnerId: partner.id,
      scope: 'partner',
      mfa: true,
      // Epoch claims (core-auth PR 1): authMiddleware rejects access tokens
      // missing aep/mep/sid or stale vs users.auth_epoch/mfa_epoch (DB default 1).
      aep: 1,
      mep: 1,
      sid: 'it-session',
    });

    const linkStartRes = await app.request(`/sso/link/start/${provider.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${vToken}` },
    });
    expect(linkStartRes.status).toBe(200);
    const linkStartBody = await linkStartRes.json();
    expect(linkStartBody.authUrl).toBeDefined();
    expect(String(linkStartBody.authUrl)).toContain(ISSUER);

    const linkSetCookie = linkStartRes.headers.get('set-cookie');
    expect(linkSetCookie).toBeTruthy();
    const linkState = extractStateFromLocation(String(linkStartBody.authUrl));

    const [linkSessionRow] = await db.select().from(ssoSessions).where(eq(ssoSessions.state, linkState)).limit(1);
    expect(linkSessionRow).toBeDefined();
    expect(linkSessionRow?.linkUserId).toBe(passwordUser.id);

    // (c) Callback with that state + stubbed IdP asserting V's email →
    // redirect /settings/profile?ssoLinked=1, identity row created.
    vi.mocked(verifyIdTokenSignature).mockResolvedValue(idClaimsFor('external-sub-v', passwordUser.email, linkSessionRow!.nonce));
    vi.mocked(getUserInfo).mockResolvedValue({ sub: 'external-sub-v', email: passwordUser.email, name: 'V Tech' });

    const linkCallbackRes = await app.request(`/sso/callback?code=idp-auth-code&state=${linkState}`, {
      headers: { cookie: extractCookiePair(linkSetCookie!) },
    });
    expect(linkCallbackRes.status).toBe(302);
    expect(linkCallbackRes.headers.get('location')).toContain('/settings/profile?ssoLinked=1');

    const [identity] = await db
      .select()
      .from(userSsoIdentities)
      .where(eq(userSsoIdentities.providerId, provider.id))
      .limit(1);
    expect(identity?.userId).toBe(passwordUser.id);
    expect(identity?.externalId).toBe('external-sub-v');

    // (d) Login-path round-trip again for V → NOW succeeds via the linked
    // identity; scope:'partner', sub === V.id.
    const secondLogin = await initiatePartnerLogin(app, partner.id);
    vi.mocked(verifyIdTokenSignature).mockResolvedValue(idClaimsFor('external-sub-v', passwordUser.email, secondLogin.nonce));
    vi.mocked(getUserInfo).mockResolvedValue({ sub: 'external-sub-v', email: passwordUser.email, name: 'V Tech' });

    const secondCallback = await app.request(`/sso/callback?code=idp-auth-code&state=${secondLogin.state}`, {
      headers: { cookie: secondLogin.cookiePair },
    });
    expect(secondCallback.status).toBe(302);
    const secondLocation = secondCallback.headers.get('location');
    expect(secondLocation).toContain('#ssoCode=');

    const secondSsoCode = extractSsoCodeFromLocation(secondLocation!);
    const secondExchangeRes = await app.request('/sso/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: secondSsoCode }),
    });
    expect(secondExchangeRes.status).toBe(200);
    const secondExchangeBody = await secondExchangeRes.json();
    const secondPayload = decodeJwt(secondExchangeBody.accessToken);
    expect(secondPayload.scope).toBe('partner');
    expect(secondPayload.sub).toBe(passwordUser.id);
    expect(secondPayload.partnerId).toBe(partner.id);
    expect(secondPayload.orgId).toBeNull();
  });

  it('org-axis callback: full login succeeds and mints a scope:organization token (regression lock for both axes)', async () => {
    // This is the ORG-axis sibling of the callback's shared-plumbing fixes:
    // both the "Get provider" read AND the org-membership read (org branch
    // of the token-payload switch) were bare `db` reads that 0-rowed under
    // real RLS — the first blocked EVERY axis at provider resolution, the
    // second specifically blocked org-axis at the final membership check.
    // Both are now wrapped in withSystemDbAccessContext, matching every
    // other pre-auth read in this handler. This test drives a full org-axis
    // login to a successfully minted token, so a regression in EITHER fix
    // fails loudly here: reverting the provider-read fix yields
    // `provider_not_found`; reverting the membership-read fix yields
    // `no_org_access` — neither matches the asserted `#ssoCode=` success path.
    //
    // The sso_sessions row is seeded directly (rather than via
    // GET /sso/login/:orgId) to keep this case a PURE callback regression
    // lock, independent of the initiation route. The full
    // check → initiation → callback org path is exercised by the #2195
    // tests below.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const role = await createRole({ scope: 'organization', orgId: org.id });
    const user = await createPasswordlessUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `org-user-${Date.now()}@example.com`,
    });
    await assignUserToOrganization(user.id, org.id, role.id);

    const db = getTestDb();
    const [orgProvider] = await db
      .insert(ssoProviders)
      .values({
        orgId: org.id,
        partnerId: null,
        name: 'Org IdP',
        type: 'oidc',
        status: 'active',
        issuer: ISSUER,
        clientId: 'test-client-id',
        clientSecret: encryptSecret('test-client-secret'),
        authorizationUrl: `${ISSUER}/authorize`,
        tokenUrl: `${ISSUER}/token`,
        userInfoUrl: `${ISSUER}/userinfo`,
        jwksUrl: `${ISSUER}/jwks`,
        autoProvision: false,
      })
      .returning();
    if (!orgProvider) throw new Error('failed to create org-axis provider fixture');

    const state = generateState();
    const nonce = generateNonce();
    await db.insert(ssoSessions).values({
      providerId: orgProvider.id,
      state,
      nonce,
      codeVerifier: null,
      redirectUrl: '/',
      linkUserId: null,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    vi.mocked(verifyIdTokenSignature).mockResolvedValue(idClaimsFor('external-sub-org', user.email, nonce));
    vi.mocked(getUserInfo).mockResolvedValue({ sub: 'external-sub-org', email: user.email, name: 'Org User' });

    const callbackRes = await app.request(`/sso/callback?code=idp-auth-code&state=${state}`, {
      headers: { cookie: buildTestSsoStateCookie(state) },
    });
    expect(callbackRes.status).toBe(302);
    const location = callbackRes.headers.get('location');
    expect(location).toContain('#ssoCode=');

    // The session row was atomically claimed (deleted).
    const [claimedSession] = await db.select().from(ssoSessions).where(eq(ssoSessions.state, state)).limit(1);
    expect(claimedSession).toBeUndefined();

    const ssoCode = extractSsoCodeFromLocation(location!);
    const exchangeRes = await app.request('/sso/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: ssoCode }),
    });
    expect(exchangeRes.status).toBe(200);
    const exchangeBody = await exchangeRes.json();
    const payload = decodeJwt(exchangeBody.accessToken);
    expect(payload.scope).toBe('organization');
    expect(payload.orgId).toBe(org.id);
    expect(payload.partnerId).toBeNull();
    expect(payload.roleId).toBe(role.id);
    expect(payload.sub).toBe(user.id);

    const [identity] = await db
      .select()
      .from(userSsoIdentities)
      .where(eq(userSsoIdentities.providerId, orgProvider.id))
      .limit(1);
    expect(identity?.userId).toBe(user.id);
    expect(identity?.externalId).toBe('external-sub-org');
  });

  it('sso_sessions.link_user_id ON DELETE CASCADE: an abandoned link session never blocks a hard user delete', async () => {
    // An abandoned Connect SSO link attempt (user starts POST /sso/link/start
    // but never completes the callback) leaves an sso_sessions row with
    // link_user_id set — the callback only deletes CLAIMED sessions, so this
    // row is never cleaned up on its own. sso_sessions has no partner_id/
    // org_id, so the tenant-cascade sweep never reaches it either. Without
    // ON DELETE CASCADE on link_user_id, a hard user delete (account
    // deletion, tenant-cascade canary purges) would hit FK 23503 and abort.
    const partner = await createPartner();
    const provider = await createPartnerAxisProvider(partner.id);
    const user = await createPasswordlessUser({
      partnerId: partner.id,
      email: `abandoned-link-${Date.now()}@example.com`,
    });

    const db = getTestDb();
    await db.insert(ssoSessions).values({
      providerId: provider.id,
      state: generateState(),
      nonce: generateNonce(),
      codeVerifier: null,
      redirectUrl: '/settings/profile',
      linkUserId: user.id,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    const [pendingSession] = await db
      .select()
      .from(ssoSessions)
      .where(eq(ssoSessions.linkUserId, user.id))
      .limit(1);
    expect(pendingSession).toBeDefined();

    // The hard delete must succeed without an FK violation.
    await expect(db.delete(users).where(eq(users.id, user.id))).resolves.not.toThrow();

    const [afterDelete] = await db
      .select()
      .from(ssoSessions)
      .where(eq(ssoSessions.linkUserId, user.id))
      .limit(1);
    expect(afterDelete).toBeUndefined();
  });

  // ── review follow-up: status='active' provider-selection gate (real-DB) ──
  // The WHERE eq(ssoProviders.status, 'active') filter that both the login-
  // initiation route and ssoPolicy.ts's enforcement check rely on was, until
  // now, verified only against a mocked db. These two cases exercise the real
  // Postgres row so a status='testing' provider genuinely behaves like "not
  // there yet" on both surfaces.

  it('GET /sso/login/partner/:partnerId 404s when the partner\'s only provider is status=testing', async () => {
    const partner = await createPartner();
    await createPartnerAxisProvider(partner.id, { status: 'testing' });

    const res = await app.request(`/sso/login/partner/${partner.id}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('No active SSO provider');
  });

  it('enforceSSO on a status=testing provider does NOT suppress password login for the partner\'s staff', async () => {
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const password = 'TestPass123!';
    const user = await createUser({ partnerId: partner.id, password, withMembership: false });
    await assignUserToPartner(user.id, partner.id, role.id, 'all');
    // enforceSSO:true would suppress password login IF this provider were
    // status='active' (see ssoPolicy.ts's isPasswordAuthDisabledBySso, which
    // filters on both status='active' AND enforceSSO=true) — status='testing'
    // must leave password login untouched even with enforceSSO set.
    await createPartnerAxisProvider(partner.id, { status: 'testing', enforceSSO: true });

    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, password }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokens?.accessToken).toBeDefined();
    expect(body.mfaRequired).toBe(false);
  });

  // ── #2195: the org-axis PUBLIC entry surface (check + initiation) ────────
  // GET /sso/check/:orgId and GET /sso/login/:orgId read the provider (and
  // the initiation INSERTs the sso_sessions row) with bare `db` calls until
  // #2195: under the real breeze_app FORCED-RLS pool they silently 0-rowed,
  // so /check always answered ssoEnabled:false and /login/:orgId always
  // 404'd — org SSO could never even START in production-shaped deployments.
  // These cases drive the REAL routes end-to-end against that pool.

  it('#2195 org-axis: /sso/check reports the provider and /sso/login/:orgId starts a flow that completes to a minted token', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const role = await createRole({ scope: 'organization', orgId: org.id });
    const user = await createPasswordlessUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `org-e2e-${Date.now()}@example.com`,
    });
    await assignUserToOrganization(user.id, org.id, role.id);
    const provider = await createOrgAxisProvider(org.id);

    // The login page's "show the SSO button?" probe.
    const checkRes = await app.request(`/sso/check/${org.id}`);
    expect(checkRes.status).toBe(200);
    const checkBody = await checkRes.json();
    expect(checkBody.ssoEnabled).toBe(true);
    expect(checkBody.provider?.id).toBe(provider.id);
    expect(checkBody.loginUrl).toBe(`/api/v1/sso/login/${org.id}`);

    // Initiation through the real route: 302 to the IdP, session persisted,
    // binding cookie set.
    const { state, nonce, cookiePair } = await initiateOrgLogin(app, org.id);

    vi.mocked(verifyIdTokenSignature).mockResolvedValue(idClaimsFor('external-sub-org-e2e', user.email, nonce));
    vi.mocked(getUserInfo).mockResolvedValue({ sub: 'external-sub-org-e2e', email: user.email, name: 'Org User' });

    const callbackRes = await app.request(`/sso/callback?code=idp-auth-code&state=${state}`, {
      headers: { cookie: cookiePair },
    });
    expect(callbackRes.status).toBe(302);
    const location = callbackRes.headers.get('location');
    expect(location).toContain('#ssoCode=');

    const exchangeRes = await app.request('/sso/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: extractSsoCodeFromLocation(location!) }),
    });
    expect(exchangeRes.status).toBe(200);
    const payload = decodeJwt((await exchangeRes.json()).accessToken);
    expect(payload.scope).toBe('organization');
    expect(payload.orgId).toBe(org.id);
    expect(payload.sub).toBe(user.id);
  });

  it('#2195: a returning SSO login UPDATEs the identity row instead of inserting a duplicate', async () => {
    // Shared identity block (both axes) — before #2195 the existingIdentity
    // read sat outside the system context, always 0-rowed under RLS, and
    // every returning login INSERTed a duplicate (provider, sub) row. The
    // unique index added in 2026-07-04-user-sso-identities-unique-external
    // would turn that duplicate into a hard failure; with the fix the second
    // login must take the UPDATE branch — exactly one row, refreshed stamp.
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const user = await createPasswordlessUser({
      partnerId: partner.id,
      email: `returning-${Date.now()}@example.com`,
    });
    await assignUserToPartner(user.id, partner.id, role.id, 'all');
    const provider = await createPartnerAxisProvider(partner.id);
    const externalSub = `returning-sub-${Date.now()}`;

    const doFullLogin = async () => {
      const { state, nonce, cookiePair } = await initiatePartnerLogin(app, partner.id);
      vi.mocked(verifyIdTokenSignature).mockResolvedValue(idClaimsFor(externalSub, user.email, nonce));
      vi.mocked(getUserInfo).mockResolvedValue({ sub: externalSub, email: user.email, name: 'Tech' });
      const res = await app.request(`/sso/callback?code=idp-auth-code&state=${state}`, {
        headers: { cookie: cookiePair },
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location') ?? '').toContain('#ssoCode=');
    };

    await doFullLogin();
    await doFullLogin();

    const db = getTestDb();
    const rows = await db
      .select()
      .from(userSsoIdentities)
      .where(and(
        eq(userSsoIdentities.providerId, provider.id),
        eq(userSsoIdentities.externalId, externalSub)
      ));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(user.id);
    expect(rows[0]?.lastLoginAt).not.toBeNull();
  });

  it('#2195: with two active providers, /check and /login/:orgId agree on the OLDEST one (deterministic ORDER BY)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    // Insert the NEWER provider first so a "first row wins" accident (insert
    // order / physical order) picks the wrong one without the ORDER BY.
    await createOrgAxisProvider(org.id, { name: 'Newer IdP', createdAt: new Date('2026-02-01T00:00:00Z') });
    const older = await createOrgAxisProvider(org.id, { name: 'Older IdP', createdAt: new Date('2026-01-01T00:00:00Z') });

    const checkRes = await app.request(`/sso/check/${org.id}`);
    expect(checkRes.status).toBe(200);
    const checkBody = await checkRes.json();
    expect(checkBody.provider?.id).toBe(older.id);

    const { state } = await initiateOrgLogin(app, org.id);
    const db = getTestDb();
    const [sessionRow] = await db.select().from(ssoSessions).where(eq(ssoSessions.state, state)).limit(1);
    expect(sessionRow?.providerId).toBe(older.id);
  });

  it('#2195: the DB unique index rejects a second (provider_id, external_id) link outright (23505)', async () => {
    const partner = await createPartner();
    const provider = await createPartnerAxisProvider(partner.id);
    const userA = await createPasswordlessUser({ partnerId: partner.id, email: `uniq-a-${Date.now()}@example.com` });
    const userB = await createPasswordlessUser({ partnerId: partner.id, email: `uniq-b-${Date.now()}@example.com` });

    const db = getTestDb();
    await db.insert(userSsoIdentities).values({
      userId: userA.id,
      providerId: provider.id,
      externalId: 'uniq-sub',
      email: userA.email,
    });
    await expect(
      db.insert(userSsoIdentities).values({
        userId: userB.id,
        providerId: provider.id,
        externalId: 'uniq-sub',
        email: userB.email,
      })
    ).rejects.toMatchObject({ cause: { code: '23505' } }); // DrizzleQueryError wraps the PostgresError
  });
});

// ── shared helpers ──────────────────────────────────────────────────────────

function idClaimsFor(sub: string, email: string, nonce: string) {
  return {
    iss: ISSUER,
    sub,
    aud: 'test-client-id',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    nonce,
    email,
    email_verified: true,
  };
}

async function initiatePartnerLogin(app: Hono, partnerId: string): Promise<{ state: string; nonce: string; cookiePair: string }> {
  return initiateLoginVia(app, `/sso/login/partner/${partnerId}`);
}

// Org-axis sibling (#2195): drives the real GET /sso/login/:orgId route.
async function initiateOrgLogin(app: Hono, orgId: string): Promise<{ state: string; nonce: string; cookiePair: string }> {
  return initiateLoginVia(app, `/sso/login/${orgId}`);
}

async function initiateLoginVia(app: Hono, path: string): Promise<{ state: string; nonce: string; cookiePair: string }> {
  const loginRes = await app.request(path);
  if (loginRes.status !== 302) {
    throw new Error(`expected 302 from ${path}, got ${loginRes.status}: ${await loginRes.text()}`);
  }
  const location = loginRes.headers.get('location');
  const setCookie = loginRes.headers.get('set-cookie');
  if (!location || !setCookie) throw new Error('login response missing location/set-cookie');

  const state = extractStateFromLocation(location);
  const db = getTestDb();
  const [sessionRow] = await db.select().from(ssoSessions).where(eq(ssoSessions.state, state)).limit(1);
  if (!sessionRow) throw new Error(`no sso_sessions row for state ${state}`);

  return { state, nonce: sessionRow.nonce, cookiePair: extractCookiePair(setCookie) };
}
