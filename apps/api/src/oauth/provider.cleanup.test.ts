import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db';
import {
  oauthAuthorizationCodes,
  oauthClients,
  oauthGrants,
  oauthInteractions,
  oauthRefreshTokens,
  oauthSessions,
} from '../db/schema';
import {
  cleanupExpiredOauthLifecycleRows,
  cleanupStaleOauthClients,
  DCR_STALE_CLIENT_TTL_MS,
  OAUTH_LIFECYCLE_ROW_RETENTION_MS,
} from './provider';

vi.mock('../db', () => ({
  db: { delete: vi.fn() },
}));

const deleteMock = vi.mocked(db.delete);

function queueDeleteReturning(rows: unknown[] = []) {
  const returning = vi.fn(async (_projection?: unknown) => rows);
  const where = vi.fn((_predicate: unknown) => ({ returning }));
  deleteMock.mockReturnValueOnce({ where } as unknown as ReturnType<typeof db.delete>);
  return { where, returning };
}

function collectSqlStrings(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const chunks = (value as { queryChunks?: unknown[] }).queryChunks;
  const stringValue = (value as { value?: unknown }).value;
  let out = '';
  if (Array.isArray(stringValue)) {
    out += stringValue.join('');
  }
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) {
      out += collectSqlStrings(chunk);
    }
  }
  return out;
}

function collectColumnNames(value: unknown, acc: string[] = [], seen = new WeakSet<object>()): string[] {
  if (!value || typeof value !== 'object') return acc;
  if (seen.has(value)) return acc;
  seen.add(value);
  const name = (value as { name?: unknown }).name;
  const table = (value as { table?: unknown }).table;
  if (typeof name === 'string' && table) acc.push(name);
  for (const v of Object.values(value as Record<string, unknown>)) {
    collectColumnNames(v, acc, seen);
  }
  return acc;
}

function collectBoundDates(value: unknown, acc: string[] = [], seen = new WeakSet<object>()): string[] {
  if (value instanceof Date) {
    acc.push(value.toISOString());
    return acc;
  }
  if (!value || typeof value !== 'object') return acc;
  if (seen.has(value)) return acc;
  seen.add(value);
  for (const v of Object.values(value as Record<string, unknown>)) {
    collectBoundDates(v, acc, seen);
  }
  return acc;
}

describe('OAuth cleanup helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not treat clients with active OAuth state as stale orphans', async () => {
    const staleDelete = queueDeleteReturning([{ id: 'orphan-client' }]);
    const now = new Date('2026-05-02T12:00:00.000Z');

    await expect(cleanupStaleOauthClients(now)).resolves.toBe(1);

    expect(deleteMock).toHaveBeenCalledWith(oauthClients);
    const predicateSql = collectSqlStrings(staleDelete.where.mock.calls[0]![0]);
    expect((predicateSql.match(/NOT EXISTS/g) ?? [])).toHaveLength(4);
    expect((predicateSql.match(/SELECT 1/g) ?? [])).toHaveLength(4);
    expect((predicateSql.match(/>=/g) ?? [])).toHaveLength(3);
    expect(predicateSql).toContain('IS NULL');
  });

  // #5610: the age test must accept a client that WAS used once but not since
  // the cutoff, not just one that was never used at all.
  it('ages out stale clients on last_used_at as well as created_at', async () => {
    const staleDelete = queueDeleteReturning([{ id: 'once-used-client' }]);
    const now = new Date('2026-05-02T12:00:00.000Z');

    await expect(cleanupStaleOauthClients(now)).resolves.toBe(1);

    const predicate = staleDelete.where.mock.calls[0]![0];
    const lastUsedRefs = collectColumnNames(predicate).filter((n) => n === 'last_used_at');
    // one for `IS NULL`, one for the `< cutoff` comparison
    expect(lastUsedRefs.length).toBeGreaterThanOrEqual(2);
    const cutoffs = collectBoundDates(predicate);
    const expectedCutoff = new Date(now.getTime() - DCR_STALE_CLIENT_TTL_MS).toISOString();
    // created_at and last_used_at are both compared against the same cutoff
    expect(cutoffs.filter((d) => d === expectedCutoff).length).toBeGreaterThanOrEqual(2);
  });

  it('prunes only lifecycle rows past the retention cutoff', async () => {
    const deletes = [
      queueDeleteReturning([{ id: 'code-1' }]),
      queueDeleteReturning([{ id: 'interaction-1' }, { id: 'interaction-2' }]),
      queueDeleteReturning([]),
      queueDeleteReturning([{ id: 'grant-1' }]),
      queueDeleteReturning([{ id: 'refresh-1' }]),
    ];
    const now = new Date('2026-05-02T12:00:00.000Z');
    const expectedCutoff = new Date(now.getTime() - OAUTH_LIFECYCLE_ROW_RETENTION_MS);

    await expect(cleanupExpiredOauthLifecycleRows(now)).resolves.toEqual({
      authCodes: 1,
      interactions: 2,
      sessions: 0,
      grants: 1,
      refreshTokens: 1,
    });

    expect(deleteMock).toHaveBeenNthCalledWith(1, oauthAuthorizationCodes);
    expect(deleteMock).toHaveBeenNthCalledWith(2, oauthInteractions);
    expect(deleteMock).toHaveBeenNthCalledWith(3, oauthSessions);
    expect(deleteMock).toHaveBeenNthCalledWith(4, oauthGrants);
    expect(deleteMock).toHaveBeenNthCalledWith(5, oauthRefreshTokens);
    expect(collectSqlStrings(deletes[0]!.where.mock.calls[0]![0])).toContain('<');
    expect(collectSqlStrings(deletes[3]!.where.mock.calls[0]![0])).toContain('NOT EXISTS');
    expect(collectSqlStrings(deletes[4]!.where.mock.calls[0]![0])).toContain('IS NOT NULL');
    expect(deletes.every((d) => d.returning.mock.calls.length === 1)).toBe(true);
    expect(expectedCutoff.toISOString()).toBe('2026-04-25T12:00:00.000Z');
  });
});
