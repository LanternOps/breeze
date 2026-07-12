import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  currentContext: null as 'request' | 'system' | null,
  queryContexts: [] as Array<'request' | 'system' | null>,
  insertContexts: [] as Array<'request' | 'system' | null>,
  selectedRows: [] as unknown[][],
  select: vi.fn(),
  from: vi.fn(),
  where: vi.fn(),
  limit: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  runInRequestContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  rememberJtiFamily: vi.fn()
}));

vi.mock('../db', () => ({
  db: {
    select: dbMocks.select,
    insert: dbMocks.insert
  },
  withSystemDbAccessContext: dbMocks.withSystemDbAccessContext,
  runOutsideDbContext: dbMocks.runOutsideDbContext
}));

vi.mock('./tokenRevocation', () => ({
  rememberJtiFamily: dbMocks.rememberJtiFamily
}));

import { verifyToken } from './jwt';
import {
  bindIssuedUserSession,
  issueUserSession,
  type UserSessionIdentity,
} from './userSession';
import type { AuthLifecycleTransaction } from './authLifecycle';

const DAY_MS = 24 * 60 * 60 * 1000;

const identity: UserSessionIdentity = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'session@example.com',
  roleId: '22222222-2222-4222-8222-222222222222',
  orgId: '33333333-3333-4333-8333-333333333333',
  partnerId: '44444444-4444-4444-8444-444444444444',
  scope: 'organization',
  mfa: true,
  amr: ['password', 'totp'],
  mobileDeviceId: 'mobile-install-1'
};

function activeFamily(familyId: string, userId = identity.userId) {
  return {
    familyId,
    userId,
    createdAt: new Date(),
    absoluteExpiresAt: new Date(Date.now() + DAY_MS),
    lastUsedAt: new Date(),
    revokedAt: null,
    revokedReason: null
  };
}

describe('issueUserSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.currentContext = null;
    dbMocks.queryContexts.length = 0;
    dbMocks.insertContexts.length = 0;
    dbMocks.selectedRows.length = 0;
    dbMocks.limit.mockImplementation(async () => {
      dbMocks.queryContexts.push(dbMocks.currentContext);
      if (dbMocks.currentContext !== 'system') {
        throw new Error(`query ran under ${dbMocks.currentContext ?? 'no'} DB context`);
      }
      return dbMocks.selectedRows.shift() ?? [];
    });
    dbMocks.where.mockReturnValue({ limit: dbMocks.limit });
    dbMocks.from.mockReturnValue({ where: dbMocks.where });
    dbMocks.select.mockReturnValue({ from: dbMocks.from });
    dbMocks.values.mockResolvedValue(undefined);
    dbMocks.insert.mockImplementation(() => {
      dbMocks.insertContexts.push(dbMocks.currentContext);
      if (dbMocks.currentContext !== 'system') {
        throw new Error(`insert ran under ${dbMocks.currentContext ?? 'no'} DB context`);
      }
      return { values: dbMocks.values };
    });
    dbMocks.withSystemDbAccessContext.mockImplementation(async (fn: () => Promise<unknown>) => {
      if (dbMocks.currentContext) {
        return fn();
      }
      dbMocks.currentContext = 'system';
      try {
        return await fn();
      } finally {
        dbMocks.currentContext = null;
      }
    });
    dbMocks.runOutsideDbContext.mockImplementation((fn: () => unknown) => {
      const previousContext = dbMocks.currentContext;
      dbMocks.currentContext = null;
      const result = fn();
      return Promise.resolve(result).finally(() => {
        dbMocks.currentContext = previousContext;
      });
    });
    dbMocks.runInRequestContext.mockImplementation(async (fn: () => Promise<unknown>) => {
      dbMocks.currentContext = 'request';
      try {
        return await fn();
      } finally {
        dbMocks.currentContext = null;
      }
    });
    dbMocks.rememberJtiFamily.mockResolvedValue(undefined);
  });

  it('preserves the caller-verified authentication methods in both signed tokens', async () => {
    dbMocks.selectedRows.push([{ authEpoch: 3, mfaEpoch: 5 }]);
    dbMocks.selectedRows.push([activeFamily('family-amr')]);

    const result = await issueUserSession(identity, { familyId: 'family-amr' });

    await expect(verifyToken(result.accessToken)).resolves.toMatchObject({
      mfa: true,
      amr: ['password', 'totp'],
    });
    await expect(verifyToken(result.refreshToken)).resolves.toMatchObject({
      mfa: true,
      amr: ['password', 'totp'],
    });
  });

  it('creates a 30-day family and issues an epoch-bound token pair', async () => {
    dbMocks.selectedRows.push([{ authEpoch: 3, mfaEpoch: 7 }]);
    const before = Date.now();

    const session = await issueUserSession(identity);

    const after = Date.now();
    const inserted = dbMocks.values.mock.calls[0]?.[0];
    expect(inserted).toMatchObject({ familyId: session.familyId, userId: identity.userId });
    expect(inserted.absoluteExpiresAt).toBeInstanceOf(Date);
    expect(inserted.absoluteExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
    expect(inserted.absoluteExpiresAt.getTime()).toBeLessThanOrEqual(after + 30 * DAY_MS);

    const accessPayload = await verifyToken(session.accessToken);
    const refreshPayload = await verifyToken(session.refreshToken);
    expect(accessPayload).toMatchObject({
      sub: identity.userId,
      ae: 3,
      me: 7,
      sid: session.familyId,
      mdid: identity.mobileDeviceId,
      type: 'access'
    });
    expect(refreshPayload).toMatchObject({
      sub: identity.userId,
      ae: 3,
      me: 7,
      fam: session.familyId,
      mdid: identity.mobileDeviceId,
      type: 'refresh'
    });
    expect(dbMocks.rememberJtiFamily).toHaveBeenCalledWith(session.refreshJti, session.familyId);
  });

  it('uses one supplied transaction for epoch load and family insert, then binds Redis post-commit', async () => {
    const txLimit = vi.fn().mockResolvedValue([{ authEpoch: 8, mfaEpoch: 13 }]);
    const txWhere = vi.fn(() => ({ limit: txLimit }));
    const txFrom = vi.fn(() => ({ where: txWhere }));
    const txSelect = vi.fn(() => ({ from: txFrom }));
    const txValues = vi.fn().mockResolvedValue(undefined);
    const txInsert = vi.fn(() => ({ values: txValues }));
    const tx = { select: txSelect, insert: txInsert } as unknown as AuthLifecycleTransaction;

    const session = await issueUserSession(identity, { tx });

    expect(txSelect).toHaveBeenCalledOnce();
    expect(txInsert).toHaveBeenCalledOnce();
    expect(dbMocks.select).not.toHaveBeenCalled();
    expect(dbMocks.insert).not.toHaveBeenCalled();
    expect(dbMocks.rememberJtiFamily).not.toHaveBeenCalled();
    await expect(verifyToken(session.accessToken)).resolves.toMatchObject({ ae: 8, me: 13 });

    await bindIssuedUserSession(session);
    expect(dbMocks.rememberJtiFamily).toHaveBeenCalledWith(session.refreshJti, session.familyId);
  });

  it('escapes an active request DB context for new-family creation', async () => {
    dbMocks.selectedRows.push([{ authEpoch: 3, mfaEpoch: 7 }]);

    const session = await dbMocks.runInRequestContext(() => issueUserSession(identity));

    expect(session).toMatchObject({ familyId: expect.any(String) });
    expect(dbMocks.queryContexts).toEqual(['system']);
    expect(dbMocks.insertContexts).toEqual(['system']);
    expect(dbMocks.runOutsideDbContext).toHaveBeenCalledTimes(2);
  });

  it('rotates within an existing active family without extending its lifetime', async () => {
    const familyId = '55555555-5555-4555-8555-555555555555';
    const family = activeFamily(familyId);
    dbMocks.selectedRows.push([{ authEpoch: 4, mfaEpoch: 9 }], [family]);

    const session = await issueUserSession(identity, { familyId });

    expect(session.familyId).toBe(familyId);
    expect(dbMocks.insert).not.toHaveBeenCalled();
    expect(dbMocks.rememberJtiFamily).toHaveBeenCalledWith(session.refreshJti, familyId);
    await expect(verifyToken(session.accessToken)).resolves.toMatchObject({ sid: familyId });
    await expect(verifyToken(session.refreshToken)).resolves.toMatchObject({ fam: familyId });
  });

  it('escapes an active request DB context for epoch and family lifecycle reads', async () => {
    const familyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    dbMocks.selectedRows.push(
      [{ authEpoch: 4, mfaEpoch: 9 }],
      [activeFamily(familyId)]
    );

    const session = await dbMocks.runInRequestContext(
      () => issueUserSession(identity, { familyId })
    );

    expect(session).toMatchObject({ familyId });
    expect(dbMocks.queryContexts).toEqual(['system', 'system']);
    expect(dbMocks.runOutsideDbContext).toHaveBeenCalledTimes(2);
  });

  it('rejects a revoked existing family', async () => {
    const familyId = '66666666-6666-4666-8666-666666666666';
    dbMocks.selectedRows.push(
      [{ authEpoch: 3, mfaEpoch: 7 }],
      [{ ...activeFamily(familyId), revokedAt: new Date() }]
    );

    await expect(issueUserSession(identity, { familyId })).rejects.toMatchObject({
      name: 'UserSessionFamilyInactiveError',
    });
    expect(dbMocks.rememberJtiFamily).not.toHaveBeenCalled();
  });

  it('rejects an absolutely expired existing family', async () => {
    const familyId = '77777777-7777-4777-8777-777777777777';
    dbMocks.selectedRows.push(
      [{ authEpoch: 3, mfaEpoch: 7 }],
      [{ ...activeFamily(familyId), absoluteExpiresAt: new Date(Date.now() - 1) }]
    );

    await expect(issueUserSession(identity, { familyId })).rejects.toThrow('refresh token family');
    expect(dbMocks.rememberJtiFamily).not.toHaveBeenCalled();
  });

  it('rejects an existing family with a non-finite absolute expiry', async () => {
    const familyId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    dbMocks.selectedRows.push(
      [{ authEpoch: 3, mfaEpoch: 7 }],
      [{ ...activeFamily(familyId), absoluteExpiresAt: new Date('invalid') }]
    );

    await expect(issueUserSession(identity, { familyId })).rejects.toThrow('refresh token family');
    expect(dbMocks.rememberJtiFamily).not.toHaveBeenCalled();
  });

  it('rejects an existing family owned by another user', async () => {
    const familyId = '88888888-8888-4888-8888-888888888888';
    dbMocks.selectedRows.push(
      [{ authEpoch: 3, mfaEpoch: 7 }],
      [activeFamily(familyId, '99999999-9999-4999-8999-999999999999')]
    );

    await expect(issueUserSession(identity, { familyId })).rejects.toThrow('refresh token family');
    expect(dbMocks.rememberJtiFamily).not.toHaveBeenCalled();
  });

  it('loads epochs from PostgreSQL instead of accepting caller-supplied values', async () => {
    dbMocks.selectedRows.push([{ authEpoch: 12, mfaEpoch: 15 }]);
    const untrustedIdentity = { ...identity, authEpoch: 99, mfaEpoch: 100 } as UserSessionIdentity;

    const session = await issueUserSession(untrustedIdentity);

    await expect(verifyToken(session.accessToken)).resolves.toMatchObject({ ae: 12, me: 15 });
    await expect(verifyToken(session.refreshToken)).resolves.toMatchObject({ ae: 12, me: 15 });
  });
});
