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
  // Read by the effective-MFA-policy resolver (kill switch for the role-force
  // axis). The resolver is mocked below, but keep the export honest.
  mfaForcePartnerAdmin: () => false,
}));

// Effective MFA policy (PR2's resolver). The redirect mint site consults it so
// an unenrolled user under a `required` policy can never be handed a vacuous
// mfa=true. Mocked at module level so the policy axis is independent of the
// user-row axis, and so an implementation set in one test can't leak into the
// next (the suite's beforeEach clears calls, not implementations).
const policyState = vi.hoisted(() => ({ required: false }));

vi.mock('../../services/mfaPolicy', () => ({
  getEffectiveMfaPolicy: vi.fn(async () => ({
    required: policyState.required,
    allowedMethods: { totp: true, sms: true, passkey: true },
    source: {
      roleForceMfa: false,
      settingsRequireMfa: policyState.required,
      killSwitchOff: false,
    },
  })),
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
  lastLoginUpdated: false,
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
  const db = {
    select: vi.fn(() => makeChain(dbState.userRow)),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          if (values.lastLoginAt) dbState.lastLoginUpdated = true;
        }),
      })),
    })),
  };
  return {
    withDbAccessContext: vi.fn(async (_c: unknown, fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
    runOutsideDbContext: vi.fn(async (fn: () => unknown) => fn()),
    db,
  };
});

const transitionState = vi.hoisted(() => {
  class AuthBindingRotationRequiredError extends Error {
    constructor(readonly replacement: { kind: 'browser'; value: string }) { super('rotation'); }
  }
  class AuthBindingUnavailableError extends Error {}
  class AuthIssuanceCapabilityError extends Error {}
  class AuthIssuanceConflictError extends Error {}
  return {
    AuthBindingRotationRequiredError,
    AuthBindingUnavailableError,
    AuthIssuanceCapabilityError,
    AuthIssuanceConflictError,
    beginError: null as Error | null,
    finishError: null as Error | null,
    enforcement: false,
    bindingValue: '',
    replacement: null as string | null,
    cookieKind: null as 'guarded' | 'legacy' | null,
    legacyMetrics: [] as string[],
    events: [] as string[],
  };
});

vi.mock('../../services/authBrowserTransition', () => ({
  AuthBindingRotationRequiredError: transitionState.AuthBindingRotationRequiredError,
  AuthBindingUnavailableError: transitionState.AuthBindingUnavailableError,
  AuthIssuanceCapabilityError: transitionState.AuthIssuanceCapabilityError,
  AuthIssuanceConflictError: transitionState.AuthIssuanceConflictError,
  beginAuthIssuance: vi.fn(async () => {
    if (transitionState.beginError) throw transitionState.beginError;
    transitionState.events.push('admit');
    return { transitionId: 'transition-1', generation: 1, operationId: 'operation-1' };
  }),
  cancelAuthIssuance: vi.fn(async () => undefined),
  finishAuthIssuance: vi.fn(async (_capability: unknown, callback: (tx: unknown) => Promise<unknown>) => {
    if (transitionState.finishError) throw transitionState.finishError;
    transitionState.events.push('finish-start');
    const { db } = await import('../../db');
    const result = await callback(db);
    transitionState.events.push('finish-commit');
    return result;
  }),
}));

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
  getUserEpochs: vi.fn(async () => ({ authEpoch: 1, mfaEpoch: 1 })),
}));

vi.mock('../../services/userSession', () => ({
  authBrowserTransitionsEnforced: vi.fn(() => transitionState.enforcement),
  issueUserSession: vi.fn(async (identity: Record<string, unknown>, options: Record<string, unknown>) => {
    servicesState.lastTokenPayload = { sub: identity.userId, mfa: identity.mfa };
    servicesState.lastTokenOptions = options;
    servicesState.mintCalls.push(String(identity.userId));
    transitionState.events.push('issue-guarded');
    return {
      accessToken: 'access-tok', refreshToken: 'refresh-tok', refreshJti: 'jti-new',
      expiresInSeconds: 900, familyId: 'fam-1', transitionId: 'transition-1', generation: 1,
    };
  }),
  issueUserSessionLegacyDuringTransition: vi.fn(async (identity: Record<string, unknown>) => {
    servicesState.lastTokenPayload = { sub: identity.userId, mfa: identity.mfa };
    servicesState.lastTokenOptions = { refreshFam: 'fam-1' };
    servicesState.mintCalls.push(String(identity.userId));
    servicesState.bindCalls.push({ jti: 'jti-new', familyId: 'fam-1' });
    transitionState.events.push('issue-legacy');
    return {
      accessToken: 'access-tok', refreshToken: 'refresh-tok', refreshJti: 'jti-new',
      expiresInSeconds: 900, familyId: 'fam-1',
    };
  }),
  bindIssuedUserSession: vi.fn(async (issued: { refreshJti: string; familyId: string }) => {
    servicesState.bindCalls.push({ jti: issued.refreshJti, familyId: issued.familyId });
  }),
}));

vi.mock('../../services/authTransitionMetrics', () => ({
  recordAuthTransitionLegacyIssuer: vi.fn((issuer: string) => transitionState.legacyMetrics.push(issuer)),
}));

vi.mock('./binding', () => ({
  requestAuthBinding: vi.fn(() => ({ kind: 'browser', value: transitionState.bindingValue })),
  installAuthBindingReplacement: vi.fn((_c: unknown, replacement: { value: string }) => {
    transitionState.replacement = replacement.value;
  }),
}));

const auditState = vi.hoisted(() => ({
  audits: [] as Array<Record<string, unknown>>,
  loginFailures: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
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
    installAuthorizedUserSessionCookies: vi.fn((_c: unknown, issued: { refreshToken: string }) => {
      cookieState.set = issued.refreshToken;
      transitionState.cookieKind = 'guarded';
    }),
    installLegacyUserSessionCookiesDuringTransition: vi.fn((_c: unknown, issued: { refreshToken: string }) => {
      cookieState.set = issued.refreshToken;
      transitionState.cookieKind = 'legacy';
    }),
    authClientUpgradeRequiredResponse: vi.fn((c: any) =>
      c.json({ error: 'Authentication client upgrade required', reason: 'auth_client_upgrade_required' }, 426)),
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
    policyState.required = false;
    verifyState.next = undefined;
    dbState.userRow = null;
    dbState.lastLoginUpdated = false;
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
    transitionState.finishError = null;
    transitionState.beginError = null;
    transitionState.enforcement = false;
    transitionState.bindingValue = '';
    transitionState.replacement = null;
    transitionState.cookieKind = null;
    transitionState.legacyMetrics = [];
    transitionState.events = [];
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

  it('leaves last-login, family, cookie, and success audit unchanged when logout wins guarded finalization', async () => {
    envState.enabled = true;
    transitionState.bindingValue = 'a'.repeat(64);
    transitionState.finishError = new transitionState.AuthIssuanceCapabilityError();
    verifyState.next = {
      kind: 'claims',
      claims: { email: activeUser.email, sub: 'cf-1', aud: envState.audience,
        iss: `https://${envState.teamDomain}`, exp: 999, iat: 1 },
    };
    dbState.userRow = { ...activeUser, authEpoch: 3, mfaEpoch: 2 };

    const res = await callGet('/cf-access-login', { 'Cf-Access-Jwt-Assertion': 'tok' });

    expect(res.status).toBe(409);
    expect(dbState.lastLoginUpdated).toBe(false);
    expect(servicesState.mintCalls).toEqual([]);
    expect(cookieState.set).toBeNull();
    expect(auditState.audits).toEqual([]);
  });

  it('uses guarded issuance for a valid binding cookie even without a transition header', async () => {
    envState.enabled = true;
    transitionState.bindingValue = 'a'.repeat(64);
    verifyState.next = {
      kind: 'claims',
      claims: { email: activeUser.email, sub: 'cf-1', aud: envState.audience,
        iss: `https://${envState.teamDomain}`, exp: 999, iat: 1 },
    };
    dbState.userRow = { ...activeUser, authEpoch: 3, mfaEpoch: 2 };

    const res = await callGet('/cf-access-login', { 'Cf-Access-Jwt-Assertion': 'tok' });

    expect(res.status).toBe(302);
    expect(transitionState.cookieKind).toBe('guarded');
    expect(dbState.lastLoginUpdated).toBe(true);
    expect(transitionState.events).toContain('finish-commit');
    expect(transitionState.legacyMetrics).toEqual([]);
  });

  it('uses the frozen legacy seam for a missing binding only while enforcement is false', async () => {
    envState.enabled = true;
    verifyState.next = {
      kind: 'claims',
      claims: { email: activeUser.email, sub: 'cf-1', aud: envState.audience,
        iss: `https://${envState.teamDomain}`, exp: 999, iat: 1 },
    };
    dbState.userRow = { ...activeUser, authEpoch: 3, mfaEpoch: 2 };

    const res = await callGet('/cf-access-login', { 'Cf-Access-Jwt-Assertion': 'tok' });

    expect(res.status).toBe(302);
    expect(transitionState.cookieKind).toBe('legacy');
    expect(transitionState.legacyMetrics).toEqual(['cf_access_redirect']);
  });

  it('rejects a missing binding before authority effects when enforcement is true', async () => {
    envState.enabled = true;
    transitionState.enforcement = true;
    verifyState.next = {
      kind: 'claims',
      claims: { email: activeUser.email, sub: 'cf-1', aud: envState.audience,
        iss: `https://${envState.teamDomain}`, exp: 999, iat: 1 },
    };
    dbState.userRow = { ...activeUser, authEpoch: 3, mfaEpoch: 2 };

    const res = await callGet('/cf-access-login', { 'Cf-Access-Jwt-Assertion': 'tok' });

    expect(res.status).toBe(426);
    expect(dbState.lastLoginUpdated).toBe(false);
    expect(servicesState.mintCalls).toEqual([]);
    expect(cookieState.set).toBeNull();
  });

  it('maps an invalid presented binding to the exact 428 replacement response', async () => {
    envState.enabled = true;
    transitionState.bindingValue = 'invalid-binding';
    transitionState.finishError = new transitionState.AuthBindingRotationRequiredError({
      kind: 'browser', value: 'b'.repeat(64),
    });
    verifyState.next = {
      kind: 'claims',
      claims: { email: activeUser.email, sub: 'cf-1', aud: envState.audience,
        iss: `https://${envState.teamDomain}`, exp: 999, iat: 1 },
    };
    dbState.userRow = { ...activeUser, authEpoch: 3, mfaEpoch: 2 };

    const res = await callGet('/cf-access-login', { 'Cf-Access-Jwt-Assertion': 'tok' });

    expect(res.status).toBe(428);
    expect(await res.json()).toEqual({
      error: 'Authentication binding refresh required', reason: 'binding_refresh',
    });
    expect(transitionState.replacement).toBe('b'.repeat(64));
  });

  it('bootstraps a transition-v1 redirect with a missing binding instead of using legacy issuance', async () => {
    envState.enabled = true;
    transitionState.beginError = new transitionState.AuthBindingRotationRequiredError({
      kind: 'browser', value: 'c'.repeat(64),
    });
    verifyState.next = {
      kind: 'claims',
      claims: { email: activeUser.email, sub: 'cf-1', aud: envState.audience,
        iss: `https://${envState.teamDomain}`, exp: 999, iat: 1 },
    };
    dbState.userRow = { ...activeUser, authEpoch: 3, mfaEpoch: 2 };

    const res = await callGet('/cf-access-login', {
      'Cf-Access-Jwt-Assertion': 'tok',
      'x-breeze-auth-transition': 'v1',
    });

    expect(res.status).toBe(428);
    expect(transitionState.replacement).toBe('c'.repeat(64));
    expect(transitionState.legacyMetrics).toEqual([]);
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

  // PR3 carry-forward: this mint site used to compute
  // `trustsMfa || !(ENABLE_2FA && user.mfaEnabled)`, handing mfa=true to any
  // user with no enrolled factor — including one whose effective policy
  // REQUIRES MFA. The redirect path has no JSON body to carry an
  // `mfaEnrollmentRequired` flag, so the mfa=false claim IS the fix: it is
  // what makes authMiddleware 428 the session into enrollment and what keeps
  // every hasSatisfiedMfa() gate closed.
  describe('MFA assurance parity with /login (PR3 carry-forward)', () => {
    function claimsFor(email: string) {
      return {
        kind: 'claims' as const,
        claims: {
          email,
          sub: 'cf-1',
          aud: envState.audience,
          iss: `https://${envState.teamDomain}`,
          exp: 999,
          iat: 1,
        },
      };
    }

    it('an unenrolled user under a required policy is NOT granted mfa=true', async () => {
      envState.enabled = true;
      policyState.required = true;
      verifyState.next = claimsFor(activeUser.email);
      dbState.userRow = { ...activeUser, mfaEnabled: false };

      const res = await callGet('/cf-access-login', { 'Cf-Access-Jwt-Assertion': 'tok' });

      expect(res.status).toBe(302);
      expect(servicesState.lastTokenPayload).toMatchObject({ sub: activeUser.id, mfa: false });
      // The audit trail must record the real assurance level, not the claimed one.
      expect(auditState.audits[0]).toMatchObject({
        details: expect.objectContaining({ mfa: false }),
      });
    });

    it('an unenrolled user under a NON-required policy still gets mfa=true', async () => {
      envState.enabled = true;
      policyState.required = false;
      verifyState.next = claimsFor(activeUser.email);
      dbState.userRow = { ...activeUser, mfaEnabled: false };

      const res = await callGet('/cf-access-login', { 'Cf-Access-Jwt-Assertion': 'tok' });

      expect(res.status).toBe(302);
      expect(servicesState.lastTokenPayload).toMatchObject({ mfa: true });
    });

    it('CF_ACCESS_TRUSTS_MFA does NOT satisfy a required policy for an unenrolled user (fail closed)', async () => {
      envState.enabled = true;
      envState.trustsMfa = true;
      policyState.required = true;
      verifyState.next = claimsFor(activeUser.email);
      dbState.userRow = { ...activeUser, mfaEnabled: false };

      const res = await callGet('/cf-access-login', { 'Cf-Access-Jwt-Assertion': 'tok' });

      expect(res.status).toBe(302);
      expect(servicesState.lastTokenPayload).toMatchObject({ mfa: false });
    });

    it('CF_ACCESS_TRUSTS_MFA still satisfies a required policy for an ENROLLED user', async () => {
      envState.enabled = true;
      envState.trustsMfa = true;
      policyState.required = true;
      verifyState.next = claimsFor(activeUser.email);
      dbState.userRow = {
        ...activeUser,
        mfaEnabled: true,
        mfaSecret: 'encrypted',
        mfaMethod: 'totp',
      };

      const res = await callGet('/cf-access-login', { 'Cf-Access-Jwt-Assertion': 'tok' });

      expect(res.status).toBe(302);
      expect(servicesState.lastTokenPayload).toMatchObject({ mfa: true });
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

  it('logout endpoint chains app-domain + team-domain CF logouts ending at /login?signedOut=1', async () => {
    envState.enabled = true;
    process.env.DASHBOARD_URL = 'https://breeze.example.com';
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
    process.env.DASHBOARD_URL = 'https://breeze.example.com';
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
    process.env.DASHBOARD_URL = 'https://breeze.example.com';
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
    process.env.DASHBOARD_URL = 'https://breeze.example.com';
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
    process.env.DASHBOARD_URL = 'https://breeze.example.com';
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

  // #2895: the route used to synthesise the origin from the request Host when
  // neither env var was set, which made the Location header an open redirect.
  // It now fails closed on a relative /login instead.
  it('logout fails closed to a relative /login when neither env is set, never trusting Host', async () => {
    envState.enabled = true;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await cfAccessRedirectLoginRoutes.request('http://api.example/cf-access-logout', {
      method: 'GET',
      headers: { host: 'evil.example', 'x-forwarded-proto': 'http' },
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get('Location') ?? '';
    expect(loc).toBe('/login?signedOut=1');
    expect(loc).not.toContain('evil.example');
    // The misconfiguration is logged so the operator knows to set DASHBOARD_URL,
    // and reported so it is visible somewhere other than container stdout.
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('DASHBOARD_URL'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('<unset>'));
    const { captureException } = await import('../../services/sentry');
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('DASHBOARD_URL') }),
      expect.anything()
    );
    // The Breeze session is still cleared even though the CF chain is skipped.
    expect(cookieState.cleared).toBe(true);
    errSpy.mockRestore();
  });

  it('logout fails closed when the configured base URL is unparseable, never trusting Host', async () => {
    envState.enabled = true;
    process.env.DASHBOARD_URL = 'not a url';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await cfAccessRedirectLoginRoutes.request('http://api.example/cf-access-logout', {
      method: 'GET',
      headers: { host: 'evil.example' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login?signedOut=1');
    expect(cookieState.cleared).toBe(true);
    // The log names the offending value — "unset" and "typo'd" are different fixes.
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('"not a url"'));
    errSpy.mockRestore();
  });

  it('logout fails closed when the configured base URL has a non-http(s) scheme', async () => {
    envState.enabled = true;
    // `new URL('javascript:...').origin` serialises to the literal "null",
    // which is truthy and would otherwise land in the Location header.
    process.env.DASHBOARD_URL = 'javascript:alert(1)';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await cfAccessRedirectLoginRoutes.request('http://api.example/cf-access-logout', {
      method: 'GET',
      headers: { host: 'evil.example' },
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get('Location') ?? '';
    // The "null" origin never reaches the header, and the operator is told.
    expect(loc).toBe('/login?signedOut=1');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('javascript:alert(1)'));
    errSpy.mockRestore();
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
