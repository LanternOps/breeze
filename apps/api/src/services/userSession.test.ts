import { beforeEach, describe, expect, it, vi } from 'vitest';

const transitionMocks = vi.hoisted(() => ({
  assertAuthIssuanceCapability: vi.fn(async () => undefined),
  bindAuthIssuanceSession: vi.fn(async () => undefined),
}));

vi.mock('./authBrowserTransition', async (importOriginal) => ({
  ...await importOriginal<typeof import('./authBrowserTransition')>(),
  assertAuthIssuanceCapability: transitionMocks.assertAuthIssuanceCapability,
  bindAuthIssuanceSession: transitionMocks.bindAuthIssuanceSession,
}));

import type { AuthIssuanceCapability } from './authBrowserTransition';
import type { Tx as AuthLifecycleTransaction } from './authLifecycle';
import { verifyToken } from './jwt';
import { digestRefreshTokenJti } from './refreshTokenFamily';
import {
  issueUserSession,
  issueUserSessionLegacyDuringTransition,
  type UserSessionIdentity,
} from './userSession';

const identity: UserSessionIdentity = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'session@example.com',
  roleId: '22222222-2222-4222-8222-222222222222',
  orgId: '33333333-3333-4333-8333-333333333333',
  partnerId: '44444444-4444-4444-8444-444444444444',
  scope: 'organization',
  mfa: true,
  mobileDeviceId: 'mobile-install-1',
};

const capability = {
  transitionId: '55555555-5555-4555-8555-555555555555',
  generation: 4,
  operationId: '66666666-6666-4666-8666-666666666666',
  expiresAt: new Date(Date.now() + 60_000),
} as AuthIssuanceCapability;

function transactionHarness(rows: unknown[][]) {
  const events: string[] = [];
  const inserted: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const limit = vi.fn(async () => rows.shift() ?? []);
  const forUpdate = vi.fn(() => ({ limit }));
  const selectWhere = vi.fn(() => ({ for: forUpdate, limit }));
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => {
    events.push('lock-user-or-family');
    return { from };
  });
  const values = vi.fn(async (value: Record<string, unknown>) => {
    events.push('insert-family');
    inserted.push(value);
  });
  const insert = vi.fn(() => ({ values }));
  const returning = vi.fn(async () => [{ familyId: 'family-1' }]);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn((value: Record<string, unknown>) => {
    events.push('rotate-family');
    updated.push(value);
    return { where: updateWhere };
  });
  const update = vi.fn(() => ({ set }));
  return {
    tx: { select, insert, update } as unknown as AuthLifecycleTransaction,
    events,
    inserted,
    updated,
  };
}

describe('guarded user-session issuance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AUTH_BROWSER_TRANSITIONS_ENFORCED;
  });

  it('requires the finalization transaction, branded capability, and verified epoch snapshot', async () => {
    await expect(issueUserSession(identity, undefined as never)).rejects.toThrow(
      'requires a transaction, capability, and expected epochs',
    );
  });

  it('asserts the transition, locks live epochs, stores current JTI, and binds the family before returning', async () => {
    const harness = transactionHarness([[{ status: 'active', authEpoch: 8, mfaEpoch: 13 }]]);

    const issued = await issueUserSession(identity, {
      tx: harness.tx,
      capability,
      expectedEpochs: { authEpoch: 8, mfaEpoch: 13 },
    });

    expect(transitionMocks.assertAuthIssuanceCapability).toHaveBeenCalledWith(
      harness.tx,
      capability,
    );
    expect(harness.inserted).toHaveLength(1);
    expect(harness.inserted[0]).toMatchObject({
      familyId: issued.familyId,
      userId: identity.userId,
      currentRefreshJtiDigest: digestRefreshTokenJti(issued.refreshJti),
    });
    expect(transitionMocks.bindAuthIssuanceSession).toHaveBeenCalledWith(
      harness.tx,
      capability,
      identity.userId,
      issued.familyId,
    );
    expect(issued).toMatchObject({
      transitionId: capability.transitionId,
      generation: capability.generation,
    });
    await expect(verifyToken(issued.accessToken)).resolves.toMatchObject({
      type: 'access',
      aep: 8,
      mep: 13,
      sid: issued.familyId,
    });
    await expect(verifyToken(issued.refreshToken)).resolves.toMatchObject({
      type: 'refresh',
      aep: 8,
      mep: 13,
      fam: issued.familyId,
      jti: issued.refreshJti,
    });
  });

  it('compare-and-swaps the presented family JTI before signing the successor', async () => {
    const familyId = '77777777-7777-4777-8777-777777777777';
    const presentedJti = '88888888-8888-4888-8888-888888888888';
    const harness = transactionHarness([
      [{ status: 'active', authEpoch: 4, mfaEpoch: 7 }],
      [{
        userId: identity.userId,
        revokedAt: null,
        absoluteExpiresAt: new Date(Date.now() + 60_000),
        currentRefreshJtiDigest: digestRefreshTokenJti(presentedJti),
        databaseNow: new Date(),
      }],
    ]);

    const issued = await issueUserSession(identity, {
      tx: harness.tx,
      capability,
      expectedEpochs: { authEpoch: 4, mfaEpoch: 7 },
      familyId,
      refreshRotation: { presentedJti },
    });

    expect(harness.inserted).toHaveLength(0);
    expect(harness.updated[0]).toMatchObject({
      currentRefreshJtiDigest: digestRefreshTokenJti(issued.refreshJti),
    });
    await expect(verifyToken(issued.refreshToken)).resolves.toMatchObject({
      fam: familyId,
      jti: issued.refreshJti,
    });
  });

  it('rejects changed live epochs before rotating or signing a refresh successor', async () => {
    const harness = transactionHarness([[{ status: 'active', authEpoch: 5, mfaEpoch: 7 }]]);

    await expect(issueUserSession(identity, {
      tx: harness.tx,
      capability,
      expectedEpochs: { authEpoch: 4, mfaEpoch: 7 },
      familyId: '77777777-7777-4777-8777-777777777777',
      refreshRotation: {
        presentedJti: '88888888-8888-4888-8888-888888888888',
      },
    })).rejects.toMatchObject({ name: 'RefreshTokenCurrentnessError' });

    expect(harness.inserted).toHaveLength(0);
    expect(harness.updated).toHaveLength(0);
    expect(transitionMocks.bindAuthIssuanceSession).not.toHaveBeenCalled();
  });

  it('rejects a stale non-refresh proof before minting a family or signing tokens', async () => {
    const harness = transactionHarness([[{ status: 'active', authEpoch: 5, mfaEpoch: 8 }]]);

    await expect(issueUserSession(identity, {
      tx: harness.tx,
      capability,
      expectedEpochs: { authEpoch: 4, mfaEpoch: 8 },
    })).rejects.toMatchObject({ name: 'UserSessionEpochMismatchError' });

    expect(harness.inserted).toHaveLength(0);
    expect(harness.updated).toHaveLength(0);
    expect(transitionMocks.bindAuthIssuanceSession).not.toHaveBeenCalled();
  });

  it('disables the explicitly named legacy seam once enforcement is enabled', async () => {
    process.env.AUTH_BROWSER_TRANSITIONS_ENFORCED = 'true';

    await expect(issueUserSessionLegacyDuringTransition(identity)).rejects.toThrow(
      'Legacy user-session issuance is disabled',
    );
  });
});
