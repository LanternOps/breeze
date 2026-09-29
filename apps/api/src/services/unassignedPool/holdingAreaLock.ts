import { sql, type SQL } from 'drizzle-orm';

/**
 * The per-partner holding-area lock: a transaction-scoped advisory lock keyed
 * on the partner. Provisioning, enrollment admission, assignment, expiry and
 * purge all take it, so every change to one partner's holding area is
 * serialised. One key, defined here only.
 *
 * LOCK ORDER — every path that takes both locks takes them in this order:
 *   1. this per-partner holding-area advisory lock;
 *   2. the device row (FOR UPDATE), when one is involved;
 *   3. the `partners` row (FOR UPDATE, via admitPartnerDeviceCapacity or the
 *      enrollment switch).
 * Assignment follows it (the partner row is taken last, by capacity
 * admission after the move). Any deploy-key enrollment path must too: take
 * this lock first (admitParkedEnrollment does), and never hold the partners
 * row lock while waiting for it — the reverse order deadlocks against a
 * concurrent assignment.
 */
export function holdingAreaLockKey(partnerId: string): string {
  return `unassigned_pool:${partnerId}`;
}

export function holdingAreaLockSql(partnerId: string): SQL {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${holdingAreaLockKey(partnerId)}, 0))`;
}

/** Takes the lock on the caller's open transaction (released at commit/rollback). */
export async function lockPartnerHoldingArea(
  tx: { execute(query: SQL): Promise<unknown> },
  partnerId: string,
): Promise<void> {
  await tx.execute(holdingAreaLockSql(partnerId));
}
