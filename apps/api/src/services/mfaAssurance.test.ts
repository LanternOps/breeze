import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  dbTransactionMock,
  advanceUserEpochsMock,
  revokeAllRefreshFamiliesMock,
  runPostCommitCleanupMock,
  terminateUserRemoteSessionsMock,
  getRedisMock,
  revokeTechSessionsForUserMock,
} = vi.hoisted(() => ({
  dbTransactionMock: vi.fn(),
  advanceUserEpochsMock: vi.fn(),
  revokeAllRefreshFamiliesMock: vi.fn(),
  runPostCommitCleanupMock: vi.fn(),
  terminateUserRemoteSessionsMock: vi.fn(),
  getRedisMock: vi.fn(),
  revokeTechSessionsForUserMock: vi.fn(),
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

vi.mock('./redis', () => ({ getRedis: getRedisMock }));
vi.mock('./officeAddin/techSession', () => ({
  revokeTechSessionsForUser: revokeTechSessionsForUserMock,
}));

import { invalidateMfaAssuranceAfterFactorChange } from './mfaAssurance';
import { TEARDOWN_FAILED } from './remoteSessionTeardown';

describe('invalidateMfaAssuranceAfterFactorChange', () => {
  const userId = 'user-123';
  const bindingRevokeWhereMock = vi.fn(async () => undefined);
  const bindingRevokeSetMock = vi.fn(() => ({ where: bindingRevokeWhereMock }));
  const bindingRevokeUpdateMock = vi.fn(() => ({ set: bindingRevokeSetMock }));
  const fakeTx = { marker: 'tx', update: bindingRevokeUpdateMock } as unknown;
  const epochRow = { authEpoch: 1, mfaEpoch: 2, emailEpoch: 1, passwordResetEpoch: 1 };

  beforeEach(() => {
    vi.clearAllMocks();
    dbTransactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx));
    advanceUserEpochsMock.mockResolvedValue(epochRow);
    revokeAllRefreshFamiliesMock.mockResolvedValue(undefined);
    runPostCommitCleanupMock.mockResolvedValue({ redisOk: true, permissionCacheOk: true, oauthOk: true });
    terminateUserRemoteSessionsMock.mockResolvedValue(3);
    getRedisMock.mockReturnValue({ marker: 'redis' });
    revokeTechSessionsForUserMock.mockResolvedValue(undefined);
  });

  // (a) User/family authority is acquired before route-specific factor rows.
  it('rejects stale proof before family revocation, factor mutation or cleanup', async () => {
    const stale = new Error('epoch precondition mismatch');
    advanceUserEpochsMock.mockRejectedValueOnce(stale);
    const mutate = vi.fn();
    const expected = { authEpoch: 1, mfaEpoch: 1, status: 'active' as const };
    await expect(invalidateMfaAssuranceAfterFactorChange(userId, 'phone-replacement', mutate, expected)).rejects.toBe(stale);
    expect(advanceUserEpochsMock).toHaveBeenCalledWith(fakeTx, userId, { mfa: true }, expected);
    expect(revokeAllRefreshFamiliesMock).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(runPostCommitCleanupMock).not.toHaveBeenCalled();
    expect(terminateUserRemoteSessionsMock).not.toHaveBeenCalled();
  });

  it('advances epochs and revokes families before mutate(tx), then runs post-commit cleanup + teardown', async () => {
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
    bindingRevokeWhereMock.mockImplementation(async () => {
      callOrder.push('revokeOfficeBinding');
    });
    runPostCommitCleanupMock.mockImplementation(async () => {
      callOrder.push('runPostCommitCleanup');
      return { redisOk: true, permissionCacheOk: true, oauthOk: true };
    });
    terminateUserRemoteSessionsMock.mockImplementation(async () => {
      callOrder.push('terminateUserRemoteSessions');
      return 3;
    });
    revokeTechSessionsForUserMock.mockImplementation(async () => {
      callOrder.push('revokeTechSessions');
    });

    const result = await invalidateMfaAssuranceAfterFactorChange(userId, 'test-reason', mutate);

    // (b) post-commit cleanup AND remote-session teardown both run, strictly
    // after the durable commit (mutate + epoch advance + family revoke).
    expect(callOrder).toEqual([
      'advanceUserEpochs',
      'revokeAllRefreshFamilies',
      'revokeOfficeBinding',
      'mutate',
      'runPostCommitCleanup',
      'revokeTechSessions',
      'terminateUserRemoteSessions',
    ]);
    expect(advanceUserEpochsMock).toHaveBeenCalledWith(fakeTx, userId, { mfa: true }, undefined);
    expect(revokeAllRefreshFamiliesMock).toHaveBeenCalledWith(fakeTx, userId, 'test-reason');
    expect(bindingRevokeUpdateMock).toHaveBeenCalledTimes(1);
    expect(runPostCommitCleanupMock).toHaveBeenCalledWith(userId);
    expect(revokeTechSessionsForUserMock).toHaveBeenCalledWith({ marker: 'redis' }, userId);
    expect(terminateUserRemoteSessionsMock).toHaveBeenCalledWith(userId);
    expect(result).toEqual({
      mfaEpoch: epochRow.mfaEpoch,
      cleanup: { redisOk: true, permissionCacheOk: true, oauthOk: true },
      remoteSessionsTerminated: 3,
    });
  });

  it('works with no mutate provided — still advances the epoch and revokes families', async () => {
    const result = await invalidateMfaAssuranceAfterFactorChange(userId, 'no-mutate');

    expect(advanceUserEpochsMock).toHaveBeenCalledWith(fakeTx, userId, { mfa: true }, undefined);
    expect(revokeAllRefreshFamiliesMock).toHaveBeenCalledWith(fakeTx, userId, 'no-mutate');
    expect(result.mfaEpoch).toBe(epochRow.mfaEpoch);
  });

  it('keeps the durable revoke effective and continues teardown when Redis session cleanup fails', async () => {
    revokeTechSessionsForUserMock.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(invalidateMfaAssuranceAfterFactorChange(userId, 'redis-failure')).resolves.toEqual(
      expect.objectContaining({ mfaEpoch: epochRow.mfaEpoch })
    );
    expect(bindingRevokeUpdateMock).toHaveBeenCalledTimes(1);
    expect(terminateUserRemoteSessionsMock).toHaveBeenCalledWith(userId);
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

  // (d) A throw inside mutate rejects the whole tx. Authority statements have
  // executed first to preserve global lock order, but the DB transaction rolls
  // them back and no post-commit step runs.
  it('rejects the whole operation and skips post-commit steps when mutate throws (transaction rollback)', async () => {
    const boom = new Error('factor write failed');
    const mutate = vi.fn(async () => {
      throw boom;
    });

    await expect(invalidateMfaAssuranceAfterFactorChange(userId, 'will-fail', mutate)).rejects.toThrow(boom);

    expect(advanceUserEpochsMock).toHaveBeenCalledWith(fakeTx, userId, { mfa: true }, undefined);
    expect(revokeAllRefreshFamiliesMock).toHaveBeenCalledWith(fakeTx, userId, 'will-fail');
    expect(runPostCommitCleanupMock).not.toHaveBeenCalled();
    expect(terminateUserRemoteSessionsMock).not.toHaveBeenCalled();
  });
});
