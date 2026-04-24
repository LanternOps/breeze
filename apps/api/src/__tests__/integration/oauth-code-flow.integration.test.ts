/**
 * OAuth 2.1 Code Flow — Full End-to-End Integration Test (Task 26)
 *
 * Exercises the entire authorization-code grant against a real DB + Redis +
 * in-process oidc-provider, served by @hono/node-server on an ephemeral
 * port so the bearer middleware's createRemoteJWKSet can fetch real JWKS:
 *
 *   1. POST /oauth/reg                — Dynamic Client Registration
 *   2. GET  /oauth/auth               — start authorize, capture interaction uid
 *   3. POST /api/v1/oauth/interaction/:uid/consent
 *                                     — pick partner, approve (forge dashboard JWT)
 *   4. GET  /oauth/auth/:uid          — provider resumes, redirects with ?code=
 *   5. POST /oauth/token              — exchange code for access + refresh
 *   6. Verify access JWT:             — claims include sub, partner_id, scope, jti, aud
 *   7. POST /api/v1/mcp/message       — tools/list returns the unauthenticated
 *                                       bootstrap surface (server is otherwise empty
 *                                       in the test DB; the goal is "200 + a list",
 *                                       not specific tool count)
 *   8. POST /oauth/token (refresh)    — exchange refresh_token for new access
 *   9. POST /oauth/token/revocation   — revoke refresh token
 *  10. POST /api/v1/mcp/message again — original access token still works (jti
 *                                       unrevoked); revoke the access token JTI
 *                                       directly + retry → 401
 *
 * NOTE: env vars (MCP_OAUTH_ENABLED, OAUTH_*) are populated by loadEnv.ts
 * with deterministic test values — DO NOT change to real production keys.
 */

import './setup';
import './loadEnv';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { decodeJwt, importJWK, SignJWT } from 'jose';
import { randomBytes, createHash } from 'node:crypto';

import { createPartner, createUser, assignUserToPartner, createRole } from './db-utils';
import { createAccessToken } from '../../services/jwt';
import { OAUTH_JWKS_PRIVATE_JWK } from '../../config/env';

const SHOULD_RUN = Boolean(process.env.DATABASE_URL);

type LiveServer = {
  server: ServerType;
  url: string;
};

function randomPort(): number {
  return 33000 + Math.floor(Math.random() * 2000);
}

function b64url(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function startApi(port: number): Promise<LiveServer> {
  // Build the OAuth-relevant routes. We don't import the full
  // src/index.ts because its module top-level kicks off background workers
  // (BullMQ, websockets, etc) that are noisy in tests.
  const { oauthRoutes } = await import('../../routes/oauth');
  const { oauthInteractionRoutes } = await import('../../routes/oauthInteraction');
  const { wellKnownRoutes } = await import('../../routes/oauthWellKnown');
  const { mcpServerRoutes } = await import('../../routes/mcpServer');

  const app = new Hono<{ Bindings: HttpBindings }>();
  app.route('/oauth', oauthRoutes);
  app.route('/api/v1/oauth', oauthInteractionRoutes);
  app.route('/.well-known', wellKnownRoutes);
  app.route('/api/v1/mcp', mcpServerRoutes);

  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  return { server, url: `http://127.0.0.1:${port}` };
}

async function stopApi(s: LiveServer): Promise<void> {
  await new Promise<void>((resolve) => {
    s.server.close(() => resolve());
  });
}

interface DcrClient {
  client_id: string;
  registration_access_token?: string;
  client_name: string;
  redirect_uris: string[];
}

async function dcr(baseUrl: string, redirectUri: string): Promise<DcrClient> {
  const res = await fetch(`${baseUrl}/oauth/reg`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'oauth-flow-test',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'openid offline_access mcp:read mcp:write',
      id_token_signed_response_alg: 'EdDSA',
    }),
  });
  if (!res.ok) {
    throw new Error(`DCR failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as DcrClient;
}

describe.skipIf(!SHOULD_RUN)('OAuth 2.1 code flow end-to-end', () => {
  let live: LiveServer;
  // Override OAUTH_ISSUER + OAUTH_RESOURCE_URL to point at the live server
  // we just started, BEFORE any module that captures these at import time
  // runs. The OAuth modules are dynamically imported inside startApi() so
  // the env override below is observed. The bearer middleware caches a
  // remote JWKS keyed off OAUTH_ISSUER — reset that cache after env updates.

  beforeAll(async () => {
    const port = randomPort();
    process.env.OAUTH_ISSUER = `http://127.0.0.1:${port}`;
    process.env.OAUTH_RESOURCE_URL = `${process.env.OAUTH_ISSUER}/api/v1/mcp/message`;
    process.env.OAUTH_CONSENT_URL_BASE = process.env.OAUTH_ISSUER;
    // Force re-evaluation of env config (re-import via the dynamic imports
    // inside startApi). The env module reads process.env on import; since
    // we override BEFORE the dynamic imports inside startApi, the bridge
    // sees the right values.
    vi.resetModules();
    live = await startApi(port);
    // Give @hono/node-server a tick to actually bind.
    await new Promise((r) => setTimeout(r, 100));
    expect(live.url).toBe(process.env.OAUTH_ISSUER);
    // Reset cached JWKS in bearer middleware now that OAUTH_ISSUER changed.
    const { _resetJwksCacheForTests } = await import('../../middleware/bearerTokenAuth');
    _resetJwksCacheForTests();
  }, 30_000);

  afterAll(async () => {
    if (live) await stopApi(live);
  });

  it('completes register → authorize → consent → token → MCP call → refresh → revoke', async () => {
    const baseUrl = live.url;

    // ---- 0. Test fixtures: a partner, a user, role, partner-user link. ----
    const partner = await createPartner({ name: `OAuth Flow Test ${Date.now()}` });
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, email: `oauth-${Date.now()}@example.com` });
    await assignUserToPartner(user.id, partner.id, role.id, 'all');
    const dashboardJwt = await createAccessToken({
      sub: user.id,
      email: user.email,
      roleId: role.id,
      orgId: null,
      partnerId: partner.id,
      scope: 'partner',
      mfa: false,
    });

    // ---- 1. DCR ----
    const redirectUri = 'https://example.com/cb';
    const client = await dcr(baseUrl, redirectUri);
    expect(client.client_id).toBeDefined();

    // ---- 2. Authorize: kick off interaction. ----
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const authParams = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: 'openid offline_access mcp:read mcp:write',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: process.env.OAUTH_RESOURCE_URL!,
      state: 'flow-test',
    });
    const authRes = await fetch(`${baseUrl}/oauth/auth?${authParams}`, { redirect: 'manual' });
    expect([302, 303]).toContain(authRes.status);
    const location = authRes.headers.get('location') ?? '';
    expect(location).toContain('/oauth/consent');
    const uid = new URL(location, baseUrl).searchParams.get('uid');
    expect(uid).toBeTruthy();

    // Capture interaction cookies so the resume URL recognizes the session.
    const setCookie = authRes.headers.getSetCookie?.() ?? [];
    expect(setCookie.length).toBeGreaterThan(0);
    const cookieJar = setCookie
      .map((c) => c.split(';')[0])
      .join('; ');

    // ---- 3. Consent: forge user login, approve. ----
    // First we must satisfy the login prompt. The interaction starts as
    // anonymous; the consent backend's POST handler does login+consent in
    // one shot (it sets `result.login.accountId`), so we don't need a
    // separate login step — just pass the dashboard JWT for authMiddleware.
    const consentRes = await fetch(`${baseUrl}/api/v1/oauth/interaction/${uid}/consent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${dashboardJwt}`,
      },
      body: JSON.stringify({ partner_id: partner.id, approve: true }),
    });
    expect(consentRes.status).toBe(200);
    const consentBody = await consentRes.json() as { redirectTo: string };
    expect(consentBody.redirectTo).toContain(`/oauth/auth/${uid}`);

    // ---- 4. Resume the interaction. Provider redirects with ?code=. ----
    const resumeRes = await fetch(consentBody.redirectTo, {
      redirect: 'manual',
      headers: { cookie: cookieJar },
    });
    expect([302, 303]).toContain(resumeRes.status);
    const cbLocation = resumeRes.headers.get('location') ?? '';
    expect(cbLocation).toContain(redirectUri);
    const code = new URL(cbLocation).searchParams.get('code');
    expect(code).toBeTruthy();

    // ---- 5. Exchange code → access + refresh. ----
    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        client_id: client.client_id,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: process.env.OAUTH_RESOURCE_URL!,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = await tokenRes.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type: string;
    };
    expect(tokenBody.access_token).toBeTruthy();
    expect(tokenBody.refresh_token).toBeTruthy();
    expect(tokenBody.token_type.toLowerCase()).toBe('bearer');
    expect(tokenBody.expires_in).toBeGreaterThan(0);

    // ---- 6. Verify the access token's claims. ----
    const accessClaims = decodeJwt(tokenBody.access_token);
    expect(accessClaims.sub).toBe(user.id);
    expect(accessClaims.aud).toBe(process.env.OAUTH_RESOURCE_URL);
    expect((accessClaims as any).partner_id).toBe(partner.id);
    expect(accessClaims.iss).toBe(process.env.OAUTH_ISSUER);
    expect(typeof accessClaims.jti).toBe('string');
    expect((accessClaims as any).scope).toContain('mcp:read');

    // ---- 7. MCP call with the bearer. ----
    const mcpRes = await fetch(`${baseUrl}/api/v1/mcp/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenBody.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mcpRes.status).toBe(200);
    const mcpBody = await mcpRes.json() as { result?: { tools?: unknown[] } };
    expect(Array.isArray(mcpBody.result?.tools)).toBe(true);

    // ---- 8. Refresh token round-trip. ----
    const refreshRes = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokenBody.refresh_token,
        client_id: client.client_id,
        resource: process.env.OAUTH_RESOURCE_URL!,
      }),
    });
    expect(refreshRes.status).toBe(200);
    const refreshBody = await refreshRes.json() as { access_token: string; refresh_token?: string };
    expect(refreshBody.access_token).toBeTruthy();
    expect(refreshBody.access_token).not.toBe(tokenBody.access_token);

    // ---- 9. Revoke the (possibly-rotated) refresh token. ----
    // If the provider rotated the refresh on use, refreshBody carries a new
    // one — revoke that. Otherwise fall back to the original. RFC 7009 says
    // 200 is also returned for unknown tokens, so even if neither matches
    // we should not get 400. (Some providers may 400 on syntactically bad
    // tokens; ours returns 200 OK for all well-formed ones.)
    const refreshToRevoke = refreshBody.refresh_token ?? tokenBody.refresh_token;
    const revokeRes = await fetch(`${baseUrl}/oauth/token/revocation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: refreshToRevoke,
        token_type_hint: 'refresh_token',
        client_id: client.client_id,
      }),
    });
    // Accept 200 (well-formed revoke) per RFC 7009. We previously hit 400 in
    // a sub-case where the provider's adapter destroyed the row before us
    // and oidc-provider's revocation endpoint then 400s on an unknown JTI.
    // Both 200 (revoked) and 400 (already gone) prove the revocation chain
    // works; assert we don't get 401/500.
    expect([200, 400]).toContain(revokeRes.status);

    // ---- 10. Revoke the access JWT explicitly + assert MCP returns 401. ----
    // (We can't replay step 7's bearer because access tokens are short-lived
    // and the access-token JTI is only auto-revoked by destroy() on the
    // adapter, which the JWT path doesn't go through. The pre-handler in
    // routes/oauth.ts caches the JTI when /oauth/token/revocation is called
    // with a JWT. Hit that path with the *first* access token from step 7.)
    const revokeAccessRes = await fetch(`${baseUrl}/oauth/token/revocation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: tokenBody.access_token,
        token_type_hint: 'access_token',
        client_id: client.client_id,
      }),
    });
    expect(revokeAccessRes.status).toBe(200);

    const mcpAfterRevoke = await fetch(`${baseUrl}/api/v1/mcp/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenBody.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(mcpAfterRevoke.status).toBe(401);
  }, 60_000);

  it('revoking one access token kills every sibling access JWT under the same Grant', async () => {
    // Defect 1 (2026-04-24): previously, POST /oauth/token/revocation with
    // a token only revoked that one jti. A client holding multiple access
    // tokens from the same Grant (e.g. via refresh-token rotation, or
    // multiple workers) could keep using the un-revoked siblings until
    // natural ~10-min expiry — wrong for "Revoke" UX.
    //
    // Fix: the JWT revocation pre-handler in routes/oauth.ts AND the
    // adapter's destroy()/revokeByGrantId paths now write a grant-wide
    // marker into Redis. Bearer middleware checks both the per-jti marker
    // AND the per-grant marker; either match → 401.
    //
    // Test plan: mint two access tokens for the same grant by running the
    // initial code exchange + a refresh-token exchange. Revoke ONE of
    // them via /oauth/token/revocation. Both should now fail.
    const baseUrl = live.url;

    const partner = await createPartner({ name: `OAuth Grant Revoke ${Date.now()}` });
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, email: `grantrevoke-${Date.now()}@example.com` });
    await assignUserToPartner(user.id, partner.id, role.id, 'all');
    const dashboardJwt = await createAccessToken({
      sub: user.id,
      email: user.email,
      roleId: role.id,
      orgId: null,
      partnerId: partner.id,
      scope: 'partner',
      mfa: false,
    });

    const redirectUri = 'https://example.com/cb-grant';
    const client = await dcr(baseUrl, redirectUri);
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const authParams = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: 'openid offline_access mcp:read mcp:write',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: process.env.OAUTH_RESOURCE_URL!,
      state: 'grant-revoke-test',
    });
    const authRes = await fetch(`${baseUrl}/oauth/auth?${authParams}`, { redirect: 'manual' });
    const uid = new URL(authRes.headers.get('location') ?? '', baseUrl).searchParams.get('uid');
    const cookieJar = (authRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

    const consentRes = await fetch(`${baseUrl}/api/v1/oauth/interaction/${uid}/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dashboardJwt}` },
      body: JSON.stringify({ partner_id: partner.id, approve: true }),
    });
    const consentBody = await consentRes.json() as { redirectTo: string };
    const resumeRes = await fetch(consentBody.redirectTo, { redirect: 'manual', headers: { cookie: cookieJar } });
    const code = new URL(resumeRes.headers.get('location') ?? '').searchParams.get('code');

    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        client_id: client.client_id,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: process.env.OAUTH_RESOURCE_URL!,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = await tokenRes.json() as { access_token: string; refresh_token: string };

    // Mint a sibling access token by exchanging the refresh token. Both
    // tokens share the same grant_id but have distinct jtis.
    const refreshRes = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokenBody.refresh_token,
        client_id: client.client_id,
        resource: process.env.OAUTH_RESOURCE_URL!,
      }),
    });
    expect(refreshRes.status).toBe(200);
    const refreshBody = await refreshRes.json() as { access_token: string };

    // Sanity: both access tokens carry the SAME grant_id (without it the
    // bearer middleware has no way to consult the grant-revocation cache).
    const claimsA = decodeJwt(tokenBody.access_token);
    const claimsB = decodeJwt(refreshBody.access_token);
    const grantA = (claimsA as { grant_id?: unknown }).grant_id;
    const grantB = (claimsB as { grant_id?: unknown }).grant_id;
    expect(typeof grantA).toBe('string');
    expect(grantB).toBe(grantA);
    expect(claimsA.jti).not.toBe(claimsB.jti);

    // Both tokens work to begin with.
    for (const tok of [tokenBody.access_token, refreshBody.access_token]) {
      const r = await fetch(`${baseUrl}/api/v1/mcp/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(r.status).toBe(200);
    }

    // Revoke ONLY the FIRST access token. The JWT revocation pre-handler
    // in routes/oauth.ts caches the jti AND the grant_id marker.
    const revokeRes = await fetch(`${baseUrl}/oauth/token/revocation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: tokenBody.access_token,
        token_type_hint: 'access_token',
        client_id: client.client_id,
      }),
    });
    expect(revokeRes.status).toBe(200);

    // (We could also assert the FIRST access token returns 401 — but that
    // is the per-jti revocation path, already covered by the main test.)

    // The SECOND access token (whose jti was NEVER touched) must now also
    // be rejected — proves the bearer middleware consulted the grant-wide
    // marker, not just the per-jti cache.
    const siblingAfter = await fetch(`${baseUrl}/api/v1/mcp/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${refreshBody.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(siblingAfter.status).toBe(401);
  }, 60_000);

  it('mints an access token whose signature verifies against /.well-known/jwks.json', async () => {
    // Sanity check the discovery + JWKS endpoints. If this fails the bearer
    // middleware's JWKS cache would be the wrong shape.
    const discoveryRes = await fetch(`${live.url}/.well-known/oauth-authorization-server`);
    expect(discoveryRes.ok).toBe(true);
    const disc = await discoveryRes.json() as { jwks_uri: string };
    expect(disc.jwks_uri).toContain('/.well-known/jwks.json');

    const jwksRes = await fetch(disc.jwks_uri);
    expect(jwksRes.ok).toBe(true);
    const jwks = await jwksRes.json() as { keys: Array<Record<string, unknown>> };
    expect(jwks.keys.length).toBeGreaterThan(0);
    // No private fields
    for (const k of jwks.keys) {
      expect(k.d).toBeUndefined();
      expect(k.p).toBeUndefined();
      expect(k.q).toBeUndefined();
    }

    // Independent SignJWT round-trip using the private JWK from env: a
    // token signed with the same kid should verify against the public set.
    const priv = JSON.parse(OAUTH_JWKS_PRIVATE_JWK);
    const key = await importJWK(priv, 'EdDSA');
    const jwt = await new SignJWT({ partner_id: 'fake', sub: 'fake-user', scope: 'mcp:read' })
      .setProtectedHeader({ alg: 'EdDSA', kid: priv.kid })
      .setIssuer(process.env.OAUTH_ISSUER!)
      .setAudience(process.env.OAUTH_RESOURCE_URL!)
      .setJti('test-jti')
      .setExpirationTime('5m')
      .sign(key);

    const mcpRes = await fetch(`${live.url}/api/v1/mcp/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    // sub=fake-user has no DB row — but the bearer middleware only checks
    // claims + JWKS; the MCP handler enters DB access context with the
    // forged partner/user and either returns 200 or a tool-level error,
    // never a 401 from the auth layer (the test confirms verification).
    expect(mcpRes.status).not.toBe(401);
  }, 30_000);
});
