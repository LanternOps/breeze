/**
 * #8210 — the site location migration builds `time_entries_site_id_idx`
 * CONCURRENTLY. That build waits for every older transaction in the database,
 * and the wait obeys `lock_timeout`: if the 5s bound used for the ALTERs is
 * still set, one long-open transaction cancels the build, leaves an INVALID
 * index, and the file's own INVALID-index guard then aborts every later boot.
 * The timeout must be RESET before the concurrent build (precedent:
 * 2026-12-17-100300-time-entries-contract-line.sql).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
const MIGRATION = '2026-12-20-220000-site-location-columns.sql';

function statements(): string[] {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  return sql.split(';').map((s) => s.trim()).filter(Boolean);
}

describe('site location columns migration (#8210)', () => {
  it('resets lock_timeout before CREATE INDEX CONCURRENTLY', () => {
    const stmts = statements();
    const setAt = stmts.findIndex((s) => /^SET lock_timeout/i.test(s));
    const resetAt = stmts.findIndex((s) => /^RESET lock_timeout/i.test(s));
    const concurrentAt = stmts.findIndex((s) => /CREATE INDEX CONCURRENTLY/i.test(s));

    expect(setAt).toBeGreaterThanOrEqual(0);
    expect(concurrentAt).toBeGreaterThan(setAt);
    expect(resetAt).toBeGreaterThan(setAt);
    expect(resetAt).toBeLessThan(concurrentAt);
  });
});
