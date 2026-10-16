import { sql, type SQL } from 'drizzle-orm';
import { devices } from '../db/schema';
import { LOG_SHIPPING_SUSTAINED_MS } from './logShippingHealth';

/**
 * SQL twin of `deriveLogShipping(...).state === 'failing'` (#8611, feature
 * #8607): the device is online, its stored state is `failing`, and the episode
 * has lasted at least LOG_SHIPPING_SUSTAINED_MS on the server clock.
 *
 * Shared by the `logShippingFailing` fleet filter (filterEngine) and the
 * `/devices/stats` count (deviceStats) so the two cannot drift. Agreement with
 * `deriveLogShipping` is pinned row-by-row against real Postgres in
 * `__tests__/integration/logShippingFailingFilter.integration.test.ts`.
 *
 * `IS NOT NULL` is spelled out (it is implied by the `<=` comparison) because
 * it is the predicate of the partial index `devices_log_shipping_failing_idx`;
 * the planner only considers a partial index when the query states its
 * predicate. The window is a server constant, inlined rather than bound, so the
 * statement text is identical on every call.
 *
 * Can evaluate to NULL for rows that break the stored-state invariants; callers
 * that negate it must wrap it in COALESCE(..., false).
 */
export function logShippingFailingPredicate(): SQL {
  const sustainedMs = sql.raw(String(LOG_SHIPPING_SUSTAINED_MS));
  return sql`(${devices.status} = 'online' AND ${devices.logShippingState} = 'failing' AND ${devices.logShippingFailureStartedAt} IS NOT NULL AND ${devices.logShippingFailureStartedAt} <= NOW() - (${sustainedMs} * interval '1 millisecond'))`;
}
