import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';

const envState = vi.hoisted(() => ({
  enabled: false,
  teamDomain: 'your-team.cloudflareaccess.com',
  audience: 'aud-app-1234567890abcdef',
  trustsMfa: false,
}));

vi.mock('../config/env', async () => {
  const actual = await vi.importActual<typeof import('../config/env')>('../config/env');
  return {
    ...actual,
    cfAccessTrustEnabled: () => envState.enabled,
    cfAccessTeamDomain: () => envState.teamDomain,
    cfAccessAud: () => envState.audience,
    cfAccessTrustsMfa: () => envState.trustsMfa,
  };
});

const verifyState = vi.hoisted(() => ({
  next: undefined as
    | { kind: 'claims'; claims: Record<string, unknown> }
    | { kind: 'invalid'; code?: string }
    | { kind: 'jwks-unavailable' }
    | undefined,
}));

vi.mock('../services/cfAccessJwt', async () => {
  const actual = await vi.importActual<typeof import('../services/cfAccessJwt')>(
    '../services/cfAccessJwt'
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
  lastUpdateId: null as string | null,
}));

vi.mock('../db', () => {
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
    withDbAccessContext: vi.fn(async (_context: unknown, fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
    runOutsideDbContext: vi.fn(async (fn: () => unknown) => fn()),
    db: {
      select: vi.fn(() => makeChain(dbState.userRow)),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn((predicate: unknown) => {
            void predicate;
            dbState.lastUpdateId = dbState.userRow?.id as string | null;
            return Promise.resolve();
          }),
        })),
      })),
    },
  };
});

const tokenState = vi.hoisted(() => ({
  lastIdentity: null as Record<string, unknown> | null,
  pendingInput: null as Record<string, unknown> | null,
}));

vi.mock('../services', () => ({
  NATIVE_AUTH_BINDING_HEADER: 'x-breeze-native-auth-binding',
  selectAuthBindingSource: vi.fn((input: {
    browserBinding?: string | null;
    nativeBinding?: string | null;
    nativeRequest?: boolean;
  }) => input.nativeBinding !== null && input.nativeBinding !== undefined
    ? { kind: 'native', value: input.nativeBinding }
    : input.nativeRequest
      ? { kind: 'native', value: '' }
      : { kind: 'browser', value: input.browserBinding ?? '' }),
  AuthBindingRotationRequiredError: class AuthBindingRotationRequiredError extends Error {
    replacement = { kind: 'browser', value: 'b'.repeat(64) };
  },
  AuthBindingUnavailableError: class AuthBindingUnavailableError extends Error {},
  AuthIssuanceCapabilityError: class AuthIssuanceCapabilityError extends Error {},
  AuthIssuanceConflictError: class AuthIssuanceConflictError extends Error {},
  createPendingMfaForLogin: vi.fn(async (input: Record<string, unknown>) => {
    tokenState.pendingInput = input;
    return {
      tempToken: 'v2-temp-token',
      primaryMfaMethod: dbState.userRow?.mfaMethod ?? 'totp',
      passkeyAvailable: dbState.userRow?.mfaMethod === 'passkey',
      phoneLast4: null,
    };
  }),
  PendingMfaInvalidError: class PendingMfaInvalidError extends Error {},
  PendingMfaUnavailableError: class PendingMfaUnavailableError extends Error {},
  issueUserSession: vi.fn(
    async (identity: Record<string, unknown>) => {
      tokenState.lastIdentity = identity;
      return {
        accessToken: 'access-tok',
        refreshToken: 'refresh-tok',
        refreshJti: 'jti-new',
        expiresInSeconds: 900,
        familyId: 'fam-1',
      };
    }
  ),
  decideAuthenticatedUserSession: vi.fn(async (input: Record<string, unknown>) => {
    tokenState.pendingInput = input;
    const hasLocalFactor = dbState.userRow?.mfaEnabled === true
      && Boolean(dbState.userRow?.mfaSecret || dbState.userRow?.mfaMethod === 'sms' || dbState.userRow?.mfaMethod === 'passkey');
    if (input.requireLocalMfa === true && hasLocalFactor) {
      return {
        kind: 'pending',
        tempToken: 'v2-temp-token',
        primaryMfaMethod: dbState.userRow?.mfaMethod ?? 'totp',
        passkeyAvailable: dbState.userRow?.mfaMethod === 'passkey',
        phoneLast4: null,
      };
    }
    tokenState.lastIdentity = {
      userId: input.userId,
      email: dbState.userRow?.email,
      roleId: input.roleId,
      orgId: input.orgId,
      partnerId: input.partnerId,
      scope: input.scope,
      mfa: input.externallySatisfiedMfa === true,
      amr: ['cf_access'],
      mobileDeviceId: input.mobileDeviceId,
    };
    return {
      kind: 'issued',
      tokens: {
        accessToken: 'access-tok',
        refreshToken: 'refresh-tok',
        refreshJti: 'jti-new',
        expiresInSeconds: 900,
        familyId: 'fam-1',
      },
    };
  }),
  getRedis: vi.fn(() => ({
    setex: vi.fn(async () => 'OK'),
  })),
}));

const auditState = vi.hoisted(() => ({
  audits: [] as Array<Record<string, unknown>>,
  loginFailures: [] as Array<Record<string, unknown>>,
}));

vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn((entry: Record<string, unknown>) => {
    auditState.audits.push(entry);
  }),
}));

vi.mock('../routes/auth/helpers', async () => {
  const actual = await vi.importActual<typeof import('../routes/auth/helpers')>(
    '../routes/auth/helpers'
  );
  return {
    ...actual,
    auditUserLoginFailure: vi.fn((_c: unknown, entry: Record<string, unknown>) => {
      auditState.loginFailures.push(entry);
    }),
    resolveCurrentUserTokenContext: vi.fn(async () => contextState.value),
    getCookieValue: vi.fn(() => 'a'.repeat(64)),
    rotateCsrfBindingCookie: vi.fn(),
    setRefreshTokenCookie: vi.fn((c: Context, refreshToken: string) => {
      cookieState.set = refreshToken;
      // ape Hono's behaviour just enough for the test's purposes
      c.header('set-cookie', `breeze_refresh=${refreshToken}; Path=/; HttpOnly`);
    }),
    toPublicTokens: actual.toPublicTokens,
    userRequiresSetup: () => false,
    getClientIP: () => '127.0.0.1',
  };
});

vi.mock('../services/mobileDeviceBinding', () => ({
  readMobileDeviceId: vi.fn(() => null),
  carryForwardBinding: vi.fn((p: Record<string, unknown>) => p.mdid as string | undefined),
}));

const contextState = vi.hoisted(() => ({
  value: {
    roleId: 'role-1',
    partnerId: 'partner-1',
    orgId: null as string | null,
    scope: 'partner' as 'partner' | 'organization' | 'system',
  },
}));

const cookieState = vi.hoisted(() => ({
  set: null as string | null,
}));

vi.mock('../routes/auth/schemas', async () => {
  const actual = await vi.importActual<typeof import('../routes/auth/schemas')>(
    '../routes/auth/schemas'
  );
  return { ...actual, ENABLE_2FA: true };
});

import { cfAccessLoginMiddleware } from './cfAccessLogin';
import { verifyCfAccessJwt } from '../services/cfAccessJwt';
import {
  decideAuthenticatedUserSession,
  PendingMfaInvalidError,
  AuthIssuanceCapabilityError,
} from '../services';

function createContext(headers: Record<string, string | undefined> = {}): Context {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  const responseHeaders: Record<string, string> = {};
  const store = new Map<string, unknown>();

  return {
    req: {
      header: (name: string) => normalized[name.toLowerCase()],
    },
    set: (key: string, value: unknown) => {
      store.set(key, value);
    },
    get: (key: string) => store.get(key),
    header: (name: string, value: string) => {
      responseHeaders[name.toLowerCase()] = value;
    },
    json: (body: unknown, status?: number) => {
      const res = new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json', ...responseHeaders },
      });
      return res;
    },
  } as unknown as Context;
}

function createNext(): { next: Next; called: () => boolean } {
  let called = false;
  const next: Next = async () => {
    called = true;
  };
  return { next, called: () => called };
}

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

describe('cfAccessLoginMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envState.enabled = false;
    envState.teamDomain = 'your-team.cloudflareaccess.com';
    envState.audience = 'aud-app-1234567890abcdef';
    envState.trustsMfa = false;
    verifyState.next = undefined;
    dbState.userRow = null;
    dbState.lastUpdateId = null;
    tokenState.lastIdentity = null;
    tokenState.pendingInput = null;
    auditState.audits = [];
    auditState.loginFailures = [];
    contextState.value = {
      roleId: 'role-1',
      partnerId: 'partner-1',
      orgId: null,
      scope: 'partner',
    };
    cookieState.set = null;
  });

  it('falls through when trust is disabled', async () => {
    envState.enabled = false;
    const { next, called } = createNext();
    const res = await cfAccessLoginMiddleware(
      createContext({ 'Cf-Access-Jwt-Assertion': 'any.jwt.here' }),
      next
    );
    expect(res).toBeUndefined();
    expect(called()).toBe(true);
  });

  it('falls through when the JWT header is absent', async () => {
    envState.enabled = true;
    const { next, called } = createNext();
    const res = await cfAccessLoginMiddleware(createContext(), next);
    expect(res).toBeUndefined();
    expect(called()).toBe(true);
  });

  it('falls through and warns when team domain is missing', async () => {
    envState.enabled = true;
    envState.teamDomain = '';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { next, called } = createNext();
    await cfAccessLoginMiddleware(
      createContext({ 'Cf-Access-Jwt-Assertion': 'tok' }),
      next
    );
    expect(called()).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('falls through before JWT verification when the runtime team domain is malformed', async () => {
    envState.enabled = true;
    envState.teamDomain = 'team..cloudflareaccess.com';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { next, called } = createNext();

    await cfAccessLoginMiddleware(
      createContext({ 'Cf-Access-Jwt-Assertion': 'tok' }),
      next,
    );

    expect(called()).toBe(true);
    expect(verifyCfAccessJwt).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('falls through on invalid JWT', async () => {
    envState.enabled = true;
    verifyState.next = { kind: 'invalid', code: 'ERR_JWT_EXPIRED' };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { next, called } = createNext();
    await cfAccessLoginMiddleware(
      createContext({ 'Cf-Access-Jwt-Assertion': 'tok' }),
      next
    );
    expect(called()).toBe(true);
    warnSpy.mockRestore();
  });

  it('falls through on JWKS-unavailable', async () => {
    envState.enabled = true;
    verifyState.next = { kind: 'jwks-unavailable' };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { next, called } = createNext();
    await cfAccessLoginMiddleware(
      createContext({ 'Cf-Access-Jwt-Assertion': 'tok' }),
      next
    );
    expect(called()).toBe(true);
    errSpy.mockRestore();
  });

  it('falls through when the JWT email does not match any Breeze user', async () => {
    envState.enabled = true;
    verifyState.next = {
      kind: 'claims',
      claims: { email: 'ghost@nowhere.test', sub: 'cf-1', aud: envState.audience, iss: `https://${envState.teamDomain}`, exp: 999, iat: 1 },
    };
    dbState.userRow = null;
    const { next, called } = createNext();
    await cfAccessLoginMiddleware(
      createContext({ 'Cf-Access-Jwt-Assertion': 'tok' }),
      next
    );
    expect(called()).toBe(true);
  });

  it('falls through when the matching user is inactive and audits the denial', async () => {
    envState.enabled = true;
    verifyState.next = {
      kind: 'claims',
      claims: { email: activeUser.email, sub: 'cf-1', aud: envState.audience, iss: `https://${envState.teamDomain}`, exp: 999, iat: 1, country: 'CA' },
    };
    dbState.userRow = { ...activeUser, status: 'suspended' };
    const { next, called } = createNext();
    await cfAccessLoginMiddleware(
      createContext({ 'Cf-Access-Jwt-Assertion': 'tok' }),
      next
    );
    expect(called()).toBe(true);
    expect(auditState.loginFailures).toHaveLength(1);
    expect(auditState.loginFailures[0]).toMatchObject({
      userId: activeUser.id,
      reason: 'account_inactive',
    });
  });

  it('mints tokens for a valid JWT + active user without MFA', async () => {
    envState.enabled = true;
    verifyState.next = {
      kind: 'claims',
      claims: { email: activeUser.email, sub: 'cf-1', aud: envState.audience, iss: `https://${envState.teamDomain}`, exp: 999, iat: 1, country: 'CA' },
    };
    dbState.userRow = { ...activeUser };
    const { next, called } = createNext();
    const res = await cfAccessLoginMiddleware(
      createContext({ 'Cf-Access-Jwt-Assertion': 'tok' }),
      next
    );
    expect(called()).toBe(false);
    expect(res).toBeInstanceOf(Response);
    const body = await (res as Response).json();
    expect(body.user.email).toBe(activeUser.email);
    expect(body.tokens.accessToken).toBe('access-tok');
    expect(body.mfaRequired).toBe(false);
    expect(tokenState.lastIdentity).toMatchObject({
      userId: activeUser.id,
      mfa: false,
      amr: ['cf_access'],
    });
    expect(cookieState.set).toBe('refresh-tok');
    expect(dbState.lastUpdateId).toBeNull();
    expect(auditState.audits[0]).toMatchObject({
      action: 'user.login',
      details: expect.objectContaining({ method: 'cf_access_jwt', cfAccessCountry: 'CA' }),
    });
  });

  it('returns no cookie, success audit, or last-login write when terminal finalization rejects', async () => {
    envState.enabled = true;
    verifyState.next = {
      kind: 'claims',
      claims: { email: activeUser.email, sub: 'cf-1', aud: envState.audience, iss: `https://${envState.teamDomain}`, exp: 999, iat: 1 },
    };
    dbState.userRow = { ...activeUser };
    vi.mocked(decideAuthenticatedUserSession)
      .mockRejectedValueOnce(new AuthIssuanceCapabilityError());

    const { next, called } = createNext();
    const res = await cfAccessLoginMiddleware(
      createContext({ 'Cf-Access-Jwt-Assertion': 'tok' }),
      next,
    );

    expect(called()).toBe(false);
    expect((res as Response).status).toBe(409);
    expect(cookieState.set).toBeNull();
    expect(dbState.lastUpdateId).toBeNull();
    expect(auditState.audits).toEqual([]);
  });

  it('honors a locked live enrollment decision even when the pre-auth user row had MFA disabled', async () => {
    envState.enabled = true;
    verifyState.next = {
      kind: 'claims',
      claims: { email: activeUser.email, sub: 'cf-1', aud: envState.audience, iss: `https://${envState.teamDomain}`, exp: 999, iat: 1 },
    };
    dbState.userRow = { ...activeUser, mfaEnabled: false };
    vi.mocked(decideAuthenticatedUserSession).mockResolvedValueOnce({
      kind: 'pending',
      tempToken: 'live-enrollment-token',
      primaryMfaMethod: 'passkey',
      passkeyAvailable: true,
      phoneLast4: null,
    } as never);

    const { next, called } = createNext();
    const res = await cfAccessLoginMiddleware(
      createContext({ 'Cf-Access-Jwt-Assertion': 'tok' }),
      next,
    );

    expect(called()).toBe(false);
    await expect((res as Response).json()).resolves.toMatchObject({
      mfaRequired: true,
      tempToken: 'live-enrollment-token',
      mfaMethod: 'passkey',
    });
  });

  it('binds the locked decision to the verified assertion email and denies drift', async () => {
    envState.enabled = true;
    verifyState.next = {
      kind: 'claims',
      claims: { email: 'Old.Name@Example.com', sub: 'cf-1', aud: envState.audience, iss: `https://${envState.teamDomain}`, exp: 999, iat: 1 },
    };
    dbState.userRow = { ...activeUser, email: 'old.name@example.com' };
    vi.mocked(decideAuthenticatedUserSession).mockImplementationOnce(async (input) => {
      expect(input).toMatchObject({
        primaryAuthenticationMethod: 'cf_access',
        credentialBinding: {
          kind: 'cf_access',
          verifiedEmail: 'old.name@example.com',
        },
      });
      throw new PendingMfaInvalidError();
    });

    const { next, called } = createNext();
    const response = await cfAccessLoginMiddleware(
      createContext({ 'Cf-Access-Jwt-Assertion': 'tok' }),
      next,
    );

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(401);
    expect(called()).toBe(false);
    expect(cookieState.set).toBeNull();
    expect(tokenState.lastIdentity).toBeNull();
  });

  it('delegates the complete identity to the high-level session issuer', async () => {
    envState.enabled = true;
    verifyState.next = {
      kind: 'claims',
      claims: { email: activeUser.email, sub: 'cf-1', aud: envState.audience, iss: `https://${envState.teamDomain}`, exp: 999, iat: 1 },
    };
    dbState.userRow = { ...activeUser };
    const { next } = createNext();
    const res = await cfAccessLoginMiddleware(
      createContext({ 'Cf-Access-Jwt-Assertion': 'tok' }),
      next
    );
    expect(res).toBeInstanceOf(Response);
    expect(tokenState.lastIdentity).toMatchObject({
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

  it('passes the signed native binding to Cloudflare assertion issuance', async () => {
    envState.enabled = true;
    verifyState.next = {
      kind: 'claims',
      claims: { email: activeUser.email, sub: 'cf-1', aud: envState.audience, iss: `https://${envState.teamDomain}`, exp: 999, iat: 1 },
    };
    dbState.userRow = { ...activeUser };
    const nativeBinding = 'c'.repeat(64);
    const { next } = createNext();

    const res = await cfAccessLoginMiddleware(createContext({
      'Cf-Access-Jwt-Assertion': 'tok',
      'x-breeze-native-auth-binding': nativeBinding,
    }), next);

    expect(res).toBeInstanceOf(Response);
    expect(decideAuthenticatedUserSession).toHaveBeenCalledWith(expect.objectContaining({
      authBinding: { kind: 'native', value: nativeBinding },
    }));
  });

  it('does not issue a session when the MFA temp-token path short-circuits', async () => {
    envState.enabled = true;
    envState.trustsMfa = false;
    verifyState.next = {
      kind: 'claims',
      claims: { email: activeUser.email, sub: 'cf-1', aud: envState.audience, iss: `https://${envState.teamDomain}`, exp: 999, iat: 1 },
    };
    dbState.userRow = { ...activeUser, mfaEnabled: true, mfaSecret: 'encrypted', mfaMethod: 'totp' };
    const { next } = createNext();
    await cfAccessLoginMiddleware(createContext({ 'Cf-Access-Jwt-Assertion': 'tok' }), next);
    expect(tokenState.lastIdentity).toBeNull();
  });

  it('issues an MFA temp token when user has MFA and TRUSTS_MFA is false', async () => {
    envState.enabled = true;
    envState.trustsMfa = false;
    verifyState.next = {
      kind: 'claims',
      claims: { email: activeUser.email, sub: 'cf-1', aud: envState.audience, iss: `https://${envState.teamDomain}`, exp: 999, iat: 1 },
    };
    dbState.userRow = { ...activeUser, mfaEnabled: true, mfaSecret: 'encrypted', mfaMethod: 'totp' };
    const { next, called } = createNext();
    const res = await cfAccessLoginMiddleware(
      createContext({ 'Cf-Access-Jwt-Assertion': 'tok' }),
      next
    );
    expect(called()).toBe(false);
    const body = await (res as Response).json();
    expect(body.mfaRequired).toBe(true);
    expect(body.tempToken).toBeTruthy();
    expect(body.mfaMethod).toBe('totp');
    expect(body.tokens).toBeNull();
    expect(tokenState.lastIdentity).toBeNull(); // no full token mint yet
    expect(tokenState.pendingInput).toEqual(expect.objectContaining({
      userId: activeUser.id,
      roleId: 'role-1',
      partnerId: 'partner-1',
      orgId: null,
      scope: 'partner',
      primaryAuthenticationMethod: 'cf_access',
      requireLocalMfa: true,
      externallySatisfiedMfa: false,
    }));
  });

  it('issues an MFA temp token when user has passkey MFA and TRUSTS_MFA is false', async () => {
    envState.enabled = true;
    envState.trustsMfa = false;
    verifyState.next = {
      kind: 'claims',
      claims: { email: activeUser.email, sub: 'cf-1', aud: envState.audience, iss: `https://${envState.teamDomain}`, exp: 999, iat: 1 },
    };
    dbState.userRow = { ...activeUser, mfaEnabled: true, mfaSecret: null, mfaMethod: 'passkey' };
    const { next, called } = createNext();
    const res = await cfAccessLoginMiddleware(
      createContext({ 'Cf-Access-Jwt-Assertion': 'tok' }),
      next
    );
    expect(called()).toBe(false);
    const body = await (res as Response).json();
    expect(body.mfaRequired).toBe(true);
    expect(body.mfaMethod).toBe('passkey');
    expect(body.tokens).toBeNull();
    expect(tokenState.lastIdentity).toBeNull();
  });

  it('mints tokens with mfa=true when TRUSTS_MFA is true even if user has MFA enabled', async () => {
    envState.enabled = true;
    envState.trustsMfa = true;
    verifyState.next = {
      kind: 'claims',
      claims: { email: activeUser.email, sub: 'cf-1', aud: envState.audience, iss: `https://${envState.teamDomain}`, exp: 999, iat: 1 },
    };
    dbState.userRow = { ...activeUser, mfaEnabled: true, mfaSecret: 'encrypted', mfaMethod: 'totp' };
    const { next, called } = createNext();
    const res = await cfAccessLoginMiddleware(
      createContext({ 'Cf-Access-Jwt-Assertion': 'tok' }),
      next
    );
    expect(called()).toBe(false);
    const body = await (res as Response).json();
    expect(body.mfaRequired).toBe(false);
    expect(tokenState.lastIdentity).toMatchObject({ mfa: true, amr: ['cf_access'] });
  });
});
