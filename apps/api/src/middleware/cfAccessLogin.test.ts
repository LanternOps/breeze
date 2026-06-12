import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';

const envState = vi.hoisted(() => ({
  enabled: false,
  teamDomain: 'your-team.cloudflareaccess.com',
  audience: 'aud-app-1234567890abcdef',
  trustsMfa: false,
}));

vi.mock('../config/env', () => ({
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
  lastPayload: null as Record<string, unknown> | null,
  lastOptions: null as Record<string, unknown> | null,
  mintCalls: [] as string[],
  bindCalls: [] as Array<{ jti: string; familyId: string }>,
}));

vi.mock('../services', () => ({
  createTokenPair: vi.fn(
    async (payload: Record<string, unknown>, options?: Record<string, unknown>) => {
      tokenState.lastPayload = payload;
      tokenState.lastOptions = options ?? null;
      return {
        accessToken: 'access-tok',
        refreshToken: 'refresh-tok',
        refreshJti: 'jti-new',
        expiresInSeconds: 900,
      };
    }
  ),
  mintRefreshTokenFamily: vi.fn(async (userId: string) => {
    tokenState.mintCalls.push(userId);
    return 'fam-1';
  }),
  bindRefreshJtiToFamily: vi.fn(async (jti: string, familyId: string) => {
    tokenState.bindCalls.push({ jti, familyId });
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
    tokenState.lastPayload = null;
    tokenState.lastOptions = null;
    tokenState.mintCalls = [];
    tokenState.bindCalls = [];
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
      claims: { email: activeUser.email, sub: 'cf-1', aud: envState.audience, iss: `https://${envState.teamDomain}`, exp: 999, iat: 1 },
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
      claims: { email: activeUser.email, sub: 'cf-1', aud: envState.audience, iss: `https://${envState.teamDomain}`, exp: 999, iat: 1 },
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
    expect(tokenState.lastPayload).toMatchObject({
      sub: activeUser.id,
      mfa: true, // vacuously satisfied because mfaEnabled=false
    });
    expect(cookieState.set).toBe('refresh-tok');
    expect(dbState.lastUpdateId).toBe(activeUser.id);
    expect(auditState.audits[0]).toMatchObject({
      action: 'user.login',
      details: expect.objectContaining({ method: 'cf_access_jwt' }),
    });
  });

  it('binds the minted refresh token to a fresh family (reuse-detection invariant)', async () => {
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
    // 1. A fresh family was minted for this user.
    expect(tokenState.mintCalls).toEqual([activeUser.id]);
    // 2. createTokenPair received the family id via refreshFam.
    expect(tokenState.lastOptions).toMatchObject({ refreshFam: 'fam-1' });
    // 3. The minted refresh jti was bound to the family in Redis.
    expect(tokenState.bindCalls).toEqual([{ jti: 'jti-new', familyId: 'fam-1' }]);
  });

  it('does not mint a family when the MFA temp-token path short-circuits', async () => {
    envState.enabled = true;
    envState.trustsMfa = false;
    verifyState.next = {
      kind: 'claims',
      claims: { email: activeUser.email, sub: 'cf-1', aud: envState.audience, iss: `https://${envState.teamDomain}`, exp: 999, iat: 1 },
    };
    dbState.userRow = { ...activeUser, mfaEnabled: true, mfaSecret: 'encrypted', mfaMethod: 'totp' };
    const { next } = createNext();
    await cfAccessLoginMiddleware(createContext({ 'Cf-Access-Jwt-Assertion': 'tok' }), next);
    expect(tokenState.mintCalls).toEqual([]);
    expect(tokenState.bindCalls).toEqual([]);
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
    expect(tokenState.lastPayload).toBeNull(); // no full token mint yet
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
    expect(tokenState.lastPayload).toBeNull();
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
    expect(tokenState.lastPayload).toMatchObject({ mfa: true });
  });
});
