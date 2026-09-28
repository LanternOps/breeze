import { sql } from 'drizzle-orm';
import { db } from '../../db';

/**
 * M2 D5: run legacy collector-absence cleanup DELETEs of `network_topology`
 * with the transaction-local `breeze.topology_delete_cause` set, so the M0
 * capture trigger stamps their tombstones and legacy replay expires support
 * instead of deleting. The cause is cleared again before returning so it can
 * never tag a later user/inventory delete in the same transaction.
 */
export async function withLegacyCollectorAbsence<T>(fn: () => Promise<T>): Promise<T> {
  await db.execute(sql`SELECT set_config('breeze.topology_delete_cause', 'collector_absence', true)`);
  try {
    return await fn();
  } finally {
    await db.execute(sql`SELECT set_config('breeze.topology_delete_cause', '', true)`);
  }
}
