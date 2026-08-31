import { beforeEach, describe, expect, it, vi } from 'vitest';

const transitionState = vi.hoisted(() => {
  class AuthBindingRotationRequiredError extends Error {
    constructor(readonly replacement: { kind: 'browser'; value: string }) {
      super('rotation required');
    }
  }
  class AuthBindingUnavailableError extends Error {}
  class AuthIssuanceCapabilityError extends Error {}
  class AuthIssuanceConflictError extends Error {}
  return {
    AuthBindingRotationRequiredError,
    AuthBindingUnavailableError,
    AuthIssuanceCapabilityError,
    AuthIssuanceConflictError,
    finishError: null as Error | null,
    events: [] as string[],
    beginCalls: 0,
    cancelCalls: 0,
    enforcement: false,
  };
});

const routeState = vi.hoisted(() => ({
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'invitee@example.com',
    name: 'Invitee',
    status: 'invited',
    passwordHash: null as string | null,
    authEpoch: 3,
    mfaEpoch: 2,
  },
  redis: new Map<string, string>(),
  familyCount: 0,
  oldFamilyRevoked: false,
  cookieKind: null as 'guarded' | 'legacy' | null,
  replacement: null as string | null,
  legacyMetric: [] as string[],
}));

function userRows() {
  return routeState.user ? [{ ...routeState.user }] : [];
}

function selectChain(rows: () => unknown[]) {
  const terminal = Promise.resolve(rows()) as Promise<unknown[]> & {
    limit: () => unknown;
    for: () => Promise<unknown[]>;
  };
  terminal.for = vi.fn(async () => rows());
  terminal.limit = vi.fn(() => terminal);
  const chain = {
    from: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    where: vi.fn(() => terminal),
    limit: vi.fn(() => terminal),
  };
  return chain;
}

function updateChain() {
  let values: Record<string, unknown> = {};
  const returning = vi.fn(async () => {
    if (values.passwordHash !== undefined) {
      Object.assign(routeState.user, values);
    }
    return [{ id: routeState.user.id }];
  });
  const chain = {
    set: vi.fn((next: Record<string, unknown>) => {
      values = next;
      return chain;
    }),
    where: vi.fn(() => ({ returning })),
  };
  return chain;
}

const fakeTx = {
  select: vi.fn(() => selectChain(userRows)),
  update: vi.fn(() => updateChain()),
};

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => selectChain(userRows)),
    update: vi.fn(() => updateChain()),
    transaction: vi.fn(async (callback: (tx: typeof fakeTx) => unknown) => callback(fakeTx)),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../../db/schema', () => ({
  users: {
    id: 'users.id', email: 'users.email', name: 'users.name', status: 'users.status',
    authEpoch: 'users.authEpoch', mfaEpoch: 'users.mfaEpoch',
  },
  partners: { id: 'partners.id', name: 'partners.name' },
  organizations: { id: 'organizations.id', name: 'organizations.name' },
}));

const redis = {
  get: vi.fn(async (key: string) => routeState.redis.get(key) ?? null),
  del: vi.fn(async (key: string) => {
    transitionState.events.push(`redis-del:${key}`);
    return routeState.redis.delete(key) ? 1 : 0;
  }),
};

vi.mock('../../services', () => ({
  hashPassword: vi.fn(async () => 'new-password-hash'),
  isPasswordStrong: vi.fn(() => ({ valid: true, errors: [] })),
  getRedis: vi.fn(() => redis),
  rateLimiter: vi.fn(async () => ({ allowed: true })),
  createTokenPair: vi.fn(async () => ({
    accessToken: 'old-access', refreshToken: 'old-refresh', refreshJti: 'old-jti', expiresInSeconds: 900,
  })),
  mintRefreshTokenFamily: vi.fn(async () => {
    routeState.familyCount += 1;
    return 'old-family';
  }),
  bindRefreshJtiToFamily: vi.fn(async () => undefined),
  getUserEpochs: vi.fn(async () => ({ authEpoch: routeState.user.authEpoch, mfaEpoch: routeState.user.mfaEpoch })),
}));

vi.mock('../../services/authBrowserTransition', () => ({
  AuthBindingRotationRequiredError: transitionState.AuthBindingRotationRequiredError,
  AuthBindingUnavailableError: transitionState.AuthBindingUnavailableError,
  AuthIssuanceCapabilityError: transitionState.AuthIssuanceCapabilityError,
  AuthIssuanceConflictError: transitionState.AuthIssuanceConflictError,
  beginAuthIssuance: vi.fn(async () => {
    transitionState.beginCalls += 1;
    transitionState.events.push('admit');
    return { transitionId: 'transition-1', generation: 1, operationId: 'operation-1' };
  }),
  cancelAuthIssuance: vi.fn(async () => {
    transitionState.cancelCalls += 1;
  }),
  finishAuthIssuance: vi.fn(async (_capability: unknown, callback: (tx: typeof fakeTx) => Promise<unknown>) => {
    transitionState.events.push('finish-start');
    if (transitionState.finishError) throw transitionState.finishError;
    const result = await callback(fakeTx);
    transitionState.events.push('finish-commit');
    return result;
  }),
}));

vi.mock('../../services/userSession', () => ({
  authBrowserTransitionsEnforced: vi.fn(() => transitionState.enforcement),
  issueUserSession: vi.fn(async (_identity: unknown, options: { expectedEpochs: { authEpoch: number; mfaEpoch: number } }) => {
    expect(options.expectedEpochs).toEqual({
      authEpoch: routeState.user.authEpoch,
      mfaEpoch: routeState.user.mfaEpoch,
    });
    transitionState.events.push('issue-guarded');
    routeState.familyCount += 1;
    return {
      accessToken: 'guarded-access', refreshToken: 'guarded-refresh', refreshJti: 'guarded-jti',
      expiresInSeconds: 900, familyId: 'guarded-family', transitionId: 'transition-1', generation: 1,
    };
  }),
  issueUserSessionLegacyDuringTransition: vi.fn(async () => {
    transitionState.events.push('issue-legacy');
    routeState.familyCount += 1;
    return {
      accessToken: 'legacy-access', refreshToken: 'legacy-refresh', refreshJti: 'legacy-jti',
      expiresInSeconds: 900, familyId: 'legacy-family',
    };
  }),
  bindIssuedUserSession: vi.fn(async () => undefined),
}));

vi.mock('../../services/authLifecycle', () => ({
  advanceUserEpochs: vi.fn(async () => {
    routeState.user.authEpoch += 1;
    return {
      authEpoch: routeState.user.authEpoch,
      mfaEpoch: routeState.user.mfaEpoch,
      emailEpoch: 1,
      passwordResetEpoch: 1,
    };
  }),
  lockActiveRefreshFamiliesForUsers: vi.fn(async () => {
    transitionState.events.push('lock:families');
  }),
  revokeAllRefreshFamilies: vi.fn(async () => {
    transitionState.events.push('revoke:families');
    routeState.oldFamilyRevoked = true;
  }),
}));

vi.mock('../../services/authTransitionMetrics', () => ({
  recordAuthTransitionLegacyIssuer: vi.fn((issuer: string) => routeState.legacyMetric.push(issuer)),
}));

vi.mock('./binding', () => ({
  requestAuthBinding: vi.fn(() => ({ kind: 'browser', value: 'a'.repeat(64) })),
  installAuthBindingReplacement: vi.fn((_c: unknown, replacement: { value: string }) => {
    routeState.replacement = replacement.value;
  }),
}));

vi.mock('./helpers', async () => {
  const actual = await vi.importActual<typeof import('./helpers')>('./helpers');
  return {
    ...actual,
    getClientRateLimitKey: vi.fn(() => 'client'),
    resolveCurrentUserTokenContext: vi.fn(async () => ({
      roleId: 'role-1', orgId: 'org-1', partnerId: 'partner-1', scope: 'organization' as const,
    })),
    resolveUserAuditOrgId: vi.fn(async () => 'org-1'),
    writeAuthAudit: vi.fn(),
    isAuthTransitionV1Request: vi.fn((c: { req: { header: (name: string) => string | undefined } }) =>
      c.req.header('x-breeze-auth-transition') === 'v1'),
    authClientUpgradeRequiredResponse: vi.fn((c: any) =>
      c.json({ error: 'Authentication client upgrade required', reason: 'auth_client_upgrade_required' }, 426)),
    installAuthorizedUserSessionCookies: vi.fn(() => { routeState.cookieKind = 'guarded'; }),
    installLegacyUserSessionCookiesDuringTransition: vi.fn(() => { routeState.cookieKind = 'legacy'; }),
  };
});

import { inviteRoutes } from './invite';
import { hashInviteToken, inviteRedisKey, inviteUserRedisKey, writeAuthAudit } from './helpers';

const token = 'invite-token';
const tokenKey = inviteRedisKey(hashInviteToken(token));
const userKey = inviteUserRedisKey(routeState.user.id);

async function accept(headers: Record<string, string> = {}) {
  return inviteRoutes.request('/accept-invite', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ token, password: 'StrongPassword123!' }),
  });
}

describe('POST /accept-invite guarded issuance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transitionState.finishError = null;
    transitionState.events = [];
    transitionState.beginCalls = 0;
    transitionState.cancelCalls = 0;
    transitionState.enforcement = false;
    Object.assign(routeState.user, {
      status: 'invited', passwordHash: null, authEpoch: 3, mfaEpoch: 2,
    });
    routeState.redis = new Map([[tokenKey, routeState.user.id], [userKey, hashInviteToken(token)]]);
    routeState.familyCount = 0;
    routeState.oldFamilyRevoked = false;
    routeState.cookieKind = null;
    routeState.replacement = null;
    routeState.legacyMetric = [];
  });

  it('leaves password, status, epochs, families, audits, cookies, and Redis authority unchanged when logout wins', async () => {
    transitionState.finishError = new transitionState.AuthIssuanceCapabilityError();

    const response = await accept({ 'x-breeze-auth-transition': 'v1' });

    expect(response.status).toBe(409);
    expect(routeState.user).toMatchObject({ status: 'invited', passwordHash: null, authEpoch: 3, mfaEpoch: 2 });
    expect(routeState.familyCount).toBe(0);
    expect(routeState.oldFamilyRevoked).toBe(false);
    expect(routeState.cookieKind).toBeNull();
    expect(routeState.redis.get(tokenKey)).toBe(routeState.user.id);
    expect(routeState.redis.get(userKey)).toBe(hashInviteToken(token));
    expect(writeAuthAudit).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'success' }),
    );
  });

  it('commits activation, epoch advance, family replacement, then deletes Redis keys and installs guarded cookies', async () => {
    const response = await accept({ 'x-breeze-auth-transition': 'v1' });

    expect(response.status).toBe(200);
    expect(routeState.user).toMatchObject({ status: 'active', passwordHash: 'new-password-hash', authEpoch: 4 });
    expect(routeState.oldFamilyRevoked).toBe(true);
    expect(routeState.familyCount).toBe(1);
    expect(routeState.cookieKind).toBe('guarded');
    expect(routeState.redis.has(tokenKey)).toBe(false);
    expect(routeState.redis.has(userKey)).toBe(false);
    expect(transitionState.events).toEqual(expect.arrayContaining([
      'finish-start', 'lock:families', 'revoke:families', 'issue-guarded', 'finish-commit',
    ]));
    expect(transitionState.events.indexOf('lock:families')).toBeLessThan(
      transitionState.events.indexOf('revoke:families'),
    );
    expect(transitionState.events.indexOf('revoke:families')).toBeLessThan(
      transitionState.events.indexOf('issue-guarded'),
    );
    expect(transitionState.events.indexOf('finish-commit')).toBeLessThan(
      transitionState.events.findIndex((event) => event.startsWith('redis-del:')),
    );
  });

  it('installs a replacement binding and returns the exact 428 mapping', async () => {
    transitionState.finishError = new transitionState.AuthBindingRotationRequiredError({
      kind: 'browser', value: 'b'.repeat(64),
    });

    const response = await accept({ 'x-breeze-auth-transition': 'v1' });

    expect(response.status).toBe(428);
    expect(await response.json()).toEqual({
      error: 'Authentication binding refresh required', reason: 'binding_refresh',
    });
    expect(routeState.replacement).toBe('b'.repeat(64));
  });

  it('keeps enforcement-false legacy issuance on the branded legacy boundary', async () => {
    const response = await accept();

    expect(response.status).toBe(200);
    expect(transitionState.beginCalls).toBe(0);
    expect(routeState.cookieKind).toBe('legacy');
    expect(routeState.legacyMetric).toEqual(['invite']);
  });

  it('rejects a legacy client before mutation when enforcement is enabled', async () => {
    transitionState.enforcement = true;

    const response = await accept();

    expect(response.status).toBe(426);
    expect(routeState.user.status).toBe('invited');
    expect(routeState.familyCount).toBe(0);
    expect(routeState.redis.get(tokenKey)).toBe(routeState.user.id);
  });
});
