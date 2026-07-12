import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  user: {
    id: 'user-1',
    partnerId: 'partner-1',
    status: 'active',
    authEpoch: 3,
    mfaEpoch: 7,
    mfaRecoveryCodes: ['hash-one', 'hash-two'],
  } as Record<string, unknown> | undefined,
  setValues: undefined as Record<string, unknown> | undefined,
  updateRows: [{ id: 'user-1' }] as Array<{ id: string }>,
  tx: undefined as any,
  events: [] as string[],
}));

const lockMfaAssuranceState = vi.hoisted(() => vi.fn());
const invalidateUserMfaAssurance = vi.hoisted(() => vi.fn());
const withAuthLifecycleSystemTransaction = vi.hoisted(() => vi.fn());
const consumePendingMfa = vi.hoisted(() => vi.fn());
const resolveEffectiveMfaPolicy = vi.hoisted(() => vi.fn());
const issueUserSession = vi.hoisted(() => vi.fn());
const bindIssuedUserSession = vi.hoisted(() => vi.fn());

vi.mock('./mfaAssuranceLocks', () => ({ lockMfaAssuranceState }));
vi.mock('./authLifecycle', () => ({
  invalidateUserMfaAssurance,
  withAuthLifecycleSystemTransaction,
}));
vi.mock('./mfaAssurance', () => ({
  consumePendingMfa,
  PendingMfaInvalidError: class PendingMfaInvalidError extends Error {},
  PendingMfaUnavailableError: class PendingMfaUnavailableError extends Error {},
  selectEffectiveMfaMethod: vi.fn(() => 'totp'),
}));
vi.mock('./mfaPolicy', () => ({ resolveEffectiveMfaPolicy }));
vi.mock('./userSession', () => ({ issueUserSession, bindIssuedUserSession }));
import {
  RecoveryCodeInvalidError,
  RecoveryCodeUnavailableError,
  completeRecoveryCodeLogin,
  consumeRecoveryCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from './recoveryCodeAuth';
import { PendingMfaUnavailableError } from './mfaAssurance';

function fakeTx() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ partnerId: 'partner-1' }]) })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        state.setValues = values;
        return { where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue(state.updateRows) })) };
      }),
    })),
  } as any;
}

describe('recovery-code authentication', () => {
  beforeEach(() => {
    state.user = {
      id: 'user-1', partnerId: 'partner-1', status: 'active', authEpoch: 3, mfaEpoch: 7,
      email: 'user@example.com', name: 'User', mfaMethod: 'totp', mfaSecret: 'secret',
      phoneNumber: null, phoneVerified: false,
      mfaRecoveryCodes: [hashRecoveryCode('ABCD-EF12'), 'hash-two'],
    };
    state.setValues = undefined;
    state.updateRows = [{ id: 'user-1' }];
    state.events = [];
    state.tx = fakeTx();
    lockMfaAssuranceState.mockReset().mockImplementation(async () => ({
      user: state.user,
      activePasskeyCount: 0,
    }));
    invalidateUserMfaAssurance.mockReset().mockImplementation(async () => {
      state.user = { ...state.user!, mfaEpoch: 8 };
      return {
        securityState: { id: 'user-1', authEpoch: 3, mfaEpoch: 8 },
        revokedFamilyCount: 2,
      };
    });
    withAuthLifecycleSystemTransaction.mockReset().mockImplementation(async (fn) => {
      state.events.push('transaction');
      return fn(state.tx);
    });
    consumePendingMfa.mockReset().mockImplementation(async () => {
      state.events.push('pending-consumed');
      return {
        version: 2,
        userId: 'user-1', authEpoch: 3, mfaEpoch: 7, expectedStatus: 'active',
        roleId: 'role-1', orgId: null, partnerId: 'partner-1', scope: 'partner',
        policyRequired: false, policySources: [],
        allowedMethods: ['totp', 'sms', 'passkey', 'recovery_code'],
        enrolledMethods: ['totp', 'recovery_code'],
        primaryAuthenticationMethod: 'password', configuredMfaMethod: 'totp',
        primaryMfaMethod: 'totp', issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
    });
    resolveEffectiveMfaPolicy.mockReset().mockResolvedValue({
      required: false,
      sources: [],
      allowedMethods: new Set(['totp', 'sms', 'passkey', 'recovery_code']),
    });
    issueUserSession.mockReset().mockImplementation(async (identity) => {
      state.events.push('session-issued');
      return {
        accessToken: 'access', refreshToken: 'refresh', refreshJti: 'jti',
        expiresInSeconds: 900, familyId: 'new-family', identity,
      };
    });
    bindIssuedUserSession.mockReset().mockResolvedValue(undefined);
  });

  it('normalizes a documented code before hashing', () => {
    expect(normalizeRecoveryCode('  abcd-ef12  ')).toBe('ABCD-EF12');
    expect(() => normalizeRecoveryCode('abcdef12')).toThrow(RecoveryCodeInvalidError);
  });

  it('locks assurance state, removes exactly one matching hash, advances the epoch, and revokes families', async () => {
    const tx = fakeTx();

    await expect(consumeRecoveryCode('user-1', '  abcd-ef12 ', tx)).resolves.toEqual({
      remainingCount: 1,
      authEpoch: 3,
      mfaEpoch: 8,
      revokedFamilyCount: 2,
    });

    expect(lockMfaAssuranceState).toHaveBeenCalledWith(tx, {
      userId: 'user-1',
      partnerId: 'partner-1',
    });
    expect(state.setValues).toMatchObject({ mfaRecoveryCodes: ['hash-two'] });
    expect(invalidateUserMfaAssurance).toHaveBeenCalledWith(
      tx, 'user-1', 'mfa-recovery-code-used',
    );
  });

  it.each([
    ['wrong code', 'WXYZ-9999'],
    ['missing stored codes', 'ABCD-EF12'],
    ['replayed code', 'ABCD-EF12'],
  ])('fails generically for %s without advancing assurance', async (scenario, code) => {
    if (scenario === 'missing stored codes') state.user = { ...state.user!, mfaRecoveryCodes: null };
    if (scenario === 'replayed code') state.user = { ...state.user!, mfaRecoveryCodes: ['hash-two'] };

    await expect(consumeRecoveryCode('user-1', code, fakeTx()))
      .rejects.toBeInstanceOf(RecoveryCodeInvalidError);
    expect(invalidateUserMfaAssurance).not.toHaveBeenCalled();
  });

  it('propagates a durable write failure so the transaction can roll back', async () => {
    state.updateRows = [];

    await expect(consumeRecoveryCode('user-1', 'ABCD-EF12', fakeTx()))
      .rejects.toThrow('Failed to consume recovery code');
    expect(invalidateUserMfaAssurance).not.toHaveBeenCalled();
  });

  it('burns pending state before database work and only issues after the consumption transaction commits', async () => {
    const result = await completeRecoveryCodeLogin({
      tempToken: 'pending-token',
      code: 'ABCD-EF12',
    });

    expect(state.events).toEqual([
      'pending-consumed',
      'transaction',
      'transaction',
      'session-issued',
    ]);
    expect(issueUserSession).toHaveBeenCalledWith(expect.objectContaining({
      mfa: true,
      amr: ['password', 'recovery_code'],
    }), { tx: state.tx });
    expect(result).toMatchObject({ remainingCount: 1, mfaEpoch: 8 });
  });

  it('burns pending state and issues no token when the durable transaction fails', async () => {
    state.updateRows = [];

    await expect(completeRecoveryCodeLogin({
      tempToken: 'pending-token', code: 'ABCD-EF12',
    })).rejects.toBeInstanceOf(RecoveryCodeUnavailableError);

    expect(consumePendingMfa).toHaveBeenCalledOnce();
    expect(issueUserSession).not.toHaveBeenCalled();
  });

  it('fails closed without database work when no pending state exists', async () => {
    consumePendingMfa.mockResolvedValueOnce(null);

    await expect(completeRecoveryCodeLogin({
      tempToken: 'missing', code: 'ABCD-EF12',
    })).rejects.toBeInstanceOf(RecoveryCodeInvalidError);
    expect(withAuthLifecycleSystemTransaction).not.toHaveBeenCalled();
  });

  it('does no database work when atomic Redis consumption is unavailable', async () => {
    consumePendingMfa.mockRejectedValueOnce(new PendingMfaUnavailableError());

    await expect(completeRecoveryCodeLogin({
      tempToken: 'pending-token', code: 'ABCD-EF12',
    })).rejects.toBeInstanceOf(RecoveryCodeUnavailableError);
    expect(withAuthLifecycleSystemTransaction).not.toHaveBeenCalled();
    expect(issueUserSession).not.toHaveBeenCalled();
  });

  it('revalidates live policy and epochs before consuming or issuing', async () => {
    resolveEffectiveMfaPolicy.mockResolvedValueOnce({
      required: false, sources: [], allowedMethods: new Set(['totp']),
    });

    await expect(completeRecoveryCodeLogin({
      tempToken: 'pending-token', code: 'ABCD-EF12',
    })).rejects.toBeInstanceOf(RecoveryCodeInvalidError);
    expect(invalidateUserMfaAssurance).not.toHaveBeenCalled();
    expect(issueUserSession).not.toHaveBeenCalled();
  });
});
