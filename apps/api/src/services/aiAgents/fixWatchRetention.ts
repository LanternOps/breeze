/**
 * Wave 6.2a (#3828) — retention for fix-held watch state.
 *
 * Two different things age out for two different reasons:
 *
 *   - A TERMINAL watch is history. It is worth keeping while an operator might
 *     still be looking at the run it belongs to, and worthless long after.
 *   - A CLOSED circuit with no recent failures is not history at all — it is a
 *     row whose counters have already decayed to nothing. Keeping it forever
 *     would leave a per-(device, target) row for every remediation the fleet
 *     ever performed. An OPEN circuit is never purged: it is live safety state
 *     and only a human closes it.
 */
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { aiAgentCircuits, aiAgentFixWatches } from '../../db/schema/aiAgentFixWatches';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';

function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/** Matches the 90-day horizon the rest of the agent ledgers keep. */
export const FIX_WATCH_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * A closed circuit is purged once it is quiet for well over the 24h failure
 * window — long enough that the row carries no information the window would
 * still have counted.
 */
export const CIRCUIT_QUIET_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface FixWatchRetentionResult {
  watchesDeleted: number;
  circuitsDeleted: number;
}

export async function purgeExpiredFixWatchState(
  now = new Date(),
): Promise<FixWatchRetentionResult> {
  const watchFloor = new Date(now.getTime() - FIX_WATCH_RETENTION_MS);
  const circuitFloor = new Date(now.getTime() - CIRCUIT_QUIET_RETENTION_MS);

  return inSystemDbContext(async () => {
    // Terminal only. A `pending`/`checking` row is still live work no matter
    // how old it looks — an ancient one means the sweeper has been failing,
    // which is a bug to see in the table, not to delete from it.
    const watches = await db
      .delete(aiAgentFixWatches)
      .where(and(
        sql`${aiAgentFixWatches.status} IN ('held', 'regressed', 'inconclusive', 'cancelled')`,
        lt(aiAgentFixWatches.createdAt, watchFloor),
      ))
      .returning({ id: aiAgentFixWatches.id });

    const circuits = await db
      .delete(aiAgentCircuits)
      .where(and(
        // Never an open breaker: that is live state a human still has to clear.
        eq(aiAgentCircuits.state, 'closed'),
        // A circuit that has never failed is matched by the NULL branch, which
        // a bare `lt()` over the nullable column would silently drop.
        or(
          isNull(aiAgentCircuits.lastFailureAt),
          lt(aiAgentCircuits.lastFailureAt, circuitFloor),
        ),
        lt(aiAgentCircuits.updatedAt, circuitFloor),
      ))
      .returning({ id: aiAgentCircuits.id });

    return { watchesDeleted: watches.length, circuitsDeleted: circuits.length };
  });
}
