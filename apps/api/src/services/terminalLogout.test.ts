import { beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycle = vi.hoisted(() => ({
  transaction: vi.fn(),
  lockAuthority: vi.fn(),
  advanceUser: vi.fn(),
  revokeAllFamilies: vi.fn(),
  revokeFamily: vi.fn(),
}));
const revocation = vi.hoisted(() => ({
  classifyRefresh: vi.fn(),
  revokeUserTokens: vi.fn(),
  revokeJti: vi.fn(),
  cacheFamily: vi.fn(),
}));
const jwt = vi.hoisted(() => ({ verifyToken: vi.fn() }));
const transition = vi.hoisted(() => ({
  resolveBinding: vi.fn(),
}));

vi.mock('./authLifecycle', () => ({
  withAuthLifecycleSystemTransaction: (fn: (tx: object) => Promise<unknown>) => lifecycle.transaction(fn),
  lockTerminalLogoutAuthority: (...args: unknown[]) => lifecycle.lockAuthority(...args),
  advanceUserSecurityState: (...args: unknown[]) => lifecycle.advanceUser(...args),
  revokeAllUserSessionFamilies: (...args: unknown[]) => lifecycle.revokeAllFamilies(...args),
  revokeUserSessionFamily: (...args: unknown[]) => lifecycle.revokeFamily(...args),
}));
vi.mock('./tokenRevocation', () => ({
  classifyRefreshTokenAuthority: (...args: unknown[]) => revocation.classifyRefresh(...args),
  revokeAllUserTokens: (...args: unknown[]) => revocation.revokeUserTokens(...args),
  revokeRefreshTokenJti: (...args: unknown[]) => revocation.revokeJti(...args),
  cacheRefreshTokenFamilyRevocation: (...args: unknown[]) => revocation.cacheFamily(...args),
}));
vi.mock('./jwt', () => ({
  verifyToken: (...args: unknown[]) => jwt.verifyToken(...args),
}));
vi.mock('./authBrowserTransition', () => ({
  resolveAuthBinding: (...args: unknown[]) => transition.resolveBinding(...args),
}));
vi.mock('../db/schema/authBrowserTransitions', () => ({
  authBrowserTransitions: {
    id: 'transition.id',
    bindingDigest: 'transition.bindingDigest',
    generation: 'transition.generation',
    state: 'transition.state',
    currentUserId: 'transition.currentUserId',
    currentFamilyId: 'transition.currentFamilyId',
    logoutId: 'transition.logoutId',
    completionNonceDigest: 'transition.completionNonceDigest',
    logoutExpiresAt: 'transition.logoutExpiresAt',
    activeOperationId: 'transition.activeOperationId',
    activeOperationExpiresAt: 'transition.activeOperationExpiresAt',
    updatedAt: 'transition.updatedAt',
  },
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn((...clauses: unknown[]) => ({ and: clauses })),
  eq: vi.fn((left: unknown, right: unknown) => ({ eq: [left, right] })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: Array.from(strings).join('?'),
    values,
  })),
}));

import { prepareTerminalLogout } from './terminalLogout';

const txState = {
  transition: {
    id: 'transition-1',
    generation: 7,
    state: 'active',
    currentUserId: 'user-c',
    currentFamilyId: 'family-c',
  },
  pending: null as null | Record<string, unknown>,
};

function makeTx() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          for: vi.fn(() => ({
            limit: vi.fn(async () => [txState.transition]),
          })),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            txState.pending = values;
            return [{
              id: 'transition-1',
              generation: 8,
              logoutId: 'logout-1',
              logoutExpiresAt: new Date('2026-07-13T00:10:00.000Z'),
            }];
          }),
        })),
      })),
    })),
  };
}

const ACCESS = {
  userId: 'user-a',
  familyId: 'family-a',
  authEpoch: 4,
  mfaEpoch: 5,
};
const BINDING = { kind: 'browser' as const, value: 'a'.repeat(64) };

function lockedAuthority(overrides: Record<string, unknown> = {}) {
  return {
    users: new Map([
      ['user-a', { id: 'user-a', status: 'active', authEpoch: 4, mfaEpoch: 5 }],
      ['user-b', { id: 'user-b', status: 'active', authEpoch: 9, mfaEpoch: 11 }],
      ['user-c', { id: 'user-c', status: 'active', authEpoch: 1, mfaEpoch: 1 }],
    ]),
    families: new Map([
      ['family-a', { familyId: 'family-a', userId: 'user-a', revokedAt: null, absoluteExpiresAt: new Date('2099-01-01') }],
      ['family-b', { familyId: 'family-b', userId: 'user-b', revokedAt: null, absoluteExpiresAt: new Date('2099-01-01') }],
      ['family-c', { familyId: 'family-c', userId: 'user-c', revokedAt: null, absoluteExpiresAt: new Date('2099-01-01') }],
    ]),
    databaseNow: new Date('2026-07-13T00:00:00.000Z'),
    ...overrides,
  };
}

describe('prepareTerminalLogout subject classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txState.pending = null;
    transition.resolveBinding.mockReturnValue({ kind: 'browser', bindingDigest: 'd'.repeat(64) });
    lifecycle.transaction.mockImplementation(async (fn: (tx: object) => Promise<unknown>) => fn(makeTx()));
    lifecycle.lockAuthority.mockResolvedValue(lockedAuthority());
    lifecycle.advanceUser.mockResolvedValue({ authEpoch: 10 });
    lifecycle.revokeAllFamilies.mockResolvedValue(2);
    lifecycle.revokeFamily.mockResolvedValue(1);
    revocation.revokeUserTokens.mockResolvedValue(undefined);
    revocation.revokeJti.mockResolvedValue(true);
    revocation.cacheFamily.mockResolvedValue(undefined);
    jwt.verifyToken.mockResolvedValue({
      type: 'refresh', sub: 'user-b', fam: 'family-b', jti: 'jti-b', ae: 9, me: 11,
    });
    revocation.classifyRefresh.mockResolvedValue({ kind: 'current', userId: 'user-b', familyId: 'family-b' });
  });

  it('globally invalidates live bearer A and independently current refresh B, then exactly revokes linked C', async () => {
    const result = await prepareTerminalLogout({ binding: BINDING, access: ACCESS, refreshToken: 'refresh-b' });

    expect(lifecycle.advanceUser.mock.calls.map((call) => call[1])).toEqual(['user-a', 'user-b']);
    expect(lifecycle.revokeAllFamilies.mock.calls.map((call) => call[1])).toEqual(['user-a', 'user-b']);
    expect(lifecycle.revokeFamily).toHaveBeenCalledWith(
      expect.anything(), 'user-c', 'family-c', 'cf-access-terminal-logout',
    );
    expect(result).toMatchObject({
      transitionId: 'transition-1',
      generation: 8,
      logoutId: 'logout-1',
      subjectIds: ['user-a', 'user-b'],
      cleanupStatus: 'complete',
    });
    expect(result.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(txState.pending).toMatchObject({ state: 'logout_pending' });
  });

  it.each([
    ['stale rotated', { kind: 'legacy_or_stale_family', familyId: 'family-b' }],
    ['legacy null', { kind: 'legacy_or_stale_family', familyId: 'family-b' }],
  ])('revokes %s refresh B exactly without selecting B globally', async (_label, authority) => {
    revocation.classifyRefresh.mockResolvedValue(authority);

    const result = await prepareTerminalLogout({ binding: BINDING, access: ACCESS, refreshToken: 'refresh-b' });

    expect(result.subjectIds).toEqual(['user-a']);
    expect(lifecycle.revokeFamily).toHaveBeenCalledWith(
      expect.anything(), 'user-b', 'family-b', 'cf-access-terminal-logout',
    );
    expect(lifecycle.advanceUser.mock.calls.map((call) => call[1])).toEqual(['user-a']);
  });

  it.each(['revoked', 'expired', 'malformed', 'wrong-owner'])('ignores %s refresh B for global selection', async (kind) => {
    if (kind === 'malformed') jwt.verifyToken.mockResolvedValue(null);
    revocation.classifyRefresh.mockResolvedValue({ kind: 'invalid' });

    const result = await prepareTerminalLogout({ binding: BINDING, access: ACCESS, refreshToken: 'refresh-b' });

    expect(result.subjectIds).toEqual(['user-a']);
    expect(lifecycle.advanceUser.mock.calls.map((call) => call[1])).toEqual(['user-a']);
    expect(lifecycle.revokeFamily).not.toHaveBeenCalledWith(
      expect.anything(), 'user-b', 'family-b', expect.anything(),
    );
  });

  it('rolls back pending state when authoritative refresh classification fails', async () => {
    revocation.classifyRefresh.mockRejectedValue(new Error('postgres classification failed'));
    lifecycle.transaction.mockImplementation(async (fn: (tx: object) => Promise<unknown>) => {
      const before = txState.pending;
      try {
        return await fn(makeTx());
      } catch (error) {
        txState.pending = before;
        throw error;
      }
    });

    await expect(prepareTerminalLogout({ binding: BINDING, access: ACCESS, refreshToken: 'refresh-b' }))
      .rejects.toThrow('postgres classification failed');
    expect(txState.pending).toBeNull();
    expect(revocation.revokeUserTokens).not.toHaveBeenCalled();
  });

  it('reports Redis cleanup failure only after durable invalidation commits', async () => {
    revocation.revokeUserTokens.mockRejectedValueOnce(new Error('redis unavailable'));

    const result = await prepareTerminalLogout({ binding: BINDING, access: ACCESS, refreshToken: 'refresh-b' });

    expect(result.cleanupStatus).toBe('partial');
    expect(result.cleanupFailures).toContain('user:user-a');
    expect(lifecycle.advanceUser).toHaveBeenCalledTimes(2);
    expect(lifecycle.revokeAllFamilies).toHaveBeenCalledTimes(2);
  });
});
