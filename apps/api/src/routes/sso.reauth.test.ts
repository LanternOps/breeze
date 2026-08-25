import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { ssoRoutes } from './sso';

// Mirrors the mocking style established in ./sso.test.ts — copied verbatim
// for the ../db, ../services, and ../middleware/auth blocks (per the Task 3
// brief), trimmed to what POST /sso/reauth/start actually exercises:
// provider lookup + getOIDCConfig (needs assertSafeOidcEndpoint's real logic),
// authorization-URL building, epoch/session binding, and the system-context
// insert.

vi.mock('../services/sso', () => ({
  generateState: vi.fn().mockReturnValue('state'),
  generateNonce: vi.fn().mockReturnValue('nonce'),
  generatePKCEChallenge: vi.fn().mockReturnValue({
    codeVerifier: 'verifier',
    codeChallenge: 'challenge',
    codeChallengeMethod: 'S256'
  }),
  // Real logic (not a stub): asserts the route actually threads prompt/maxAge
  // through to the built URL.
  buildAuthorizationUrl: vi.fn(
    ({ config, state, nonce, redirectUri, pkce, prompt, maxAge }: any) => {
      const url = new URL(config.authorizationUrl);
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', config.scopes);
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('code_challenge', pkce.codeChallenge);
      url.searchParams.set('code_challenge_method', pkce.codeChallengeMethod);
      if (prompt != null) url.searchParams.set('prompt', prompt);
      if (maxAge != null) url.searchParams.set('max_age', String(maxAge));
      return url.toString();
    }
  ),
  exchangeCodeForTokens: vi.fn(),
  getUserInfo: vi.fn(),
  verifyIdTokenSignature: vi.fn(),
  readEmailVerifiedClaim: vi.fn(),
  idpAssertedMfa: vi.fn(),
  mapUserAttributes: vi.fn(),
  discoverOIDCConfig: vi.fn(),
  // Real logic (not a stub) — getOIDCConfig (defined in sso.ts, not mocked)
  // calls this to validate the persisted provider endpoints.
  assertSafeOidcEndpoint: (label: string, urlStr: string | null | undefined, allowPrivateNetwork = false) => {
    if (!urlStr) throw new Error(`OIDC endpoint missing: ${label}`);
    let u: URL;
    try { u = new URL(urlStr); } catch { throw new Error(`OIDC endpoint rejected: ${label}`); }
    const isHttps = u.protocol === 'https:';
    const isHttp = u.protocol === 'http:';
    if (!isHttps && !(allowPrivateNetwork && isHttp)) throw new Error(`OIDC endpoint rejected (must be HTTPS): ${label}`);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost') throw new Error(`OIDC endpoint rejected (internal): ${label}`);
    const literalIp = /^[0-9.]+$/.test(host) || host.includes(':');
    if (literalIp && /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|::1|::$|fc|fd|fe80)/i.test(host)) {
      throw new Error(`OIDC endpoint rejected (internal): ${label}`);
    }
  },
  PROVIDER_PRESETS: {}
}));

vi.mock('../services', () => ({
  createTokenPair: vi.fn(),
  createSession: vi.fn(),
  mintRefreshTokenFamily: vi.fn(),
  bindRefreshJtiToFamily: vi.fn(),
  getUserEpochs: vi.fn().mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 }),
  getRefreshFamily: vi.fn(),
  rateLimiter: vi.fn().mockResolvedValue({ allowed: true, remaining: 4, resetAt: new Date(Date.now() + 60_000) }),
  getRedis: vi.fn().mockReturnValue({})
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([])),
          orderBy: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) }))
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    }))
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => any) => fn()),
  getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' }))
}));

vi.mock('../services/auditEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/auditEvents')>()),
  writeRouteAudit: vi.fn()
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      orgId: '00000000-0000-4000-8000-000000000010',
      partnerId: null,
      accessibleOrgIds: ['00000000-0000-4000-8000-000000000010'],
      canAccessOrg: () => true,
      user: { id: USER_ID, email: 'test@example.com' },
      token: { sid: SID }
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  // #4018 Finding 1: unconditionally reject, mirroring the real
  // requireMfa()'s unsatisfied-session response shape exactly
  // (middleware/auth.ts:862). /reauth/start must NEVER be wired to this —
  // if someone adds requireMfa() to its middleware chain, this mock makes
  // every request through it 403, which is what the dedicated regression
  // test below asserts against.
  requireMfa: vi.fn(() => async (c: any) => c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403)),
  dbAccessContextFromAuth: vi.fn((auth: any) => ({
    scope: auth.scope,
    orgId: auth.orgId ?? null,
    accessibleOrgIds: auth.accessibleOrgIds ?? null,
    accessiblePartnerIds: auth.partnerId ? [auth.partnerId] : [],
    userId: auth.user?.id ?? null,
    currentPartnerId: auth.partnerId ?? null
  })),
  withAuthDbAccessContext: vi.fn((_auth: any, fn: () => any) => fn())
}));

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { getUserEpochs, rateLimiter } from '../services';
import { authMiddleware } from '../middleware/auth';

const USER_ID = '00000000-0000-4000-8000-000000000020';
const PROVIDER_ID = '00000000-0000-4000-8000-000000000001';
const SID = '00000000-0000-4000-8000-0000000000fa';

const ACTIVE_OIDC_PROVIDER = {
  id: PROVIDER_ID,
  orgId: '00000000-0000-4000-8000-000000000010',
  partnerId: null,
  status: 'active',
  configVersion: 7,
  type: 'oidc',
  name: 'Okta',
  issuer: 'https://issuer.example.com',
  authorizationUrl: 'https://issuer.example.com/auth',
  tokenUrl: 'https://issuer.example.com/token',
  userInfoUrl: 'https://issuer.example.com/userinfo',
  jwksUrl: 'https://issuer.example.com/jwks',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  scopes: 'openid profile email',
  attributeMapping: { email: 'email', name: 'name' },
  defaultRoleId: null
};

describe('POST /sso/reauth/start', () => {
  let app: Hono;

  // Mock db.select() sequenced per the route's query order:
  //   1. users (passwordHash)
  //   2. userSsoIdentities (providerId)
  //   3. ssoProviders (full row)
  const mockUserRow = (row: { id: string; passwordHash: string | null } | null) => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(row ? [row] : []) })
      })
    } as any);
  };

  const mockSsoIdentityRows = (rows: Array<{ providerId: string }>) => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) })
        })
      })
    } as any);
  };

  const mockProviderRow = (row: Record<string, unknown> | null) => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(row ? [row] : []) })
      })
    } as any);
  };

  let insertValues: ReturnType<typeof vi.fn>;
  const captureInsert = () => {
    insertValues = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) }));
    vi.mocked(db.insert).mockReturnValueOnce({ values: insertValues } as any);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset().mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([])),
          orderBy: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) }))
        }))
      }))
    } as any);
    vi.mocked(db.insert).mockReset().mockReturnValue({
      values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) }))
    } as any);
    vi.mocked(getUserEpochs).mockReset().mockResolvedValue({ authEpoch: 3, mfaEpoch: 1 } as any);
    vi.mocked(rateLimiter).mockReset().mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 60_000)
    } as any);
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'organization',
        orgId: '00000000-0000-4000-8000-000000000010',
        partnerId: null,
        accessibleOrgIds: ['00000000-0000-4000-8000-000000000010'],
        canAccessOrg: () => true,
        user: { id: USER_ID, email: 'test@example.com' },
        token: { sid: SID }
      });
      return next();
    });
    process.env.APP_ENCRYPTION_KEY = 'test-sso-cookie-secret';
    app = new Hono();
    app.route('/sso', ssoRoutes);
  });

  it('refuses when the account has a password', async () => {
    mockUserRow({ id: USER_ID, passwordHash: 'argon2id$...' });

    const res = await app.request('/sso/reauth/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Account has a password' });
  });

  it('404s when the user has no linked SSO identity', async () => {
    mockUserRow({ id: USER_ID, passwordHash: null });
    mockSsoIdentityRows([]);

    const res = await app.request('/sso/reauth/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(404);
  });

  it('inserts a reauth-mode session bound to the caller and returns an authUrl with prompt=login and max_age=0', async () => {
    mockUserRow({ id: USER_ID, passwordHash: null });
    mockSsoIdentityRows([{ providerId: PROVIDER_ID }]);
    mockProviderRow(ACTIVE_OIDC_PROVIDER);
    captureInsert();
    vi.mocked(getUserEpochs).mockResolvedValueOnce({ authEpoch: 3, mfaEpoch: 1 } as any);

    const res = await app.request('/sso/reauth/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const { authUrl } = await res.json();
    const url = new URL(authUrl);
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('max_age')).toBe('0');

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      providerId: PROVIDER_ID,
      reauthUserId: USER_ID,
      providerVersion: 7,
      initiatingAuthEpoch: 3,
      initiatingMfaEpoch: 1,
      initiatingSessionId: SID
    }));
    const insertedArg = insertValues.mock.calls[0][0];
    expect(insertedArg.linkUserId).toBeUndefined();

    // #4018 Finding 2: sso_sessions is system-scope-only under RLS. Dropping
    // this wrapping from the insert is the silent-RLS-drop bug (the write
    // would be discarded by RLS at runtime with no error) and this suite
    // would otherwise stay green — assert both wrappers actually ran, mirroring
    // the precedent at sso.test.ts:1082-1083.
    expect(runOutsideDbContext).toHaveBeenCalled();
    expect(withSystemDbAccessContext).toHaveBeenCalled();
  });

  // #4018 Finding 1: the entire plan hinges on this route NOT being gated by
  // requireMfa() — a passwordless SSO user cannot satisfy it, which is why
  // this route exists. The requireMfa mock above (module-level) is wired to
  // unconditionally 403 "the way the real requireMfa() does for an
  // unsatisfied session" (middleware/auth.ts:862); since the route registers
  // only `authMiddleware` (never requireMfa()), that rejecting middleware is
  // never part of this route's chain, so a fully valid happy-path request
  // must still succeed. If requireMfa() were ever added to the route's
  // middleware chain, this would 403 instead and the test would fail.
  it('never invokes requireMfa() — a happy-path request succeeds even though the requireMfa mock unconditionally rejects', async () => {
    mockUserRow({ id: USER_ID, passwordHash: null });
    mockSsoIdentityRows([{ providerId: PROVIDER_ID }]);
    mockProviderRow(ACTIVE_OIDC_PROVIDER);
    captureInsert();
    vi.mocked(getUserEpochs).mockResolvedValueOnce({ authEpoch: 3, mfaEpoch: 1 } as any);

    const res = await app.request('/sso/reauth/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const { authUrl } = await res.json();
    expect(authUrl).toBeTruthy();
  });

  it('503s when the caller has no sid or epochs are unavailable', async () => {
    mockUserRow({ id: USER_ID, passwordHash: null });
    mockSsoIdentityRows([{ providerId: PROVIDER_ID }]);
    mockProviderRow(ACTIVE_OIDC_PROVIDER);
    vi.mocked(getUserEpochs).mockResolvedValueOnce(null);

    const res = await app.request('/sso/reauth/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(503);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('refuses a provider whose status is inactive', async () => {
    mockUserRow({ id: USER_ID, passwordHash: null });
    mockSsoIdentityRows([{ providerId: PROVIDER_ID }]);
    mockProviderRow({ ...ACTIVE_OIDC_PROVIDER, status: 'inactive' });

    const res = await app.request('/sso/reauth/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(404);
  });

  it('rate-limits repeated attempts per caller', async () => {
    mockUserRow({ id: USER_ID, passwordHash: null });
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000)
    } as any);

    const res = await app.request('/sso/reauth/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(429);
  });
});
