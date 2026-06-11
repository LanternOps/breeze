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
