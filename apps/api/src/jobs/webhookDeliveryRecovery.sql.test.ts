import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  buildLeaseHeldCas,
  buildRecoveryClaimCas,
  buildUnresolvedScope,
  STALE_PENDING_MS
} from './webhookDeliveryRecovery';

/**
 * COMPILED-SQL assertions, in their own file so it imports the REAL drizzle-orm.
 *
 * The sibling `webhookDeliveryRecovery.test.ts` mocks the db to exercise the
 * sweep body; a `where` assertion there can only substring-match column names
 * and is blind to the mutations that actually matter here:
 *
 *   - the claim CAS losing `eq(webhookDeliveries.id, …)` -> the first stale
 *     row's iteration claims and re-POSTs EVERY unresolved delivery in every
 *     tenant;
 *   - `and` -> `or` anywhere in the scope -> the sweep re-delivers rows that
 *     already succeeded;
 *   - `or(isNull(nextRetryAt), lte(…))` collapsing to a bare `lte(…)` -> every
 *     never-leased row (next_retry_at IS NULL) drops out of the candidate set,
 *     so the sweep recovers NOTHING and #4095 is back, silently;
 *   - the claim CAS keeping only `eq(id, …)` and trusting the preceding SELECT
 *     for the rest -> the row can change in the gap between the two statements
 *     and the claim stops being atomic;
 *   - the lease CAS matching a RANGE rather than the exact lease instant -> the
 *     terminal write can land on a row another instance has since re-leased.
 */
describe('webhook delivery recovery predicates (compiled SQL)', () => {
  const dialect = new PgDialect();
  const now = new Date('2026-09-11T12:00:00.000Z');

  const atMs = (param: unknown) => new Date(param as string | number | Date).getTime();

  it('scopes candidates to unresolved, aged out, and not currently leased', () => {
    const { sql, params } = dialect.sqlToQuery(buildUnresolvedScope(now));

    expect(sql).toBe(
      '("webhook_deliveries"."status" in ($1, $2) '
      + 'and "webhook_deliveries"."created_at" < $3 '
      + 'and ("webhook_deliveries"."next_retry_at" is null '
      + 'or "webhook_deliveries"."next_retry_at" <= $4))'
    );

    // Both unresolved statuses, and ONLY those: `delivered`/`failed` are
    // terminal and must never be re-driven.
    expect(params.slice(0, 2)).toEqual(['pending', 'retrying']);
    // The age cut-off is derived from `now`, not hard-coded.
    expect(atMs(params[2])).toBe(now.getTime() - STALE_PENDING_MS);
    expect(atMs(params[3])).toBe(now.getTime());
  });

  it('claim CAS re-asserts the ENTIRE candidate scope against one id', () => {
    const { sql, params } = dialect.sqlToQuery(buildRecoveryClaimCas('delivery-1', now));

    // Every conjunct of the scan predicate is repeated here on purpose: only
    // predicates inside the UPDATE are evaluated atomically with the write.
    expect(sql).toBe(
      '("webhook_deliveries"."id" = $1 '
      + 'and "webhook_deliveries"."status" in ($2, $3) '
      + 'and "webhook_deliveries"."created_at" < $4 '
      + 'and ("webhook_deliveries"."next_retry_at" is null '
      + 'or "webhook_deliveries"."next_retry_at" <= $5))'
    );
    expect(params[0]).toBe('delivery-1');
    expect(params.slice(1, 3)).toEqual(['pending', 'retrying']);
    expect(atMs(params[3])).toBe(now.getTime() - STALE_PENDING_MS);
    expect(atMs(params[4])).toBe(now.getTime());
  });

  it('lease CAS matches the exact lease instant, not a range', () => {
    const leaseUntil = new Date('2026-09-11T12:15:00.000Z');
    const { sql, params } = dialect.sqlToQuery(buildLeaseHeldCas('delivery-1', leaseUntil));

    expect(sql).toBe(
      '("webhook_deliveries"."id" = $1 '
      + 'and "webhook_deliveries"."status" in ($2, $3) '
      + 'and "webhook_deliveries"."next_retry_at" = $4)'
    );
    expect(params[0]).toBe('delivery-1');
    expect(params.slice(1, 3)).toEqual(['pending', 'retrying']);
    expect(atMs(params[3])).toBe(leaseUntil.getTime());
  });
});
