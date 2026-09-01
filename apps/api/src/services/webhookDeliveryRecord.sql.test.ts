import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  buildExecutionClaimCas,
  buildExistingDeliveryLookup,
  buildOutcomeWriteCas
} from './webhookDeliveryRecord';

/**
 * COMPILED-SQL assertions for the two predicates that used to be anonymous
 * closures inside `index.ts` and were therefore untestable at any level.
 *
 * Both are safety-critical and neither is covered by a behavioural suite:
 *
 *   - the execution claim is what stops one delivery, present twice on a
 *     queue with no job identity, from POSTing to the customer TWICE. Losing
 *     `status = 'pending'` from it turns the claim into an unconditional
 *     success and every duplicate delivers;
 *   - the dedupe read-back names the row a skip deferred to. Losing the
 *     `webhook_id` conjunct makes it report ANOTHER webhook's delivery status
 *     as this one's, since one event fans out to every subscribed webhook and
 *     `event_id` alone is not unique.
 */
describe('webhook delivery record predicates (compiled SQL)', () => {
  const dialect = new PgDialect();

  it('execution claim is an AND of the delivery id and a pending marker', () => {
    const { sql, params } = dialect.sqlToQuery(buildExecutionClaimCas('delivery-1'));

    expect(sql).toBe(
      '("webhook_deliveries"."id" = $1 and "webhook_deliveries"."status" = $2)'
    );
    expect(params).toEqual(['delivery-1', 'pending']);
  });

  it('outcome write refuses to overwrite a recorded success', () => {
    const { sql, params } = dialect.sqlToQuery(buildOutcomeWriteCas('delivery-1'));

    // The `<> 'delivered'` conjunct is what stops a late-arriving FAILURE from
    // clobbering a success the customer already received. It lived as an
    // anonymous closure in coverage-excluded `index.ts`, where deleting it
    // passed everywhere.
    expect(sql).toBe(
      '("webhook_deliveries"."id" = $1 and "webhook_deliveries"."status" <> $2)'
    );
    expect(params).toEqual(['delivery-1', 'delivered']);
  });

  it('dedupe read-back is keyed on BOTH webhook and event', () => {
    const { sql, params } = dialect.sqlToQuery(
      buildExistingDeliveryLookup('webhook-1', 'event-1')
    );

    // Both conjuncts, in the same shape as the unique index the insert
    // conflicted on.
    expect(sql).toBe(
      '("webhook_deliveries"."webhook_id" = $1 and "webhook_deliveries"."event_id" = $2)'
    );
    expect(params).toEqual(['webhook-1', 'event-1']);
  });
});
