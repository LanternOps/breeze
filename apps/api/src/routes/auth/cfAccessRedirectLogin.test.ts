import { beforeEach, describe, expect, it, vi } from 'vitest';

const envState = vi.hoisted(() => ({
  enabled: false,
  teamDomain: 'your-team.cloudflareaccess.com',
  audience: 'aud-app-1234567890abcdef',
  trustsMfa: false,
}));

vi.mock('../../config/env', () => ({
  cfAccessTrustEnabled: () => envState.enabled,
  cfAccessTeamDomain: () => envState.teamDomain,
  cfAccessAud: () => envState.audience,
  cfAccessTrustsMfa: () => envState.trustsMfa,
}));

const verifyState = vi.hoisted(() => ({
  next: undefined as
    | { kind: 'claims'; claims: Record<string, unknown> }
    | { kind: 'invalid'; code?: string }
    | { kind: 'jwks-unavailable' }
    | undefined,
}));

vi.mock('../../services/cfAccessJwt', async () => {
  const actual = await vi.importActual<typeof import('../../services/cfAccessJwt')>(
    '../../services/cfAccessJwt'
  );
  return {
    ...actual,
    verifyCfAccessJwt: vi.fn(async () => {
      const v = verifyState.next;
      verifyState.next = undefined;
      if (!v) throw new actual.CfAccessInvalidTokenError('no verifier setup');
      if (v.kind === 'claims') return v.claims;
      if (v.kind === 'invalid') throw new actual.CfAccessInvalidTokenError('invalid', v.code);
      throw new actual.CfAccessJwksUnavailableError('jwks down');
    }),
  };
});

const dbState = vi.hoisted(() => ({
  userRow: null as Record<string, unknown> | null,
}));

vi.mock('../../db', () => {
  function makeChain(row: Record<string, unknown> | null) {
    const rows = row ? [row] : [];
    const limit = vi.fn(async () => rows);
    const where = vi.fn(() => {
      const thenable = Promise.resolve(rows) as Promise<unknown[]> & { limit: typeof limit };
      thenable.limit = limit;
      return thenable;
    });
    const from = vi.fn(() => ({ where, limit }));
    return { from };
  }
  return {
    withDbAccessContext: vi.fn(async (_c: unknown, fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
    runOutsideDbContext: vi.fn(async (fn: () => unknown) => fn()),
    db: {
      select: vi.fn(() => makeChain(dbState.userRow)),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve()),
        })),
      })),
    },
  };
});

const servicesState = vi.hoisted(() => ({
  lastTokenPayload: null as Record<string, unknown> | null,
  lastTokenOptions: null as Record<string, unknown> | null,
  verifyResult: null as Record<string, unknown> | null,
  mintCalls: [] as string[],
  bindCalls: [] as Array<{ jti: string; familyId: string }>,
  revokeAllCalls: [] as string[],
  revokeJtiCalls: [] as string[],
}));

vi.mock('../../services', () => ({
  createTokenPair: vi.fn(
    async (payload: Record<string, unknown>, options?: Record<string, unknown>) => {
      servicesState.lastTokenPayload = payload;
      servicesState.lastTokenOptions = options ?? null;
      return {
        accessToken: 'access-tok',
        refreshToken: 'refresh-tok',
        refreshJti: 'jti-new',
        expiresInSeconds: 900,
      };
    }
  ),
  mintRefreshTokenFamily: vi.fn(async (userId: string) => {
    servicesState.mintCalls.push(userId);
    return 'fam-1';
  }),
  bindRefreshJtiToFamily: vi.fn(async (jti: string, familyId: string) => {
    servicesState.bindCalls.push({ jti, familyId });
  }),
  revokeAllUserTokens: vi.fn(async (userId: string) => {
    servicesState.revokeAllCalls.push(userId);
  }),
  revokeRefreshTokenJti: vi.fn(async (jti: string) => {
    servicesState.revokeJtiCalls.push(jti);
    return true;
  }),
  verifyToken: vi.fn(async () => servicesState.verifyResult),
}));

const auditState = vi.hoisted(() => ({
  audits: [] as Array<Record<string, unknown>>,
  loginFailures: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../services/auditService', () => ({
  createAuditLogAsync: vi.fn((entry: Record<string, unknown>) => {
    auditState.audits.push(entry);
  }),
}));

const cookieState = vi.hoisted(() => ({ set: null as string | null, cleared: false }));

vi.mock('./helpers', async () => {
  const actual = await vi.importActual<typeof import('./helpers')>('./helpers');
  return {
    ...actual,
    auditUserLoginFailure: vi.fn((_c: unknown, entry: Record<string, unknown>) => {
      auditState.loginFailures.push(entry);
    }),
    resolveCurrentUserTokenContext: vi.fn(async () => ({
      roleId: 'role-1',
      partnerId: 'partner-1',
      orgId: null as string | null,
      scope: 'partner' as const,
    })),
    setRefreshTokenCookie: vi.fn((c: unknown, refreshToken: string) => {
      void c;
      cookieState.set = refreshToken;
    }),
    clearRefreshTokenCookie: vi.fn((c: unknown) => {
      void c;
      cookieState.set = null;
      cookieState.cleared = true;
    }),
    getClientIP: () => '127.0.0.1',
  };
});

vi.mock('./schemas', async () => {
  const actual = await vi.importActual<typeof import('./schemas')>('./schemas');
  return { ...actual, ENABLE_2FA: true };
});

import { cfAccessRedirectLoginRoutes } from './cfAccessRedirectLogin';

const activeUser = {
  id: 'user-1',
  email: 'user@example.com',
  name: 'Billy Dunn',
  status: 'active',
  passwordHash: 'argon2hash',
  mfaEnabled: false,
  mfaSecret: null,
  mfaMethod: null,
  phoneNumber: null,
  avatarUrl: null,
  setupCompletedAt: new Date(),
  preferences: null,
  lastLoginAt: null,
};

async function callGet(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return cfAccessRedirectLoginRoutes.request(url, { method: 'GET', headers });
}

describe('GET /cf-access-login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envState.enabled = false;
    envState.teamDomain = 'your-team.cloudflareaccess.com';
    envState.audience = 'aud-app-1234567890abcdef';
    envState.trustsMfa = false;
    verifyState.next = undefined;
    dbState.userRow = null;
    auditState.audits = [];
    auditState.loginFailures = [];
    cookieState.set = null;
    cookieState.cleared = false;
    servicesState.lastTokenPayload = null;
    servicesState.lastTokenOptions = null;
    servicesState.verifyResult = null;
    servicesState.mintCalls = [];
    servicesState.bindCalls = [];
    servicesState.revokeAllCalls = [];
    servicesState.revokeJtiCalls = [];
    delete process.env.DASHBOARD_URL;
    delete process.env.PUBLIC_APP_URL;
  });

  it('redirects to /login with error=disabled when trust is off', async () => {
    envState.enabled = false;
    const res = await callGet('/cf-access-login', { 'Cf-Access-Jwt-Assertion': 'tok' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('/login?');
    expect(res.headers.get('Location')).toContain('reason=disabled');
  });

  it('redirects to /login with error=no-jwt when header missing', async () => {
    envState.enabled = true;
    const res = await callGet('/cf-access-login');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('reason=no-jwt');
  });

  it('redirects to /login with error=misconfigured when team domain absent', async () => {
    envState.enabled = true;
    envState.teamDomain = '';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await callGet('/cf-access-login', { 'Cf-Access-Jwt-Assertion': 'tok' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('reason=misconfigured');
    errSpy.mockRestore();
  });

  it('redirects to /login with error=invalid-jwt when verifier rejects token', async () => {
    envState.enabled = true;
    verifyState.next = { kind: 'invalid', code: 'ERR_JWT_EXPIRED' };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await callGet('/cf-access-login', { 'Cf-Access-Jwt-Assertion': 'tok' });
    expect(res.headers.get('Location')).toContain('reason=invalid-jwt');
    warnSpy.mockRestore();
  });

  it('redirects to /login with error=jwks-unavailable on JWKS network error', async () => {
    envState.enabled = true;
    verifyState.next = { kind: 'jwks-unavailable' };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await callGet('/cf-access-login', { 'Cf-Access-Jwt-Assertion': 'tok' });
    expect(res.headers.get('Location')).toContain('reason=jwks-unavailable');
    errSpy.mockRestore();
  });

  it('redirects to /login with error=no-user when JWT email does not match a Breeze user', async () => {
    envState.enabled = true;
    verifyState.next = {
      kind: 'claims',
      claims: {
        email: 'ghost@nowhere.test',
        sub: 'cf-1',
        aud: envState.audience,
        iss: `https://${envState.teamDomain}`,
        exp: 999,
        iat: 1,
      },
    };
    dbState.userRow = null;
    const res = await callGet('/cf-access-login', { 'Cf-Access-Jwt-Assertion': 'tok' });
    expect(res.headers.get('Location')).toContain('reason=no-user');
  });

  it('redirects to /login with error=mfa-required when user has MFA and TRUSTS_MFA is false', async () => {
    envState.enabled = true;
    envState.trustsMfa = false;
    verifyState.next = {
      kind: 'claims',
      claims: {
        email: activeUser.email,
        sub: 'cf-1',
        aud: envState.audience,
        iss: `https://${envState.teamDomain}`,
        exp: 999,
        iat: 1,
      },
    };
    dbState.userRow = { ...activeUser, mfaEnabled: true, mfaSecret: 'encrypted', mfaMethod: 'totp' };
    const res = await callGet('/cf-access-login', { 'Cf-Access-Jwt-Assertion': 'tok' });
    expect(res.headers.get('Location')).toContain('reason=mfa-required');
  });

  it('redirects to /login with error=mfa-required when user has passkey MFA and TRUSTS_MFA is false', async () => {
    envState.enabled = true;
    envState.trustsMfa = false;
    verifyState.next = {
      kind: 'claims',
      claims: {
        email: activeUser.email,
        sub: 'cf-1',
        aud: envState.audience,
        iss: `https://${envState.teamDomain}`,
        exp: 999,
        iat: 1,
      },
    };
    dbState.userRow = { ...activeUser, mfaEnabled: true, mfaSecret: null, mfaMethod: 'passkey' };
    const res = await callGet('/cf-access-login', { 'Cf-Access-Jwt-Assertion': 'tok' });
    expect(res.headers.get('Location')).toContain('reason=mfa-required');
  });

  it('mints a session and redirects to / with cf-access-login=success on success', async () => {
    envState.enabled = true;
    verifyState.next = {
      kind: 'claims',
      claims: {
        email: activeUser.email,
        sub: 'cf-1',
        aud: envState.audience,
        iss: `https://${envState.teamDomain}`,
        exp: 999,
        iat: 1,
      },
    };
    dbState.userRow = { ...activeUser };
    const res = await callGet('/cf-access-login', { 'Cf-Access-Jwt-Assertion': 'tok' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toMatch(/^\/\?cf-access-login=success$/);
    expect(cookieState.set).toBe('refresh-tok');
    expect(auditState.audits[0]).toMatchObject({
      action: 'user.login',
      details: expect.objectContaining({ method: 'cf_access_jwt_redirect' }),
    });
  });

  it('binds the minted refresh token to a fresh family (reuse-detection invariant)', async () => {
    envState.enabled = true;
    verifyState.next = {
      kind: 'claims',
      claims: {
        email: activeUser.email,
        sub: 'cf-1',
        aud: envState.audience,
        iss: `https://${envState.teamDomain}`,
        exp: 999,
        iat: 1,
      },
    };
    dbState.userRow = { ...activeUser };
    const res = await callGet('/cf-access-login', { 'Cf-Access-Jwt-Assertion': 'tok' });
    expect(res.status).toBe(302);
    // 1. A fresh family was minted for this user.
    expect(servicesState.mintCalls).toEqual([activeUser.id]);
    // 2. createTokenPair received the family id via refreshFam.
    expect(servicesState.lastTokenOptions).toMatchObject({ refreshFam: 'fam-1' });
    // 3. The minted refresh jti was bound to the family in Redis.
    expect(servicesState.bindCalls).toEqual([{ jti: 'jti-new', familyId: 'fam-1' }]);
  });

  it('preserves a safe next param and appends cf-access-login=success', async () => {
    envState.enabled = true;
    verifyState.next = {
      kind: 'claims',
      claims: {
        email: activeUser.email,
        sub: 'cf-1',
        aud: envState.audience,
        iss: `https://${envState.teamDomain}`,
        exp: 999,
        iat: 1,
      },
    };
    dbState.userRow = { ...activeUser };
    const res = await callGet('/cf-access-login?next=%2Fdevices', { 'Cf-Access-Jwt-Assertion': 'tok' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toMatch(/^\/devices\?cf-access-login=success$/);
  });

  it('logout endpoint chains app-domain + team-domain CF logouts ending at /login?signedOut=1', async () => {
    envState.enabled = true;
    const res = await cfAccessRedirectLoginRoutes.request('http://api.example/cf-access-logout', {
      method: 'GET',
      headers: { host: 'breeze.example.com' },
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get('Location') ?? '';
    // Outer hop is the app-domain logout.
    expect(loc.startsWith('https://breeze.example.com/cdn-cgi/access/logout?returnTo=')).toBe(true);
    // Inner hop (decoded once) is the team-domain logout.
    const innerEncoded = loc.split('returnTo=')[1] ?? '';
    const inner = decodeURIComponent(innerEncoded);
    expect(inner.startsWith(`https://${envState.teamDomain}/cdn-cgi/access/logout?returnTo=`)).toBe(true);
    // Innermost (decoded twice) is the SPA landing page.
    const finalEncoded = inner.split('returnTo=')[1] ?? '';
    expect(decodeURIComponent(finalEncoded)).toBe('https://breeze.example.com/login?signedOut=1');
    expect(cookieState.cleared).toBe(true);
  });

  it('logout endpoint falls back to /login?signedOut=1 when CF Access trust disabled', async () => {
    envState.enabled = false;
    const res = await cfAccessRedirectLoginRoutes.request('http://api.example/cf-access-logout', { method: 'GET' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login?signedOut=1');
    expect(cookieState.cleared).toBe(true);
  });

  it('logout revokes all user tokens + the refresh jti when a valid refresh cookie is present', async () => {
    envState.enabled = true;
    servicesState.verifyResult = { type: 'refresh', sub: 'user-1', jti: 'jti-current' };
    const res = await cfAccessRedirectLoginRoutes.request('http://api.example/cf-access-logout', {
      method: 'GET',
      headers: {
        host: 'breeze.example.com',
        cookie: 'breeze_refresh_token=refresh-cookie-tok',
      },
    });
    expect(res.status).toBe(302);
    expect(servicesState.revokeAllCalls).toEqual(['user-1']);
    expect(servicesState.revokeJtiCalls).toEqual(['jti-current']);
    expect(cookieState.cleared).toBe(true);
  });

  it('logout with no refresh cookie still clears + 302s without calling revocation', async () => {
    envState.enabled = true;
    const res = await cfAccessRedirectLoginRoutes.request('http://api.example/cf-access-logout', {
      method: 'GET',
      headers: { host: 'breeze.example.com' },
    });
    expect(res.status).toBe(302);
    expect(servicesState.revokeAllCalls).toEqual([]);
    expect(servicesState.revokeJtiCalls).toEqual([]);
    expect(cookieState.cleared).toBe(true);
  });

  it('logout with an invalid refresh cookie still clears + 302s (no 500)', async () => {
    envState.enabled = true;
    servicesState.verifyResult = null; // verifyToken rejects the cookie
    const res = await cfAccessRedirectLoginRoutes.request('http://api.example/cf-access-logout', {
      method: 'GET',
      headers: {
        host: 'breeze.example.com',
        cookie: 'breeze_refresh_token=garbage',
      },
    });
    expect(res.status).toBe(302);
    expect(servicesState.revokeAllCalls).toEqual([]);
    expect(servicesState.revokeJtiCalls).toEqual([]);
    expect(cookieState.cleared).toBe(true);
  });

  it('logout still clears + 302s when revocation throws (e.g. Redis down)', async () => {
    envState.enabled = true;
    servicesState.verifyResult = { type: 'refresh', sub: 'user-1', jti: 'jti-current' };
    const services = await import('../../services');
    vi.mocked(services.revokeAllUserTokens).mockRejectedValueOnce(new Error('redis down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await cfAccessRedirectLoginRoutes.request('http://api.example/cf-access-logout', {
      method: 'GET',
      headers: {
        host: 'breeze.example.com',
        cookie: 'breeze_refresh_token=refresh-cookie-tok',
      },
    });
    expect(res.status).toBe(302);
    expect(cookieState.cleared).toBe(true);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('logout builds the redirect origin from DASHBOARD_URL, ignoring a spoofed Host header', async () => {
    envState.enabled = true;
    process.env.DASHBOARD_URL = 'https://breeze.example.com';
    const res = await cfAccessRedirectLoginRoutes.request('http://api.example/cf-access-logout', {
      method: 'GET',
      headers: { host: 'evil.attacker.example' },
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get('Location') ?? '';
    expect(loc.startsWith('https://breeze.example.com/cdn-cgi/access/logout?returnTo=')).toBe(true);
    expect(loc).not.toContain('evil.attacker.example');
    const inner = decodeURIComponent(loc.split('returnTo=')[1] ?? '');
    const finalReturn = decodeURIComponent(inner.split('returnTo=')[1] ?? '');
    expect(finalReturn).toBe('https://breeze.example.com/login?signedOut=1');
  });

  it('logout falls back to PUBLIC_APP_URL when DASHBOARD_URL is unset', async () => {
    envState.enabled = true;
    process.env.PUBLIC_APP_URL = 'https://app.example.net/';
    const res = await cfAccessRedirectLoginRoutes.request('http://api.example/cf-access-logout', {
      method: 'GET',
      headers: { host: 'evil.attacker.example' },
    });
    const loc = res.headers.get('Location') ?? '';
    expect(loc.startsWith('https://app.example.net/cdn-cgi/access/logout?returnTo=')).toBe(true);
    expect(loc).not.toContain('evil.attacker.example');
  });

  it('logout falls back to https + Host only when neither env is set', async () => {
    envState.enabled = true;
    const res = await cfAccessRedirectLoginRoutes.request('http://api.example/cf-access-logout', {
      method: 'GET',
      headers: { host: 'breeze.example.com', 'x-forwarded-proto': 'http' },
    });
    const loc = res.headers.get('Location') ?? '';
    // Scheme is pinned to https even when the request claims otherwise.
    expect(loc.startsWith('https://breeze.example.com/cdn-cgi/access/logout?returnTo=')).toBe(true);
  });

  it('rejects an unsafe next param and falls back to /', async () => {
    envState.enabled = true;
    verifyState.next = {
      kind: 'claims',
      claims: {
        email: activeUser.email,
        sub: 'cf-1',
        aud: envState.audience,
        iss: `https://${envState.teamDomain}`,
        exp: 999,
        iat: 1,
      },
    };
    dbState.userRow = { ...activeUser };
    const res = await callGet('/cf-access-login?next=%2F%2Fevil.com', { 'Cf-Access-Jwt-Assertion': 'tok' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toMatch(/^\/\?cf-access-login=success$/);
  });
});
