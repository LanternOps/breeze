import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  events: [] as string[],
  tx: {} as any,
  memberRows: [] as unknown[][],
  teardownResult: 0,
}));

const lifecycle = vi.hoisted(() => ({
  invalidateOne: vi.fn(),
  invalidateMany: vi.fn(),
}));

vi.mock('./authLifecycle', () => ({
  withAuthLifecycleSystemTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(state.tx)),
  invalidateUserMfaAssurance: lifecycle.invalidateOne,
  invalidateUsersMfaAssurance: lifecycle.invalidateMany,
}));

vi.mock('./mfaPolicy', () => ({
  lockMfaPolicyPartner: vi.fn(async () => { state.events.push('partner-policy'); }),
}));

vi.mock('./mfaAssuranceLocks', () => ({
  lockMfaAssuranceState: vi.fn(async (_tx: unknown, input: { userId: string }) => {
    state.events.push(`user-factor:${input.userId}`);
    return {
      user: { id: input.userId, status: 'active', authEpoch: 4, mfaEpoch: 7 },
      activePasskeyCount: 0,
    };
  }),
}));

vi.mock('../db/schema', () => ({
  partnerUsers: { userId: 'partnerUsers.userId', partnerId: 'partnerUsers.partnerId' },
  organizationUsers: { userId: 'organizationUsers.userId', orgId: 'organizationUsers.orgId' },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId', deletedAt: 'organizations.deletedAt' },
}));

vi.mock('./session', () => ({ invalidateAllUserSessions: vi.fn(async () => undefined) }));
vi.mock('./tokenRevocation', () => ({ revokeAllUserTokens: vi.fn(async () => undefined) }));
vi.mock('./permissions', () => ({ clearPermissionCache: vi.fn(async () => undefined) }));
vi.mock('./remoteSessionTeardown', () => ({
  TEARDOWN_FAILED: -1,
  terminateUserRemoteSessions: vi.fn(async () => state.teardownResult),
}));

import {
  cleanupMfaAssuranceUsers,
  invalidateMfaPolicyAssurance,
  runLockedMfaMutation,
} from './mfaAssuranceMutation';

describe('MFA assurance mutation orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.events.length = 0;
    state.memberRows = [];
    state.teardownResult = 0;
    state.tx = {
      select: vi.fn(() => {
        const rows = state.memberRows.shift() ?? [];
        const query: any = {};
        query.from = vi.fn(() => query);
        query.innerJoin = vi.fn(() => query);
        query.where = vi.fn(async () => rows);
        return query;
      }),
    };
    lifecycle.invalidateOne.mockImplementation(async () => {
      state.events.push('epoch-families');
      return { securityState: { id: 'user-1', mfaEpoch: 8 }, revokedFamilyCount: 2 };
    });
    lifecycle.invalidateMany.mockResolvedValue({ advancedUserCount: 3, revokedFamilyCount: 4 });
  });

  it('locks and revalidates before mutation, then invalidates in the same transaction', async () => {
    const result = await runLockedMfaMutation({
      userId: 'user-1',
      partnerId: 'partner-1',
      authEpoch: 4,
      mfaEpoch: 7,
      reason: 'factor-changed',
    }, async (tx) => {
      expect(tx).toBe(state.tx);
      state.events.push('factor-write');
      return 'written';
    });

    expect(state.events).toEqual(['user-factor:user-1', 'factor-write', 'epoch-families']);
    expect(result).toMatchObject({ result: 'written', revokedFamilyCount: 2 });
  });

  it('locks affected users in stable order and performs one set-based policy invalidation', async () => {
    state.memberRows.push(
      [{ userId: 'user-b' }, { userId: 'user-a' }],
      [{ userId: 'user-c' }, { userId: 'user-a' }],
    );

    const result = await invalidateMfaPolicyAssurance(state.tx, {
      partnerId: 'partner-1',
      reason: 'partner-mfa-policy-changed',
    });

    expect(state.events).toEqual([
      'partner-policy',
      'user-factor:user-a',
      'user-factor:user-b',
      'user-factor:user-c',
    ]);
    expect(lifecycle.invalidateMany).toHaveBeenCalledOnce();
    expect(lifecycle.invalidateMany).toHaveBeenCalledWith(
      state.tx,
      ['user-a', 'user-b', 'user-c'],
      'partner-mfa-policy-changed',
    );
    expect(result).toEqual({
      userIds: ['user-a', 'user-b', 'user-c'],
      revokedFamilyCount: 4,
    });
  });

  it('reports remote teardown failure as partial after durable invalidation', async () => {
    state.teardownResult = -1;
    const result = await cleanupMfaAssuranceUsers(['user-1']);

    expect(result.cleanupStatus).toBe('partial');
    expect(result.cleanupFailures).toEqual(['remote-sessions:user-1']);
  });
});
