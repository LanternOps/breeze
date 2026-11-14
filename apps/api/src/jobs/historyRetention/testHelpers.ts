/**
 * Test-only helpers for the history retention target tests (#4342 W5).
 * Not imported by production code.
 */
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

export const CUTOFF = '2026-01-01T00:00:00.000Z';
export const NOW = '2026-05-01T00:00:00.000Z';

const dialect = new PgDialect();

/** Rendered SQL with whitespace collapsed, plus its bound params. */
export function render(q: SQL): { sql: string; params: unknown[] } {
  const out = dialect.sqlToQuery(q);
  return { sql: out.sql.replace(/\s+/g, ' ').trim(), params: out.params as unknown[] };
}

/** The mocks every target module needs: retentionBatch imports the db and sentry. */
export const dbMock = () => ({
  db: { execute: () => { throw new Error('no db in unit tests'); } },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
});
export const sentryMock = () => ({ captureException: () => {}, captureMessage: () => {} });
