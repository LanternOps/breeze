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

// resolvePartnerAccessibleOrgIds queries partner_users + organizations under
// withSystemDbAccessContext. The `db` mock below feeds a sequence of rows so
// each call (membership lookup, then org enumeration) gets predictable data.
// `dbState.next` is the queue; tests push rows in the order the resolver will
// read them. The resolver runs INSIDE withSystemDbAccessContext, which we
// stub to a passthrough.
const dbState = vi.hoisted(() => ({
  rows: [] as unknown[][],
  wherePredicates: [] as unknown[],
}));

vi.mock('../db', () => {
  function makeChain(rows: unknown[]) {
    // The production code may end a query at either `.limit(1)` (partner_users
    // lookup) OR `.where(...)` alone (organizations enumeration). Both must
    // be thenable/iterable to the same row list for the mock to be correct.
    const limit = vi.fn(async () => rows);
    const where = vi.fn((predicate: unknown) => {
      dbState.wherePredicates.push(predicate);
      const thenable = Promise.resolve(rows) as Promise<unknown[]> & { limit: typeof limit };
      thenable.limit = limit;
      return thenable;
    });
    const from = vi.fn(() => ({ where, limit }));
    return { from };
  }
  return {
    withDbAccessContext: vi.fn(async (_context, fn) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn) => fn()),
    db: {
      select: vi.fn(() => {
        const next = dbState.rows.shift() ?? [];
        return makeChain(next);
      }),
    },
  };
});

vi.mock('../oauth/revocationCache', () => ({
  isJtiRevoked: vi.fn().mockResolvedValue(false),
  isGrantRevoked: vi.fn().mockResolvedValue(false),
}));

vi.mock('../services/tenantStatus', () => ({
  TenantInactiveError: class TenantInactiveError extends Error {},
  assertActiveTenantContext: vi.fn().mockResolvedValue(undefined),
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
import { assertActiveTenantContext, TenantInactiveError } from '../services/tenantStatus';
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

function collectPredicateFacts(value: unknown, seen = new Set<unknown>()): { columns: string[]; params: unknown[] } {
  const facts = { columns: [] as string[], params: [] as unknown[] };
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);

    const record = node as Record<string, unknown>;
    if (typeof record.name === 'string' && typeof record.columnType === 'string') {
      facts.columns.push(record.name);
    }
    if (node.constructor?.name === 'Param') {
      facts.params.push(record.value);
    }

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    if (Array.isArray(record.queryChunks)) {
      for (const chunk of record.queryChunks) walk(chunk);
    }
  };

  walk(value);
  return facts;
}

describe('bearerTokenAuthMiddleware', () => {
  beforeAll(async () => {
    keypair = await generateTestKeypair();
    jwksState.importedPublicKey = await importJWK(keypair.publicJwk as JWK, 'EdDSA');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    dbState.rows = [];
    dbState.wherePredicates = [];
    _resetJwksCacheForTests();
    envState.issuer = issuer;
    envState.resourceUrl = audience;
    vi.mocked(isJtiRevoked).mockResolvedValue(false);
    vi.mocked(isGrantRevoked).mockResolvedValue(false);
    vi.mocked(assertActiveTenantContext).mockResolvedValue(undefined);
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

  it('rejects a token missing exp', async () => {
    // jose's jwtVerify without `requiredClaims` accepts missing exp by
    // default — but bearer auth pins `algorithms: ['EdDSA']` and treats
    // `exp` as load-bearing for revocation cache TTLs. Sign a JWT with
    // no `setExpirationTime` to confirm it's rejected.
    const { SignJWT, importJWK } = await import('jose');
    const key = await importJWK(keypair.privateJwk as JWK, 'EdDSA');
    const token = await new SignJWT({
      sub: userId,
      partner_id: partnerId,
      org_id: orgId,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: keypair.kid })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setJti('no-exp-jti')
      .sign(key);

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

  it('rejects OAuth bearer tokens for inactive or deleted tenant contexts', async () => {
    vi.mocked(assertActiveTenantContext).mockRejectedValue(new TenantInactiveError('Partner is not active'));
    const token = await mintToken({
      sub: userId,
      partner_id: partnerId,
      org_id: orgId,
      jti: 'inactive-tenant-jti',
    });

    await expectUnauthorized(createContext({ Authorization: `Bearer ${token}` }), 'tenant inactive');
  });

  it('maps legacy mcp:write to read/write/execute (back-compat through 2026-05-15)', async () => {
    // Pre-split refresh tokens carried mcp:write expecting ai:execute. We
    // continue granting ai:execute when mcp:execute is NOT also present so
    // 14-day live refresh tokens don't silently lose tool execution.
    const { _resetLegacyMcpWriteWarningsForTests } = await import('./bearerTokenAuth');
    _resetLegacyMcpWriteWarningsForTests();
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

  it('maps mcp:execute to internal execute scope', async () => {
    const token = await mintToken({
      sub: userId,
      partner_id: partnerId,
      org_id: orgId,
      scope: 'mcp:read mcp:write mcp:execute',
      jti: 'execute-token-jti',
    });
    const c = createContext({ Authorization: `Bearer ${token}` });
    const next = vi.fn();

    await bearerTokenAuthMiddleware(c, next);

    expect(c.get('apiKey')).toMatchObject({
      scopes: ['mcp:read', 'mcp:write', 'mcp:execute', 'ai:read', 'ai:write', 'ai:execute'],
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it('preserves grant_id for stable MCP session and rate-limit ownership', async () => {
    const token = await mintToken({
      sub: userId,
      partner_id: partnerId,
      org_id: orgId,
      scope: 'mcp:read',
      jti: 'access-token-jti',
      grant_id: 'grant-stable-id',
    });
    const c = createContext({ Authorization: `Bearer ${token}` });
    const next = vi.fn();

    await bearerTokenAuthMiddleware(c, next);

    expect(c.get('apiKey')).toMatchObject({
      id: 'oauth:access-token-jti',
      oauthGrantId: 'grant-stable-id',
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it('sets partner-scope API key context when org_id is null and resolves the partner org allowlist (M-B1)', async () => {
    // Defense-in-depth: partner-scope tokens used to pass `accessibleOrgIds: null`
    // to withDbAccessContext, which downstream auth.orgCondition() interprets
    // as "system, no filter". This regression test pins the new behavior:
    // we resolve the actual partner→org list (via partner_users + organizations
    // under system DB context) and pass it through.
    const orgA = '44444444-4444-4444-8444-444444444444';
    const orgB = '55555555-5555-5555-8555-555555555555';
    // Resolver does: SELECT partner_users (membership), then SELECT organizations.
    dbState.rows = [
      [{ orgAccess: 'all', orgIds: null }],
      [{ id: orgA }, { id: orgB }],
    ];

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
    });
    expect(c.get('apiKeyOrgId')).toBeUndefined();
    expect(withDbAccessContext).toHaveBeenCalledWith(
      {
        scope: 'partner',
        orgId: null,
        accessibleOrgIds: [orgA, orgB],
        accessiblePartnerIds: [partnerId],
        userId,
      },
      expect.any(Function)
    );
    expect(next).toHaveBeenCalledOnce();

    const orgPredicate = dbState.wherePredicates[1];
    const facts = collectPredicateFacts(orgPredicate);
    expect(facts.columns).toEqual(expect.arrayContaining(['partner_id', 'status', 'deleted_at']));
    expect(facts.params).toEqual(expect.arrayContaining(['active', 'trial']));
  });

  it('passes [] (not null) for partner-scope tokens whose partner has no orgs (M-B1)', async () => {
    // Edge case: a brand-new partner with no orgs. Resolver returns []. We
    // MUST pass [] to withDbAccessContext — passing null would be the
    // historical "system, no filter" shape that defeats defense-in-depth.
    dbState.rows = [
      [{ orgAccess: 'all', orgIds: null }],
      [],
    ];

    const token = await mintToken({
      sub: userId,
      partner_id: partnerId,
      org_id: null,
      scope: 'mcp:read',
      jti: 'partner-empty-token-jti',
    });
    const c = createContext({ Authorization: `Bearer ${token}` });
    const next = vi.fn();

    await bearerTokenAuthMiddleware(c, next);

    expect(withDbAccessContext).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'partner',
        accessibleOrgIds: [],
      }),
      expect.any(Function)
    );
  });

  it('passes [] for partner-scope tokens whose user has no partner_users membership (M-B1)', async () => {
    // The user is no longer a member of the partner — happens when an admin
    // revokes membership but a token is mid-flight. Resolver returns []
    // immediately; the middleware MUST still pass [] (not null) so any
    // downstream query produces zero rows instead of system-wide.
    dbState.rows = [[]];

    const token = await mintToken({
      sub: userId,
      partner_id: partnerId,
      org_id: null,
      scope: 'mcp:read',
      jti: 'no-membership-jti',
    });
    const c = createContext({ Authorization: `Bearer ${token}` });
    const next = vi.fn();

    await bearerTokenAuthMiddleware(c, next);

    expect(withDbAccessContext).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'partner',
        accessibleOrgIds: [],
      }),
      expect.any(Function)
    );
  });
});
