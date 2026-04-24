import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';

const jwksState = vi.hoisted(() => ({
  importedPublicKey: undefined as unknown,
}));

const envState = vi.hoisted(() => ({
  issuer: 'https://issuer.test',
  resourceUrl: 'https://issuer.test/mcp/server',
}));

vi.mock('../config/env', () => ({
  get OAUTH_ISSUER() {
    return envState.issuer;
  },
  get OAUTH_RESOURCE_URL() {
    return envState.resourceUrl;
  },
}));

vi.mock('../db', () => ({
  withDbAccessContext: vi.fn(async (_context, fn) => fn()),
}));

vi.mock('../oauth/revocationCache', () => ({
  isJtiRevoked: vi.fn().mockResolvedValue(false),
  isGrantRevoked: vi.fn().mockResolvedValue(false),
}));

vi.mock('jose', async () => {
  const actual = await vi.importActual<typeof import('jose')>('jose');
  return {
    ...actual,
    jwtVerify: vi.fn(actual.jwtVerify),
    createRemoteJWKSet: vi.fn(
      () => async () => jwksState.importedPublicKey as Awaited<ReturnType<typeof actual.importJWK>>
    ),
  };
});

import { importJWK, jwtVerify, type JWK } from 'jose';
import { withDbAccessContext } from '../db';
import { isGrantRevoked, isJtiRevoked } from '../oauth/revocationCache';
import { generateTestKeypair, signTestJwt, type TestKeypair } from '../oauth/testHelpers';
import { _resetJwksCacheForTests, bearerTokenAuthMiddleware } from './bearerTokenAuth';

type TestContext = Context & {
  get: (key: string) => unknown;
};

const issuer = 'https://issuer.test';
const audience = 'https://issuer.test/mcp/server';
const partnerId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';

let keypair: TestKeypair;

function createContext(headers: Record<string, string | undefined> = {}): TestContext {
  const store = new Map<string, unknown>();
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));

  return {
    req: {
      header: (name: string) => normalized[name.toLowerCase()],
    },
    set: (key: string, value: unknown) => {
      store.set(key, value);
    },
    get: (key: string) => store.get(key),
  } as TestContext;
}

async function mintToken(claims: Record<string, unknown>, opts: { issuer?: string; audience?: string; ttlSeconds?: number } = {}) {
  return signTestJwt(keypair.privateJwk, keypair.kid, claims, {
    issuer: opts.issuer ?? issuer,
    audience: opts.audience ?? audience,
    ttlSeconds: opts.ttlSeconds,
  });
}

async function expectUnauthorized(
  c: TestContext,
  message: string | RegExp,
  next = vi.fn()
) {
  await expect(bearerTokenAuthMiddleware(c, next)).rejects.toMatchObject({ status: 401, message });
  expect(next).not.toHaveBeenCalled();
}

describe('bearerTokenAuthMiddleware', () => {
  beforeAll(async () => {
    keypair = await generateTestKeypair();
    jwksState.importedPublicKey = await importJWK(keypair.publicJwk as JWK, 'EdDSA');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    _resetJwksCacheForTests();
    envState.issuer = issuer;
    envState.resourceUrl = audience;
    vi.mocked(isJtiRevoked).mockResolvedValue(false);
    vi.mocked(isGrantRevoked).mockResolvedValue(false);
  });

  it('fails fast when OAuth issuer and resource URL are not configured', async () => {
    envState.issuer = '';
    envState.resourceUrl = '';

    await expect(bearerTokenAuthMiddleware(createContext(), vi.fn())).rejects.toMatchObject({
      status: 500,
      message: 'OAuth not configured: OAUTH_ISSUER and OAUTH_RESOURCE_URL must be set',
    });
  });

  it('rejects when Authorization header is missing', async () => {
    await expectUnauthorized(createContext(), 'missing bearer token');
  });

  it('rejects when Authorization header is not bearer auth', async () => {
    await expectUnauthorized(createContext({ Authorization: 'Basic abc' }), 'missing bearer token');
  });

  it('rejects an invalid signature', async () => {
    const otherKeypair = await generateTestKeypair();
    const token = await signTestJwt(
      otherKeypair.privateJwk,
      otherKeypair.kid,
      { sub: userId, partner_id: partnerId, org_id: orgId },
      { issuer, audience }
    );

    await expectUnauthorized(createContext({ Authorization: `Bearer ${token}` }), /invalid token:/);
    expect(isJtiRevoked).not.toHaveBeenCalled();
  });

  it('rejects a token with the wrong audience', async () => {
    const token = await mintToken(
      { sub: userId, partner_id: partnerId, org_id: orgId },
      { audience: 'https://issuer.test/not-mcp' }
    );

    await expectUnauthorized(createContext({ Authorization: `Bearer ${token}` }), /invalid token:/);
  });

  it('rejects a token with the wrong issuer', async () => {
    const token = await mintToken(
      { sub: userId, partner_id: partnerId, org_id: orgId },
      { issuer: 'https://other-issuer.test' }
    );

    await expectUnauthorized(createContext({ Authorization: `Bearer ${token}` }), /invalid token:/);
  });

  it('rejects an expired token', async () => {
    const token = await mintToken(
      { sub: userId, partner_id: partnerId, org_id: orgId },
      { ttlSeconds: -60 }
    );

    await expectUnauthorized(createContext({ Authorization: `Bearer ${token}` }), /invalid token:/);
  });

  it('returns 503 when JWT verification fails for a non-jose error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(jwtVerify).mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(
      bearerTokenAuthMiddleware(createContext({ Authorization: 'Bearer token' }), vi.fn())
    ).rejects.toMatchObject({
      status: 503,
      message: 'oauth verification temporarily unavailable',
    });
    expect(errorSpy).toHaveBeenCalledWith(
      '[oauth] jwt verification failed for non-token reason (jwks fetch?)',
      expect.any(TypeError)
    );
    errorSpy.mockRestore();
  });

  it('rejects a valid token with a revoked jti', async () => {
    vi.mocked(isJtiRevoked).mockResolvedValue(true);
    const token = await mintToken({ sub: userId, partner_id: partnerId, org_id: orgId, jti: 'revoked-jti' });

    await expectUnauthorized(createContext({ Authorization: `Bearer ${token}` }), 'token revoked');
    expect(isJtiRevoked).toHaveBeenCalledWith('revoked-jti');
  });

  it('rejects a valid token whose Grant has been revoked, even if the jti itself is not revoked', async () => {
    // The grant-wide revocation path is what makes "Revoke" on a connected
    // app or POST /oauth/token/revocation with a refresh token actually kill
    // every in-flight access JWT minted under the same Grant. Without this
    // check the access tokens would survive until natural ~10-minute expiry.
    vi.mocked(isJtiRevoked).mockResolvedValue(false);
    vi.mocked(isGrantRevoked).mockResolvedValue(true);
    const token = await mintToken({
      sub: userId,
      partner_id: partnerId,
      org_id: orgId,
      jti: 'still-valid-jti',
      grant_id: 'revoked-grant',
    });

    await expectUnauthorized(createContext({ Authorization: `Bearer ${token}` }), 'token revoked');
    expect(isGrantRevoked).toHaveBeenCalledWith('revoked-grant');
  });

  it('rejects a token missing partner_id', async () => {
    const token = await mintToken({ sub: userId, org_id: orgId });

    await expectUnauthorized(createContext({ Authorization: `Bearer ${token}` }), 'token missing required claims');
  });

  it('rejects a token missing sub', async () => {
    const token = await mintToken({ partner_id: partnerId, org_id: orgId });

    await expectUnauthorized(createContext({ Authorization: `Bearer ${token}` }), 'token missing required claims');
  });

  it('sets API key context and runs next inside organization DB context', async () => {
    const token = await mintToken({
      sub: userId,
      partner_id: partnerId,
      org_id: orgId,
      scope: 'mcp:read mcp:write',
      jti: 'org-token-jti',
    });
    const c = createContext({ Authorization: `Bearer ${token}` });
    const next = vi.fn();

    await bearerTokenAuthMiddleware(c, next);

    expect(c.get('apiKey')).toEqual({
      id: 'oauth:org-token-jti',
      orgId,
      partnerId,
      name: 'OAuth bearer',
      keyPrefix: 'oauth',
      scopes: ['mcp:read', 'mcp:write', 'ai:read', 'ai:write', 'ai:execute'],
      rateLimit: 1000,
      createdBy: userId,
      scopeState: 'full',
    });
    expect(c.get('apiKeyOrgId')).toBe(orgId);
    expect(withDbAccessContext).toHaveBeenCalledWith(
      {
        scope: 'organization',
        orgId,
        accessibleOrgIds: [orgId],
        accessiblePartnerIds: [partnerId],
        userId,
      },
      expect.any(Function)
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('sets partner-scope API key context when org_id is null', async () => {
    const token = await mintToken({
      sub: userId,
      partner_id: partnerId,
      org_id: null,
      scope: 'mcp:read',
      jti: 'partner-token-jti',
    });
    const c = createContext({ Authorization: `Bearer ${token}` });
    const next = vi.fn();

    await bearerTokenAuthMiddleware(c, next);

    expect(c.get('apiKey')).toEqual({
      id: 'oauth:partner-token-jti',
      orgId: null,
      partnerId,
      name: 'OAuth bearer',
      keyPrefix: 'oauth',
      scopes: ['mcp:read', 'ai:read'],
      rateLimit: 1000,
      createdBy: userId,
      scopeState: 'full',
    });
    expect(c.get('apiKeyOrgId')).toBeUndefined();
    expect(withDbAccessContext).toHaveBeenCalledWith(
      {
        scope: 'partner',
        orgId: null,
        accessibleOrgIds: null,
        accessiblePartnerIds: [partnerId],
        userId,
      },
      expect.any(Function)
    );
    expect(next).toHaveBeenCalledOnce();
  });
});
