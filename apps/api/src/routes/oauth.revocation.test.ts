import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import type { JWK } from 'jose';
import { generateTestKeypair, signTestJwt } from '../oauth/testHelpers';

const configState = vi.hoisted(() => ({
  privateJwks: '',
}));

type CallableDelegate = (...args: any[]) => any;

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn(),
  revokeJti: vi.fn<CallableDelegate>(),
  revokeGrant: vi.fn<CallableDelegate>(),
  isJtiRevoked: vi.fn(),
  isGrantRevoked: vi.fn(),
  getRedis: vi.fn(),
  rateLimiter: vi.fn(),
}));

vi.mock('../config/env', () => Object.defineProperty({
  MCP_OAUTH_ENABLED: true,
  OAUTH_DCR_ENABLED: false,
  OAUTH_ISSUER: 'https://test.example',
  OAUTH_RESOURCE_URL: 'https://test.example/mcp/server',
}, 'OAUTH_JWKS_PRIVATE_JWK', {
  enumerable: true,
  configurable: true,
  get: () => configState.privateJwks,
}));
vi.mock('../oauth/provider', () => ({ getProvider: mocks.getProvider }));
vi.mock('../oauth/revocationCache', () => ({
  revokeJti: mocks.revokeJti,
  revokeGrant: mocks.revokeGrant,
  isJtiRevoked: mocks.isJtiRevoked,
  isGrantRevoked: mocks.isGrantRevoked,
}));
vi.mock('../services/redis', () => ({ getRedis: mocks.getRedis }));
vi.mock('../services/rate-limit', () => ({ rateLimiter: mocks.rateLimiter }));

import { oauthRoutes } from './oauth';

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
  privateJwk: JWK;
  kid: string;
  revokeJti: typeof mocks.revokeJti;
  revokeGrant: typeof mocks.revokeGrant;
  providerCalled: () => number;
}

let privateJwk: JWK;
let kid: string;

const app = new Hono();
app.onError((err) => new Response(`bridge-reached:${(err as Error).message}`, { status: 599 }));
app.route('/oauth', oauthRoutes);

const getHarness = (
  cacheBehavior: {
    revokeJti?: CallableDelegate;
    revokeGrant?: CallableDelegate;
  } = {}
): Promise<Harness> => {
  if (cacheBehavior.revokeJti) mocks.revokeJti.mockImplementation(cacheBehavior.revokeJti);
  if (cacheBehavior.revokeGrant) mocks.revokeGrant.mockImplementation(cacheBehavior.revokeGrant);

  return Promise.resolve({
    app,
    privateJwk,
    kid,
    revokeJti: mocks.revokeJti,
    revokeGrant: mocks.revokeGrant,
    providerCalled: () => mocks.getProvider.mock.calls.length,
  });
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
  beforeAll(async () => {
    const keypair = await generateTestKeypair();
    privateJwk = keypair.privateJwk;
    kid = keypair.kid;
    configState.privateJwks = JSON.stringify({ keys: [privateJwk] });
  });

  beforeEach(() => {
    clearEnv();
    configState.privateJwks = JSON.stringify({ keys: [privateJwk] });
    mocks.getProvider.mockReset();
    mocks.getProvider.mockRejectedValue(new Error('provider sentinel — bridge reached'));
    mocks.revokeJti.mockReset();
    mocks.revokeJti.mockResolvedValue(undefined);
    mocks.revokeGrant.mockReset();
    mocks.revokeGrant.mockResolvedValue(undefined);
    mocks.isJtiRevoked.mockReset();
    mocks.isGrantRevoked.mockReset();
    mocks.getRedis.mockReset();
    mocks.getRedis.mockReturnValue(null);
    mocks.rateLimiter.mockReset();
    mocks.rateLimiter.mockResolvedValue({ allowed: true, remaining: 1, resetAt: new Date() });
  });

  it('does NOT write the cache for a forged JWT signed with a foreign key', async () => {
    const h = await getHarness();
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
    const h = await getHarness();
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
    const h = await getHarness();
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
    const h = await getHarness();
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
    const h = await getHarness({
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
    const h = await getHarness({
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
    const h = await getHarness();
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
    const h = await getHarness();
    const res = await post(h.app, { token: 'opaque-refresh-token-no-dots', client_id: 'client-A' });

    // Bridge is reached (sentinel) and revocation cache is untouched.
    expect(res.status).toBe(599);
    expect(h.revokeJti).not.toHaveBeenCalled();
    expect(h.revokeGrant).not.toHaveBeenCalled();
  });
});
