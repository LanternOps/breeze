import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({
  db: { execute: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { db, withSystemDbAccessContext } from '../db';
import { hashBootstrapToken } from './installerBootstrapToken';
import { hashLegacyInstallerBootstrapTokens } from './installerBootstrapTokenHashBackfill';

const dialect = new PgDialect();
function render(call: unknown[]) {
  return dialect.sqlToQuery(call[0] as any);
}

/**
 * Scripted db.execute: SELECTs are answered from `batches` in order, UPDATEs
 * by `updateResult(id)`.
 */
function script(batches: Array<Array<{ id: string; token: string }>>, updateResult: (id: string) => unknown[] | Error) {
  const queue = [...batches];
  vi.mocked(db.execute).mockImplementation((async (q: any) => {
    const { sql, params } = dialect.sqlToQuery(q);
    if (/^\s*select/i.test(sql)) return queue.shift() ?? [];
    const id = params.find((p) => typeof p === 'string' && /^id-/.test(p)) as string;
    const r = updateResult(id);
    if (r instanceof Error) throw r;
    return r;
  }) as any);
}

describe('hashLegacyInstallerBootstrapTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('replaces each plaintext token with its keyed hash via a compare-and-set, in system scope', async () => {
    script([[{ id: 'id-1', token: 'AAAAAAAAAA' }, { id: 'id-2', token: 'BBBBBBBBBB' }]], (id) => [{ id }]);

    const stats = await hashLegacyInstallerBootstrapTokens({ batchSize: 50 });

    expect(stats).toEqual({ scanned: 2, hashed: 2, contended: 0, failed: 0 });
    expect(withSystemDbAccessContext).toHaveBeenCalled();
    const updates = vi.mocked(db.execute).mock.calls.map(render).filter((q) => /^\s*update/i.test(q.sql));
    expect(updates).toHaveLength(2);
    const first = updates[0]!;
    expect(first.sql).toMatch(/set token_hash = \$\d+, token = null/i);
    // CAS: only while the row still holds exactly this plaintext and no hash.
    expect(first.sql).toMatch(/token = \$\d+/i);
    expect(first.sql).toMatch(/token_hash is null/i);
    expect(first.params).toEqual(expect.arrayContaining([hashBootstrapToken('AAAAAAAAAA'), 'AAAAAAAAAA', 'id-1']));
  });

  it('selects only legacy rows (plaintext present, hash absent), keyset-paginated', async () => {
    script([[{ id: 'id-1', token: 'AAAAAAAAAA' }]], (id) => [{ id }]);
    await hashLegacyInstallerBootstrapTokens({ batchSize: 1 });
    const selects = vi.mocked(db.execute).mock.calls.map(render).filter((q) => /^\s*select/i.test(q.sql));
    expect(selects.length).toBe(2); // one batch + the empty terminating batch
    expect(selects[0]!.sql).toMatch(/token is not null/i);
    expect(selects[0]!.sql).toMatch(/token_hash is null/i);
    expect(selects[1]!.params).toContain('id-1');
  });

  it('counts a row whose plaintext changed under it as contended, not hashed', async () => {
    script([[{ id: 'id-1', token: 'AAAAAAAAAA' }]], () => []);
    const stats = await hashLegacyInstallerBootstrapTokens();
    expect(stats).toEqual({ scanned: 1, hashed: 0, contended: 1, failed: 0 });
  });

  it('counts and logs a failed row by id only, and keeps going', async () => {
    const logger = { error: vi.fn() };
    script(
      [[{ id: 'id-1', token: 'AAAAAAAAAA' }, { id: 'id-2', token: 'BBBBBBBBBB' }]],
      (id) => (id === 'id-1' ? new Error('duplicate key') : [{ id }]),
    );
    const stats = await hashLegacyInstallerBootstrapTokens({ logger });
    expect(stats).toEqual({ scanned: 2, hashed: 1, contended: 0, failed: 1 });
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).toContain('id-1');
    expect(logged).not.toContain('AAAAAAAAAA');
  });

  it('fails before touching the database when no pepper is configured', async () => {
    vi.stubEnv('ENROLLMENT_KEY_PEPPER', '');
    vi.stubEnv('NODE_ENV', 'production');
    await expect(hashLegacyInstallerBootstrapTokens()).rejects.toThrow(/ENROLLMENT_KEY_PEPPER/);
    expect(db.execute).not.toHaveBeenCalled();
  });
});
