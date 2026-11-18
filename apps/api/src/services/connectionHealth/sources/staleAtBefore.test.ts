import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { staleAtBefore, staleCutoff } from './observeRows';

describe('staleAtBefore', () => {
  const now = new Date('2026-11-09T10:00:00.000Z');

  it('casts the ISO instant bind parameter to timestamp', () => {
    const q = new PgDialect().sqlToQuery(staleAtBefore(sql`some_expr`, now));
    expect(q.sql).toBe('(some_expr < $1::timestamp)');
    expect(q.params).toEqual(['2026-11-09T10:00:00.000Z']);
  });

  it('staleCutoff subtracts the threshold floor', () => {
    expect(staleCutoff(now, 60)).toBe('2026-11-09T09:00:00.000Z');
  });
});
