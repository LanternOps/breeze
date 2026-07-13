import { beforeEach, describe, expect, it, vi } from 'vitest';

const transitionMocks = vi.hoisted(() => ({
  assertAuthIssuanceCapability: vi.fn(async () => undefined),
  bindAuthIssuanceSession: vi.fn(async () => undefined),
}));
const revocationMocks = vi.hoisted(() => ({ rememberJtiFamily: vi.fn(async () => undefined) }));

vi.mock('./authBrowserTransition', () => ({
  assertAuthIssuanceCapability: transitionMocks.assertAuthIssuanceCapability,
  bindAuthIssuanceSession: transitionMocks.bindAuthIssuanceSession,
}));
vi.mock('./tokenRevocation', () => ({ rememberJtiFamily: revocationMocks.rememberJtiFamily }));

import { verifyToken } from './jwt';
import { digestRefreshTokenJti } from './refreshTokenFamily';
import {
  bindIssuedUserSession,
  issueUserSession,
  issueUserSessionLegacyDuringTransition,
  type UserSessionIdentity,
} from './userSession';
import type { AuthLifecycleTransaction } from './authLifecycle';
import type { AuthIssuanceCapability } from './authBrowserTransition';

const identity: UserSessionIdentity = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'session@example.com',
  roleId: '22222222-2222-4222-8222-222222222222',
  orgId: '33333333-3333-4333-8333-333333333333',
  partnerId: '44444444-4444-4444-8444-444444444444',
  scope: 'organization',
  mfa: true,
  amr: ['password', 'totp'],
  mobileDeviceId: 'mobile-install-1',
};
const capability = { transitionId: 'transition-1' } as AuthIssuanceCapability;

function transactionHarness(rows: unknown[][]) {
  const inserted: unknown[] = [];
  const updated: unknown[] = [];
  const limit = vi.fn(async () => rows.shift() ?? []);
  const forUpdate = vi.fn(() => ({ limit }));
  const selectWhere = vi.fn(() => ({ for: forUpdate, limit }));
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));
  const values = vi.fn(async (value: unknown) => { inserted.push(value); });
  const insert = vi.fn(() => ({ values }));
  const returning = vi.fn(async () => [{ familyId: 'family-1' }]);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn((value: unknown) => { updated.push(value); return { where: updateWhere }; });
  const update = vi.fn(() => ({ set }));
  return {
    tx: { select, insert, update } as unknown as AuthLifecycleTransaction,
    inserted,
    updated,
  };
}

describe('issueUserSession', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires a transaction and branded capability for guarded issuance', async () => {
    await expect(issueUserSession(identity, undefined as never)).rejects.toThrow(
      'requires a transaction and capability',
    );
  });

  it('stores initial JTI currentness and the binding link in one guarded transaction', async () => {
    const harness = transactionHarness([[{ authEpoch: 8, mfaEpoch: 13 }]]);
    const session = await issueUserSession(identity, { tx: harness.tx, capability });

    expect(harness.inserted[0]).toMatchObject({
      familyId: session.familyId,
      userId: identity.userId,
      currentRefreshJtiDigest: digestRefreshTokenJti(session.refreshJti),
    });
    expect(transitionMocks.assertAuthIssuanceCapability).toHaveBeenCalledWith(harness.tx, capability);
    expect(transitionMocks.bindAuthIssuanceSession).toHaveBeenCalledWith(
      harness.tx, capability, identity.userId, session.familyId,
    );
    await expect(verifyToken(session.accessToken)).resolves.toMatchObject({ ae: 8, me: 13, sid: session.familyId });
    await expect(verifyToken(session.refreshToken)).resolves.toMatchObject({
      ae: 8, me: 13, fam: session.familyId, jti: session.refreshJti,
      amr: ['password', 'totp'],
    });
    expect(revocationMocks.rememberJtiFamily).not.toHaveBeenCalled();
  });

  it('atomically compare/swaps the current digest before signing a successor', async () => {
    const familyId = '55555555-5555-4555-8555-555555555555';
    const presentedJti = 'presented-current-jti';
    const harness = transactionHarness([
      [{ authEpoch: 4, mfaEpoch: 7 }],
      [{
        userId: identity.userId,
        revokedAt: null,
        absoluteExpiresAt: new Date(Date.now() + 60_000),
        currentRefreshJtiDigest: digestRefreshTokenJti(presentedJti),
        databaseNow: new Date(),
      }],
    ]);

    const session = await issueUserSession(identity, {
      tx: harness.tx,
      capability,
      familyId,
      refreshRotation: { presentedJti, authEpoch: 4, mfaEpoch: 7 },
    });

    expect(session.familyId).toBe(familyId);
    expect(harness.inserted).toHaveLength(0);
    expect(harness.updated[0]).toMatchObject({
      previousRefreshJtiDigest: digestRefreshTokenJti(presentedJti),
      currentRefreshJtiDigest: digestRefreshTokenJti(session.refreshJti),
    });
    await expect(verifyToken(session.refreshToken)).resolves.toMatchObject({
      fam: familyId, jti: session.refreshJti,
    });
  });

  it('upgrades an active legacy-null family on its next exact-family refresh', async () => {
    const harness = transactionHarness([
      [{ authEpoch: 4, mfaEpoch: 7 }],
      [{
        userId: identity.userId,
        revokedAt: null,
        absoluteExpiresAt: new Date(Date.now() + 60_000),
        currentRefreshJtiDigest: null,
        databaseNow: new Date(),
      }],
    ]);
    const session = await issueUserSession(identity, {
      tx: harness.tx,
      capability,
      familyId: '55555555-5555-4555-8555-555555555555',
      refreshRotation: { presentedJti: 'legacy-jti', authEpoch: 4, mfaEpoch: 7 },
    });
    expect(harness.updated[0]).toMatchObject({
      currentRefreshJtiDigest: digestRefreshTokenJti(session.refreshJti),
    });
  });

  it('rejects a stale predecessor without signing or binding a successor', async () => {
    const harness = transactionHarness([
      [{ authEpoch: 4, mfaEpoch: 7 }],
      [{
        userId: identity.userId,
        revokedAt: null,
        absoluteExpiresAt: new Date(Date.now() + 60_000),
        currentRefreshJtiDigest: digestRefreshTokenJti('different-jti'),
        databaseNow: new Date(),
      }],
    ]);
    await expect(issueUserSession(identity, {
      tx: harness.tx,
      capability,
      familyId: '55555555-5555-4555-8555-555555555555',
      refreshRotation: { presentedJti: 'stale-jti', authEpoch: 4, mfaEpoch: 7 },
    })).rejects.toMatchObject({ name: 'RefreshTokenCurrentnessError' });
    expect(harness.updated).toHaveLength(0);
    expect(transitionMocks.bindAuthIssuanceSession).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong-owner or missing', []],
    ['revoked', [{
      userId: identity.userId,
      revokedAt: new Date(),
      absoluteExpiresAt: new Date(Date.now() + 60_000),
      currentRefreshJtiDigest: digestRefreshTokenJti('presented-jti'),
      databaseNow: new Date(),
    }]],
    ['absolutely expired', [{
      userId: identity.userId,
      revokedAt: null,
      absoluteExpiresAt: new Date(Date.now() - 60_000),
      currentRefreshJtiDigest: digestRefreshTokenJti('presented-jti'),
      databaseNow: new Date(),
    }]],
  ])('rejects a %s family before signing or binding a successor', async (_case, familyRows) => {
    const harness = transactionHarness([
      [{ authEpoch: 4, mfaEpoch: 7 }],
      familyRows,
    ]);
    await expect(issueUserSession(identity, {
      tx: harness.tx,
      capability,
      familyId: '55555555-5555-4555-8555-555555555555',
      refreshRotation: { presentedJti: 'presented-jti', authEpoch: 4, mfaEpoch: 7 },
    })).rejects.toMatchObject({ name: 'RefreshTokenCurrentnessError' });
    expect(harness.updated).toHaveLength(0);
    expect(transitionMocks.bindAuthIssuanceSession).not.toHaveBeenCalled();
  });

  it('keeps the named legacy seam buildable without accepting a capability', async () => {
    const harness = transactionHarness([[{ authEpoch: 3, mfaEpoch: 5 }]]);
    const session = await issueUserSessionLegacyDuringTransition(identity, { tx: harness.tx });
    expect(session.familyId).toEqual(expect.any(String));
    expect(transitionMocks.assertAuthIssuanceCapability).not.toHaveBeenCalled();
    expect(harness.inserted[0]).toMatchObject({
      currentRefreshJtiDigest: digestRefreshTokenJti(session.refreshJti),
    });
    await bindIssuedUserSession(session);
    expect(revocationMocks.rememberJtiFamily).toHaveBeenCalledWith(session.refreshJti, session.familyId);
  });
});
