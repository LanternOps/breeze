import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import { Hono } from 'hono';
import { ssoRoutes } from './sso';

// Mirrors the mocking style established in ./sso.test.ts — copied verbatim
// for the ../db, ../services, and ../middleware/auth blocks (per the Task 3
// brief), trimmed to what POST /sso/reauth/start actually exercises:
// provider lookup + getOIDCConfig (needs assertSafeOidcEndpoint's real logic),
// authorization-URL building, epoch/session binding, and the system-context
// insert. Task 4 extends the same blocks with what GET /sso/callback's reauth
// branch exercises (token exchange, id_token verification, userinfo, grant
// minting).

// Mirrors the route's signed binding-cookie derivation
// (HMAC-SHA256 of `sso-login-state:<state>` keyed by the cookie secret) —
// same helper as ./sso.test.ts:8-14.
const SSO_STATE_COOKIE_SECRET = 'test-sso-cookie-secret';
function ssoStateCookieHeader(state: string): string {
  const value = createHmac('sha256', SSO_STATE_COOKIE_SECRET)
    .update(`sso-login-state:${state}`)
    .digest('hex');
  return `breeze_sso_state=${encodeURIComponent(value)}`;
}

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
  // Real logic (not a stub), same mirror as ./sso.test.ts:37-42 — an
  // always-undefined stub would make the callback's email_verified gate
  // unconditionally pass, hiding it from the reauth callback tests.
  readEmailVerifiedClaim: (source: Record<string, unknown> | null | undefined) => {
    const ev = source?.email_verified;
    if (ev === true || ev === 'true') return 'true';
    if (ev === false || ev === 'false') return 'false';
    return 'absent';
  },
  idpAssertedMfa: vi.fn(),
  // Real logic (not a stub) — a faithful mirror of services/sso.ts:295-313
  // (Task 1; independently unit-tested in services/sso.test.ts:633). A plain
  // vi.fn() stub would return `undefined` and let the callback's freshness
  // gate be deleted with the auth_time tests below still green, which is
  // exactly the revert-probe this suite has to survive. Wrapped in vi.fn() so
  // the suite can ALSO assert the route bounds it from the sso_sessions row's
  // own created_at rather than a window measured from now.
  assertFreshIdpAuthentication: vi.fn((
    claims: { auth_time?: unknown } | null | undefined,
    startedAtMs: number,
    nowMs: number = Date.now(),
  ) => {
    const AUTH_TIME_SKEW_SECONDS = 120;
    const authTime = claims?.auth_time;
    if (typeof authTime !== 'number' || !Number.isFinite(authTime)) {
      return { ok: false, reason: 'auth_time_missing' };
    }
    const nowSeconds = Math.floor(nowMs / 1000);
    const startedAtSeconds = Math.floor(startedAtMs / 1000);
    if (authTime > nowSeconds + AUTH_TIME_SKEW_SECONDS) {
      return { ok: false, reason: 'auth_time_future' };
    }
    if (authTime < startedAtSeconds - AUTH_TIME_SKEW_SECONDS) {
      return { ok: false, reason: 'auth_time_stale' };
    }
    return { ok: true };
  }),
  // Real logic (not a stub), same reasoning as above: this is the conversion
  // that puts the session's created_at on the same clock as the id_token's
  // auth_time. A stub returning `undefined` would make the freshness bound
  // NaN-ish and the timezone test below meaningless.
  //
  // Wrapped in vi.fn() so the CALL ITSELF is observable. Every value-based
  // assertion about this conversion is vacuous under TZ=UTC — the offset is 0,
  // so the converted bound and a naive `.getTime()` are the SAME number and a
  // reverted call site still passes. That is exactly how the missing conversion
  // shipped past a green (UTC) CI run. Asserting that the route CALLED this,
  // with the session's own createdAt, has teeth in every host timezone.
  utcMsFromOffsetlessTimestamp: vi.fn((value: Date) =>
    value.getTime() - value.getTimezoneOffset() * 60_000),
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
  // The reauth callback re-checks the initiating refresh family is still live
  // via validateSessionBinding. Default: healthy + far-future, so only the
  // dedicated revocation test sees a dead one.
  getRefreshFamily: vi.fn().mockResolvedValue({
    revokedAt: null,
    absoluteExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  }),
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

// The reauth callback's ONLY output on success. Mocked so the suite can assert
// the exact bind (userId/operation/epochs/sid) and prove the grant is never
// minted on any rejection path.
vi.mock('../services/mfaStepUpGrant', () => ({
  mintStepUpGrant: vi.fn()
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
import { createTokenPair, getRefreshFamily, getUserEpochs, rateLimiter } from '../services';
import {
  assertFreshIdpAuthentication,
  exchangeCodeForTokens,
  getUserInfo,
  mapUserAttributes,
  utcMsFromOffsetlessTimestamp,
  verifyIdTokenSignature,
} from '../services/sso';
import { mintStepUpGrant } from '../services/mfaStepUpGrant';
import { writeRouteAudit } from '../services/auditEvents';
import { authMiddleware } from '../middleware/auth';
import { pgOffsetlessTimestamp } from '../testUtils/pgOffsetlessTimestamp';

const USER_ID = '00000000-0000-4000-8000-000000000020';
const OTHER_USER_ID = '00000000-0000-4000-8000-0000000000aa';
const PROVIDER_ID = '00000000-0000-4000-8000-000000000001';
const ORG_ID = '00000000-0000-4000-8000-000000000010';
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
    const insertedArg = insertValues.mock.calls[0]![0];
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

// ══════════════════════════════════════════════════════════════════════════
// #4018 Task 4: GET /sso/callback — reauth mode.
//
// A passwordless SSO user who has just proved identity through a FORCED IdP
// round-trip (`prompt=login&max_age=0`, stamped by POST /sso/reauth/start) is
// handed a single-use step-up grant so they can enroll a FIRST MFA factor.
//
// The branch sits after the full id_token signature/nonce verification, the
// atomic session claim and the userinfo `sub` cross-check — the same position
// link mode occupies — and it mints NO login tokens, creates NO users and
// links NO identities. Everything below exists to keep it that way.
// ══════════════════════════════════════════════════════════════════════════
describe('GET /sso/callback — reauth mode (#4018)', () => {
  let app: Hono;

  const EXTERNAL_ID = 'external-user-1';

  const sel = (rows: unknown[]) => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) })
    })
  } as any);

  const ACTIVE_REAUTH_USER = {
    id: USER_ID,
    email: 'tech@acme.example',
    name: 'Tech',
    status: 'active',
    orgId: null,
    passwordHash: null,
  };

  const secondsAgo = (n: number) => Math.floor(Date.now() / 1000) - n;

  // Primes ONE reauth callback round-trip. db.select is consumed in exactly
  // this order by the branch under test:
  //   1. ssoProviders           (callback: provider by id)
  //   2. users                  (validateSessionBinding: the bound user)
  //   3. organizationUsers      (validateSessionBinding: org-axis membership)
  //   4. userSsoIdentities      (reauth branch: (provider, sub) ownership)
  // Every test funnels through here so that ordering lives in one place.
  const primeReauthCallback = (opts: {
    // A TRUE epoch. It is deliberately not a Date: the row's created_at is
    // built from it via pgOffsetlessTimestamp so that every test in this suite
    // sees the session exactly as postgres.js delivers it from a `timestamp
    // without time zone` column, rather than the true-instant Date a hand-rolled
    // `new Date(...)` would produce. Handing in a Date here is what let the
    // freshness bound be compared on the wrong clock with the suite still green.
    sessionCreatedAtMs?: number;
    idClaims?: Record<string, unknown>;
    sessionOverrides?: Record<string, unknown>;
    // undefined = healthy user; null = simulate "user gone" (no row).
    reauthUser?: Record<string, unknown> | null;
    // undefined = live membership row; [] = membership lost.
    membership?: unknown[];
    // undefined = the identity belongs to the reauth user; [] = no identity.
    identityRows?: Array<{ userId: string }>;
    provider?: Record<string, unknown>;
  } = {}) => {
    const {
      sessionCreatedAtMs = Date.now(),
      sessionOverrides = {},
      reauthUser = ACTIVE_REAUTH_USER,
      membership = [{ userId: USER_ID }],
      identityRows = [{ userId: USER_ID }],
      provider = ACTIVE_OIDC_PROVIDER,
    } = opts;
    const idClaims = opts.idClaims ?? {
      sub: EXTERNAL_ID,
      email: 'tech@acme.example',
      auth_time: secondsAgo(5),
    };

    vi.mocked(exchangeCodeForTokens).mockResolvedValue({
      access_token: 'a', refresh_token: 'r', expires_in: 3600, id_token: 'h.p.s'
    } as any);
    vi.mocked(verifyIdTokenSignature).mockResolvedValue(idClaims as any);
    vi.mocked(getUserInfo).mockResolvedValue({
      sub: EXTERNAL_ID, email: 'tech@acme.example', name: 'Tech'
    } as any);
    vi.mocked(mapUserAttributes).mockReturnValue({
      email: 'tech@acme.example', name: 'Tech'
    } as any);

    const session = {
      id: 'sso-session-reauth',
      providerId: PROVIDER_ID,
      state: 'state',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      redirectUrl: '/settings/profile',
      linkUserId: null,
      reauthUserId: USER_ID,
      providerVersion: 7,
      initiatingAuthEpoch: 3,
      initiatingMfaEpoch: 1,
      initiatingSessionId: SID,
      createdAt: pgOffsetlessTimestamp(sessionCreatedAtMs),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      ...sessionOverrides,
    };

    vi.mocked(db.delete).mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([session])
      })
    } as any);

    vi.mocked(db.select)
      .mockReturnValueOnce(sel([provider]))
      .mockReturnValueOnce(sel(reauthUser ? [reauthUser] : []))
      .mockReturnValueOnce(sel(membership))
      .mockReturnValueOnce(sel(identityRows));

    return { session, idClaims };
  };

  const doCallback = () => app.request('/sso/callback?code=oidc-code&state=state', {
    method: 'GET',
    headers: { cookie: ssoStateCookieHeader('state') }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset().mockReturnValue(sel([]));
    vi.mocked(db.insert).mockReset().mockReturnValue({
      values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) }))
    } as any);
    vi.mocked(db.delete).mockReset().mockReturnValue({
      where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) }))
    } as any);
    vi.mocked(getUserEpochs).mockReset().mockResolvedValue({ authEpoch: 3, mfaEpoch: 1 } as any);
    vi.mocked(getRefreshFamily).mockReset().mockResolvedValue({
      revokedAt: null,
      absoluteExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    } as any);
    vi.mocked(mintStepUpGrant).mockReset().mockResolvedValue('grant-abc');
    process.env.APP_ENCRYPTION_KEY = SSO_STATE_COOKIE_SECRET;
    app = new Hono();
    app.route('/sso', ssoRoutes);
  });

  // ── Freshness: the IdP must have ACTUALLY re-authenticated ───────────────

  it('rejects when the id_token has no auth_time (fails closed)', async () => {
    primeReauthCallback({ idClaims: { sub: EXTERNAL_ID, email: 'tech@acme.example' } });

    const res = await doCallback();

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('ssoReauthError=reauth_not_fresh');
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('rejects a stale auth_time — the IdP replayed a cached session', async () => {
    primeReauthCallback({
      idClaims: { sub: EXTERNAL_ID, email: 'tech@acme.example', auth_time: secondsAgo(3600) }
    });

    const res = await doCallback();

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('ssoReauthError=reauth_not_fresh');
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  // The load-bearing half of the freshness contract: the lower bound is the
  // sso_sessions row's own created_at, NOT a window measured from now. An
  // authentication that predates the user's click is a cached session however
  // recent it looks in wall-clock terms — this pair discriminates the two
  // (both auth_times below are comfortably "recent", only one post-dates the
  // click), and the call-argument assertion pins the contract exactly.
  it('bounds freshness from the session created_at, not from now (accepts an auth_time after the click)', async () => {
    const sessionCreatedAtMs = Date.now() - 9 * 60 * 1000;
    const { idClaims } = primeReauthCallback({
      sessionCreatedAtMs,
      idClaims: { sub: EXTERNAL_ID, email: 'tech@acme.example', auth_time: secondsAgo(30) }
    });

    const res = await doCallback();

    // The TRUE epoch of the click — not `createdAt.getTime()`, which is that
    // epoch plus the host's UTC offset (see the timezone test below).
    expect(assertFreshIdpAuthentication).toHaveBeenCalledWith(idClaims, sessionCreatedAtMs);
    expect(res.headers.get('location')).toBe('/settings/profile#ssoReauthGrant=grant-abc');
  });

  it('bounds freshness from the session created_at, not from now (rejects an auth_time that predates the click)', async () => {
    const sessionCreatedAtMs = Date.now() - 9 * 60 * 1000;
    primeReauthCallback({
      sessionCreatedAtMs,
      idClaims: {
        sub: EXTERNAL_ID,
        email: 'tech@acme.example',
        // ~14 minutes ago: still "recent" by any now-relative window, but it
        // predates the /reauth/start click by 5 minutes.
        auth_time: Math.floor(sessionCreatedAtMs / 1000) - 300,
      }
    });

    const res = await doCallback();

    expect(res.headers.get('location')).toContain('ssoReauthError=reauth_not_fresh');
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  // sso_sessions.created_at is `timestamp without time zone`, and postgres.js
  // parses an offsetless value as LOCAL time — so `createdAt.getTime()` is the
  // true epoch plus the HOST's UTC offset, while the id_token's auth_time is a
  // true UTC epoch. Comparing the two directly is dead on arrival west of UTC
  // (bound lands in the future, every attempt reads stale) and silently
  // permissive east of it (window widens by the offset, so a cached IdP session
  // that old is accepted as fresh).
  //
  // This test is the reason the fixture takes an epoch rather than a Date: it
  // only has teeth when the session row is built the way the driver builds it.
  //
  // It is deliberately NOT written as an arithmetic comparison of the bound
  // against `createdAt.getTime()`. Under TZ=UTC the host offset is zero, so
  // those two numbers are identical and every such assertion passes with or
  // without the conversion — which is exactly how this shipped past a green CI
  // run on UTC runners. The load-bearing assertions here are therefore about
  // the CALL: the route must hand the raw `createdAt` Date to
  // utcMsFromOffsetlessTimestamp and use that function's return value as the
  // bound. Deleting the conversion at the call site fails this in every
  // timezone, UTC included.
  it('compares auth_time against the click on the SAME clock, whatever the host timezone', async () => {
    const sessionCreatedAtMs = Date.now() - 60_000;
    const { session } = primeReauthCallback({
      sessionCreatedAtMs,
      // 30s after the click: unambiguously fresh on a correct clock.
      idClaims: { sub: EXTERNAL_ID, email: 'tech@acme.example', auth_time: Math.floor(sessionCreatedAtMs / 1000) + 30 }
    });

    const res = await doCallback();

    // TZ-independent teeth #1: the conversion ran, on the session's OWN
    // created_at Date (not on `Date.now()`, not on a pre-converted number).
    expect(utcMsFromOffsetlessTimestamp).toHaveBeenCalledWith(session.createdAt);

    const [, boundMs] = vi.mocked(assertFreshIdpAuthentication).mock.calls.at(-1)!;
    // TZ-independent teeth #2: the bound the freshness check received is the
    // value that conversion RETURNED — so the two calls are wired together
    // rather than coincidentally agreeing on a UTC host.
    const converted = vi.mocked(utcMsFromOffsetlessTimestamp).mock.results.at(-1)!;
    expect(converted.type).toBe('return');
    expect(boundMs).toBe(converted.value);

    // And, on a correct clock, that bound is the true epoch of the click.
    expect(boundMs).toBe(sessionCreatedAtMs);
    expect(session.createdAt.getTime() - boundMs).toBe(session.createdAt.getTimezoneOffset() * 60_000);

    expect(assertFreshIdpAuthentication).toHaveLastReturnedWith({ ok: true });
    expect(res.headers.get('location')).toBe('/settings/profile#ssoReauthGrant=grant-abc');
  });

  // ── Identity: stricter than link mode's email comparison ─────────────────

  it('rejects when the asserted sub belongs to a different user', async () => {
    // Same asserted email as the reauth user — an email comparison (link
    // mode's rule) would WAVE THIS THROUGH. Only (providerId, externalSub)
    // ownership catches it.
    primeReauthCallback({ identityRows: [{ userId: OTHER_USER_ID }] });

    const res = await doCallback();

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('ssoReauthError=identity_mismatch');
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('rejects when the asserted sub has no identity row at all (never creates one)', async () => {
    primeReauthCallback({ identityRows: [] });

    const res = await doCallback();

    expect(res.headers.get('location')).toContain('ssoReauthError=identity_mismatch');
    expect(mintStepUpGrant).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  // ── Binding: live re-check of the /reauth/start snapshot ─────────────────

  it('rejects when the initiating session was revoked since /reauth/start', async () => {
    primeReauthCallback();
    vi.mocked(getRefreshFamily).mockResolvedValueOnce({
      revokedAt: new Date(),
      absoluteExpiresAt: new Date(Date.now() + 1e9),
    } as any);

    const res = await doCallback();

    expect(res.headers.get('location')).toContain('ssoReauthError=session_invalid');
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('rejects an auth-epoch bump since /reauth/start', async () => {
    primeReauthCallback();
    vi.mocked(getUserEpochs).mockResolvedValueOnce({ authEpoch: 4, mfaEpoch: 1 } as any);

    const res = await doCallback();

    expect(res.headers.get('location')).toContain('ssoReauthError=session_invalid');
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('rejects an mfa-epoch bump since /reauth/start', async () => {
    primeReauthCallback();
    vi.mocked(getUserEpochs).mockResolvedValueOnce({ authEpoch: 3, mfaEpoch: 2 } as any);

    const res = await doCallback();

    expect(res.headers.get('location')).toContain('ssoReauthError=session_invalid');
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('rejects a suspended user', async () => {
    primeReauthCallback({ reauthUser: { ...ACTIVE_REAUTH_USER, status: 'suspended' } });

    const res = await doCallback();

    expect(res.headers.get('location')).toContain('ssoReauthError=session_invalid');
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('rejects lost org-axis membership since /reauth/start', async () => {
    primeReauthCallback({ membership: [] });

    const res = await doCallback();

    expect(res.headers.get('location')).toContain('ssoReauthError=session_invalid');
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('rejects a NULL binding column — pre-deploy row', async () => {
    primeReauthCallback({ sessionOverrides: { initiatingSessionId: null } });

    const res = await doCallback();

    expect(res.headers.get('location')).toContain('ssoReauthError=session_invalid');
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  // ── Belt-and-braces: a password set mid-flight ───────────────────────────

  it('rejects when a password was set between /reauth/start and the callback', async () => {
    primeReauthCallback({ reauthUser: { ...ACTIVE_REAUTH_USER, passwordHash: 'argon2id$...' } });

    const res = await doCallback();

    expect(res.headers.get('location')).toContain('ssoReauthError=password_set');
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  // ── Success ──────────────────────────────────────────────────────────────

  it('mints an enroll_first_factor grant and redirects with it in the fragment', async () => {
    primeReauthCallback();

    const res = await doCallback();

    expect(mintStepUpGrant).toHaveBeenCalledWith({
      userId: USER_ID,
      operation: 'enroll_first_factor',
      authEpoch: 3,
      mfaEpoch: 1,
      sid: SID,
    });
    expect(res.status).toBe(302);
    // Fragment, not query: never sent to the server, never in an access log.
    expect(res.headers.get('location')).toBe('/settings/profile#ssoReauthGrant=grant-abc');
    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'sso.reauth.completed' })
    );
  });

  it('fails closed with reauth_unavailable when the grant cannot be minted (Redis down)', async () => {
    primeReauthCallback();
    vi.mocked(mintStepUpGrant).mockResolvedValueOnce(null);

    const res = await doCallback();

    expect(res.headers.get('location')).toBe('/settings/profile?ssoReauthError=reauth_unavailable');
  });

  // A mint failure is an INFRASTRUCTURE outcome, not a user decision. Without a
  // terminal audit row a Redis outage looks exactly like the user closing the
  // IdP tab: `sso.reauth.started` and then nothing. Every other terminal
  // outcome on this road writes one.
  it('audits a mint failure as grant_mint_failed rather than going silent', async () => {
    primeReauthCallback();
    vi.mocked(mintStepUpGrant).mockResolvedValueOnce(null);

    await doCallback();

    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'sso.reauth.rejected',
        result: 'denied',
        details: expect.objectContaining({ mode: 'reauth', reason: 'grant_mint_failed', userId: USER_ID }),
      })
    );
    expect(writeRouteAudit).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'sso.reauth.completed' })
    );
  });

  // ── Reauth is NOT a login: failures stay on /settings/profile ────────────
  //
  // Both sites below used to discriminate on `callbackMode === 'link'`, which
  // drops reauth into the login-mode `else`. An already-signed-in user
  // re-authenticating was then redirected to /login with SSO-LOGIN copy, on a
  // page whose error handler for these codes does not exist. The generation
  // site is live in normal operation: `config_version` bumps on ANY provider
  // edit — including this feature's own trustsIdpMfa toggle — and a bump inside
  // the 10-minute state TTL lands here.

  it('keeps a config_version bump mid-flight on the profile page, namespaced', async () => {
    // Session snapshot 7 vs a provider the admin has since edited to 8.
    primeReauthCallback({ provider: { ...ACTIVE_OIDC_PROVIDER, configVersion: 8 } });

    const res = await doCallback();

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/settings/profile?ssoReauthError=config_changed');
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('keeps a disabled provider on the profile page, namespaced', async () => {
    primeReauthCallback({ provider: { ...ACTIVE_OIDC_PROVIDER, status: 'inactive' } });

    const res = await doCallback();

    expect(res.headers.get('location')).toBe('/settings/profile?ssoReauthError=provider_inactive');
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('keeps an email_verified=false assertion on the profile page, namespaced', async () => {
    primeReauthCallback({
      idClaims: {
        sub: EXTERNAL_ID,
        email: 'tech@acme.example',
        email_verified: false,
        auth_time: secondsAgo(5),
      }
    });

    const res = await doCallback();

    expect(res.headers.get('location')).toBe('/settings/profile?ssoReauthError=email_unverified');
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  // Pins the CURRENT mint-site contract, deliberately without changing it.
  // Neither /sso/reauth/start nor this callback consults userIsMfaProtected, so
  // a passwordless account that already holds TOTP still gets a live grant; only
  // resolveEnrollmentStepUp refuses to spend it. That is safe today because
  // there is exactly one redemption site. A SECOND redemption site added later
  // would inherit a grant that should never have existed — this test is here so
  // that change has to be deliberate.
  it('mints even for an already-protected account: the refusal lives at redemption, not here', async () => {
    primeReauthCallback({
      reauthUser: { ...ACTIVE_REAUTH_USER, mfaEnabled: true },
    });

    const res = await doCallback();

    expect(mintStepUpGrant).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, operation: 'enroll_first_factor' })
    );
    expect(res.headers.get('location')).toBe('/settings/profile#ssoReauthGrant=grant-abc');
  });

  it('never mints login tokens, creates users, or links identities in reauth mode', async () => {
    primeReauthCallback();

    const res = await doCallback();

    expect(res.headers.get('location')).toBe('/settings/profile#ssoReauthGrant=grant-abc');
    expect(createTokenPair).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
});
