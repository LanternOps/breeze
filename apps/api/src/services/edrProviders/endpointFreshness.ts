import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { EDR_DETAIL_OWNED_STATE_PROVIDER_KEYS } from './providerKeys';

/**
 * How long a detail-owned `health` / `online` value is evidence (#12825).
 *
 * For a provider in EDR_DETAIL_OWNED_STATE_PROVIDER_KEYS the inventory list does not refresh these
 * columns; a per-endpoint details read does, at most DETAIL_ENRICH_PER_RUN (50) endpoints per
 * company per inventory run, stalest first (jobs/edrProviderSync.ts). A company of N endpoints is
 * therefore re-read every ceil(N/50) runs: 10 h for 500 at the default 60-minute interval, 20 h
 * for 1,000. 24 h is 24 such intervals, so a healthy company of up to 1,200 endpoints at the
 * default interval is never reported as uncovered because of the rotation alone. The same 24 h is
 * the point at which a tenant whose inventory has not synced is reported stale (EDR_TENANT_STALE_MS).
 *
 * Past the bound (a larger company, a lengthened cadence, or a sync that keeps failing) a value is
 * "not recently verified": not counted as protection, and shown as not verified rather than as
 * healthy. It is NOT reported as unprotected either: the device falls back to whatever other
 * evidence the report or portal has for it, exactly like an offline or unknown-health endpoint.
 */
export const EDR_DETAIL_FRESHNESS_MS = 24 * 60 * 60 * 1000;

/** True when `provider`'s list does not refresh health / online (a details read does). */
export function hasDetailOwnedState(provider: string): boolean {
  return (EDR_DETAIL_OWNED_STATE_PROVIDER_KEYS as readonly string[]).includes(provider);
}

/**
 * PURE: whether an endpoint row's stored health / online are current enough to act on. A provider
 * whose list supplies them every run is always current (unchanged behaviour); a detail-owned one is
 * current only when its details were read within EDR_DETAIL_FRESHNESS_MS of `now` (never read =
 * the list's placeholders, which are no evidence).
 */
export function isEdrEndpointStateFresh(
  row: { provider: string; vendorDetailSyncedAt: Date | string | null },
  now: Date,
): boolean {
  if (!hasDetailOwnedState(row.provider)) return true;
  if (row.vendorDetailSyncedAt === null) return false;
  const at = new Date(row.vendorDetailSyncedAt).getTime();
  return Number.isFinite(at) && at >= now.getTime() - EDR_DETAIL_FRESHNESS_MS;
}

/**
 * The same rule as a SQL predicate over an `edr_endpoints` row, for queries that decide coverage
 * (the posture report, the portal). `provider` / `syncedAt` are the row's column references.
 */
export function edrEndpointStateFreshSql(provider: SQLWrapper, syncedAt: SQLWrapper, now: Date): SQL {
  if (EDR_DETAIL_OWNED_STATE_PROVIDER_KEYS.length === 0) return sql`true`;
  const cutoff = new Date(now.getTime() - EDR_DETAIL_FRESHNESS_MS).toISOString();
  const keys = sql.join(EDR_DETAIL_OWNED_STATE_PROVIDER_KEYS.map((k) => sql`${k}`), sql`, `);
  return sql`(${provider} not in (${keys}) or ${syncedAt} >= ${cutoff}::timestamptz)`;
}
