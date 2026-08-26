import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildResolveAlertCas, RESOLVABLE_ALERT_STATUSES } from './alertService';

/**
 * COMPILED-SQL assertions, deliberately in their own file so it can import the
 * REAL drizzle-orm.
 *
 * The sibling `alertService.resolveCas.test.ts` mocks drizzle wholesale to test
 * handler behaviour, which means its `where` assertions can only substring-match
 * column NAMES. That is vacuous against the two mutations that matter, both
 * verified to pass green before this file existed:
 *
 *   - `and(...)` -> `or(...)`: every active/acknowledged/suppressed alert in
 *     EVERY tenant gets stamped resolved by a single call;
 *   - adding a terminal status to the list: the CAS becomes a no-op and the
 *     duplicate `alert.resolved` fan-out this PR exists to stop comes back.
 *
 * Compiling the predicate catches both, because either one changes the emitted
 * SQL or its parameters.
 */
describe('resolveAlert compare-and-swap predicate (compiled SQL)', () => {
  const dialect = new PgDialect();

  it('emits an AND of the id equality and the resolvable-status set', () => {
    const { sql, params } = dialect.sqlToQuery(buildResolveAlertCas('alert-1')!);

    expect(sql).toBe('("alerts"."id" = $1 and "alerts"."status" in ($2, $3, $4))');
    expect(params).toEqual(['alert-1', 'active', 'acknowledged', 'suppressed']);
  });

  it('never admits a terminal status', () => {
    // `resolved` and `dismissed` are terminal (db/schema/alerts.ts). Admitting
    // either makes the CAS match an already-finished alert, i.e. no CAS at all.
    expect(RESOLVABLE_ALERT_STATUSES).not.toContain('resolved');
    expect(RESOLVABLE_ALERT_STATUSES).not.toContain('dismissed');
  });
});
