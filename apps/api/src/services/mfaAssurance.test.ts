import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  dbTransactionMock,
  advanceUserEpochsMock,
  revokeAllRefreshFamiliesMock,
  runPostCommitCleanupMock,
  terminateUserRemoteSessionsMock,
} = vi.hoisted(() => ({
  dbTransactionMock: vi.fn(),
  advanceUserEpochsMock: vi.fn(),
  revokeAllRefreshFamiliesMock: vi.fn(),
  runPostCommitCleanupMock: vi.fn(),
  terminateUserRemoteSessionsMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    transaction: dbTransactionMock,
  },
}));

vi.mock('./authLifecycle', () => ({
  advanceUserEpochs: advanceUserEpochsMock,
  revokeAllRefreshFamilies: revokeAllRefreshFamiliesMock,
  runPostCommitCleanup: runPostCommitCleanupMock,
}));

vi.mock('./remoteSessionTeardown', () => ({
  terminateUserRemoteSessions: terminateUserRemoteSessionsMock,
  TEARDOWN_FAILED: -1,
}));

import { invalidateMfaAssuranceAfterFactorChange } from './mfaAssurance';
import { TEARDOWN_FAILED } from './remoteSessionTeardown';

describe('invalidateMfaAssuranceAfterFactorChange', () => {
  const userId = 'user-123';
  const fakeTx = { marker: 'tx' } as unknown;
  const epochRow = { authEpoch: 1, mfaEpoch: 2, emailEpoch: 1, passwordResetEpoch: 1 };

  beforeEach(() => {
    vi.clearAllMocks();
    dbTransactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx));
    advanceUserEpochsMock.mockResolvedValue(epochRow);
    revokeAllRefreshFamiliesMock.mockResolvedValue(undefined);
    runPostCommitCleanupMock.mockResolvedValue({ redisOk: true, permissionCacheOk: true, oauthOk: true });
    terminateUserRemoteSessionsMock.mockResolvedValue(3);
  });

  // (a) mutate runs inside the tx before advanceUserEpochs/revokeAllRefreshFamilies.
  it('runs mutate(tx) inside the transaction before advancing epochs and revoking families, then post-commit cleanup + teardown', async () => {
    const callOrder: string[] = [];
    const mutate = vi.fn(async (tx: unknown) => {
      expect(tx).toBe(fakeTx);
      callOrder.push('mutate');
    });
    advanceUserEpochsMock.mockImplementation(async () => {
      callOrder.push('advanceUserEpochs');
      return epochRow;
    });
    revokeAllRefreshFamiliesMock.mockImplementation(async () => {
      callOrder.push('revokeAllRefreshFamilies');
    });
    runPostCommitCleanupMock.mockImplementation(async () => {
      callOrder.push('runPostCommitCleanup');
      return { redisOk: true, permissionCacheOk: true, oauthOk: true };
    });
    terminateUserRemoteSessionsMock.mockImplementation(async () => {
      callOrder.push('terminateUserRemoteSessions');
      return 3;
    });

    const result = await invalidateMfaAssuranceAfterFactorChange(userId, 'test-reason', mutate);

    // (b) post-commit cleanup AND remote-session teardown both run, strictly
    // after the durable commit (mutate + epoch advance + family revoke).
    expect(callOrder).toEqual([
      'mutate',
      'advanceUserEpochs',
      'revokeAllRefreshFamilies',
      'runPostCommitCleanup',
      'terminateUserRemoteSessions',
    ]);
    expect(advanceUserEpochsMock).toHaveBeenCalledWith(fakeTx, userId, { mfa: true });
    expect(revokeAllRefreshFamiliesMock).toHaveBeenCalledWith(fakeTx, userId, 'test-reason');
    expect(runPostCommitCleanupMock).toHaveBeenCalledWith(userId);
    expect(terminateUserRemoteSessionsMock).toHaveBeenCalledWith(userId);
    expect(result).toEqual({
      mfaEpoch: epochRow.mfaEpoch,
      cleanup: { redisOk: true, permissionCacheOk: true, oauthOk: true },
      remoteSessionsTerminated: 3,
    });
  });

  it('works with no mutate provided — still advances the epoch and revokes families', async () => {
    const result = await invalidateMfaAssuranceAfterFactorChange(userId, 'no-mutate');

    expect(advanceUserEpochsMock).toHaveBeenCalledWith(fakeTx, userId, { mfa: true });
    expect(revokeAllRefreshFamiliesMock).toHaveBeenCalledWith(fakeTx, userId, 'no-mutate');
    expect(result.mfaEpoch).toBe(epochRow.mfaEpoch);
  });

  // (c) TEARDOWN_FAILED must be surfaced, not swallowed and not thrown.
  it('surfaces TEARDOWN_FAILED (-1) from terminateUserRemoteSessions without throwing or swallowing it', async () => {
    terminateUserRemoteSessionsMock.mockResolvedValue(TEARDOWN_FAILED);

    const result = await invalidateMfaAssuranceAfterFactorChange(userId, 'teardown-fail');

    expect(result.remoteSessionsTerminated).toBe(TEARDOWN_FAILED);
    expect(result.remoteSessionsTerminated).toBe(-1);
    // The durable side of the operation still completed — teardown failure
    // is a partial OPERATIONAL failure, never a reason to undo the revocation.
    expect(advanceUserEpochsMock).toHaveBeenCalled();
    expect(revokeAllRefreshFamiliesMock).toHaveBeenCalled();
  });

  // (d) A throw inside mutate rejects the whole tx: no epoch bump, no revoke,
  // and — because db.transaction rejects before ever returning — no
  // post-commit step runs either. Proves the rollback invariant with mocks;
  // real-PG atomicity is Task 9.
  it('rejects the whole operation and skips post-commit steps when mutate throws (transaction rollback)', async () => {
    const boom = new Error('factor write failed');
    const mutate = vi.fn(async () => {
      throw boom;
    });

    await expect(invalidateMfaAssuranceAfterFactorChange(userId, 'will-fail', mutate)).rejects.toThrow(boom);

    expect(advanceUserEpochsMock).not.toHaveBeenCalled();
    expect(revokeAllRefreshFamiliesMock).not.toHaveBeenCalled();
    expect(runPostCommitCleanupMock).not.toHaveBeenCalled();
    expect(terminateUserRemoteSessionsMock).not.toHaveBeenCalled();
  });
});
