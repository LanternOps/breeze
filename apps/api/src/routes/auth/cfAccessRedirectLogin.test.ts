import { beforeEach, describe, expect, it, vi } from 'vitest';

const envState = vi.hoisted(() => ({
  enabled: false,
  teamDomain: 'your-team.cloudflareaccess.com',
  audience: 'aud-app-1234567890abcdef',
  trustsMfa: false,
  publicOrigin: 'https://breeze.example.com' as string | null,
}));

vi.mock('../../config/env', async () => {
  const actual = await vi.importActual<typeof import('../../config/env')>('../../config/env');
  return {
    ...actual,
    cfAccessTrustEnabled: () => envState.enabled,
    cfAccessTeamDomain: () => envState.teamDomain,
    cfAccessAud: () => envState.audience,
    cfAccessTrustsMfa: () => envState.trustsMfa,
    authBrowserPublicOrigin: () => envState.publicOrigin,
  };
});

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
  pending: true,
  pendingCalls: [] as Array<Record<string, unknown>>,
  failure: null as Error | null,
}));

const issuanceState = vi.hoisted(() => ({
  beginCalls: [] as Array<Record<string, unknown>>,
  finishCalls: 0,
  cancelCalls: 0,
  beginFailure: null as Error | null,
  capability: {
    transitionId: '00000000-0000-4000-8000-000000000011',
    generation: 1,
    operationId: '00000000-0000-4000-8000-000000000012',
    expiresAt: new Date('2026-07-13T00:05:00Z'),
  } as Record<string, unknown>,
}));

vi.mock('../../services/authBrowserTransition', async () => {
  const actual = await vi.importActual<typeof import('../../services/authBrowserTransition')>(
    '../../services/authBrowserTransition'
  );
  return {
    ...actual,
    beginAuthIssuance: vi.fn(async (input: Record<string, unknown>) => {
      issuanceState.beginCalls.push(input);
      if (issuanceState.beginFailure) throw issuanceState.beginFailure;
      return issuanceState.capability;
    }),
    finishAuthIssuance: vi.fn(async (_capability: unknown, callback: (tx: unknown) => unknown) => {
      issuanceState.finishCalls += 1;
      return callback({
        update: vi.fn(() => ({
          set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
        })),
      });
    }),
    cancelAuthIssuance: vi.fn(async () => {
      issuanceState.cancelCalls += 1;
      return true;
    }),
    isTerminalLogoutPending: vi.fn(async (input: Record<string, unknown>) => {
      completionState.pendingCalls.push(input);
      return completionState.pending;
    }),
    completeTerminalLogout: vi.fn(async (input: Record<string, unknown>) => {
      completionState.calls.push(input);
      if (completionState.failure) throw completionState.failure;
      return completionState.results.shift() ?? {
        kind: 'completed',
        replacement: { kind: 'browser', value: 'b'.repeat(64) },
      };
    }),
  };
});

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
  updateCount: 0,
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
          where: vi.fn(() => {
            dbState.updateCount += 1;
            return Promise.resolve();
          }),
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
  bindIssuedUserSession: vi.fn(async () => undefined),
  issueUserSession: vi.fn(
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
    dbState.updateCount = 0;
    auditState.audits = [];
    auditState.loginFailures = [];
    cookieState.set = null;
    cookieState.cleared = false;
    cookieState.rotated = null;
    ticketState.valid = true;
    ticketState.calls = [];
    completionState.calls = [];
    completionState.results = [];
    completionState.pending = true;
    completionState.pendingCalls = [];
    completionState.failure = null;
    issuanceState.beginCalls = [];
    issuanceState.finishCalls = 0;
    issuanceState.cancelCalls = 0;
    issuanceState.beginFailure = null;
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

  it('does not mutate login authority when terminal logout already owns the binding', async () => {
    envState.enabled = true;
    verifyState.next = {
      kind: 'claims',
      claims: { email: 'user@example.com', sub: 'cf-subject' },
    };
    dbState.userRow = activeUser;
    issuanceState.beginFailure = new (
      await import('../../services/authBrowserTransition')
    ).AuthBindingUnavailableError('logout_pending');

    const res = await callGet('/cf-access-login', {
      'Cf-Access-Jwt-Assertion': 'tok',
      cookie: `breeze_csrf_token=${'a'.repeat(64)}`,
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('reason=unavailable');
    expect(issuanceState.beginCalls).toEqual([{
      kind: 'browser',
      value: 'a'.repeat(64),
    }]);
    expect(issuanceState.finishCalls).toBe(0);
    expect(servicesState.lastSessionIdentity).toBeNull();
    expect(dbState.updateCount).toBe(0);
    expect(cookieState.set).toBeNull();
    expect(auditState.audits).not.toContainEqual(expect.objectContaining({
      action: 'user.login',
      result: 'success',
    }));
  });

  it('preserves the replacement binding cookie on first-use bootstrap', async () => {
    envState.enabled = true;
    verifyState.next = {
      kind: 'claims',
      claims: { email: 'user@example.com', sub: 'cf-subject' },
    };
    dbState.userRow = activeUser;
    const { AuthBindingRotationRequiredError } = await import(
      '../../services/authBrowserTransition'
    );
    issuanceState.beginFailure = new AuthBindingRotationRequiredError({
      kind: 'browser',
      value: 'c'.repeat(64),
    }, 'missing');

    const res = await callGet('/cf-access-login', {
      'Cf-Access-Jwt-Assertion': 'tok',
    });

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/cf-access-login');
    expect(res.headers.get('set-cookie')).toContain(`breeze_csrf_token=${'c'.repeat(64)}`);
    expect(cookieState.set).toBeNull();
    expect(servicesState.lastSessionIdentity).toBeNull();
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
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(completionState.pendingCalls).toEqual([{
      transitionId: verifiedTicket.transitionId,
      logoutId: verifiedTicket.logoutId,
      generation: verifiedTicket.generation,
      nonce: verifiedTicket.nonce,
    }]);
  });

  it('rejects a consumed or old-generation signed ticket before quarantine or Cloudflare navigation', async () => {
    completionState.pending = false;

    const res = await callGet('/cf-access-logout?ticket=signed-ticket', {
      host: 'breeze.example.com',
    });

    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/login?signedOut=1&logoutError=1');
    expect(cookieState.cleared).toBe(false);
    expect(res.headers.get('Set-Cookie')).toBeNull();
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

  it.each([
    '',
    'https://team.cloudflareaccess.com',
    'team.cloudflareaccess.com/path',
    'team.cloudflareaccess.com:443',
    'team.cloudflareaccess.com?query=1',
    'team.cloudflareaccess.com#fragment',
    'team\\cloudflareaccess.com',
    ' team.cloudflareaccess.com',
    'team.cloudflareaccess.com ',
    'team .cloudflareaccess.com',
    'team\n.cloudflareaccess.com',
    'team..cloudflareaccess.com',
    '.team.cloudflareaccess.com',
    'team.cloudflareaccess.com.',
    '-team.cloudflareaccess.com',
    'team-.cloudflareaccess.com',
    'te_am.cloudflareaccess.com',
    `${'a'.repeat(64)}.cloudflareaccess.com`,
    Array.from({ length: 4 }, () => 'a'.repeat(63)).join('.'),
  ])('fails terminal navigation locally for malformed runtime team hostname %s', async (teamDomain) => {
    envState.enabled = true;
    envState.teamDomain = teamDomain;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await callGet('/cf-access-logout?ticket=signed-ticket', {
      cookie: 'breeze_refresh_token=newer-session',
    });

    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/login?signedOut=1&logoutError=1');
    expect(completionState.pendingCalls).toEqual([]);
    expect(completionState.calls).toEqual([]);
    expect(cookieState.cleared).toBe(false);
    expect(cookieState.rotated).toBeNull();
    expect(res.headers.get('Set-Cookie')).toBeNull();
    errorSpy.mockRestore();
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
    const cookies = res.headers.get('Set-Cookie') ?? '';
    expect(cookies).toContain('breeze_refresh_token=');
    expect(cookies).toContain(`breeze_csrf_token=${'b'.repeat(64)}`);
    expect(cookies).toContain(`SameSite=${sameSite}`);
    expect(auditState.audits.at(-1)).toMatchObject({
      action: 'auth.cf_access_terminal_logout.complete',
      actorType: 'system',
      actorId: verifiedTicket.transitionId,
      result: 'success',
      details: {
        transitionId: verifiedTicket.transitionId,
        logoutId: verifiedTicket.logoutId,
        result: 'completed',
        cleanupStatus: 'complete',
        refreshCookieClearCount: 1,
        bindingRotationCount: 1,
      },
    });
    const auditJson = JSON.stringify(auditState.audits.at(-1));
    expect(auditJson).not.toContain('signed-ticket');
    expect(auditJson).not.toContain(verifiedTicket.nonce);
    delete process.env.AUTH_COOKIE_SAME_SITE;
  });

  it('mutates cookies only once for concurrent completion and replay responses', async () => {
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
    expect(second.headers.get('Set-Cookie')).toBeNull();
  });

  it('duplicate top navigations cannot reinstall quarantine after successful completion', async () => {
    const firstTop = await callGet('/cf-access-logout?ticket=signed-ticket');
    const delayedSecondTop = await callGet('/cf-access-logout?ticket=signed-ticket');

    expect(firstTop.headers.get('Set-Cookie')).toBeNull();
    expect(delayedSecondTop.headers.get('Set-Cookie')).toBeNull();

    completionState.results = [
      { kind: 'completed', replacement: { kind: 'browser', value: 'c'.repeat(64) } },
      { kind: 'replayed', replacement: { kind: 'browser', value: 'c'.repeat(64) } },
    ];
    const completed = await callGet('/cf-access-logout/complete?ticket=signed-ticket');
    const replayed = await callGet('/cf-access-logout/complete?ticket=signed-ticket');

    expect(completed.headers.get('Set-Cookie')).not.toContain('breeze_cf_logout_quarantine');
    expect(replayed.headers.get('Set-Cookie')).toBeNull();
  });

  it('does not let a consumed ticket replay clear a newer refresh cookie or overwrite C3', async () => {
    completionState.results = [{
      kind: 'replayed',
      replacement: { kind: 'browser', value: 'c'.repeat(64) },
    }];

    const res = await callGet('/cf-access-logout/complete?ticket=signed-ticket', {
      cookie: `breeze_refresh_token=new-session; breeze_csrf_token=${'d'.repeat(64)}`,
    });

    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/login?signedOut=1');
    expect(cookieState.cleared).toBe(false);
    expect(cookieState.rotated).toBeNull();
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(auditState.audits.at(-1)).toMatchObject({
      action: 'auth.cf_access_terminal_logout.complete',
      result: 'success',
      details: expect.objectContaining({
        result: 'replayed',
        cleanupStatus: 'not-run',
        refreshCookieClearCount: 0,
        bindingRotationCount: 0,
      }),
    });
  });

  it('does not mutate cookies for an old-generation or otherwise invalid completion', async () => {
    completionState.results = [{ kind: 'invalid' }];

    const res = await callGet('/cf-access-logout/complete?ticket=signed-ticket');

    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/login?signedOut=1&logoutError=1');
    expect(cookieState.cleared).toBe(false);
    expect(cookieState.rotated).toBeNull();
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(auditState.audits.at(-1)).toMatchObject({
      action: 'auth.cf_access_terminal_logout.complete',
      result: 'denied',
      details: expect.objectContaining({ result: 'invalid', cleanupStatus: 'not-run' }),
    });
  });

  it('audits a durable completion failure without ticket, nonce, or binding values', async () => {
    completionState.failure = new Error('postgres unavailable');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await callGet('/cf-access-logout/complete?ticket=signed-ticket');

    expect(res.status).toBe(303);
    expect(auditState.audits.at(-1)).toMatchObject({
      action: 'auth.cf_access_terminal_logout.complete',
      result: 'failure',
      details: expect.objectContaining({
        transitionId: verifiedTicket.transitionId,
        logoutId: verifiedTicket.logoutId,
        result: 'failed',
        cleanupStatus: 'failed',
        refreshCookieClearCount: 0,
        bindingRotationCount: 0,
      }),
    });
    const auditJson = JSON.stringify(auditState.audits.at(-1));
    expect(auditJson).not.toContain('signed-ticket');
    expect(auditJson).not.toContain(verifiedTicket.nonce);
    expect(auditJson).not.toContain('b'.repeat(64));
    errorSpy.mockRestore();
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
