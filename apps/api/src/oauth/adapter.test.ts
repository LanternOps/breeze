import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { oauthAuthorizationCodes, oauthClients, oauthRefreshTokens } from '../db/schema';
import { BreezeOidcAdapter } from './adapter';

vi.mock('../db', () => ({
  db: { insert: vi.fn(), update: vi.fn(), select: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const insertMock = vi.mocked(db.insert);
const updateMock = vi.mocked(db.update);
const selectMock = vi.mocked(db.select);
const runOutsideDbContextMock = vi.mocked(runOutsideDbContext);
const withSystemDbAccessContextMock = vi.mocked(withSystemDbAccessContext);

function mockInsertChain() {
  const onConflictDoUpdate = vi.fn();
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  insertMock.mockReturnValue({ values } as unknown as ReturnType<typeof db.insert>);
  return { values, onConflictDoUpdate };
}

function mockUpdateChain() {
  const where = vi.fn();
  const set = vi.fn(() => ({ where }));
  updateMock.mockReturnValue({ set } as unknown as ReturnType<typeof db.update>);
  return { set, where };
}

function mockSelectRows(rows: unknown[]) {
  const where = vi.fn(async () => rows);
  const from = vi.fn(() => ({ where }));
  selectMock.mockReturnValue({ from } as unknown as ReturnType<typeof db.select>);
  return { from, where };
}

describe('BreezeOidcAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('upserts Client rows with null partner, metadata payload, and hashed secret', async () => {
    const chain = mockInsertChain();
    const payload = {
      client_id: 'client_abc',
      client_name: 'Claude',
      client_secret: 'secret-value',
    };

    await new BreezeOidcAdapter('Client').upsert('client_abc', payload, undefined);

    expect(insertMock).toHaveBeenCalledWith(oauthClients);
    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({
      id: 'client_abc',
      partnerId: null,
      metadata: payload,
      clientSecretHash: '31160254d1297393d2ad00e1c01851aec834361e02c524b89fe06aff2879ce6a',
    }));
    expect(chain.onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
      target: oauthClients.id,
      set: expect.objectContaining({ metadata: payload, lastUsedAt: expect.any(Date) }),
    }));
  });

  it('exits request DB context before opening system DB context', async () => {
    mockInsertChain();

    await new BreezeOidcAdapter('Client').upsert('client_abc', { client_id: 'client_abc' }, undefined);

    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    expect(runOutsideDbContextMock.mock.invocationCallOrder[0]!)
      .toBeLessThan(withSystemDbAccessContextMock.mock.invocationCallOrder[0]!);
  });

  it('finds Client metadata when enabled', async () => {
    const payload = { client_id: 'client_abc' };
    mockSelectRows([{ metadata: payload, disabledAt: null }]);

    await expect(new BreezeOidcAdapter('Client').find('client_abc')).resolves.toBe(payload);
  });

  it('returns undefined for disabled Client rows', async () => {
    mockSelectRows([{ metadata: { client_id: 'client_abc' }, disabledAt: new Date() }]);

    await expect(new BreezeOidcAdapter('Client').find('client_abc')).resolves.toBeUndefined();
  });

  it('upserts AuthorizationCode rows using tenant ids from payload.extra', async () => {
    const chain = mockInsertChain();
    const payload = {
      accountId: '00000000-0000-4000-8000-000000000001',
      clientId: 'client_abc',
      extra: {
        partner_id: '00000000-0000-4000-8000-000000000002',
        org_id: '00000000-0000-4000-8000-000000000003',
      },
    };

    await new BreezeOidcAdapter('AuthorizationCode').upsert('code_abc', payload, 60);

    expect(insertMock).toHaveBeenCalledWith(oauthAuthorizationCodes);
    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({
      id: 'code_abc',
      userId: payload.accountId,
      clientId: payload.clientId,
      partnerId: payload.extra.partner_id,
      orgId: payload.extra.org_id,
      payload,
      expiresAt: expect.any(Date),
    }));
    expect(chain.onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
      target: oauthAuthorizationCodes.id,
      set: expect.objectContaining({ payload, expiresAt: expect.any(Date) }),
    }));
  });

  it('marks AuthorizationCode rows consumed', async () => {
    const chain = mockUpdateChain();

    await new BreezeOidcAdapter('AuthorizationCode').consume('code_abc');

    expect(updateMock).toHaveBeenCalledWith(oauthAuthorizationCodes);
    expect(chain.set).toHaveBeenCalledWith({ consumedAt: expect.any(Date) });
    expect(chain.where).toHaveBeenCalled();
  });

  it('revokes RefreshToken rows on destroy', async () => {
    const chain = mockUpdateChain();

    await new BreezeOidcAdapter('RefreshToken').destroy('refresh_abc');

    expect(updateMock).toHaveBeenCalledWith(oauthRefreshTokens);
    expect(chain.set).toHaveBeenCalledWith({ revokedAt: expect.any(Date) });
    expect(chain.where).toHaveBeenCalled();
  });

  it('revokes refresh tokens by grantId with one JSON predicate update', async () => {
    const chain = mockUpdateChain();

    await new BreezeOidcAdapter('RefreshToken').revokeByGrantId('grant_abc');

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(oauthRefreshTokens);
    expect(chain.set).toHaveBeenCalledWith({ revokedAt: expect.any(Date) });
    expect(chain.where).toHaveBeenCalledTimes(1);
  });

  it('round-trips non-persistent models through in-memory fallback', async () => {
    const payload = { uid: 'session_abc', accountId: 'user_abc' };
    const adapter = new BreezeOidcAdapter('Session');

    await adapter.upsert('session_abc', payload, 60);

    await expect(adapter.find('session_abc')).resolves.toBe(payload);
  });

  it('returns undefined for unknown ids under DB-backed models', async () => {
    mockSelectRows([]);

    await expect(new BreezeOidcAdapter('RefreshToken').find('missing')).resolves.toBeUndefined();
  });
});
