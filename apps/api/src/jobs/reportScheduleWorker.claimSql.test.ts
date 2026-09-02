import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildOccurrenceClaimCas } from './reportScheduleWorker';

/**
 * COMPILED-SQL assertion for the inline occurrence claim CAS, in its own file
 * so it imports the REAL drizzle-orm (no `../db`/`../db/schema` mocks) — see
 * `src/jobs/incidentJobs.claimSql.test.ts` for the sibling precedent and its
 * rationale: a mocked-drizzle `.where(...)` assertion in
 * `reportScheduleWorker.test.ts` can only substring-match column names, which
 * cannot tell `eq` from `isNull`, cannot notice a dropped `reports.id`
 * predicate, and cannot see whether the two predicates are ANDed or ORed —
 * every one of those mutations would let an overlapping 5-minute tick
 * double-generate the same scheduled-report occurrence, and would pass a
 * mock-only assertion green.
 */
describe('report schedule occurrence claim CAS (compiled SQL)', () => {
  const dialect = new PgDialect();

  it('never-generated observation (null) claims via IS NULL, not equality', () => {
    const { sql, params } = dialect.sqlToQuery(buildOccurrenceClaimCas('report-1', null)!);

    expect(sql).toBe('("reports"."id" = $1 and "reports"."last_generated_at" is null)');
    expect(params).toEqual(['report-1']);
  });

  it('a previously-generated observation claims via equality against the observed timestamp', () => {
    const observed = new Date('2026-07-01T09:00:00.000Z');
    const { sql, params } = dialect.sqlToQuery(buildOccurrenceClaimCas('report-1', observed)!);

    expect(sql).toBe('("reports"."id" = $1 and "reports"."last_generated_at" = $2)');
    expect(params).toEqual(['report-1', observed.toISOString()]);
  });
});
