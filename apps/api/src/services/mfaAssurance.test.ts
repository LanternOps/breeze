import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  redisState,
  redisMock,
  dbState,
  dbMock,
  transactionMock,
  transactionEvents,
  transactionWrapperMock,
  schemaMocks,
  policyMock,
  lockPolicyMock,
  issueUserSessionMock,
  bindIssuedUserSessionMock,
} = vi.hoisted(() => {
  const store = new Map<string, string>();
  const schema = {
    users: { id: Symbol('users.id') },
    userPasskeys: {
      id: Symbol('userPasskeys.id'),
      userId: Symbol('userPasskeys.userId'),
      disabledAt: Symbol('userPasskeys.disabledAt'),
    },
  };
  const state = {
    userRows: [] as Array<Record<string, unknown>>,
    passkeyRows: [] as Array<Record<string, unknown>>,
  };
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => {
      const query: Record<string, unknown> = {};
      query.limit = vi.fn(async () => table === schema.users ? state.userRows : state.passkeyRows);
      query.for = vi.fn(() => query);
      query.where = vi.fn(() => query);
      return query;
    }),
  }));
  const database = { select };
  const transaction = { select };
  const events: string[] = [];
  const wrapper = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    events.push('tx-start');
    const result = await fn(transaction);
    events.push('tx-commit');
    return result;
  });
  return {
    redisState: { available: true, store },
    redisMock: {
      setex: vi.fn(async (key: string, _ttl: number, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      getdel: vi.fn(async (key: string) => {
        const value = store.get(key) ?? null;
        if (value !== null) store.delete(key);
        return value;
      }),
    },
    dbState: state,
    schemaMocks: schema,
    dbMock: database,
    transactionMock: transaction,
    transactionEvents: events,
    transactionWrapperMock: wrapper,
    policyMock: vi.fn(),
    lockPolicyMock: vi.fn(),
    issueUserSessionMock: vi.fn(),
    bindIssuedUserSessionMock: vi.fn(async () => { events.push('bind'); }),
  };
});

vi.mock('./redis', () => ({
  getRedis: () => redisState.available ? redisMock : null,
}));

vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
  isNull: vi.fn((value: unknown) => value),
}));

vi.mock('../db', () => ({
  db: dbMock,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

vi.mock('../db/schema', () => schemaMocks);

vi.mock('./mfaPolicy', () => ({
  resolveEffectiveMfaPolicy: policyMock,
  lockMfaPolicyPartner: lockPolicyMock,
}));

vi.mock('./userSession', () => ({
  issueUserSession: issueUserSessionMock,
  bindIssuedUserSession: bindIssuedUserSessionMock,
}));

vi.mock('./authLifecycle', () => ({
  withAuthLifecycleSystemTransaction: transactionWrapperMock,
}));

import {
  PendingMfaInvalidError,
  PendingMfaUnavailableError,
  consumePendingMfa,
  createPendingMfa,
  createPendingMfaForLogin,
  decideAuthenticatedUserSession,
  issueVerifiedPendingMfaSession,
  pendingMfaRecordsEqual,
  readPendingMfa,
  selectEffectiveMfaMethod,
  type CreatePendingMfaInput,
} from './mfaAssurance';

const now = new Date('2026-07-12T12:00:00.000Z');

function pendingInput(overrides: Partial<CreatePendingMfaInput> = {}): CreatePendingMfaInput {
  return {
    userId: 'user-1',
    authEpoch: 4,
    mfaEpoch: 7,
    expectedStatus: 'active',
    roleId: 'role-1',
    orgId: 'org-1',
    partnerId: 'partner-1',
    scope: 'organization',
    policyRequired: true,
    policySources: ['role', 'partner', 'organization'],
    allowedMethods: new Set(['totp', 'passkey', 'recovery_code']),
    enrolledMethods: new Set(['totp', 'passkey']),
    primaryAuthenticationMethod: 'password',
    configuredMfaMethod: 'totp',
    primaryMfaMethod: 'totp',
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.clearAllMocks();
  redisState.available = true;
  redisState.store.clear();
  transactionEvents.length = 0;
  dbState.userRows = [{
    id: 'user-1',
    email: 'user@example.com',
    name: 'User One',
    status: 'active',
    authEpoch: 4,
    mfaEpoch: 7,
    mfaEnabled: true,
    passwordHash: 'verified-password-hash',
    passwordChangedAt: new Date('2026-07-01T00:00:00.000Z'),
    mfaMethod: 'totp',
    mfaSecret: 'encrypted-secret',
    phoneNumber: null,
    phoneVerified: false,
  }];
  dbState.passkeyRows = [{ id: 'passkey-1' }];
  policyMock.mockResolvedValue({
    required: true,
    allowedMethods: new Set(['totp', 'passkey', 'recovery_code']),
    sources: ['role', 'partner', 'organization'],
  });
  issueUserSessionMock.mockResolvedValue({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresIn: 900,
    refreshExpiresIn: 604800,
    familyId: 'family-1',
  });
  lockPolicyMock.mockResolvedValue(undefined);
  bindIssuedUserSessionMock.mockImplementation(async () => { transactionEvents.push('bind'); });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pending MFA V2 state', () => {
  it.each([
    ['configured TOTP falls back to passkey', 'totp', ['passkey'], ['passkey', 'recovery_code'], 'passkey'],
    ['configured TOTP falls back to SMS before passkey', 'totp', ['sms', 'passkey'], ['sms', 'passkey'], 'sms'],
    ['configured passkey remains passkey', 'passkey', ['totp', 'passkey'], ['totp', 'passkey'], 'passkey'],
  ] as const)('%s', (_label, configuredMfaMethod, enrolled, allowed, expected) => {
    expect(selectEffectiveMfaMethod({
      configuredMfaMethod,
      enrolledMethods: new Set(enrolled),
      allowedMethods: new Set(allowed),
    })).toBe(expected);
  });

  it('creates login state from freshly loaded user, policy, enrollment, and authority', async () => {
    const created = await createPendingMfaForLogin({
      userId: 'user-1',
      roleId: 'role-1',
      orgId: 'org-1',
      partnerId: 'partner-1',
      scope: 'organization',
      primaryAuthenticationMethod: 'password',
    });

    const pending = await readPendingMfa(created.tempToken);
    expect(pending).toMatchObject({
      version: 2,
      userId: 'user-1',
      authEpoch: 4,
      mfaEpoch: 7,
      expectedStatus: 'active',
      policyRequired: true,
      policySources: ['role', 'partner', 'organization'],
      allowedMethods: ['totp', 'passkey', 'recovery_code'],
      enrolledMethods: ['totp', 'passkey'],
      primaryAuthenticationMethod: 'password',
      configuredMfaMethod: 'totp',
      primaryMfaMethod: 'totp',
    });
    expect(created).toMatchObject({
      primaryMfaMethod: 'totp',
      passkeyAvailable: true,
      phoneLast4: null,
    });
  });

  it('includes stored recovery-code enrollment in the exact enrolled-method snapshot', async () => {
    dbState.userRows[0]!.mfaRecoveryCodes = ['hashed-code'];

    const created = await createPendingMfaForLogin({
      userId: 'user-1',
      roleId: 'role-1',
      orgId: 'org-1',
      partnerId: 'partner-1',
      scope: 'organization',
      primaryAuthenticationMethod: 'password',
    });

    await expect(readPendingMfa(created.tempToken)).resolves.toMatchObject({
      enrolledMethods: ['totp', 'passkey', 'recovery_code'],
    });
  });

  it('stores the complete canonical snapshot for exactly five minutes', async () => {
    const tempToken = await createPendingMfa(pendingInput());

    expect(tempToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(redisMock.setex).toHaveBeenCalledOnce();
    const [key, ttl, raw] = redisMock.setex.mock.calls[0]!;
    expect(key).toBe(`mfa:pending:${tempToken}`);
    expect(ttl).toBe(300);
    expect(JSON.parse(raw)).toEqual({
      version: 2,
      userId: 'user-1',
      authEpoch: 4,
      mfaEpoch: 7,
      expectedStatus: 'active',
      roleId: 'role-1',
      orgId: 'org-1',
      partnerId: 'partner-1',
      scope: 'organization',
      policyRequired: true,
      policySources: ['role', 'partner', 'organization'],
      allowedMethods: ['totp', 'passkey', 'recovery_code'],
      enrolledMethods: ['totp', 'passkey'],
      primaryAuthenticationMethod: 'password',
      configuredMfaMethod: 'totp',
      primaryMfaMethod: 'totp',
      issuedAt: '2026-07-12T12:00:00.000Z',
      expiresAt: '2026-07-12T12:05:00.000Z',
    });
    await expect(readPendingMfa(tempToken)).resolves.toEqual(JSON.parse(raw));
  });

  it.each([
    ['legacy bare user id', 'user-1'],
    ['legacy partial JSON', JSON.stringify({ userId: 'user-1', mfaMethod: 'totp', amr: ['password'] })],
    ['version 1', JSON.stringify({ version: 1, userId: 'user-1' })],
    ['malformed JSON', '{not-json'],
    ['unknown field', JSON.stringify({
      version: 2,
      userId: 'user-1',
      authEpoch: 4,
      mfaEpoch: 7,
      expectedStatus: 'active',
      roleId: 'role-1',
      orgId: 'org-1',
      partnerId: 'partner-1',
      scope: 'organization',
      policyRequired: true,
      policySources: ['role', 'partner', 'organization'],
      allowedMethods: ['totp'],
      enrolledMethods: ['totp'],
      primaryAuthenticationMethod: 'password',
      primaryMfaMethod: 'totp',
      issuedAt: '2026-07-12T12:00:00.000Z',
      expiresAt: '2026-07-12T12:05:00.000Z',
      unexpected: true,
    })],
  ])('rejects %s records', async (_label, raw) => {
    redisState.store.set('mfa:pending:token', raw);
    await expect(readPendingMfa('token')).resolves.toBeNull();
  });

  it.each([
    ['negative auth epoch', { authEpoch: -1 }],
    ['fractional MFA epoch', { mfaEpoch: 1.5 }],
    ['inactive expected status', { expectedStatus: 'suspended' }],
    ['duplicate allowed method', { allowedMethods: ['totp', 'totp'] }],
    ['unknown enrolled method', { enrolledMethods: ['webauthn'] }],
    ['unbound primary MFA method', { primaryMfaMethod: 'sms' }],
    ['wrong primary authenticator', { primaryAuthenticationMethod: 'totp' }],
    ['invalid authority axes', { scope: 'organization', orgId: null }],
    ['expiry beyond five minutes', { expiresAt: '2026-07-12T12:05:01.000Z' }],
    ['already expired', { expiresAt: '2026-07-12T11:59:59.000Z' }],
  ])('rejects a structurally invalid V2 record: %s', async (_label, patch) => {
    const token = await createPendingMfa(pendingInput());
    const key = `mfa:pending:${token}`;
    const parsed = JSON.parse(redisState.store.get(key)!);
    redisState.store.set(key, JSON.stringify({ ...parsed, ...patch }));

    await expect(readPendingMfa(token)).resolves.toBeNull();
  });

  it('fails closed when Redis is unavailable or errors', async () => {
    redisState.available = false;
    await expect(createPendingMfa(pendingInput())).rejects.toBeInstanceOf(PendingMfaUnavailableError);
    await expect(readPendingMfa('token')).rejects.toBeInstanceOf(PendingMfaUnavailableError);
    await expect(consumePendingMfa('token')).rejects.toBeInstanceOf(PendingMfaUnavailableError);

    redisState.available = true;
    redisMock.get.mockRejectedValueOnce(new Error('redis down'));
    redisMock.getdel.mockRejectedValueOnce(new Error('redis down'));
    redisMock.setex.mockRejectedValueOnce(new Error('redis down'));
    await expect(readPendingMfa('token')).rejects.toBeInstanceOf(PendingMfaUnavailableError);
    await expect(consumePendingMfa('token')).rejects.toBeInstanceOf(PendingMfaUnavailableError);
    await expect(createPendingMfa(pendingInput())).rejects.toBeInstanceOf(PendingMfaUnavailableError);
  });

  it('atomically permits exactly one of two concurrent consumers', async () => {
    const token = await createPendingMfa(pendingInput());

    const results = await Promise.all([
      consumePendingMfa(token),
      consumePendingMfa(token),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(redisMock.getdel).toHaveBeenCalledTimes(2);
    expect(redisMock.get).not.toHaveBeenCalled();
  });

  it('compares every bound field, not only the user id', async () => {
    const token = await createPendingMfa(pendingInput());
    const pending = await readPendingMfa(token);
    expect(pending).not.toBeNull();

    expect(pendingMfaRecordsEqual(pending!, { ...pending!, mfaEpoch: 8 })).toBe(false);
    expect(pendingMfaRecordsEqual(pending!, { ...pending!, allowedMethods: ['totp'] })).toBe(false);
    expect(pendingMfaRecordsEqual(pending!, { ...pending! })).toBe(true);
  });

  it('consumes, reloads every authority axis and snapshot, then issues truthful AMR', async () => {
    const token = await createPendingMfa(pendingInput());
    const expectedPending = await readPendingMfa(token);

    const result = await issueVerifiedPendingMfaSession({
      tempToken: token,
      expectedPending: expectedPending!,
      verifiedMethod: 'passkey',
      mobileDeviceId: 'mobile-1',
    });

    expect(policyMock).toHaveBeenCalledWith({
      userId: 'user-1',
      roleId: 'role-1',
      orgId: 'org-1',
      partnerId: 'partner-1',
      scope: 'organization',
      tx: transactionMock,
    });
    expect(lockPolicyMock).toHaveBeenCalledWith(transactionMock, 'partner-1');
    expect(issueUserSessionMock).toHaveBeenCalledWith({
      userId: 'user-1',
      email: 'user@example.com',
      roleId: 'role-1',
      orgId: 'org-1',
      partnerId: 'partner-1',
      scope: 'organization',
      mfa: true,
      amr: ['password', 'passkey'],
      mobileDeviceId: 'mobile-1',
    }, { tx: transactionMock });
    expect(redisMock.getdel.mock.invocationCallOrder[0]!).toBeLessThan(dbMock.select.mock.invocationCallOrder[0]!);
    expect(dbMock.select.mock.invocationCallOrder.at(-1)!).toBeLessThan(issueUserSessionMock.mock.invocationCallOrder[0]!);
    expect(result.user).toMatchObject({ id: 'user-1', status: 'active' });
    expect(transactionEvents).toEqual(['tx-start', 'tx-commit', 'bind']);
  });

  it('preserves a verified Cloudflare Access primary method in post-factor AMR', async () => {
    const token = await createPendingMfa(pendingInput({
      primaryAuthenticationMethod: 'cf_access',
    }));
    const expectedPending = await readPendingMfa(token);

    await issueVerifiedPendingMfaSession({
      tempToken: token,
      expectedPending: expectedPending!,
      verifiedMethod: 'totp',
    });

    expect(issueUserSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      mfa: true,
      amr: ['cf_access', 'totp'],
    }), { tx: transactionMock });
  });

  it('issues when a configured TOTP fallback to passkey remains unchanged', async () => {
    dbState.userRows[0]!.mfaSecret = null;
    dbState.userRows[0]!.mfaMethod = 'totp';
    policyMock.mockResolvedValue({
      required: true,
      allowedMethods: new Set(['passkey']),
      sources: ['partner'],
    });
    const token = await createPendingMfa(pendingInput({
      policySources: ['partner'],
      allowedMethods: new Set(['passkey']),
      enrolledMethods: new Set(['passkey']),
      configuredMfaMethod: 'totp',
      primaryMfaMethod: 'passkey',
    }));
    const expectedPending = await readPendingMfa(token);

    await expect(issueVerifiedPendingMfaSession({
      tempToken: token,
      expectedPending: expectedPending!,
      verifiedMethod: 'passkey',
    })).resolves.toMatchObject({ tokens: { accessToken: 'access-token' } });
  });

  it('burns without issuance when policy drift changes the selected fallback factor', async () => {
    dbState.userRows[0]!.mfaSecret = null;
    dbState.userRows[0]!.mfaMethod = 'totp';
    dbState.userRows[0]!.phoneNumber = '+15551234567';
    dbState.userRows[0]!.phoneVerified = true;
    const token = await createPendingMfa(pendingInput({
      policySources: ['partner'],
      allowedMethods: new Set(['passkey']),
      enrolledMethods: new Set(['sms', 'passkey']),
      configuredMfaMethod: 'totp',
      primaryMfaMethod: 'passkey',
    }));
    const expectedPending = await readPendingMfa(token);
    policyMock.mockResolvedValue({
      required: true,
      allowedMethods: new Set(['sms', 'passkey']),
      sources: ['partner'],
    });

    await expect(issueVerifiedPendingMfaSession({
      tempToken: token,
      expectedPending: expectedPending!,
      verifiedMethod: 'passkey',
    })).rejects.toBeInstanceOf(PendingMfaInvalidError);
    expect(issueUserSessionMock).not.toHaveBeenCalled();
  });

  it('makes the password pending-vs-direct decision from locked live enrollment', async () => {
    dbState.userRows[0]!.mfaEnabled = false;
    dbState.userRows[0]!.mfaSecret = null;
    dbState.userRows[0]!.mfaMethod = 'totp';
    dbState.passkeyRows = [{ id: 'enrolled-after-password-check' }];
    policyMock.mockResolvedValue({
      required: false,
      allowedMethods: new Set(['passkey']),
      sources: [],
    });

    const decision = await decideAuthenticatedUserSession({
      userId: 'user-1',
      roleId: 'role-1',
      orgId: 'org-1',
      partnerId: 'partner-1',
      scope: 'organization',
      primaryAuthenticationMethod: 'password',
      requireLocalMfa: true,
      passwordCredential: {
        passwordHash: 'verified-password-hash',
        passwordChangedAt: new Date('2026-07-01T00:00:00.000Z'),
        authEpoch: 4,
      },
    });

    expect(decision).toMatchObject({
      kind: 'pending',
      primaryMfaMethod: 'passkey',
      passkeyAvailable: true,
    });
    expect(issueUserSessionMock).not.toHaveBeenCalled();
    expect(transactionEvents).toEqual(['tx-start', 'tx-commit']);
  });

  it('rejects a password credential changed before the locked login decision', async () => {
    dbState.userRows[0]!.authEpoch = 5;

    await expect(decideAuthenticatedUserSession({
      userId: 'user-1',
      roleId: 'role-1',
      orgId: 'org-1',
      partnerId: 'partner-1',
      scope: 'organization',
      primaryAuthenticationMethod: 'password',
      requireLocalMfa: true,
      passwordCredential: {
        passwordHash: 'verified-password-hash',
        passwordChangedAt: new Date('2026-07-01T00:00:00.000Z'),
        authEpoch: 4,
      },
    })).rejects.toBeInstanceOf(PendingMfaInvalidError);

    expect(issueUserSessionMock).not.toHaveBeenCalled();
  });

  it.each([
    ['status', () => { dbState.userRows[0]!.status = 'suspended'; }],
    ['password/auth epoch', () => { dbState.userRows[0]!.authEpoch = 5; }],
    ['MFA epoch', () => { dbState.userRows[0]!.mfaEpoch = 8; }],
    ['primary MFA method', () => { dbState.userRows[0]!.mfaMethod = 'sms'; }],
    ['enrolled TOTP', () => { dbState.userRows[0]!.mfaSecret = null; }],
    ['enrolled passkey', () => { dbState.passkeyRows = []; }],
    ['policy required state', () => { policyMock.mockResolvedValue({ required: false, allowedMethods: new Set(['totp', 'passkey', 'recovery_code']), sources: [] }); }],
    ['policy sources', () => { policyMock.mockResolvedValue({ required: true, allowedMethods: new Set(['totp', 'passkey', 'recovery_code']), sources: ['organization'] }); }],
    ['allowed methods', () => { policyMock.mockResolvedValue({ required: true, allowedMethods: new Set(['totp', 'recovery_code']), sources: ['role', 'partner', 'organization'] }); }],
  ])('burns the pending login without issuing when live %s changes', async (_label, mutate) => {
    const token = await createPendingMfa(pendingInput());
    const expectedPending = await readPendingMfa(token);
    mutate();

    await expect(issueVerifiedPendingMfaSession({
      tempToken: token,
      expectedPending: expectedPending!,
      verifiedMethod: 'totp',
    })).rejects.toBeInstanceOf(PendingMfaInvalidError);

    expect(redisState.store.has(`mfa:pending:${token}`)).toBe(false);
    expect(issueUserSessionMock).not.toHaveBeenCalled();
  });

  it('burns a consumed record that differs from the earlier verified record', async () => {
    const token = await createPendingMfa(pendingInput());
    const expectedPending = await readPendingMfa(token);
    const key = `mfa:pending:${token}`;
    const stored = JSON.parse(redisState.store.get(key)!);
    redisState.store.set(key, JSON.stringify({ ...stored, authEpoch: 5 }));

    await expect(issueVerifiedPendingMfaSession({
      tempToken: token,
      expectedPending: expectedPending!,
      verifiedMethod: 'totp',
    })).rejects.toBeInstanceOf(PendingMfaInvalidError);
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(issueUserSessionMock).not.toHaveBeenCalled();
  });

  it('fails closed before issuance when atomic consume is absent or Redis fails', async () => {
    const token = await createPendingMfa(pendingInput());
    const expectedPending = await readPendingMfa(token);
    redisState.store.delete(`mfa:pending:${token}`);

    await expect(issueVerifiedPendingMfaSession({
      tempToken: token,
      expectedPending: expectedPending!,
      verifiedMethod: 'totp',
    })).rejects.toBeInstanceOf(PendingMfaInvalidError);

    redisMock.getdel.mockRejectedValueOnce(new Error('redis down'));
    await expect(issueVerifiedPendingMfaSession({
      tempToken: token,
      expectedPending: expectedPending!,
      verifiedMethod: 'totp',
    })).rejects.toBeInstanceOf(PendingMfaUnavailableError);
    expect(issueUserSessionMock).not.toHaveBeenCalled();
  });

  it('allows exactly one issuer in a two-consumer race', async () => {
    const token = await createPendingMfa(pendingInput());
    const expectedPending = await readPendingMfa(token);

    const results = await Promise.allSettled([
      issueVerifiedPendingMfaSession({ tempToken: token, expectedPending: expectedPending!, verifiedMethod: 'totp' }),
      issueVerifiedPendingMfaSession({ tempToken: token, expectedPending: expectedPending!, verifiedMethod: 'totp' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(issueUserSessionMock).toHaveBeenCalledOnce();
  });
});
