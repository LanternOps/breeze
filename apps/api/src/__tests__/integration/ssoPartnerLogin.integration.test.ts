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
 * Also includes ONE org-axis callback case (see "org-axis callback" test
 * below) to regression-lock the shared `withSystemDbAccessContext` fix to
 * the callback's provider read — that fix is shared plumbing hit by BOTH
 * axes, so a partner-only suite wouldn't catch a regression on the org side.
 * That case seeds `sso_sessions` directly rather than going through
 * `GET /sso/login/:orgId`, because that route's own provider read is a
 * SEPARATE, pre-existing, unfixed bare-db bug (see PR description) that
 * always 404s regardless of this fix.
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
import { eq } from 'drizzle-orm';
import { createHmac } from 'crypto';
import { getTestDb } from './setup';
import { ssoProviders, ssoSessions, userSsoIdentities, users } from '../../db/schema';
import {
  createPartner,
  createOrganization,
  createRole,
  assignUserToPartner,
  assignUserToOrganization,
} from './db-utils';
import { encryptSecret } from '../../services/secretCrypto';
import { createAccessToken } from '../../services/jwt';

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

async function createPartnerAxisProvider(partnerId: string, opts: { trustsIdpMfa?: boolean } = {}) {
  const db = getTestDb();
  const [row] = await db
    .insert(ssoProviders)
    .values({
      orgId: null,
      partnerId,
      name: 'Partner IdP',
      type: 'oidc',
      status: 'active',
      issuer: ISSUER,
      clientId: 'test-client-id',
      clientSecret: encryptSecret('test-client-secret'),
      authorizationUrl: `${ISSUER}/authorize`,
      tokenUrl: `${ISSUER}/token`,
      userInfoUrl: `${ISSUER}/userinfo`,
      jwksUrl: `${ISSUER}/jwks`,
      trustsIdpMfa: opts.trustsIdpMfa ?? false,
      autoProvision: false,
    })
    .returning();
  if (!row) throw new Error('failed to create partner-axis provider fixture');
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
 * directly-seeded session (see the org-axis test) can present a
 * browser-binding cookie the callback will accept without going through the
 * real /login/:orgId route — whose OWN provider read is a separate,
 * pre-existing, unfixed bare-db bug that always 404s regardless of this
 * suite's fix (see PR description). */
function buildTestSsoStateCookie(state: string): string {
  const secret = process.env.APP_ENCRYPTION_KEY!;
  const value = createHmac('sha256', secret).update(`sso-login-state:${state}`).digest('hex');
  return `breeze_sso_state=${encodeURIComponent(value)}`;
}

describe('SSO partner-axis login + Connect SSO link — real-DB e2e (#2183)', () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.route('/sso', ssoRoutes);
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

  it('org-axis callback: the shared provider-read fix resolves an org provider too (regression lock for both axes)', async () => {
    // This is the ORG-axis sibling of the "Get provider" fix's regression
    // coverage. The fix (routes/sso.ts, wrapping the callback's provider
    // read in withSystemDbAccessContext) is shared plumbing hit identically
    // by both axes — if it regressed back to a bare `db` read, an org-axis
    // provider would 0-row exactly like a partner-axis one, and this test
    // would see `provider_not_found`/`session_expired` instead of the
    // asserted `no_org_access`.
    //
    // We can't reach this via GET /sso/login/:orgId — that route's OWN
    // provider read is a separate, pre-existing, unfixed bare-db bug (see
    // PR description) that always 404s. So the sso_sessions row is seeded
    // directly instead (that table carries no RLS policy at all — confirmed
    // empirically and via migration grep — so a direct insert is a faithful
    // stand-in for what a working initiation route would have written).
    //
    // The org-axis callback has its OWN separate, pre-existing, unfixed
    // bare-db bug too — the final organizationUsers membership check
    // (routes/sso.ts, org branch of the token-payload switch) — which always
    // 0-rows and yields `no_org_access` regardless of real membership. That
    // is NOT what this test is regression-locking (org-axis behavior is out
    // of scope for this fix); it's simply the accurate, currently-true
    // outcome once the provider resolves correctly. The important signal is
    // that the callback gets THIS far at all — proving the shared fix works
    // for the org axis, not just partner.
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
    // Exact match (not `.toContain`): a regression back to the bare provider
    // read would land on a DIFFERENT error (provider_not_found), so this
    // assertion fails loudly rather than passing on the wrong redirect.
    expect(callbackRes.headers.get('location')).toBe('/login?error=no_org_access');

    // The session row was still atomically claimed (deleted) — proves the
    // callback reached past the session-claim step and into provider
    // resolution, not an early bail before ever touching the DB.
    const [claimedSession] = await db.select().from(ssoSessions).where(eq(ssoSessions.state, state)).limit(1);
    expect(claimedSession).toBeUndefined();
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
  const loginRes = await app.request(`/sso/login/partner/${partnerId}`);
  if (loginRes.status !== 302) {
    throw new Error(`expected 302 from /sso/login/partner/${partnerId}, got ${loginRes.status}: ${await loginRes.text()}`);
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
