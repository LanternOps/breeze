import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  getCurrentDbAccessContextMock,
  runOutsideDbContextMock,
  withSystemDbAccessContextMock,
  invalidateMock,
  redisDelMock,
  getRedisMock,
  captureExceptionMock,
} = vi.hoisted(() => ({
  getCurrentDbAccessContextMock: vi.fn(),
  runOutsideDbContextMock: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  invalidateMock: vi.fn(),
  redisDelMock: vi.fn(),
  getRedisMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { transaction: vi.fn() },
  getCurrentDbAccessContext: getCurrentDbAccessContextMock,
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

vi.mock('../db/schema', () => ({
  users: { id: { __column: 'users.id' }, mfaEnabled: {}, mfaMethod: {}, mfaSecret: {}, mfaRecoveryCodes: {}, phoneNumber: {}, phoneVerified: {} },
  userPasskeys: { id: { __column: 'user_passkeys.id' }, userId: { __column: 'user_passkeys.user_id' }, credentialId: {}, name: {} },
}));

vi.mock('./mfaAssurance', () => ({ invalidateMfaAssuranceAfterFactorChange: invalidateMock }));
vi.mock('./redis', () => ({ getRedis: getRedisMock }));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));

import {
  MAX_AUDITED_PASSKEYS,
  MfaFactorResetContextError,
  pendingFactorArtifactKeys,
  resetAllFactors,
  resetAllFactorsAndInvalidate,
  sweepPendingFactorArtifacts,
} from './mfaFactorReset';

const USER = '11111111-1111-1111-1111-111111111111';
const ROW = { mfaEnabled: true, mfaMethod: 'sms', mfaSecret: 'enc', mfaRecoveryCodes: ['h1', 'h2'], phoneNumber: '+15550100', phoneVerified: true };

function makeTx(opts: { inventory?: Record<string, unknown> | null; passkeys?: Array<{ id: string; credentialId: string; name: string | null }>; updatedRows?: number } = {}) {
  const calls: string[] = [];
  const setValues: Array<Record<string, unknown>> = [];
  const select = vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => { calls.push('select-inventory'); return opts.inventory === null ? [] : [opts.inventory ?? ROW]; }) })) })),
  }));
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      setValues.push(values);
      return { where: vi.fn(() => ({ returning: vi.fn(async () => { calls.push('update-users'); return Array.from({ length: opts.updatedRows ?? 1 }, () => ({ id: USER })); }) })) };
    }),
  }));
  const del = vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => { calls.push('delete-passkeys'); return opts.passkeys ?? []; }) })) }));
  return { tx: { select, update, delete: del } as any, calls, setValues, select, update, del };
}

describe('resetAllFactors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'system', orgId: null, accessibleOrgIds: null });
  });

  it.each([
    ['partner', { scope: 'partner', orgId: null, accessibleOrgIds: [] }],
    ['none', undefined],
  ])('throws MfaFactorResetContextError under a %s context and touches nothing', async (_label, ctx) => {
    getCurrentDbAccessContextMock.mockReturnValue(ctx);
    const { tx, select, update, del } = makeTx();
    await expect(resetAllFactors(tx, USER)).rejects.toBeInstanceOf(MfaFactorResetContextError);
    expect(select).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('throws when the users row is missing and issues no write', async () => {
    const { tx, update, del } = makeTx({ inventory: null });
    await expect(resetAllFactors(tx, USER)).rejects.toThrow(/no users row/);
    expect(update).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('throws when the users UPDATE matches zero rows (silent-zero-row guard) before deleting passkeys', async () => {
    const { tx, del } = makeTx({ updatedRows: 0 });
    await expect(resetAllFactors(tx, USER)).rejects.toThrow(/matched 0 rows/);
    expect(del).not.toHaveBeenCalled();
  });

  it('snapshots the inventory, clears every users column, then deletes passkeys — exactly one UPDATE and one DELETE, in that order', async () => {
    const passkeys = [
      { id: 'pk-1', credentialId: 'cred-1', name: 'YubiKey' },
      { id: 'pk-2', credentialId: 'cred-2', name: null },
    ];
    const { tx, calls, setValues, update, del } = makeTx({ passkeys });

    const inventory = await resetAllFactors(tx, USER);

    expect(calls).toEqual(['select-inventory', 'update-users', 'delete-passkeys']);
    expect(update).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledTimes(1);
    expect(setValues[0]).toMatchObject({ mfaSecret: null, mfaEnabled: false, mfaMethod: null, mfaRecoveryCodes: null, phoneNumber: null, phoneVerified: false });
    expect(setValues[0]).not.toHaveProperty('mfaEpoch'); // D3: the service never bumps epochs
    expect(setValues[0]).not.toHaveProperty('authEpoch');
    expect(inventory).toEqual({
      wasEnabled: true, previousMethod: 'sms', hadTotp: true, hadSms: true, hadRecoveryCodes: true, hadPhone: true,
      passkeys, passkeysDeleted: 2,
    });
  });

  it('reports an empty inventory for a bare account and zero passkeys', async () => {
    const { tx } = makeTx({ inventory: { mfaEnabled: false, mfaMethod: null, mfaSecret: null, mfaRecoveryCodes: null, phoneNumber: null, phoneVerified: false } });
    const inventory = await resetAllFactors(tx, USER);
    expect(inventory).toEqual({ wasEnabled: false, previousMethod: null, hadTotp: false, hadSms: false, hadRecoveryCodes: false, hadPhone: false, passkeys: [], passkeysDeleted: 0 });
  });

  it(`caps the audited passkey list at ${MAX_AUDITED_PASSKEYS} while passkeysDeleted carries the full count`, async () => {
    const many = Array.from({ length: MAX_AUDITED_PASSKEYS + 1 }, (_, i) => ({ id: `pk-${i}`, credentialId: `cred-${i}`, name: null }));
    const { tx } = makeTx({ passkeys: many });
    const inventory = await resetAllFactors(tx, USER);
    expect(inventory.passkeys).toHaveLength(MAX_AUDITED_PASSKEYS);
    expect(inventory.passkeysDeleted).toBe(MAX_AUDITED_PASSKEYS + 1);
  });
});

describe('resetAllFactorsAndInvalidate', () => {
  const fakeTx = makeTx({ passkeys: [{ id: 'pk-1', credentialId: 'cred-1', name: null }] });

  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'system', orgId: null, accessibleOrgIds: null });
    getRedisMock.mockReturnValue({ del: redisDelMock });
    redisDelMock.mockResolvedValue(3);
    invalidateMock.mockImplementation(async (_userId: string, _reason: string, mutate: (tx: unknown) => Promise<void>) => {
      await mutate(fakeTx.tx);
      return { mfaEpoch: 9, cleanup: { redisOk: true, permissionCacheOk: true, oauthOk: true }, remoteSessionsTerminated: 0 };
    });
  });

  it('escalates to system context, folds resetAllFactors into the assurance primitive, then sweeps the three keys after commit', async () => {
    const order: string[] = [];
    runOutsideDbContextMock.mockImplementation((fn: () => unknown) => { order.push('runOutsideDbContext'); return fn(); });
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => { order.push('withSystemDbAccessContext'); return fn(); });
    invalidateMock.mockImplementation(async (_u: string, _r: string, mutate: (tx: unknown) => Promise<void>) => {
      order.push('invalidate:begin');
      await mutate(fakeTx.tx);
      order.push('invalidate:committed');
      return { mfaEpoch: 9, cleanup: { redisOk: true, permissionCacheOk: true, oauthOk: true }, remoteSessionsTerminated: 0 };
    });
    redisDelMock.mockImplementation(async () => { order.push('redis.del'); return 3; });

    const result = await resetAllFactorsAndInvalidate(USER, 'admin-mfa-reset');

    expect(order).toEqual(['runOutsideDbContext', 'withSystemDbAccessContext', 'invalidate:begin', 'invalidate:committed', 'redis.del']);
    expect(invalidateMock).toHaveBeenCalledWith(USER, 'admin-mfa-reset', expect.any(Function));
    expect(redisDelMock).toHaveBeenCalledWith(`mfa:setup:${USER}`, `passkey:challenge:registration:${USER}`, `passkey:challenge:authentication:${USER}`);
    expect(result).toEqual({
      mfaEpoch: 9,
      cleanup: { redisOk: true, permissionCacheOk: true, oauthOk: true },
      remoteSessionsTerminated: 0,
      pendingSweepOk: true,
      inventory: expect.objectContaining({ passkeysDeleted: 1, previousMethod: 'sms' }),
    });
  });

  it('propagates a transaction failure and never sweeps', async () => {
    invalidateMock.mockRejectedValue(new Error('tx failed'));
    await expect(resetAllFactorsAndInvalidate(USER, 'admin-mfa-reset')).rejects.toThrow('tx failed');
    expect(redisDelMock).not.toHaveBeenCalled();
  });

  it('reports pendingSweepOk=false when Redis is unavailable, without throwing', async () => {
    getRedisMock.mockReturnValue(null);
    const result = await resetAllFactorsAndInvalidate(USER, 'admin-mfa-reset');
    expect(result.pendingSweepOk).toBe(false);
  });
});

describe('sweepPendingFactorArtifacts', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('lists exactly the three per-user keys', () => {
    expect(pendingFactorArtifactKeys(USER)).toEqual([`mfa:setup:${USER}`, `passkey:challenge:registration:${USER}`, `passkey:challenge:authentication:${USER}`]);
  });

  it('swallows a Redis error, reports it to Sentry and returns false', async () => {
    getRedisMock.mockReturnValue({ del: vi.fn().mockRejectedValue(new Error('ECONNRESET')) });
    await expect(sweepPendingFactorArtifacts(USER)).resolves.toBe(false);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
