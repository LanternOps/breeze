import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildReceiptClaimCas, buildReceiptDeliveringCas } from './eventDispatchWorker';

/**
 * COMPILED-SQL assertions for the receipt CAS predicates (vacuous-Drizzle-
 * assertion rule — a `where` assertion against a mocked db can only
 * substring-match column names and is blind to the mutations that actually
 * matter here:
 *
 *   - the claim CAS losing `ne(status, 'delivered')` (e.g. collapsing to just
 *     `eq(eventId)`/`eq(subscriberId)`) -> a delivered receipt gets re-claimed
 *     and its subscriber handler re-executed, breaking the post-retention
 *     dedupe this table exists to provide;
 *   - the claim CAS's `ne` flipping to `eq` (delivered-only) -> nothing
 *     EVER claims, and every event silently stops delivering;
 *   - either CAS dropping the `subscriberId` conjunct -> one subscriber's
 *     claim/outcome write clobbers every other subscriber's receipt for the
 *     same event (the PK is the pair, not eventId alone);
 *   - the delivering CAS's `eq(status, 'delivering')` loosening to `ne(status,
 *     'delivered')` -> an outcome write could land on a `planned` or already
 *     `failed` row that never actually held this attempt's claim.
 */
describe('event delivery receipt predicates (compiled SQL)', () => {
  const dialect = new PgDialect();

  it('claim CAS admits everything except a delivered receipt, keyed on both eventId and subscriberId', () => {
    const { sql, params } = dialect.sqlToQuery(buildReceiptClaimCas('event-1', 'webhook-delivery'));

    expect(sql).toBe(
      '("event_delivery_receipts"."event_id" = $1 '
      + 'and "event_delivery_receipts"."subscriber_id" = $2 '
      + 'and "event_delivery_receipts"."status" <> $3)'
    );
    expect(params).toEqual(['event-1', 'webhook-delivery', 'delivered']);
  });

  it('delivering CAS only matches a receipt this attempt actually holds the claim on', () => {
    const { sql, params } = dialect.sqlToQuery(buildReceiptDeliveringCas('event-1', 'webhook-delivery'));

    expect(sql).toBe(
      '("event_delivery_receipts"."event_id" = $1 '
      + 'and "event_delivery_receipts"."subscriber_id" = $2 '
      + 'and "event_delivery_receipts"."status" = $3)'
    );
    expect(params).toEqual(['event-1', 'webhook-delivery', 'delivering']);
  });
});
