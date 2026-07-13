import { beforeEach, describe, expect, it, vi } from 'vitest';

const envState = vi.hoisted(() => ({
  enabled: false,
  teamDomain: 'your-team.cloudflareaccess.com',
  audience: 'aud-app-1234567890abcdef',
  trustsMfa: false,
  publicOrigin: 'https://breeze.example.com' as string | null,
}));

vi.mock('../../config/env', () => ({
  cfAccessTrustEnabled: () => envState.enabled,
  cfAccessTeamDomain: () => envState.teamDomain,
  cfAccessAud: () => envState.audience,
  cfAccessTrustsMfa: () => envState.trustsMfa,
  authBrowserPublicOrigin: () => envState.publicOrigin,
}));

const ticketState = vi.hoisted(() => ({
  valid: true,
  calls: [] as string[],
}));

const verifiedTicket = {
  version: 1 as const,
  audience: 'terminal-logout-completion' as const,
  transitionId: '00000000-0000-4000-8000-000000000001',
  logoutId: '00000000-0000-4000-8000-000000000002',
  generation: 2,
  nonce: 'a'.repeat(64),
  issuedAt: Date.parse('2026-07-13T00:00:00Z'),
  expiresAt: Date.parse('2026-07-13T00:10:00Z'),
  signingKeyId: 'key-1',
};

vi.mock('../../services/terminalLogoutTicket', () => ({
  verifyTerminalLogoutTicket: vi.fn((ticket: string) => {
    ticketState.calls.push(ticket);
    if (!ticketState.valid || ticket !== 'signed-ticket') throw new Error('invalid ticket');
    return verifiedTicket;
  }),
}));

const completionState = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  results: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../services/authBrowserTransition', () => ({
  completeTerminalLogout: vi.fn(async (input: Record<string, unknown>) => {
    completionState.calls.push(input);
    return completionState.results.shift() ?? {
      kind: 'completed',
      replacement: { kind: 'browser', value: 'b'.repeat(64) },
    };
  }),
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
  lastSessionIdentity: null as Record<string, unknown> | null,
  verifyResult: null as Record<string, unknown> | null,
  revokeAllCalls: [] as string[],
  revokeJtiCalls: [] as string[],
}));

vi.mock('../../services', () => ({
  issueUserSessionLegacyDuringTransition: vi.fn(
    async (identity: Record<string, unknown>) => {
      servicesState.lastSessionIdentity = identity;
      return {
        accessToken: 'access-tok',
        refreshToken: 'refresh-tok',
        refreshJti: 'jti-new',
        expiresInSeconds: 900,
        familyId: 'fam-1',
      };
    }
  ),
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

const cookieState = vi.hoisted(() => ({
  set: null as string | null,
  cleared: false,
  quarantineSet: false,
  quarantineCleared: false,
  rotated: null as string | null,
}));

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
      cookieState.set = null;
      cookieState.cleared = true;
      actual.clearRefreshTokenCookie(c as never);
    }),
    setCfAccessLogoutQuarantineCookie: vi.fn((c: unknown) => {
      cookieState.quarantineSet = true;
      actual.setCfAccessLogoutQuarantineCookie(c as never);
    }),
    clearCfAccessLogoutQuarantineCookie: vi.fn((c: unknown) => {
      cookieState.quarantineCleared = true;
      actual.clearCfAccessLogoutQuarantineCookie(c as never);
    }),
    rotateCsrfBindingCookie: vi.fn((c: unknown, value: string) => {
      cookieState.rotated = value;
      actual.rotateCsrfBindingCookie(c as never, value);
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
    envState.publicOrigin = 'https://breeze.example.com';
    verifyState.next = undefined;
    dbState.userRow = null;
    auditState.audits = [];
    auditState.loginFailures = [];
    cookieState.set = null;
    cookieState.cleared = false;
    cookieState.quarantineSet = false;
    cookieState.quarantineCleared = false;
    cookieState.rotated = null;
    ticketState.valid = true;
    ticketState.calls = [];
    completionState.calls = [];
    completionState.results = [];
    servicesState.lastSessionIdentity = null;
    servicesState.verifyResult = null;
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
        country: 'CA',
      },
    };
    dbState.userRow = { ...activeUser };
    const res = await callGet('/cf-access-login', { 'Cf-Access-Jwt-Assertion': 'tok' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toMatch(/^\/\?cf-access-login=success$/);
    expect(cookieState.set).toBe('refresh-tok');
    expect(auditState.audits[0]).toMatchObject({
      action: 'user.login',
      details: expect.objectContaining({
        method: 'cf_access_jwt_redirect',
        cfAccessCountry: 'CA',
      }),
    });
  });

  it('delegates the complete identity to the high-level session issuer', async () => {
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
    expect(servicesState.lastSessionIdentity).toMatchObject({
      userId: activeUser.id,
      email: activeUser.email,
      roleId: 'role-1',
      partnerId: 'partner-1',
      orgId: null,
      scope: 'partner',
      mfa: false,
      amr: ['cf_access'],
    });
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

  it.each([undefined, 'invalid-ticket'])('grants no authority to a missing or invalid ticket', async (ticket) => {
    envState.enabled = true;
    if (ticket) ticketState.valid = false;
    const query = ticket ? `?ticket=${ticket}` : '';
    const res = await cfAccessRedirectLoginRoutes.request(
      `http://api.example/cf-access-logout${query}`,
      { method: 'GET', headers: { host: 'evil.attacker.example', cookie: 'breeze_refresh_token=stale' } },
    );

    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/login?signedOut=1&logoutError=1');
    expect(completionState.calls).toEqual([]);
    expect(cookieState.cleared).toBe(false);
    expect(cookieState.quarantineSet).toBe(false);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('chains configured-origin Cloudflare logouts and carries the exact ticket to completion', async () => {
    envState.enabled = true;
    const res = await cfAccessRedirectLoginRoutes.request(
      'http://api.example/cf-access-logout?ticket=signed-ticket',
      { method: 'GET', headers: { host: 'evil.attacker.example' } },
    );

    expect(res.status).toBe(303);
    const location = res.headers.get('Location') ?? '';
    expect(location).toMatch(/^https:\/\/breeze\.example\.com\/cdn-cgi\/access\/logout\?returnTo=/);
    expect(location).not.toContain('evil.attacker.example');
    const teamLogout = decodeURIComponent(location.split('returnTo=')[1] ?? '');
    const finalReturn = decodeURIComponent(teamLogout.split('returnTo=')[1] ?? '');
    expect(finalReturn).toBe(
      'https://breeze.example.com/api/v1/auth/cf-access-logout/complete?ticket=signed-ticket',
    );
    expect(cookieState.cleared).toBe(false);
    expect(cookieState.quarantineSet).toBe(true);
  });

  it('never falls back to Host when the configured public origin is unavailable', async () => {
    envState.enabled = true;
    envState.publicOrigin = null;

    const res = await cfAccessRedirectLoginRoutes.request(
      'http://api.example/cf-access-logout?ticket=signed-ticket',
      { method: 'GET', headers: { host: 'evil.attacker.example' } },
    );

    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/login?signedOut=1&logoutError=1');
    expect(res.headers.get('Location')).not.toContain('evil.attacker.example');
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('carries a valid ticket directly to completion when Cloudflare trust is disabled', async () => {
    envState.enabled = false;
    const res = await callGet('/cf-access-logout?ticket=signed-ticket');

    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(
      'https://breeze.example.com/api/v1/auth/cf-access-logout/complete?ticket=signed-ticket',
    );
  });

  it.each(['Strict', 'Lax', 'None'])('completes cookie-less return with SameSite=%s cookies and rotates C1 to C2', async (sameSite) => {
    process.env.AUTH_COOKIE_SAME_SITE = sameSite;

    const res = await callGet('/cf-access-logout/complete?ticket=signed-ticket');

    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/login?signedOut=1');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(completionState.calls).toEqual([{
      transitionId: verifiedTicket.transitionId,
      logoutId: verifiedTicket.logoutId,
      generation: verifiedTicket.generation,
      nonce: verifiedTicket.nonce,
      signingKeyId: verifiedTicket.signingKeyId,
    }]);
    expect(cookieState.cleared).toBe(true);
    expect(cookieState.rotated).toBe('b'.repeat(64));
    expect(cookieState.quarantineCleared).toBe(true);
    const cookies = res.headers.get('Set-Cookie') ?? '';
    expect(cookies).toContain('breeze_refresh_token=');
    expect(cookies).toContain(`breeze_csrf_token=${'b'.repeat(64)}`);
    expect(cookies).toContain(`SameSite=${sameSite}`);
    delete process.env.AUTH_COOKIE_SAME_SITE;
  });

  it('returns the same C2 for concurrent completion and replay responses', async () => {
    completionState.results = [
      { kind: 'completed', replacement: { kind: 'browser', value: 'c'.repeat(64) } },
      { kind: 'replayed', replacement: { kind: 'browser', value: 'c'.repeat(64) } },
    ];

    const [first, second] = await Promise.all([
      callGet('/cf-access-logout/complete?ticket=signed-ticket'),
      callGet('/cf-access-logout/complete?ticket=signed-ticket'),
    ]);

    expect(first.status).toBe(303);
    expect(second.status).toBe(303);
    expect(first.headers.get('Set-Cookie')).toContain(`breeze_csrf_token=${'c'.repeat(64)}`);
    expect(second.headers.get('Set-Cookie')).toContain(`breeze_csrf_token=${'c'.repeat(64)}`);
  });

  it('does not mutate cookies for an old-generation or otherwise invalid completion', async () => {
    completionState.results = [{ kind: 'invalid' }];

    const res = await callGet('/cf-access-logout/complete?ticket=signed-ticket');

    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/login?signedOut=1&logoutError=1');
    expect(cookieState.cleared).toBe(false);
    expect(cookieState.rotated).toBeNull();
    expect(cookieState.quarantineCleared).toBe(false);
    expect(res.headers.get('Set-Cookie')).toBeNull();
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
