import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// Only the CONNECTION is mocked. drizzle-orm and ../db/schema stay REAL, so the
// predicate `resolveAlert` hands to `.where()` is a real `SQL` object that can be
// compiled — see the note on the `resolveAlert` block below for why that matters.
const { updateWheres } = vi.hoisted(() => ({ updateWheres: [] as unknown[] }));

vi.mock('../db', () => ({
  db: {
    update: () => ({
      set: () => ({
        where: (predicate: unknown) => {
          updateWheres.push(predicate);
          // Empty RETURNING = the CAS matched nothing, i.e. this caller lost.
          // resolveAlert then returns early, so no redis/event-bus work runs and
          // this file needs no further mocks.
          return { returning: () => Promise.resolve([]) };
        },
      }),
    }),
  },
}));

import { buildResolveAlertCas, RESOLVABLE_ALERT_STATUSES, resolveAlert } from './alertService';

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

/**
 * The two tests above compile the HELPER. Until #4094 that was one step removed
 * from production: `resolveAlert` built its own copy of the same `and(...)` inline,
 * so the helper and the shipped predicate could drift apart with this file staying
 * green. These tests close that gap by compiling the predicate the function
 * actually passes to `.where()`.
 */
describe('resolveAlert ships the compiled CAS, not a lookalike', () => {
  const dialect = new PgDialect();

  beforeEach(() => {
    updateWheres.length = 0;
  });

  it('passes the exact compare-and-swap predicate to the UPDATE', async () => {
    await resolveAlert('alert-9');

    expect(updateWheres).toHaveLength(1);
    const { sql, params } = dialect.sqlToQuery(updateWheres[0] as SQL);

    expect(sql).toBe('("alerts"."id" = $1 and "alerts"."status" in ($2, $3, $4))');
    expect(params).toEqual(['alert-9', 'active', 'acknowledged', 'suppressed']);
  });

  it('ships the same SQL the helper compiles to', async () => {
    await resolveAlert('alert-9');

    expect(dialect.sqlToQuery(updateWheres[0] as SQL)).toEqual(
      dialect.sqlToQuery(buildResolveAlertCas('alert-9')!)
    );
  });
});
