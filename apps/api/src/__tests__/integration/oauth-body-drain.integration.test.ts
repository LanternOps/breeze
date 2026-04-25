/**
 * OAuth body-drain regression tests
 *
 * Why this file exists
 * --------------------
 * `apps/api/src/routes/oauth.ts` has pre-handlers on `/oauth/reg`,
 * `/oauth/token`, and `/oauth/token/revocation` that read the request body
 * before passing the request through to the oidc-provider Koa bridge.
 *
 * Under `@hono/node-server`, calling `c.req.raw.clone().body.getReader()`
 * exhausts the underlying Node `IncomingMessage` socket stream — even though
 * the call is on a Web `Request` clone, the socket bytes live on a single
 * shared stream. When that stream is drained, oidc-provider's
 * `selective_body` (`node_modules/.../oidc-provider/lib/shared/selective_body.js`)
 * falls back to `req.body || ctx.request.body`, which is `undefined` unless
 * the pre-handler explicitly hands it the parsed buffer:
 *
 *   (incoming as unknown as { body?: Buffer }).body = buf;
 *
 * Two production bugs found 2026-04-24 and fixed in `oauth.ts`:
 *   1. `/oauth/reg` returned `invalid_redirect_uri: redirect_uris is mandatory
 *      property` for every well-formed DCR call.
 *   2. `/oauth/token` returned `invalid_request: no client authentication
 *      mechanism provided` for every public-client token exchange.
 *
 * Both passed unit tests because Hono's `app.request()` test helper goes
 * through the Web Request branch, never touches a real Node socket, and
 * therefore never exercises the broken code path.
 *
 * These tests run the routes through a real `@hono/node-server` TCP listener
 * to exercise the actual `IncomingMessage` plumbing the bugs lived in. If a
 * future change reverts the `incoming.body = buf` assignment on any of the
 * three pre-handlers, the corresponding test below will fail with a clear
 * symptom matching the original bug.
 */

import './setup';
import './loadEnv';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { decodeJwt } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { oauthRefreshTokens } from '../../db/schema/oauth';
import { getTestDb } from './setup';
import { assignUserToPartner, createPartner, createRole, createUser } from './db-utils';
import { createAccessToken } from '../../services/jwt';

const SHOULD_RUN = Boolean(process.env.DATABASE_URL);

type LiveServer = { server: ServerType; url: string };

function randomPort(): number {
  return 35000 + Math.floor(Math.random() * 2000);
}

function b64url(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function startApi(port: number): Promise<LiveServer> {
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
  await new Promise<void>((resolve) => s.server.close(() => resolve()));
}

describe.skipIf(!SHOULD_RUN)('OAuth pre-handler body-drain regressions', () => {
  let live: LiveServer;

  beforeAll(async () => {
    const port = randomPort();
    process.env.OAUTH_ISSUER = `http://127.0.0.1:${port}`;
    process.env.OAUTH_RESOURCE_URL = `${process.env.OAUTH_ISSUER}/api/v1/mcp/message`;
    process.env.OAUTH_CONSENT_URL_BASE = process.env.OAUTH_ISSUER;
    vi.resetModules();
    live = await startApi(port);
    await new Promise((r) => setTimeout(r, 100));
    const { _resetJwksCacheForTests } = await import('../../middleware/bearerTokenAuth');
    _resetJwksCacheForTests();
  }, 30_000);

  afterAll(async () => {
    if (live) await stopApi(live);
  });

  /**
   * Regression: /oauth/reg used to drain the Node socket in the pre-handler
   * and not replay it onto `incoming.body`, which made oidc-provider read an
   * empty body and respond `invalid_redirect_uri`.
   *
   * Symptom of regression: status 400, error `invalid_redirect_uri`,
   * description "redirect_uris is mandatory property".
   */
  it('/oauth/reg over a real Node listener returns 201 and a client_id (DCR body must reach the bridge)', async () => {
    const res = await fetch(`${live.url}/oauth/reg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'body-drain-reg-test',
        redirect_uris: ['https://example.com/cb'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'openid offline_access mcp:read',
        id_token_signed_response_alg: 'EdDSA',
      }),
    });
    if (res.status !== 201) {
      const body = await res.text();
      throw new Error(
        `DCR returned ${res.status}: ${body}\n` +
        `If body contains "redirect_uris is mandatory property", the /oauth/reg ` +
        `pre-handler is draining the Node IncomingMessage without setting ` +
        `incoming.body. See routes/oauth.ts ~line 110.`,
      );
    }
    const json = await res.json() as { client_id?: string; redirect_uris?: string[] };
    expect(json.client_id).toBeTruthy();
    expect(json.redirect_uris).toEqual(['https://example.com/cb']);
  }, 30_000);

  /**
   * Regression: /oauth/token used to drain the Node socket for per-client
   * rate-limit parsing, then leave the bridge with no body. oidc-provider
   * couldn't parse `client_id` and reported "no client authentication
   * mechanism provided" (its way of saying the body is empty for a public
   * client).
   *
   * Full code-grant flow is the cleanest end-to-end check that the body
   * actually reaches the bridge.
   *
   * Symptom of regression: token endpoint returns 400 with
   * `invalid_request` / "no client authentication mechanism provided".
   */
  it('/oauth/token over a real Node listener exchanges code → access_token (token body must reach the bridge)', async () => {
    const baseUrl = live.url;

    const partner = await createPartner({ name: `BodyDrain Token ${Date.now()}` });
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, email: `bodydrain-${Date.now()}@example.com` });
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

    // DCR
    const redirectUri = 'https://example.com/cb-token';
    const dcrRes = await fetch(`${baseUrl}/oauth/reg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'body-drain-token-test',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'openid offline_access mcp:read',
        id_token_signed_response_alg: 'EdDSA',
      }),
    });
    expect(dcrRes.status).toBe(201);
    const client = await dcrRes.json() as { client_id: string };

    // Authorize
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: 'openid offline_access mcp:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: process.env.OAUTH_RESOURCE_URL!,
      state: 'body-drain',
    });
    const authRes = await fetch(`${baseUrl}/oauth/auth?${params}`, { redirect: 'manual' });
    const uid = new URL(authRes.headers.get('location') ?? '', baseUrl).searchParams.get('uid');
    const cookieJar = (authRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

    const consentRes = await fetch(`${baseUrl}/api/v1/oauth/interaction/${uid}/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dashboardJwt}` },
      body: JSON.stringify({ partner_id: partner.id, approve: true }),
    });
    const { redirectTo } = await consentRes.json() as { redirectTo: string };
    const resumeRes = await fetch(redirectTo, { redirect: 'manual', headers: { cookie: cookieJar } });
    const code = new URL(resumeRes.headers.get('location') ?? '').searchParams.get('code');
    expect(code).toBeTruthy();

    // The actual subject of this test: token exchange.
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
    if (tokenRes.status !== 200) {
      const body = await tokenRes.text();
      throw new Error(
        `Token endpoint returned ${tokenRes.status}: ${body}\n` +
        `If body contains "no client authentication mechanism provided", the ` +
        `/oauth/token pre-handler is draining the Node IncomingMessage without ` +
        `setting incoming.body. See routes/oauth.ts ~line 245.`,
      );
    }
    const tokenBody = await tokenRes.json() as {
      access_token: string;
      refresh_token: string;
      token_type: string;
    };
    expect(tokenBody.access_token).toBeTruthy();
    expect(tokenBody.refresh_token).toBeTruthy();
    expect(tokenBody.token_type.toLowerCase()).toBe('bearer');
  }, 60_000);

  /**
   * Regression: /oauth/token/revocation reads the body via
   * `c.req.raw.clone()` to sniff the JWT case. For non-JWT (opaque refresh)
   * tokens it falls through to the bridge — which then needs to read the
   * body off `incoming` again. If a future change starts buffering on the
   * Node stream WITHOUT setting `incoming.body`, opaque revocation will
   * silently no-op (or 400) and the refresh row's `revokedAt` will stay
   * NULL.
   *
   * We assert two things:
   *   - HTTP response is 200 (RFC 7009 — revocation is idempotent and 200
   *     for any well-formed request)
   *   - The refresh row in `oauth_refresh_tokens` is marked revoked
   *     (`revoked_at IS NOT NULL`). This is the SQL-level proof the bridge's
   *     adapter.destroy()/revoke() actually fired, which can ONLY happen if
   *     the body reached the Koa layer.
   */
  it('/oauth/token/revocation marks the opaque refresh row as revoked in the adapter', async () => {
    const baseUrl = live.url;

    const partner = await createPartner({ name: `BodyDrain Revoke ${Date.now()}` });
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, email: `revoke-${Date.now()}@example.com` });
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

    const redirectUri = 'https://example.com/cb-revoke';
    const dcrRes = await fetch(`${baseUrl}/oauth/reg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'body-drain-revoke-test',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'openid offline_access mcp:read',
        id_token_signed_response_alg: 'EdDSA',
      }),
    });
    const client = await dcrRes.json() as { client_id: string };

    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: 'openid offline_access mcp:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: process.env.OAUTH_RESOURCE_URL!,
      state: 'revoke-test',
    });
    const authRes = await fetch(`${baseUrl}/oauth/auth?${params}`, { redirect: 'manual' });
    const uid = new URL(authRes.headers.get('location') ?? '', baseUrl).searchParams.get('uid');
    const cookieJar = (authRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

    const consentRes = await fetch(`${baseUrl}/api/v1/oauth/interaction/${uid}/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dashboardJwt}` },
      body: JSON.stringify({ partner_id: partner.id, approve: true }),
    });
    const { redirectTo } = await consentRes.json() as { redirectTo: string };
    const resumeRes = await fetch(redirectTo, { redirect: 'manual', headers: { cookie: cookieJar } });
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
    const { refresh_token: refreshToken } = await tokenRes.json() as { refresh_token: string };

    // Sanity: opaque refresh tokens are not 3-part JWTs. This forces the
    // revocation pre-handler to fall through to the oidc-provider bridge,
    // which is the path that depends on the body reaching the Koa layer.
    expect(refreshToken.split('.').length).not.toBe(3);

    // The opaque token format is `<id>.<digest>` — the row id is the prefix
    // before the first dot. We need the id to assert against the DB row.
    const refreshRowId = refreshToken.split('.')[0] as string;
    expect(refreshRowId).toBeTruthy();

    const revokeRes = await fetch(`${baseUrl}/oauth/token/revocation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: refreshToken,
        token_type_hint: 'refresh_token',
        client_id: client.client_id,
      }),
    });
    expect(revokeRes.status).toBe(200);

    // The crux: is the row actually marked revoked? If the body never
    // reached the bridge, oidc-provider would have responded 200 (RFC 7009
    // 200-on-unknown-token rule) but the adapter's destroy() never fires
    // and revoked_at stays NULL.
    const db = getTestDb();
    const rows = await db
      .select({ revokedAt: oauthRefreshTokens.revokedAt })
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.id, refreshRowId));
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    if (row.revokedAt === null) {
      throw new Error(
        `oauth_refresh_tokens row ${refreshRowId} has revoked_at=NULL after a 200 ` +
        `from /oauth/token/revocation. The pre-handler likely drained the body ` +
        `without setting incoming.body, so the bridge's adapter.destroy() never ran. ` +
        `See routes/oauth.ts revocation pre-handler.`,
      );
    }
    expect(row.revokedAt).toBeInstanceOf(Date);
  }, 60_000);

  /**
   * Sanity check on the access-token JWT path (different code path from the
   * opaque refresh case above): a JWT access token presented to revocation
   * should be cached as revoked WITHOUT falling through to the bridge.
   * Verifying the access token is rejected on a follow-up MCP call proves
   * the JWT pre-handler also got a complete body (it parses
   * URLSearchParams from `c.req.raw.clone()`, which is the *other* drain
   * vector — clone vs `incoming.body=`).
   */
  it('/oauth/token/revocation with a JWT access token causes follow-up MCP calls to 401', async () => {
    const baseUrl = live.url;

    const partner = await createPartner({ name: `BodyDrain JWT Revoke ${Date.now()}` });
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, email: `jwt-revoke-${Date.now()}@example.com` });
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

    const redirectUri = 'https://example.com/cb-jwt-revoke';
    const dcrRes = await fetch(`${baseUrl}/oauth/reg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'body-drain-jwt-revoke-test',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'openid offline_access mcp:read',
        id_token_signed_response_alg: 'EdDSA',
      }),
    });
    const client = await dcrRes.json() as { client_id: string };

    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: 'openid offline_access mcp:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: process.env.OAUTH_RESOURCE_URL!,
      state: 'jwt-revoke',
    });
    const authRes = await fetch(`${baseUrl}/oauth/auth?${params}`, { redirect: 'manual' });
    const uid = new URL(authRes.headers.get('location') ?? '', baseUrl).searchParams.get('uid');
    const cookieJar = (authRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

    const consentRes = await fetch(`${baseUrl}/api/v1/oauth/interaction/${uid}/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dashboardJwt}` },
      body: JSON.stringify({ partner_id: partner.id, approve: true }),
    });
    const { redirectTo } = await consentRes.json() as { redirectTo: string };
    const resumeRes = await fetch(redirectTo, { redirect: 'manual', headers: { cookie: cookieJar } });
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
    const { access_token: accessToken } = await tokenRes.json() as { access_token: string };

    // Confirm this is actually a JWT (3 parts) — otherwise we're not
    // exercising the JWT pre-handler path.
    expect(accessToken.split('.').length).toBe(3);
    const claims = decodeJwt(accessToken);
    expect(claims.jti).toBeTruthy();

    // Pre-revoke: the token works.
    const before = await fetch(`${baseUrl}/api/v1/mcp/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(before.status).toBe(200);

    const revokeRes = await fetch(`${baseUrl}/oauth/token/revocation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: accessToken,
        token_type_hint: 'access_token',
        client_id: client.client_id,
      }),
    });
    expect(revokeRes.status).toBe(200);

    const after = await fetch(`${baseUrl}/api/v1/mcp/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    if (after.status !== 401) {
      throw new Error(
        `MCP call after JWT revocation returned ${after.status}, expected 401. ` +
        `The revocation pre-handler likely could not parse the body (URLSearchParams ` +
        `from a drained clone) so the jti was never written to the revocation cache.`,
      );
    }
  }, 60_000);

  /**
   * MANUAL VERIFICATION
   * -------------------
   * To prove these tests would catch a regression, temporarily edit
   * `apps/api/src/routes/oauth.ts` and:
   *
   *   1. In the `/oauth/reg` pre-handler, comment out:
   *        (incoming as unknown as { body?: Buffer }).body = buf;
   *      Expected failure: the DCR test above 400s with
   *      "redirect_uris is mandatory property".
   *
   *   2. In the `/oauth/token` pre-handler, comment out the same line.
   *      Expected failure: the token-exchange test above 400s with
   *      "no client authentication mechanism provided".
   *
   *   3. In the `/oauth/token/revocation` pre-handler, force the JWT branch
   *      to always `return next()` early (so the JWT revoke cache is never
   *      written). Expected failure: the JWT-revoke test above sees a 200
   *      on the post-revoke MCP call instead of 401.
   *
   * Restore the lines after verifying.
   */
});
