import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  selectedRows: [] as unknown[][],
  select: vi.fn(),
  from: vi.fn(),
  where: vi.fn(),
  limit: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  rememberJtiFamily: vi.fn()
}));

vi.mock('../db', () => ({
  db: {
    select: dbMocks.select,
    insert: dbMocks.insert
  },
  withSystemDbAccessContext: dbMocks.withSystemDbAccessContext
}));

vi.mock('./tokenRevocation', () => ({
  rememberJtiFamily: dbMocks.rememberJtiFamily
}));

import { verifyToken } from './jwt';
import { issueUserSession, type UserSessionIdentity } from './userSession';

const DAY_MS = 24 * 60 * 60 * 1000;

const identity: UserSessionIdentity = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'session@example.com',
  roleId: '22222222-2222-4222-8222-222222222222',
  orgId: '33333333-3333-4333-8333-333333333333',
  partnerId: '44444444-4444-4444-8444-444444444444',
  scope: 'organization',
  mfa: true,
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
    dbMocks.selectedRows.length = 0;
    dbMocks.limit.mockImplementation(async () => dbMocks.selectedRows.shift() ?? []);
    dbMocks.where.mockReturnValue({ limit: dbMocks.limit });
    dbMocks.from.mockReturnValue({ where: dbMocks.where });
    dbMocks.select.mockReturnValue({ from: dbMocks.from });
    dbMocks.values.mockResolvedValue(undefined);
    dbMocks.insert.mockReturnValue({ values: dbMocks.values });
    dbMocks.withSystemDbAccessContext.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    dbMocks.rememberJtiFamily.mockResolvedValue(undefined);
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

  it('rejects a revoked existing family', async () => {
    const familyId = '66666666-6666-4666-8666-666666666666';
    dbMocks.selectedRows.push(
      [{ authEpoch: 3, mfaEpoch: 7 }],
      [{ ...activeFamily(familyId), revokedAt: new Date() }]
    );

    await expect(issueUserSession(identity, { familyId })).rejects.toThrow('refresh token family');
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
