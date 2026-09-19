import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

// Only the CONNECTION is mocked. drizzle-orm and ../db/schema stay REAL so the
// predicate can be compiled — the whole point of this file.
vi.mock('../db', () => ({ db: {} }));

import { alertStatusEnum } from '../db/schema/alerts';
import { DISMISSIBLE_ALERT_STATUSES, buildDismissAlertCas } from './alertService';

/**
 * COMPILED-SQL assertions for the dismiss compare-and-swap predicate (#4293), the
 * third file in the set alongside `alertService.resolveCasSql.test.ts` (#4094) and
 * `alertService.ackCasSql.test.ts` (#4101).
 *
 * The cross-list drift guard that keeps all FOUR status lists anchored to the
 * `alert_status` enum lives in `alertService.ackCasSql.test.ts` and covers
 * `DISMISSIBLE_ALERT_STATUSES` too — including the deliberate carve-out that makes
 * dismiss the one transition legal from a terminal status. This file asserts only
 * what is specific to dismiss.
 */
describe('dismiss compare-and-swap predicate (compiled SQL)', () => {
  const dialect = new PgDialect();

  it('emits an AND of the id equality and the dismissible-status set', () => {
    const { sql, params } = dialect.sqlToQuery(buildDismissAlertCas('alert-3')!);

    expect(sql).toBe('("alerts"."id" = $1 and "alerts"."status" in ($2, $3, $4, $5))');
    expect(params).toEqual(['alert-3', 'active', 'acknowledged', 'suppressed', 'resolved']);
  });

  it('admits `resolved` — dismiss is the ONE transition legal from a terminal status', () => {
    // Not an oversight and not a copy of the other lists. Dismiss exists precisely so
    // an already-resolved alert can be cleared from the list for good, and the route
    // docblock says so. Dropping `resolved` here would turn a documented workflow
    // into a 409.
    expect([...DISMISSIBLE_ALERT_STATUSES]).toContain('resolved');
  });

  it('never admits `dismissed` itself, or the CAS stops guarding anything', () => {
    // This is the assertion that keeps #4293 closed. With `dismissed` in the set the
    // predicate matches an already-dismissed row, so the losing caller's UPDATE
    // succeeds again and re-stamps dismissedAt/dismissedBy over the winner's — the
    // exact provenance clobber the CAS was added to stop, reintroduced while every
    // behavioural test still passes.
    expect([...DISMISSIBLE_ALERT_STATUSES]).not.toContain('dismissed');
  });

  it('is every enum value EXCEPT `dismissed`, derived from the enum', () => {
    // A new `alert_status` value (say `snoozed`) that nobody adds here would be
    // silently un-dismissable: the alert could never be cleared, with no error to
    // explain why. Deriving the expectation from the enum turns that into a failing
    // test instead of a field report.
    const expected = alertStatusEnum.enumValues.filter((status) => status !== 'dismissed');
    expect([...DISMISSIBLE_ALERT_STATUSES].sort()).toEqual([...expected].sort());
  });
});
