import { beforeEach, describe, expect, it, vi } from 'vitest';

const envState = vi.hoisted(() => ({
  enabled: false,
  terminalPreparation: false,
  teamDomain: 'your-team.cloudflareaccess.com',
  audience: 'aud-app-1234567890abcdef',
  trustsMfa: false,
}));

vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/env')>()),
  cfAccessTrustEnabled: () => envState.enabled,
  cfAccessTeamDomain: () => envState.teamDomain,
  cfAccessAud: () => envState.audience,
  cfAccessTrustsMfa: () => envState.trustsMfa,
  authBrowserTerminalPreparationEnabled: () => envState.terminalPreparation,
  // Read by the effective-MFA-policy resolver (kill switch for the role-force
  // axis). The resolver is mocked below, but keep the export honest.
  mfaForcePartnerAdmin: () => false,
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: () => Promise<void>) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'user@example.com', name: 'Billy Dunn' },
      token: { sid: 'family-1', aep: 4, mep: 7 },
      orgId: null,
      partnerId: 'partner-1',
      scope: 'partner',
    });
    await next();
  }),
}));

const terminalLogoutState = vi.hoisted(() => ({
  prepareError: null as Error | null,
  prepareCalls: [] as Array<Record<string, unknown>>,
  pending: true,
  pendingError: null as Error | null,
  completionError: null as Error | null,
  completion: { kind: 'completed' as 'completed' | 'replayed' | 'invalid', replacement: { kind: 'browser' as const, value: 'c2-binding' } },
}));

vi.mock('../../services/terminalLogout', () => ({
  prepareCfTerminalLogout: vi.fn(async (input: Record<string, unknown>) => {
    terminalLogoutState.prepareCalls.push(input);
    if (terminalLogoutState.prepareError) throw terminalLogoutState.prepareError;
    return {
      transitionId: '11111111-1111-4111-8111-111111111111',
      logoutId: '22222222-2222-4222-8222-222222222222',
      generation: 4,
      nonce: 'ab'.repeat(32),
      issuedAt: 1_800_000_000,
      expiresAt: 1_800_000_300,
      cleanupOk: true,
    };
  }),
  isCfTerminalLogoutPending: vi.fn(async () => {
    if (terminalLogoutState.pendingError) throw terminalLogoutState.pendingError;
    return terminalLogoutState.pending;
  }),
  completeCfTerminalLogout: vi.fn(async () => {
    if (terminalLogoutState.completionError) throw terminalLogoutState.completionError;
    return terminalLogoutState.completion;
  }),
}));

const ticketState = vi.hoisted(() => ({ valid: true }));
vi.mock('../../services/terminalLogoutTicket', () => ({
  issueTerminalLogoutTicket: vi.fn(() => 'signed.ticket.value'),
  verifyTerminalLogoutTicket: vi.fn((ticket: string) => ticketState.valid && ticket === 'signed.ticket.value'
    ? {
        claims: {
          version: 1,
          audience: 'terminal-logout-completion',
          transitionId: '11111111-1111-4111-8111-111111111111',
          logoutId: '22222222-2222-4222-8222-222222222222',
          generation: 4,
          nonce: 'ab'.repeat(32),
          issuedAt: 1_800_000_000,
          expiresAt: 1_800_000_300,
        },
        signingKeyId: 'current',
      }
    : null),
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

const cookieState = vi.hoisted(() => ({
  set: null as string | null,
  cleared: false,
  csrfError: null as string | null,
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
    validateCookieCsrfRequest: vi.fn(() => cookieState.csrfError),
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
    envState.terminalPreparation = false;
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
    cookieState.csrfError = null;
    terminalLogoutState.prepareError = null;
    terminalLogoutState.prepareCalls = [];
    terminalLogoutState.pending = true;
    terminalLogoutState.pendingError = null;
    terminalLogoutState.completionError = null;
    terminalLogoutState.completion = {
      kind: 'completed', replacement: { kind: 'browser', value: 'c2-binding' },
    };
    ticketState.valid = true;
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
    process.env.CORS_ALLOWED_ORIGINS = 'https://breeze.example.com';
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

  describe('terminal Cloudflare logout', () => {
    const csrfHeaders = {
      origin: 'https://breeze.example.com',
      cookie: 'breeze_csrf_token=csrf-value; breeze_refresh_token=refresh-token',
      'x-breeze-csrf': 'csrf-value',
    };

    it('keeps terminal preparation disabled by default', async () => {
      const res = await cfAccessRedirectLoginRoutes.request('http://api.example/cf-access-logout/prepare', {
        method: 'POST', headers: csrfHeaders,
      });

      expect(res.status).toBe(503);
      expect(terminalLogoutState.prepareCalls).toEqual([]);
    });

    it('rejects the non-browser CSRF compatibility header without cookie and Origin', async () => {
      envState.terminalPreparation = true;
      const res = await cfAccessRedirectLoginRoutes.request('http://api.example/cf-access-logout/prepare', {
        method: 'POST', headers: { 'x-breeze-csrf': '1' },
      });

      expect(res.status).toBe(403);
      expect(terminalLogoutState.prepareCalls).toEqual([]);
    });

    it('rejects sentinel cookie/header equality even with valid Origin and fetch-site', async () => {
      envState.terminalPreparation = true;
      const res = await cfAccessRedirectLoginRoutes.request('http://api.example/cf-access-logout/prepare', {
        method: 'POST',
        headers: {
          cookie: 'breeze_csrf_token=1; breeze_refresh_token=refresh-token',
          'x-breeze-csrf': '1',
          origin: 'https://breeze.example.com',
          'sec-fetch-site': 'same-origin',
        },
      });

      expect(res.status).toBe(403);
      expect(terminalLogoutState.prepareCalls).toEqual([]);
    });

    it('prepares durable logout, clears only refresh authority, and returns a signed navigation URL', async () => {
      envState.terminalPreparation = true;
      transitionState.bindingValue = 'c1-binding';
      process.env.DASHBOARD_URL = 'https://breeze.example.com';

      const res = await cfAccessRedirectLoginRoutes.request('http://api.example/cf-access-logout/prepare', {
        method: 'POST', headers: csrfHeaders,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      await expect(res.json()).resolves.toEqual({
        navigationUrl: '/api/v1/auth/cf-access-logout?ticket=signed.ticket.value',
      });
      expect(terminalLogoutState.prepareCalls).toEqual([expect.objectContaining({
        access: { userId: 'user-1', familyId: 'family-1', authEpoch: 4, mfaEpoch: 7 },
        refreshToken: 'refresh-token',
        binding: { kind: 'browser', value: 'c1-binding' },
      })]);
      expect(cookieState.cleared).toBe(true);
      expect(transitionState.replacement).toBeNull();
    });

    it('never returns a navigation URL when PostgreSQL preparation fails', async () => {
      envState.terminalPreparation = true;
      transitionState.bindingValue = 'c1-binding';
      terminalLogoutState.prepareError = new Error('postgres unavailable');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await cfAccessRedirectLoginRoutes.request('http://api.example/cf-access-logout/prepare', {
        method: 'POST', headers: csrfHeaders,
      });

      expect(res.status).toBe(503);
      await expect(res.json()).resolves.not.toHaveProperty('navigationUrl');
      expect(cookieState.cleared).toBe(false);
      errSpy.mockRestore();
    });

    it('never logs binding, token, nonce, or ticket material from terminal failures', async () => {
      envState.terminalPreparation = true;
      transitionState.bindingValue = 'c1-binding';
      const secret = 'secret-binding-token-nonce-ticket';
      terminalLogoutState.prepareError = Object.assign(new Error(`failure ${secret}`), {
        name: `Leaky${secret}`,
        replacement: { kind: 'browser', value: secret },
        nonce: secret,
        ticket: secret,
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await cfAccessRedirectLoginRoutes.request('http://api.example/cf-access-logout/prepare', {
        method: 'POST', headers: csrfHeaders,
      });

      expect(res.status).toBe(503);
      expect(JSON.stringify(errSpy.mock.calls)).not.toContain(secret);
      expect(errSpy).toHaveBeenLastCalledWith(
        '[cf-access-logout] Durable terminal preparation failed',
        { name: 'TerminalLogoutError', reason: 'durable_preparation_failed' },
      );
      errSpy.mockRestore();
    });

    it('rejects missing and invalid tickets without consulting refresh cookies', async () => {
      envState.enabled = true;
      const missing = await cfAccessRedirectLoginRoutes.request('http://api.example/cf-access-logout', {
        method: 'GET', headers: { cookie: 'breeze_refresh_token=must-not-authorize' },
      });
      ticketState.valid = false;
      const invalid = await cfAccessRedirectLoginRoutes.request(
        'http://api.example/cf-access-logout?ticket=forged', { method: 'GET' });

      expect(missing.status).toBe(400);
      expect(invalid.status).toBe(400);
      expect(missing.headers.get('Cache-Control')).toBe('no-store');
      expect(invalid.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(servicesState.verifyResult).toBeNull();
      expect(servicesState.revokeAllCalls).toEqual([]);
      expect(servicesState.revokeJtiCalls).toEqual([]);
    });

    it('chains Cloudflare hops to the cookie-less completion URL using only configured origins', async () => {
      envState.enabled = true;
      process.env.DASHBOARD_URL = 'https://breeze.example.com';

      const res = await cfAccessRedirectLoginRoutes.request(
        'http://api.example/cf-access-logout?ticket=signed.ticket.value', {
          method: 'GET', headers: { host: 'evil.attacker.example' },
        });

      expect(res.status).toBe(302);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      const outer = res.headers.get('Location') ?? '';
      expect(outer).toMatch(/^https:\/\/breeze\.example\.com\/cdn-cgi\/access\/logout\?returnTo=/);
      expect(outer).not.toContain('evil.attacker.example');
      const inner = decodeURIComponent(outer.split('returnTo=')[1] ?? '');
      const completion = decodeURIComponent(inner.split('returnTo=')[1] ?? '');
      expect(completion).toBe(
        'https://breeze.example.com/api/v1/auth/cf-access-logout/complete?ticket=signed.ticket.value');
    });

    it.each([
      'trusted.cloudflareaccess.com@evil.example',
      'trusted.cloudflareaccess.com:443',
      'trusted.cloudflareaccess.com/path',
      'trusted.cloudflareaccess.com?next=evil',
      'trusted.cloudflareaccess.com#fragment',
      'trusted.cloudflareaccess.com.evil.example',
      'evil.example',
      'TRUSTED.cloudflareaccess.com',
      'trusted.cloudflareaccess.com.',
    ])('revalidates and rejects unsafe team domain %s before ticket-bearing navigation', async (teamDomain) => {
      envState.enabled = true;
      envState.teamDomain = teamDomain;
      process.env.DASHBOARD_URL = 'https://breeze.example.com';

      const res = await cfAccessRedirectLoginRoutes.request(
        'http://api.example/cf-access-logout?ticket=signed.ticket.value', { method: 'GET' });

      expect(res.status).toBe(503);
      expect(res.headers.get('Location')).toBeNull();
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    it.each(['completed', 'replayed'] as const)(
      '%s completion is idempotent, retires C1, installs C2, and redirects with no-store/no-referrer',
      async (kind) => {
        terminalLogoutState.completion = {
          kind, replacement: { kind: 'browser', value: 'c2-binding' },
        };
        const res = await cfAccessRedirectLoginRoutes.request(
          'http://api.example/cf-access-logout/complete?ticket=signed.ticket.value', { method: 'GET' });

        expect(res.status).toBe(303);
        expect(res.headers.get('Location')).toBe('/login?signedOut=1');
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
        expect(cookieState.cleared).toBe(true);
        expect(transitionState.replacement).toBe('c2-binding');
      });

    it('rejects a validly signed ticket that is no longer the pending generation', async () => {
      envState.enabled = true;
      terminalLogoutState.pending = false;
      const initial = await cfAccessRedirectLoginRoutes.request(
        'http://api.example/cf-access-logout?ticket=signed.ticket.value', { method: 'GET' });
      terminalLogoutState.completion = { kind: 'invalid', replacement: { kind: 'browser', value: 'unused' } };
      const completion = await cfAccessRedirectLoginRoutes.request(
        'http://api.example/cf-access-logout/complete?ticket=signed.ticket.value', { method: 'GET' });

      expect(initial.status).toBe(400);
      expect(completion.status).toBe(400);
      expect(initial.headers.get('Cache-Control')).toBe('no-store');
      expect(completion.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(transitionState.replacement).toBeNull();
    });

    it('fails closed with no redirect or cookie mutation on PostgreSQL ticket checks', async () => {
      envState.enabled = true;
      process.env.DASHBOARD_URL = 'https://breeze.example.com';
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      terminalLogoutState.pendingError = new Error('postgres unavailable');
      const initial = await cfAccessRedirectLoginRoutes.request(
        'http://api.example/cf-access-logout?ticket=signed.ticket.value', { method: 'GET' });
      terminalLogoutState.pendingError = null;
      terminalLogoutState.completionError = new Error('postgres unavailable');
      const completion = await cfAccessRedirectLoginRoutes.request(
        'http://api.example/cf-access-logout/complete?ticket=signed.ticket.value', { method: 'GET' });

      expect(initial.status).toBe(503);
      expect(initial.headers.get('Location')).toBeNull();
      expect(completion.status).toBe(503);
      expect(completion.headers.get('Location')).toBeNull();
      expect(initial.headers.get('Cache-Control')).toBe('no-store');
      expect(completion.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(cookieState.cleared).toBe(false);
      expect(transitionState.replacement).toBeNull();
      errSpy.mockRestore();
    });

    it('sanitizes pending-check and completion failures before logging', async () => {
      envState.enabled = true;
      process.env.DASHBOARD_URL = 'https://breeze.example.com';
      const secret = 'secret-binding-token-nonce-ticket';
      const leaky = Object.assign(new Error(secret), {
        replacement: { kind: 'browser', value: secret }, nonce: secret, ticket: secret,
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      terminalLogoutState.pendingError = leaky;
      await cfAccessRedirectLoginRoutes.request(
        'http://api.example/cf-access-logout?ticket=signed.ticket.value', { method: 'GET' });
      terminalLogoutState.pendingError = null;
      terminalLogoutState.completionError = leaky;
      await cfAccessRedirectLoginRoutes.request(
        'http://api.example/cf-access-logout/complete?ticket=signed.ticket.value', { method: 'GET' });

      expect(JSON.stringify(errSpy.mock.calls)).not.toContain(secret);
      expect(errSpy.mock.calls).toEqual([
        ['[cf-access-logout] Pending ticket check failed',
          { name: 'TerminalLogoutError', reason: 'pending_check_failed' }],
        ['[cf-access-logout] Ticket completion failed',
          { name: 'TerminalLogoutError', reason: 'completion_failed' }],
      ]);
      errSpy.mockRestore();
    });
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
