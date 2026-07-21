/**
 * DCR redirect-URI transport policy — live-listener regression (MCP-OAUTH-09).
 *
 * The security review asked for a real confirmation that a remote-HTTP
 * redirect URI is rejected at Dynamic Client Registration while an HTTPS
 * redirect URI still registers. We stand up the real oidc-provider bridge
 * behind @hono/node-server on an ephemeral 127.0.0.1 port and POST to
 * /oauth/reg through the actual pre-handler.
 *
 * NOTE: env vars (MCP_OAUTH_ENABLED, OAUTH_*) come from loadEnv.ts with
 * deterministic test values.
 */

import './setup';
import './loadEnv';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import type { HttpBindings } from '@hono/node-server';

const SHOULD_RUN = Boolean(process.env.DATABASE_URL);

type LiveServer = { server: ServerType; url: string };

function randomPort(): number {
  return 35000 + Math.floor(Math.random() * 2000);
}

async function startApi(port: number): Promise<LiveServer> {
  const { oauthRoutes } = await import('../../routes/oauth');
  const app = new Hono<{ Bindings: HttpBindings }>();
  app.route('/oauth', oauthRoutes);
  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  return { server, url: `http://127.0.0.1:${port}` };
}

async function stopApi(s: LiveServer): Promise<void> {
  await new Promise<void>((resolve) => s.server.close(() => resolve()));
}

async function register(baseUrl: string, redirectUris: string[]): Promise<Response> {
  return fetch(`${baseUrl}/oauth/reg`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'redirect-policy-test',
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'openid offline_access mcp:read',
      id_token_signed_response_alg: 'EdDSA',
    }),
  });
}

describe.skipIf(!SHOULD_RUN)('DCR redirect-URI transport policy (live)', () => {
  let live: LiveServer;

  beforeAll(async () => {
    const port = randomPort();
    process.env.OAUTH_ISSUER = `http://127.0.0.1:${port}`;
    process.env.OAUTH_RESOURCE_URL = `${process.env.OAUTH_ISSUER}/api/v1/mcp/message`;
    process.env.OAUTH_DCR_ENABLED = 'true';
    vi.resetModules();
    live = await startApi(port);
    await new Promise((r) => setTimeout(r, 100));
  }, 30_000);

  afterAll(async () => {
    if (live) await stopApi(live);
  });

  it('rejects a remote http:// redirect URI with invalid_redirect_uri', async () => {
    const res = await register(live.url, ['http://attacker.example/cb']);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('rejects the whole registration when any URI is a remote http host', async () => {
    const res = await register(live.url, ['https://ok.example/cb', 'http://attacker.example/cb']);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
  });

  it('registers a client with an HTTPS redirect URI', async () => {
    const res = await register(live.url, ['https://client.example/cb']);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id?: string; redirect_uris?: string[] };
    expect(body.client_id).toBeTruthy();
    expect(body.redirect_uris).toEqual(['https://client.example/cb']);
  });

  it('registers a client with a loopback-IP http redirect URI (mcp-remote shape)', async () => {
    const res = await register(live.url, ['http://127.0.0.1:49152/cb']);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { client_id?: string }).client_id).toBeTruthy();
  });

  it('registers a client with a localhost-hostname http redirect URI (claude-code CLI shape)', async () => {
    // Regression guard for the 2026-07-12..21 outage: the CLI's native SDK auth
    // registers `http://localhost:<ephemeral>/callback`, which #2377 rejected.
    // This asserts the shape survives the full route, not just the pure policy.
    const res = await register(live.url, ['http://localhost:52765/callback']);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { client_id?: string }).client_id).toBeTruthy();
  });
});
