import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  buildReceiptClaimCas,
  buildReceiptDeliveringCas,
  buildDeliveredRetentionDeleteQuery,
  buildShadowRetentionDeleteQuery,
  buildResidualRetentionDeleteQuery,
  buildResidualRetentionCountQuery,
  buildShadowWindowQuery
} from './eventDispatchWorker';

const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();

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

/**
 * Retention delete/count queries (Task 7, #4085) — each pass targets a
 * DIFFERENT status/mode/age predicate; a mutation swapping one pass's
 * predicate for another's (or widening/narrowing the interval) would delete
 * the wrong rows on a live table with no test-visible symptom other than
 * this compiled-SQL assertion.
 */
describe('receipt retention queries (compiled SQL)', () => {
  const dialect = new PgDialect();

  it('pass 1: delivered receipts older than 7 days, batched via ctid LIMIT', () => {
    const { sql, params } = dialect.sqlToQuery(buildDeliveredRetentionDeleteQuery());
    expect(normalize(sql)).toBe(
      "DELETE FROM event_delivery_receipts WHERE ctid IN ( SELECT ctid FROM event_delivery_receipts "
      + "WHERE status = 'delivered' AND created_at < now() - interval '7 days' LIMIT $1 )"
    );
    expect(params).toEqual([5000]);
  });

  it("pass 2: ALL shadow-mode receipts older than 48 hours (no status filter — shadow terminates at 'planned')", () => {
    const { sql, params } = dialect.sqlToQuery(buildShadowRetentionDeleteQuery());
    expect(normalize(sql)).toBe(
      "DELETE FROM event_delivery_receipts WHERE ctid IN ( SELECT ctid FROM event_delivery_receipts "
      + "WHERE mode = 'shadow' AND created_at < now() - interval '48 hours' LIMIT $1 )"
    );
    expect(params).toEqual([5000]);
  });

  it('pass 3: residual failed/planned/delivering receipts older than 30 days, across both modes', () => {
    const { sql, params } = dialect.sqlToQuery(buildResidualRetentionDeleteQuery());
    expect(normalize(sql)).toBe(
      "DELETE FROM event_delivery_receipts WHERE ctid IN ( SELECT ctid FROM event_delivery_receipts "
      + "WHERE status IN ('failed', 'planned', 'delivering') AND created_at < now() - interval '30 days' LIMIT $1 )"
    );
    expect(params).toEqual([5000]);
  });

  it('pass 3 count: same predicate as the pass-3 delete, so the pre-delete warning count cannot drift from what actually gets deleted', () => {
    const { sql: deleteSql } = dialect.sqlToQuery(buildResidualRetentionDeleteQuery());
    const { sql: countSql, params } = dialect.sqlToQuery(buildResidualRetentionCountQuery());
    expect(normalize(countSql)).toBe(
      "SELECT COUNT(*)::int AS count FROM event_delivery_receipts "
      + "WHERE status IN ('failed', 'planned', 'delivering') AND created_at < now() - interval '30 days'"
    );
    expect(params).toEqual([]);
    // The inner predicate text (after "WHERE") must match the delete's inner
    // SELECT predicate verbatim — extracted rather than duplicated so this
    // test fails if the two queries' predicates are ever edited independently.
    const deletePredicate = normalize(deleteSql).match(/WHERE (status IN[^)]+\))/)![1];
    expect(normalize(countSql)).toContain(deletePredicate!);
  });
});

describe('shadow comparison window query (compiled SQL)', () => {
  const dialect = new PgDialect();

  it('selects shadow-mode receipts created at or after the window start', () => {
    const windowStart = new Date('2026-08-26T12:00:00.000Z');
    const { sql, params } = dialect.sqlToQuery(buildShadowWindowQuery(windowStart));
    expect(normalize(sql)).toBe(
      "SELECT event_id, event_type, subscriber_id FROM event_delivery_receipts "
      + 'WHERE mode = \'shadow\' AND created_at >= $1'
    );
    expect(params).toEqual(['2026-08-26T12:00:00.000Z']);
  });
});
