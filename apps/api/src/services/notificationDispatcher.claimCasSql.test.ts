import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildAlertNotificationClaimCas } from './notificationDispatcher';

/**
 * COMPILED-SQL assertion for the alert_notifications send-identity claim/
 * success CAS (wave 3.5c, #4085), in its own file so it imports the REAL
 * drizzle-orm.
 *
 * The sibling `notificationDispatcher.test.ts` mocks `../db` to exercise
 * `processSendNotification`'s branches; its `where` assertions can only
 * structurally compare the predicate object built by the real drizzle-orm
 * (which this file also imports unmocked) — they cannot prove what SQL it
 * actually compiles to. Two mutations would pass a mocked-drizzle assertion
 * but matter here:
 *
 *   - `ne(status, 'sent')` flipping to `eq(status, 'sent')` -> nothing is
 *     ever reclaimable/CASable, so the state machine can never finish a send;
 *   - dropping the `ne` conjunct entirely -> the dedupe backstop becomes a
 *     no-op: an already-'sent' row can be reclaimed back to 'pending' and
 *     re-sent by a stale/racing attempt.
 */
describe('alert_notifications send-identity claim CAS (compiled SQL)', () => {
  const dialect = new PgDialect();

  it('is an AND of the row id equality and "status <> sent"', () => {
    const { sql, params } = dialect.sqlToQuery(buildAlertNotificationClaimCas('notif-1'));

    expect(sql).toBe(
      '("alert_notifications"."id" = $1 and "alert_notifications"."status" <> $2)'
    );
    expect(params).toEqual(['notif-1', 'sent']);
  });
});
