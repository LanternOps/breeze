/**
 * OAuth introspection client-binding — regression guard.
 *
 * Concern (from a security review): can a DCR-registered client learn anything
 * about a token issued to a DIFFERENT client via RFC 7662 introspection
 * (POST /oauth/token/introspection)? The answer is NO, guaranteed by three
 * layers, none of which Breeze asserts in code:
 *
 *   1. oidc-provider rejects structured (JWT) access tokens at introspection
 *      (`unsupported_token_type`). Breeze access tokens are JWTs, so they are
 *      never introspectable at all.  -> covered by the JWT-reject test.
 *   2. oidc-provider's DEFAULT `introspectionAllowedPolicy` returns
 *      `{ active: false }` when a public (token_endpoint_auth_method=none)
 *      client introspects a token whose clientId differs from the caller's.
 *   3. Breeze forces EVERY DCR client to be public (`none`) at /oauth/reg, so
 *      the policy's confidential-client exception is unreachable.  -> covered
 *      by the DCR auth-method-gate test.
 *
 * This file guards the externally-observable security OUTCOME (a different
 * client gets nothing) plus the two Breeze/library invariants that produce it.
 * It does NOT assert that an owner can introspect its own opaque refresh token:
 * Breeze never uses introspection internally (the MCP resource server verifies
 * JWTs directly via the bearer middleware), and oidc-provider's opaque-token
 * introspection for a public client is intentionally minimal here. The
 * JWT-reject test independently proves the endpoint is live and processing.
 *
 * Mirrors the live-server harness in oauth-code-flow.integration.test.ts.
 */

import './setup';
import './loadEnv';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { decodeJwt } from 'jose';
import { randomBytes, createHash } from 'node:crypto';

import { createPartner, createUser, assignUserToPartner, createRole } from './db-utils';
import { createAccessToken } from '../../services/jwt';

const SHOULD_RUN = Boolean(process.env.DATABASE_URL);

type LiveServer = { server: ServerType; url: string };

function randomPort(): number {
  return 35000 + Math.floor(Math.random() * 2000);
}

function b64url(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function uniq(): string {
  return `${Date.now()}-${b64url(randomBytes(6))}`;
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
  await new Promise<void>((resolve) => {
    s.server.close(() => resolve());
  });
}

// Register a public (token_endpoint_auth_method=none) DCR client.
async function dcr(baseUrl: string, redirectUri: string): Promise<string> {
  const res = await fetch(`${baseUrl}/oauth/reg`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: `introspect-test-${uniq()}`,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'openid offline_access mcp:read mcp:write',
      id_token_signed_response_alg: 'EdDSA',
    }),
  });
  if (!res.ok) throw new Error(`DCR failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

// Run the full authorization-code flow for a fresh client + partner and return
// the issued tokens. Mirrors steps 0-5 of oauth-code-flow.integration.test.ts.
async function mintTokensForNewClient(
  baseUrl: string,
): Promise<{ clientId: string; accessToken: string; refreshToken: string }> {
  const partner = await createPartner({ name: `Introspect ${uniq()}` });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, email: `introspect-${uniq()}@example.com` });
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

  const redirectUri = 'https://example.com/cb-introspect';
  const clientId = await dcr(baseUrl, redirectUri);
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid offline_access mcp:read mcp:write',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: process.env.OAUTH_RESOURCE_URL!,
    state: 'introspect-test',
  });
  const authRes = await fetch(`${baseUrl}/oauth/auth?${authParams}`, { redirect: 'manual' });
  const uid = new URL(authRes.headers.get('location') ?? '', baseUrl).searchParams.get('uid');
  const cookieJar = (authRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

  const consentRes = await fetch(`${baseUrl}/api/v1/oauth/interaction/${uid}/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dashboardJwt}` },
    body: JSON.stringify({ partner_id: partner.id, approve: true }),
  });
  const consentBody = (await consentRes.json()) as { redirectTo: string };
  const resumeRes = await fetch(consentBody.redirectTo, {
    redirect: 'manual',
    headers: { cookie: cookieJar },
  });
  const code = new URL(resumeRes.headers.get('location') ?? '').searchParams.get('code');

  const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      client_id: clientId,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: process.env.OAUTH_RESOURCE_URL!,
    }),
  });
  if (tokenRes.status !== 200) {
    throw new Error(`token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const body = (await tokenRes.json()) as { access_token: string; refresh_token: string };
  return { clientId, accessToken: body.access_token, refreshToken: body.refresh_token };
}

async function introspect(
  baseUrl: string,
  token: string,
  clientId: string,
  hint: string,
): Promise<Response> {
  return fetch(`${baseUrl}/oauth/token/introspection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, client_id: clientId, token_type_hint: hint }),
  });
}

describe.skipIf(!SHOULD_RUN)('OAuth introspection client-binding', () => {
  let live: LiveServer;
  let victim: { clientId: string; accessToken: string; refreshToken: string };
  let attackerClientId: string;

  beforeAll(async () => {
    const port = randomPort();
    process.env.OAUTH_ISSUER = `http://127.0.0.1:${port}`;
    process.env.OAUTH_RESOURCE_URL = `${process.env.OAUTH_ISSUER}/api/v1/mcp/message`;
    process.env.OAUTH_CONSENT_URL_BASE = process.env.OAUTH_ISSUER;
    vi.resetModules();
    live = await startApi(port);
    await new Promise((r) => setTimeout(r, 100));
    expect(live.url).toBe(process.env.OAUTH_ISSUER);
    const { _resetJwksCacheForTests } = await import('../../middleware/bearerTokenAuth');
    _resetJwksCacheForTests();

    // A victim client + token set, and a separate attacker client.
    victim = await mintTokensForNewClient(live.url);
    attackerClientId = await dcr(live.url, 'https://attacker.example/cb');
  }, 60_000);

  afterAll(async () => {
    if (live) await stopApi(live);
  });

  it('does NOT disclose another client token to a different client (active:false, zero metadata)', async () => {
    // The core security outcome: client A introspecting client B's refresh
    // token learns NOTHING. oidc-provider's default introspectionAllowedPolicy
    // returns { active:false } for a public caller whose clientId != the
    // token's clientId (and Breeze makes every DCR client public).
    const res = await introspect(live.url, victim.refreshToken, attackerClientId, 'refresh_token');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.active).toBe(false);
    // None of the token's metadata may leak to the attacker.
    for (const field of ['scope', 'sub', 'client_id', 'exp', 'iat', 'aud', 'username']) {
      expect(body[field]).toBeUndefined();
    }
  });

  it('rejects a JWT access token submitted to introspection (unsupported_token_type)', async () => {
    // Layer 1: structured (JWT) access tokens are never introspectable, so an
    // access token cannot be probed by anyone. Also proves the endpoint is live.
    expect(() => decodeJwt(victim.accessToken)).not.toThrow(); // it is a JWT
    const res = await introspect(live.url, victim.accessToken, victim.clientId, 'access_token');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('unsupported_token_type');
  });

  it('DCR refuses any token_endpoint_auth_method other than "none" (keeps every client public)', async () => {
    // Layer 3 (Breeze-owned invariant): forcing every DCR client to be public
    // is what makes the default deny-policy's `none` branch apply. If a future
    // change allowed confidential clients, cross-client introspection could be
    // permitted by oidc-provider's default policy.
    const confidential = await fetch(`${live.url}/oauth/reg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: `confidential-${uniq()}`,
        redirect_uris: ['https://example.com/cb-confidential'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_basic',
        scope: 'openid offline_access mcp:read',
      }),
    });
    expect(confidential.status).toBe(400);
    const body = (await confidential.json()) as { error?: string; error_description?: string };
    expect(body.error).toBe('invalid_client_metadata');
    expect(`${body.error_description ?? ''}`).toMatch(/token_endpoint_auth_method|none/i);

    // Positive control: a public ("none") registration is accepted.
    const publicClientId = await dcr(live.url, 'https://example.com/cb-public');
    expect(publicClientId).toBeTruthy();
  });
});
