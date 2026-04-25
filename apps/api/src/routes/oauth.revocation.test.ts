import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { generateTestKeypair, signTestJwt } from '../oauth/testHelpers';

const ENV_KEYS = [
  'MCP_OAUTH_ENABLED',
  'OAUTH_ISSUER',
  'OAUTH_RESOURCE_URL',
  'OAUTH_COOKIE_SECRET',
  'OAUTH_JWKS_PRIVATE_JWK',
] as const;

const clearEnv = () => {
  for (const key of ENV_KEYS) delete process.env[key];
};

const ISSUER = 'https://test.example';
const AUDIENCE = 'https://test.example/mcp/server';

interface Harness {
  app: Hono;
  privateJwk: import('jose').JWK;
  kid: string;
  revokeJti: ReturnType<typeof vi.fn>;
  revokeGrant: ReturnType<typeof vi.fn>;
  providerCalled: () => number;
}

const importHarness = async (
  cacheBehavior: {
    revokeJti?: ReturnType<typeof vi.fn>;
    revokeGrant?: ReturnType<typeof vi.fn>;
  } = {}
): Promise<Harness> => {
  const kp = await generateTestKeypair();
  // Provide a JWKS env var with both private+public so loadJwks() works.
  process.env.MCP_OAUTH_ENABLED = 'true';
  process.env.OAUTH_ISSUER = ISSUER;
  process.env.OAUTH_RESOURCE_URL = AUDIENCE;
  process.env.OAUTH_COOKIE_SECRET = 'x'.repeat(48);
  process.env.OAUTH_JWKS_PRIVATE_JWK = JSON.stringify({ keys: [kp.privateJwk] });

  const revokeJti = cacheBehavior.revokeJti ?? vi.fn(async () => undefined);
  const revokeGrant = cacheBehavior.revokeGrant ?? vi.fn(async () => undefined);

  let providerCalls = 0;
  vi.doMock('../oauth/provider', () => ({
    getProvider: vi.fn(async () => {
      providerCalls += 1;
      // Throw a sentinel so the catch-all bridge resolves to a known error.
      throw new Error('provider sentinel — bridge reached');
    }),
  }));
  vi.doMock('../oauth/revocationCache', () => ({ revokeJti, revokeGrant, isJtiRevoked: vi.fn(), isGrantRevoked: vi.fn() }));
  vi.doMock('../services/redis', () => ({ getRedis: vi.fn(() => null) }));
  vi.doMock('../services/rate-limit', () => ({
    rateLimiter: vi.fn(async () => ({ allowed: true, remaining: 1, resetAt: new Date() })),
  }));
  vi.resetModules();

  const { oauthRoutes } = await import('./oauth');
  const app = new Hono();
  // Surface the bridge sentinel as 599 so tests can distinguish "fell through to bridge"
  // from "short-circuited at pre-handler".
  app.onError((err) => new Response(`bridge-reached:${(err as Error).message}`, { status: 599 }));
  app.route('/oauth', oauthRoutes);

  return { app, privateJwk: kp.privateJwk, kid: kp.kid, revokeJti, revokeGrant, providerCalled: () => providerCalls };
};

const post = (app: Hono, body: Record<string, string>) =>
  app.request('/oauth/token/revocation', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });

const postRaw = (app: Hono, body: string) =>
  app.request('/oauth/token/revocation', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

describe('POST /oauth/token/revocation pre-handler — JWT signature gating', () => {
  beforeEach(() => {
    clearEnv();
    vi.resetModules();
  });
  afterEach(() => {
    clearEnv();
    vi.doUnmock('../oauth/provider');
    vi.doUnmock('../oauth/revocationCache');
    vi.doUnmock('../services/redis');
    vi.doUnmock('../services/rate-limit');
  });

  it('does NOT write the cache for a forged JWT signed with a foreign key', async () => {
    const h = await importHarness();
    // Sign with a DIFFERENT keypair than the one in OAUTH_JWKS_PRIVATE_JWK
    const foreignKp = await generateTestKeypair();
    const forged = await signTestJwt(
      foreignKp.privateJwk,
      foreignKp.kid,
      { client_id: 'client-A', jti: 'victim-jti', grant_id: 'victim-grant' },
      { issuer: ISSUER, audience: AUDIENCE }
    );

    const res = await post(h.app, { token: forged, client_id: 'client-A' });

    // Falls through to bridge (sentinel surfaces as 599 here).
    expect(res.status).toBe(599);
    expect(h.revokeJti).not.toHaveBeenCalled();
    expect(h.revokeGrant).not.toHaveBeenCalled();
  });

  it('returns 200 (RFC 7009) without writing the cache when client_id binding fails (M-B2)', async () => {
    // M-B2: per RFC 7009 §2.2 the revocation endpoint MUST return 200 for
    // any well-formed request — including one that presents a token the
    // caller is not authorized to act on. Returning 401/400/599 here used
    // to leak token validity to a probing client. The cache MUST stay
    // untouched (the legitimate owner can still use the token).
    const h = await importHarness();
    const tokenForA = await signTestJwt(
      h.privateJwk,
      h.kid,
      { client_id: 'client-A', jti: randomUUID(), grant_id: 'grant-A' },
      { issuer: ISSUER, audience: AUDIENCE }
    );

    // client B presents A's token claiming themselves as the requester
    const res = await post(h.app, { token: tokenForA, client_id: 'client-B' });

    expect(res.status).toBe(200);
    expect(h.revokeJti).not.toHaveBeenCalled();
    expect(h.revokeGrant).not.toHaveBeenCalled();
    // Bridge MUST NOT be reached either — a 200 short-circuit is what
    // prevents the bridge's own 400-leakage on unknown JWTs.
    expect(h.providerCalled()).toBe(0);
  });

  it('returns 200 when the request omits client_id entirely (no leak)', async () => {
    const h = await importHarness();
    const token = await signTestJwt(
      h.privateJwk,
      h.kid,
      { client_id: 'client-A', jti: randomUUID(), grant_id: 'grant-A' },
      { issuer: ISSUER, audience: AUDIENCE }
    );

    const res = await post(h.app, { token });

    expect(res.status).toBe(200);
    expect(h.revokeJti).not.toHaveBeenCalled();
    expect(h.revokeGrant).not.toHaveBeenCalled();
  });

  it('writes the cache and short-circuits 200 when JWT + client_id both verify', async () => {
    const h = await importHarness();
    const jti = randomUUID();
    const grantId = randomUUID();
    const token = await signTestJwt(
      h.privateJwk,
      h.kid,
      { client_id: 'client-A', jti, grant_id: grantId },
      { issuer: ISSUER, audience: AUDIENCE }
    );

    const res = await post(h.app, { token, client_id: 'client-A' });

    expect(res.status).toBe(200);
    expect(h.revokeJti).toHaveBeenCalledWith(jti, expect.any(Number));
    expect(h.revokeGrant).toHaveBeenCalledWith(grantId, expect.any(Number));
    expect(h.providerCalled()).toBe(0);
  });

  it('returns 503 when the JTI cache write fails (Redis-down propagation, NOT 200)', async () => {
    const h = await importHarness({
      revokeJti: vi.fn(async () => {
        throw new Error('Redis unavailable');
      }),
    });
    const token = await signTestJwt(
      h.privateJwk,
      h.kid,
      { client_id: 'client-A', jti: randomUUID(), grant_id: randomUUID() },
      { issuer: ISSUER, audience: AUDIENCE }
    );

    const res = await post(h.app, { token, client_id: 'client-A' });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('server_error');
  });

  it('returns 503 when the GRANT cache write fails (after JTI succeeded)', async () => {
    const h = await importHarness({
      revokeGrant: vi.fn(async () => {
        throw new Error('Redis unavailable');
      }),
    });
    const token = await signTestJwt(
      h.privateJwk,
      h.kid,
      { client_id: 'client-A', jti: randomUUID(), grant_id: randomUUID() },
      { issuer: ISSUER, audience: AUDIENCE }
    );

    const res = await post(h.app, { token, client_id: 'client-A' });

    expect(res.status).toBe(503);
  });

  it('rejects oversized revocation bodies before provider bridge or cache writes', async () => {
    const h = await importHarness();
    const oversized = `token=${'a'.repeat(70 * 1024)}&client_id=client-A`;

    const res = await postRaw(h.app, oversized);

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
    expect(h.providerCalled()).toBe(0);
    expect(h.revokeJti).not.toHaveBeenCalled();
    expect(h.revokeGrant).not.toHaveBeenCalled();
  });

  it('falls through to bridge for opaque (non three-part) refresh tokens', async () => {
    const h = await importHarness();
    const res = await post(h.app, { token: 'opaque-refresh-token-no-dots', client_id: 'client-A' });

    // Bridge is reached (sentinel) and revocation cache is untouched.
    expect(res.status).toBe(599);
    expect(h.revokeJti).not.toHaveBeenCalled();
    expect(h.revokeGrant).not.toHaveBeenCalled();
  });
});
