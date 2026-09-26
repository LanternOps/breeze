import { customType } from 'drizzle-orm/pg-core';

/**
 * Postgres 64-bit transaction id. Kept as a decimal STRING end to end: xid8
 * values exceed Number.MAX_SAFE_INTEGER over a database's lifetime.
 *
 * Used by the Partner API change feeds (`alerts.partner_feed_xid`,
 * `tickets.partner_feed_xid`): a BEFORE INSERT OR UPDATE trigger stamps every
 * write with `pg_current_xact_id()`, and readers bound each traversal by the
 * snapshot xmin so a committed write can never land behind a checkpoint.
 */
export const xid8 = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'xid8';
  },
});
