import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { PgDialect } from 'drizzle-orm/pg-core';

const mocks = vi.hoisted(() => ({
  returning: vi.fn(),
  where: vi.fn(),
  set: vi.fn(),
  update: vi.fn(),
  outside: vi.fn(),
  system: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { update: mocks.update },
  runOutsideDbContext: mocks.outside,
  withSystemDbAccessContext: mocks.system,
}));
vi.mock('./redis', () => ({ getRedis: vi.fn() }));

import { getRedis } from './redis';
import { revokeFamily } from './tokenRevocation';

const FAMILY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const redisStatuses = ['confirmed', 'unavailable', 'failed'] as const;
const databaseStatuses = ['confirmed', 'not_found', 'failed'] as const;

describe('family revocation acknowledgements', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.returning.mockResolvedValue([{ familyId: FAMILY_ID }]);
    mocks.where.mockReturnValue({ returning: mocks.returning });
    mocks.set.mockReturnValue({ where: mocks.where });
    mocks.update.mockReturnValue({ set: mocks.set });
    mocks.outside.mockImplementation((fn: () => unknown) => fn());
    mocks.system.mockImplementation((fn: () => unknown) => fn());
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it.each(redisStatuses.flatMap((redis) =>
    databaseStatuses.map((database) => ({ redis, database })),
  ))('reports redis=$redis and database=$database independently', async ({ redis, database }) => {
    const setex = vi.fn().mockResolvedValue('OK');
    if (redis === 'failed') setex.mockRejectedValue(new Error('redis unavailable'));
    vi.mocked(getRedis).mockReturnValue(redis === 'unavailable' ? null : { setex } as unknown as Redis);
    if (database === 'failed') mocks.returning.mockRejectedValue(new Error('database unavailable'));
    if (database === 'not_found') mocks.returning.mockResolvedValue([]);

    expect(await revokeFamily(FAMILY_ID, 'reuse-detected')).toEqual({ redis, database });
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.returning).toHaveBeenCalledOnce();
    expect(setex).toHaveBeenCalledTimes(redis === 'unavailable' ? 0 : 1);
    if (redis !== 'unavailable') {
      expect(setex).toHaveBeenCalledWith(
        `refresh-fam-revoked:${FAMILY_ID}`, 7 * 24 * 60 * 60 + 15 * 60, '1',
      );
    }
  });

  it('does not confirm a returned row when the enclosing system transaction fails', async () => {
    vi.mocked(getRedis).mockReturnValue({ setex: vi.fn().mockResolvedValue('OK') } as unknown as Redis);
    mocks.system.mockImplementation(async (fn: () => Promise<unknown>) => {
      await fn();
      throw new Error('commit acknowledgement unavailable');
    });

    expect(await revokeFamily(FAMILY_ID, 'reuse-detected')).toEqual({
      redis: 'confirmed', database: 'failed',
    });
    expect(mocks.returning).toHaveBeenCalledOnce();
  });

  it('escapes an ambient context before opening the independently committed system write', async () => {
    vi.mocked(getRedis).mockReturnValue(null);
    let outside = false;
    mocks.outside.mockImplementation(async (fn: () => Promise<unknown>) => {
      outside = true;
      try { return await fn(); } finally { outside = false; }
    });
    mocks.system.mockImplementation(async (fn: () => Promise<unknown>) => {
      expect(outside).toBe(true);
      return fn();
    });

    expect(await revokeFamily(FAMILY_ID, 'reuse-detected')).toEqual({
      redis: 'unavailable', database: 'confirmed',
    });
    expect(mocks.outside).toHaveBeenCalledOnce();
  });

  it('caps the persisted reason and preserves the first timestamp/reason on repeat attempts', async () => {
    vi.mocked(getRedis).mockReturnValue(null);
    await revokeFamily(FAMILY_ID, 'x'.repeat(100));
    const update = mocks.set.mock.calls[0]![0];
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(update.revokedAt)).toMatchObject({ sql: 'COALESCE(revoked_at, now())' });
    expect(dialect.sqlToQuery(update.revokedReason)).toMatchObject({
      sql: 'COALESCE(revoked_reason, $1)', params: ['x'.repeat(64)],
    });
    // Assert the predicate COLUMN too, not just the bound value: matching only
    // on params would still pass if the filter were swapped to another
    // uuid-shaped column (user_id), which would revoke far more than asked.
    const predicate = dialect.sqlToQuery(mocks.where.mock.calls[0]![0]);
    expect(predicate.sql).toBe('"refresh_token_families"."family_id" = $1');
    expect(predicate.params).toEqual([FAMILY_ID]);
  });
});
