import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  buildExecutionClaimCas,
  buildExistingDeliveryLookup,
  buildReleaseClaimCas,
  buildOutcomeWriteCas
} from './webhookDeliveryRecord';

/**
 * COMPILED-SQL assertions for the two predicates that used to be anonymous
 * closures inside `index.ts` and were therefore untestable at any level.
 *
 * Both are safety-critical and neither is covered by a behavioural suite:
 *
 *   - the execution claim is what stops one delivery, present twice on a
 *     duplicated queue wake-up, from POSTing to the customer TWICE. Losing
 *     the status guard from it turns the claim into an unconditional
 *     success and every duplicate delivers;
 *   - the dedupe read-back names the row a skip deferred to. Losing the
 *     `webhook_id` conjunct makes it report ANOTHER webhook's delivery status
 *     as this one's, since one event fans out to every subscribed webhook and
 *     `event_id` alone is not unique.
 */
describe('webhook delivery record predicates (compiled SQL)', () => {
  const dialect = new PgDialect();

  it('claims exactly one attempt, ignoring pending leases but honoring scheduled due time in UTC', () => {
    const { sql, params } = dialect.sqlToQuery(buildExecutionClaimCas('delivery-1', 3));
    expect(sql).toBe(
      '("webhook_deliveries"."id" = $1 and "webhook_deliveries"."attempts" = $2 and '
      + '("webhook_deliveries"."status" = $3 or ("webhook_deliveries"."status" = $4 and '
      + `("webhook_deliveries"."next_retry_at" is null or "webhook_deliveries"."next_retry_at" <= (now() AT TIME ZONE 'UTC')))))`
    );
    expect(params).toEqual(['delivery-1', 3, 'pending', 'scheduled']);
  });

  it('failure outcome requires the same attempt still retrying', () => {
    const { sql, params } = dialect.sqlToQuery(buildOutcomeWriteCas('delivery-1', 3, false));
    expect(sql).toBe('("webhook_deliveries"."id" = $1 and "webhook_deliveries"."attempts" = $2 and "webhook_deliveries"."status" = $3)');
    expect(params).toEqual(['delivery-1', 3, 'retrying']);
  });

  it('success may correct only the same retrying or failed attempt', () => {
    const { sql, params } = dialect.sqlToQuery(buildOutcomeWriteCas('delivery-1', 3, true));
    expect(sql).toBe('("webhook_deliveries"."id" = $1 and "webhook_deliveries"."attempts" = $2 and "webhook_deliveries"."status" in ($3, $4))');
    expect(params).toEqual(['delivery-1', 3, 'retrying', 'failed']);
  });

  it('release CAS pins retrying status and the attempt', () => {
    const { sql, params } = dialect.sqlToQuery(buildReleaseClaimCas('delivery-1', 3));
    expect(sql).toBe('("webhook_deliveries"."id" = $1 and "webhook_deliveries"."status" = $2 and "webhook_deliveries"."attempts" = $3)');
    expect(params).toEqual(['delivery-1', 'retrying', 3]);
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
