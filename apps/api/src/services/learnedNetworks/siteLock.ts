/**
 * Learned networks E1 (#12369, spec §8.2-8.3): the per-site lock every network-gate writer and reader takes.
 *
 * Transaction-scoped advisory locks keyed by site id. Dispatch and profile saves take `shared`; assignment,
 * unassignment, merge and "stop requiring" take `exclusive`. Lock order for every writer: these site locks in
 * ascending id, then the profile row. Never hold one across Redis or WebSocket I/O (#1105).
 */
import { sql } from 'drizzle-orm';
import { assertInTransaction, db } from '../../db';

/** Distinct site ids in the order they are locked (ascending string compare). Pure. */
export function planSiteLocks(siteIds: readonly string[]): string[] {
  return [...new Set(siteIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Takes one lock per distinct site, ascending, inside the caller's transaction; released at commit or rollback.
 * One statement per site: a set-returning form would not fix the order the locks are taken in. A `hashtext`
 * collision only makes two sites share a lock.
 */
export async function lockSitesForNetworkGate(
  siteIds: readonly string[],
  mode: 'shared' | 'exclusive',
): Promise<void> {
  assertInTransaction('lockSitesForNetworkGate');
  for (const siteId of planSiteLocks(siteIds)) {
    if (mode === 'shared') {
      await db.execute(sql`select pg_advisory_xact_lock_shared(hashtext('learned-network-site'), hashtext(${siteId}))`);
    } else {
      await db.execute(sql`select pg_advisory_xact_lock(hashtext('learned-network-site'), hashtext(${siteId}))`);
    }
  }
}
