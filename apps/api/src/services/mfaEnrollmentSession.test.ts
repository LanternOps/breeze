import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  finishAuthIssuanceMock,
  advanceUserEpochsMock,
  revokeAllRefreshFamiliesMock,
  issueUserSessionMock,
  runPostCommitCleanupMock,
  terminateUserRemoteSessionsMock,
} = vi.hoisted(() => ({
  finishAuthIssuanceMock: vi.fn(),
  advanceUserEpochsMock: vi.fn(),
  revokeAllRefreshFamiliesMock: vi.fn(),
  issueUserSessionMock: vi.fn(),
  runPostCommitCleanupMock: vi.fn(),
  terminateUserRemoteSessionsMock: vi.fn(),
}));

vi.mock('./authBrowserTransition', () => ({
  finishAuthIssuance: finishAuthIssuanceMock,
  AuthIssuanceConflictError: class AuthIssuanceConflictError extends Error {
    constructor() {
      super('Another authentication issuance operation is in progress');
      this.name = 'AuthIssuanceConflictError';
    }
  },
}));

vi.mock('./authLifecycle', () => ({
  advanceUserEpochs: advanceUserEpochsMock,
  EpochAdvancePreconditionError: class EpochAdvancePreconditionError extends Error {},
  revokeAllRefreshFamilies: revokeAllRefreshFamiliesMock,
  runPostCommitCleanup: runPostCommitCleanupMock,
}));

vi.mock('./userSession', () => ({
  issueUserSession: issueUserSessionMock,
}));

vi.mock('./remoteSessionTeardown', () => ({
  terminateUserRemoteSessions: terminateUserRemoteSessionsMock,
}));

import { completeInitialMfaEnrollment, replaceSessionOnMfaFactorWrite } from './mfaEnrollmentSession';
import type { AuthIssuanceCapability } from './authBrowserTransition';
import { EpochAdvancePreconditionError } from './authLifecycle';
import type { AuthorizedUserSession, UserSessionIdentity } from './userSession';

describe('completeInitialMfaEnrollment', () => {
  const tx = { marker: 'transaction' } as never;
  const capability = { marker: 'capability' } as unknown as AuthIssuanceCapability;
  const identity: UserSessionIdentity = {
    userId: 'user-123',
    email: 'user@example.com',
    roleId: 'role-123',
    orgId: 'org-123',
    partnerId: 'partner-123',
    scope: 'organization',
    mfa: true,
  };
  const issued = {
    accessToken: 'access',
    refreshToken: 'refresh',
    refreshJti: 'refresh-jti',
    expiresInSeconds: 900,
    familyId: 'family-new',
    transitionId: 'transition-123',
    generation: 4,
  } as unknown as AuthorizedUserSession;

  beforeEach(() => {
    vi.clearAllMocks();
    finishAuthIssuanceMock.mockImplementation(
      async (_capability: unknown, callback: (value: unknown) => Promise<unknown>) => callback(tx),
    );
    advanceUserEpochsMock.mockResolvedValue({
      authEpoch: 3,
      mfaEpoch: 8,
      emailEpoch: 1,
      passwordResetEpoch: 1,
    });
    revokeAllRefreshFamiliesMock.mockResolvedValue(undefined);
    issueUserSessionMock.mockResolvedValue(issued);
    runPostCommitCleanupMock.mockResolvedValue({ redisOk: true, permissionCacheOk: true, oauthOk: true });
    terminateUserRemoteSessionsMock.mockResolvedValue(2);
  });

  it('commits epoch, revocation, replacement session, and factor in the required order', async () => {
    const order: string[] = [];
    advanceUserEpochsMock.mockImplementation(async () => {
      order.push('epoch');
      return { authEpoch: 3, mfaEpoch: 8, emailEpoch: 1, passwordResetEpoch: 1 };
    });
    revokeAllRefreshFamiliesMock.mockImplementation(async () => { order.push('revoke'); });
    issueUserSessionMock.mockImplementation(async () => { order.push('session'); return issued; });
    const persistFactor = vi.fn(async (suppliedTx: unknown, hashes: readonly string[]) => {
      expect(suppliedTx).toBe(tx);
      expect(hashes).toEqual(['hash-1', 'hash-2']);
      order.push('factor');
      return { factorId: 'factor-1' };
    });

    const result = await completeInitialMfaEnrollment({
      userId: identity.userId,
      identity,
      capability,
      expectedAuthEpoch: 3,
      expectedMfaEpoch: 7,
      revokeReason: 'initial-mfa-enrollment',
      recoveryCodes: ['code-1', 'code-2'],
      recoveryCodeHashes: ['hash-1', 'hash-2'],
      persistFactor,
    });

    expect(order).toEqual(['epoch', 'revoke', 'session', 'factor']);
    expect(finishAuthIssuanceMock).toHaveBeenCalledWith(capability, expect.any(Function));
    expect(advanceUserEpochsMock).toHaveBeenCalledWith(
      tx,
      identity.userId,
      { mfa: true },
      { authEpoch: 3, mfaEpoch: 7, mfaEnabled: false, status: 'active' },
    );
    expect(revokeAllRefreshFamiliesMock).toHaveBeenCalledWith(tx, identity.userId, 'initial-mfa-enrollment');
    expect(issueUserSessionMock).toHaveBeenCalledWith(identity, {
      tx,
      capability,
      expectedEpochs: { authEpoch: 3, mfaEpoch: 8 },
    });
    expect(result).toEqual({
      value: { factorId: 'factor-1' },
      recoveryCodes: ['code-1', 'code-2'],
      issued,
      mfaEpoch: 8,
      cleanup: {
        redisOk: true,
        permissionCacheOk: true,
        oauthOk: true,
        remoteSessionsTerminated: 2,
      },
    });
  });

  it('does not run cleanup or expose codes when the factor write rolls back', async () => {
    const error = new Error('factor write failed');
    await expect(completeInitialMfaEnrollment({
      userId: identity.userId,
      identity,
      capability,
      expectedAuthEpoch: 3,
      expectedMfaEpoch: 7,
      revokeReason: 'initial-mfa-enrollment',
      recoveryCodes: ['code-1'],
      recoveryCodeHashes: ['hash-1'],
      persistFactor: async () => { throw error; },
    })).rejects.toThrow(error);

    expect(runPostCommitCleanupMock).not.toHaveBeenCalled();
    expect(terminateUserRemoteSessionsMock).not.toHaveBeenCalled();
  });

  it('rejects mismatched plaintext/hash counts before opening finalization', async () => {
    await expect(completeInitialMfaEnrollment({
      userId: identity.userId,
      identity,
      capability,
      expectedAuthEpoch: 3,
      expectedMfaEpoch: 7,
      revokeReason: 'initial-mfa-enrollment',
      recoveryCodes: ['code-1', 'code-2'],
      recoveryCodeHashes: ['hash-1'],
      persistFactor: vi.fn(),
    })).rejects.toThrow(/count/i);

    expect(finishAuthIssuanceMock).not.toHaveBeenCalled();
  });

  it('rejects identity/user mismatches before opening finalization', async () => {
    await expect(completeInitialMfaEnrollment({
      userId: 'different-user',
      identity,
      capability,
      expectedAuthEpoch: 3,
      expectedMfaEpoch: 7,
      revokeReason: 'initial-mfa-enrollment',
      recoveryCodes: ['code-1'],
      recoveryCodeHashes: ['hash-1'],
      persistFactor: vi.fn(),
    })).rejects.toThrow(/identity/i);

    expect(finishAuthIssuanceMock).not.toHaveBeenCalled();
  });

  it('does not persist the factor or run cleanup when replacement issuance fails', async () => {
    issueUserSessionMock.mockRejectedValueOnce(new Error('epoch mismatch'));
    const persistFactor = vi.fn();

    await expect(completeInitialMfaEnrollment({
      userId: identity.userId,
      identity,
      capability,
      expectedAuthEpoch: 3,
      expectedMfaEpoch: 7,
      revokeReason: 'initial-mfa-enrollment',
      recoveryCodes: ['code-1'],
      recoveryCodeHashes: ['hash-1'],
      persistFactor,
    })).rejects.toThrow('epoch mismatch');

    expect(persistFactor).not.toHaveBeenCalled();
    expect(runPostCommitCleanupMock).not.toHaveBeenCalled();
    expect(terminateUserRemoteSessionsMock).not.toHaveBeenCalled();
  });

  it('fails a stale or concurrent initial enrollment before family/session writes', async () => {
    advanceUserEpochsMock.mockRejectedValueOnce(new EpochAdvancePreconditionError());
    const persistFactor = vi.fn();

    await expect(completeInitialMfaEnrollment({
      userId: identity.userId,
      identity,
      capability,
      expectedAuthEpoch: 3,
      expectedMfaEpoch: 7,
      revokeReason: 'initial-mfa-enrollment',
      recoveryCodes: ['code-1'],
      recoveryCodeHashes: ['hash-1'],
      persistFactor,
    })).rejects.toMatchObject({ name: 'AuthIssuanceConflictError' });

    expect(revokeAllRefreshFamiliesMock).not.toHaveBeenCalled();
    expect(issueUserSessionMock).not.toHaveBeenCalled();
    expect(persistFactor).not.toHaveBeenCalled();
    expect(runPostCommitCleanupMock).not.toHaveBeenCalled();
  });
});


describe('replaceSessionOnMfaFactorWrite — rotation on an already-protected account (#4480)', () => {
  const tx = { marker: 'transaction' } as never;
  const capability = { marker: 'capability' } as unknown as AuthIssuanceCapability;
  const identity: UserSessionIdentity = {
    userId: 'user-123',
    email: 'user@example.com',
    roleId: 'role-123',
    orgId: 'org-123',
    partnerId: 'partner-123',
    scope: 'organization',
    mfa: true,
  };
  const issued = {
    accessToken: 'access',
    refreshToken: 'refresh',
    refreshJti: 'refresh-jti',
    expiresInSeconds: 900,
    familyId: 'family-new',
    transitionId: 'transition-123',
    generation: 4,
  } as unknown as AuthorizedUserSession;

  beforeEach(() => {
    vi.clearAllMocks();
    finishAuthIssuanceMock.mockImplementation(
      async (_capability: unknown, callback: (value: unknown) => Promise<unknown>) => callback(tx),
    );
    advanceUserEpochsMock.mockResolvedValue({
      authEpoch: 3,
      mfaEpoch: 8,
      emailEpoch: 1,
      passwordResetEpoch: 1,
    });
    revokeAllRefreshFamiliesMock.mockResolvedValue(undefined);
    issueUserSessionMock.mockResolvedValue(issued);
    runPostCommitCleanupMock.mockResolvedValue({ redisOk: true, permissionCacheOk: true, oauthOk: true });
    terminateUserRemoteSessionsMock.mockResolvedValue(0);
  });

  it('predicates the epoch bump on mfa_enabled = true and re-issues the caller session', async () => {
    const result = await replaceSessionOnMfaFactorWrite({
      userId: identity.userId,
      identity,
      capability,
      expectedAuthEpoch: 3,
      expectedMfaEpoch: 7,
      expectedMfaEnabled: true,
      revokeReason: 'mfa-recovery-rotate',
      recoveryCodes: ['code-1', 'code-2'],
      recoveryCodeHashes: ['hash-1', 'hash-2'],
      persistFactor: async (suppliedTx, hashes) => {
        expect(suppliedTx).toBe(tx);
        expect(hashes).toEqual(['hash-1', 'hash-2']);
        return undefined;
      },
    });

    expect(advanceUserEpochsMock).toHaveBeenCalledWith(
      tx,
      identity.userId,
      { mfa: true },
      { authEpoch: 3, mfaEpoch: 7, mfaEnabled: true, status: 'active' },
    );
    expect(revokeAllRefreshFamiliesMock).toHaveBeenCalledWith(tx, identity.userId, 'mfa-recovery-rotate');
    // The replacement session is bound to the POST-bump epochs, which is the
    // whole point: the caller leaves the call holding a token the middleware
    // still accepts.
    expect(issueUserSessionMock).toHaveBeenCalledWith(identity, {
      tx,
      capability,
      expectedEpochs: { authEpoch: 3, mfaEpoch: 8 },
    });
    expect(result.issued).toBe(issued);
    expect(result.mfaEpoch).toBe(8);
    expect(result.recoveryCodes).toEqual(['code-1', 'code-2']);
  });

  it('protects the replacement token from its own post-commit revocation cutoff', async () => {
    const before = Math.floor(Date.now() / 1000);

    await replaceSessionOnMfaFactorWrite({
      userId: identity.userId,
      identity,
      capability,
      expectedAuthEpoch: 3,
      expectedMfaEpoch: 7,
      expectedMfaEnabled: true,
      revokeReason: 'mfa-recovery-rotate',
      recoveryCodes: ['code-1'],
      recoveryCodeHashes: ['hash-1'],
      persistFactor: async () => undefined,
    });

    expect(runPostCommitCleanupMock).toHaveBeenCalledTimes(1);
    const [userId, options] = runPostCommitCleanupMock.mock.calls[0] ?? [];
    expect(userId).toBe(identity.userId);
    // Captured BEFORE issuance, so the Redis cutoff lands strictly below the
    // replacement token's `iat` no matter how long the commit took (#4480).
    expect(options?.preserveTokensIssuedAtOrAfter).toBeGreaterThanOrEqual(before - 1);
    expect(options?.preserveTokensIssuedAtOrAfter).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it('carries a non-assured caller claim forward instead of elevating it', async () => {
    const unassured: UserSessionIdentity = { ...identity, mfa: false };

    await replaceSessionOnMfaFactorWrite({
      userId: unassured.userId,
      identity: unassured,
      capability,
      expectedAuthEpoch: 3,
      expectedMfaEpoch: 7,
      expectedMfaEnabled: true,
      revokeReason: 'mfa-recovery-rotate',
      recoveryCodes: ['code-1'],
      recoveryCodeHashes: ['hash-1'],
      persistFactor: async () => undefined,
    });

    expect(issueUserSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: false }),
      expect.anything(),
    );
  });

  it('still rejects identity/user mismatches before opening finalization', async () => {
    await expect(replaceSessionOnMfaFactorWrite({
      userId: 'different-user',
      identity,
      capability,
      expectedAuthEpoch: 3,
      expectedMfaEpoch: 7,
      expectedMfaEnabled: true,
      revokeReason: 'mfa-recovery-rotate',
      recoveryCodes: ['code-1'],
      recoveryCodeHashes: ['hash-1'],
      persistFactor: vi.fn(),
    })).rejects.toThrow(/identity/i);

    expect(finishAuthIssuanceMock).not.toHaveBeenCalled();
  });

  it('maps a lost precondition race to an issuance conflict without touching families', async () => {
    advanceUserEpochsMock.mockRejectedValueOnce(new EpochAdvancePreconditionError());
    const persistFactor = vi.fn();

    await expect(replaceSessionOnMfaFactorWrite({
      userId: identity.userId,
      identity,
      capability,
      expectedAuthEpoch: 3,
      expectedMfaEpoch: 7,
      expectedMfaEnabled: true,
      revokeReason: 'mfa-recovery-rotate',
      recoveryCodes: ['code-1'],
      recoveryCodeHashes: ['hash-1'],
      persistFactor,
    })).rejects.toMatchObject({ name: 'AuthIssuanceConflictError' });

    expect(revokeAllRefreshFamiliesMock).not.toHaveBeenCalled();
    expect(issueUserSessionMock).not.toHaveBeenCalled();
    expect(persistFactor).not.toHaveBeenCalled();
    expect(runPostCommitCleanupMock).not.toHaveBeenCalled();
  });
});
