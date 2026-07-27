import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { revokeGrant, revokeJti } from './revocationCache';
import { revokeClientFamilies } from './revocationService';

vi.mock('../db', () => ({
  db: { select: vi.fn(), update: vi.fn(), delete: vi.fn(), insert: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('./revocationCache', () => ({
  revokeJti: vi.fn(async () => undefined),
  revokeGrant: vi.fn(async () => undefined),
}));

const selectMock = vi.mocked(db.select);
const updateMock = vi.mocked(db.update);
const deleteMock = vi.mocked(db.delete);
const insertMock = vi.mocked(db.insert);
const runOutsideDbContextMock = vi.mocked(runOutsideDbContext);
const withSystemDbAccessContextMock = vi.mocked(withSystemDbAccessContext);
const revokeGrantMock = vi.mocked(revokeGrant);
const revokeJtiMock = vi.mocked(revokeJti);

/** Queue one `db.select({...}).from(...).where(...)` result. */
function mockSelectRows(rows: unknown[]) {
  const where = vi.fn(async () => rows);
  const from = vi.fn(() => ({ where }));
  selectMock.mockReturnValueOnce({ from } as unknown as ReturnType<typeof db.select>);
}

// db.update(...).set(...).where(...) — records the `.set()` payloads so tests
// can distinguish the grant/refresh/client-disable updates.
const updateSetCalls: Record<string, unknown>[] = [];
function installDbUpdate() {
  updateMock.mockImplementation((() => {
    const where = vi.fn(async () => undefined);
    const set = vi.fn((payload: Record<string, unknown>) => {
      updateSetCalls.push(payload);
      return { where };
    });
    return { set };
  }) as unknown as typeof db.update);
}

function installDbDelete() {
  const where = vi.fn(async () => undefined);
  deleteMock.mockImplementation((() => ({ where })) as unknown as typeof db.delete);
  return { where };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateSetCalls.length = 0;
  runOutsideDbContextMock.mockImplementation((fn: () => unknown) => fn() as never);
  withSystemDbAccessContextMock.mockImplementation((async (fn: () => Promise<unknown>) => fn()) as never);
  installDbUpdate();
  installDbDelete();
});

const CLIENT = 'client-shared-dcr';
const PARTNER = '22222222-2222-2222-2222-222222222222';
const USER = '11111111-1111-1111-1111-111111111111';

describe('revokeClientFamilies', () => {
  it('revokes a code-only grant (no refresh row) under partner scope and deletes only the join row', async () => {
    mockSelectRows([{ id: 'grant-code-only', accountId: USER }]); // grants
    mockSelectRows([]); // refresh rows (none — code-only)
    const joinDelete = installDbDelete();

    const result = await revokeClientFamilies(CLIENT, { kind: 'partner', partnerId: PARTNER });

    expect(revokeGrantMock).toHaveBeenCalledWith('grant-code-only', expect.any(Number));
    expect(revokeJtiMock).not.toHaveBeenCalled();
    // grants stamped revoked
    expect(updateSetCalls).toContainEqual(expect.objectContaining({ revokedAt: expect.any(Date) }));
    // partner scope deletes the join row
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(joinDelete.where).toHaveBeenCalledTimes(1);
    // partner scope never disables the shared client
    expect(updateSetCalls).not.toContainEqual(expect.objectContaining({ disabledAt: expect.any(Date) }));
    expect(result).toEqual({ grants: 1, refreshTokens: 0 });
  });

  it('commits DB revocation plus a durable retry before a grant marker failure is surfaced', async () => {
    mockSelectRows([{ id: 'grant-A', accountId: USER }]); // grants
    mockSelectRows([{ id: 'rt-1', userId: USER, expiresAt: new Date(Date.now() + 3600_000) }]); // refresh
    let queuedUserId = '';
    const returning = vi.fn(async () => [{ userId: queuedUserId }]);
    const onConflictDoUpdate = vi.fn(() => ({ returning }));
    const values = vi.fn((input: { userId: string }) => {
      queuedUserId = input.userId;
      return { onConflictDoUpdate };
    });
    insertMock.mockReturnValue({ values } as unknown as ReturnType<typeof db.insert>);
    revokeGrantMock.mockRejectedValueOnce(new Error('redis down'));

    await expect(revokeClientFamilies(CLIENT, { kind: 'global' })).rejects.toThrow();

    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER,
      markerType: 'grant',
      markerId: 'grant-A',
    }));
    expect(updateSetCalls).toContainEqual(expect.objectContaining({ revokedAt: expect.any(Date) }));
    expect(updateSetCalls).toContainEqual(expect.objectContaining({ disabledAt: expect.any(Date) }));
  });

  it('global scope revokes every family then disables the client LAST', async () => {
    mockSelectRows([
      { id: 'grant-A', accountId: USER },
      { id: 'grant-B', accountId: USER },
    ]); // grants
    mockSelectRows([{ id: 'rt-1', userId: USER, expiresAt: new Date(Date.now() + 3600_000) }]); // refresh

    const result = await revokeClientFamilies(CLIENT, { kind: 'global' });

    expect(revokeGrantMock).toHaveBeenCalledTimes(2);
    expect(revokeJtiMock).toHaveBeenCalledTimes(1);
    // client disable happened (a .set with disabledAt)
    expect(updateSetCalls).toContainEqual(expect.objectContaining({ disabledAt: expect.any(Date) }));
    // the client-disable update is the LAST db.update call (after grant +
    // refresh stamps), and every marker was written before any db.update.
    const disableCallIndex = updateSetCalls.findIndex((c) => 'disabledAt' in c);
    expect(disableCallIndex).toBe(updateSetCalls.length - 1);
    const firstUpdateOrder = updateMock.mock.invocationCallOrder[0]!;
    const lastMarkerOrder = revokeJtiMock.mock.invocationCallOrder.at(-1)!;
    expect(lastMarkerOrder).toBeLessThan(firstUpdateOrder);
    expect(result).toEqual({ grants: 2, refreshTokens: 1 });
  });

  it('is a safe no-op when there are no active families (idempotent repeat)', async () => {
    mockSelectRows([]); // grants
    mockSelectRows([]); // refresh

    const result = await revokeClientFamilies(CLIENT, { kind: 'global' });

    expect(revokeGrantMock).not.toHaveBeenCalled();
    expect(revokeJtiMock).not.toHaveBeenCalled();
    // no grants/refresh to stamp; only the guarded client-disable update fires
    expect(updateSetCalls).toEqual([expect.objectContaining({ disabledAt: expect.any(Date) })]);
    expect(result).toEqual({ grants: 0, refreshTokens: 0 });
  });

  it('keys the refresh-token jti marker on the row id, not payload.jti (Task 3 forward-compat)', async () => {
    mockSelectRows([{ id: 'grant-A', accountId: USER }]); // grants
    // Row id is the authoritative token id; payload.jti must NOT be consulted.
    mockSelectRows([{
      id: 'rt-row-id',
      userId: USER,
      payload: { jti: 'STALE-PAYLOAD-JTI' },
      expiresAt: new Date(Date.now() + 3600_000),
    }]);

    await revokeClientFamilies(CLIENT, { kind: 'user', userId: USER });

    expect(revokeJtiMock).toHaveBeenCalledWith('rt-row-id', expect.any(Number));
    expect(revokeJtiMock).not.toHaveBeenCalledWith('STALE-PAYLOAD-JTI', expect.any(Number));
  });

  it('commits a durable retry for every failed family marker before failing closed', async () => {
    const grantOwner = '33333333-3333-4333-8333-333333333333';
    const refreshOwner = '44444444-4444-4444-8444-444444444444';
    mockSelectRows([{ id: 'grant-failed', accountId: grantOwner }]);
    mockSelectRows([{
      id: 'refresh-failed',
      userId: refreshOwner,
      expiresAt: new Date(Date.now() + 3600_000),
    }]);
    insertMock.mockImplementation((() => {
      let queuedUserId = '';
      const returning = vi.fn(async () => [{ userId: queuedUserId }]);
      const onConflictDoUpdate = vi.fn(() => ({ returning }));
      const values = vi.fn((input: { userId: string }) => {
        queuedUserId = input.userId;
        return { onConflictDoUpdate };
      });
      return { values };
    }) as unknown as typeof db.insert);
    revokeGrantMock.mockRejectedValueOnce(new Error('Redis unavailable'));
    revokeJtiMock.mockRejectedValueOnce(new Error('Redis unavailable'));

    await expect(revokeClientFamilies(CLIENT, { kind: 'global' })).rejects.toThrow();

    const queued = insertMock.mock.results.map((result) => {
      const values = (result.value as { values: ReturnType<typeof vi.fn> }).values;
      return values.mock.calls[0]?.[0] as { userId?: string; markerId?: string };
    });
    expect(queued).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: grantOwner, markerId: 'grant-failed' }),
      expect.objectContaining({ userId: refreshOwner, markerId: 'refresh-failed' }),
    ]));
    expect(updateSetCalls).toContainEqual(expect.objectContaining({ revokedAt: expect.any(Date) }));
    expect(updateSetCalls).toContainEqual(expect.objectContaining({ disabledAt: expect.any(Date) }));
  });
});
