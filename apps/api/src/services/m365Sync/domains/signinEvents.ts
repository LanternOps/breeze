import { sql } from 'drizzle-orm';
import { SIGNIN_EVENTS_DEFAULT_WINDOW_DAYS } from '@breeze/shared/m365';
import { db } from '../../../db';
import { inOwnedRunTransaction } from './persist';
import {
  M365_SYNC_PERSIST_CHUNK_SIZE,
  type DomainPersistResult, type M365SyncActionResult, type PersistContext,
} from '../types';

/**
 * #5784 W05. Interactive Microsoft 365 sign-ins, append-only.
 *
 * NEITHER existing pattern fits, and using either would be a bug:
 *
 *  * The ENTITY pattern (`planEntityWrites` / `markEntitiesStale`, used by
 *    users, intune_devices, ca_policies, skus) marks unreturned rows stale.
 *    Applied here it would mark EVERY event outside the delta window stale on
 *    every run and corrupt every closed reporting period. This module therefore
 *    touches neither helper, and there is no is_stale/stale_since/core_hash
 *    column for it to touch.
 *  * The `signin_activity` pattern updates one column on m365_users and
 *    persists no rows at all.
 *
 * Instead: an idempotent upsert on (org_id, graph_id), because the delta window
 * deliberately OVERLAPS (Graph sign-in records surface with delay) and a
 * re-fetch must be a no-op rather than a duplicate. `complete` is true only when
 * the window was fully paginated and nothing was truncated, which is what keeps
 * `last_complete_snapshot_at` honest for W06's freshness read.
 *
 * `ingested_at` is never written: the column's DB default is now(), so the
 * ingestion time stays independent of the event time and a late arrival into a
 * closed period is detectable rather than silently changing its totals.
 */

export interface SigninEventsPersistResult extends DomainPersistResult {
  /** Opaque executor blob; non-null means more pages remain. */
  continuation: string | null;
  /** Tenant has no Entra ID P1: a complete, zero-row success. */
  unlicensed: boolean;
}

interface SigninEventRow {
  graphId: string;
  signedInAt: string;
  userGraphId: string | null;
  userPrincipalName: string | null;
  appId: string | null;
  appDisplayName: string | null;
  clientAppUsed: string | null;
  ipAddress: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  conditionalAccessStatus: string | null;
  statusErrorCode: number | null;
  statusFailureReason: string | null;
  riskLevelAggregated: string | null;
  riskState: string | null;
  isInteractive: boolean | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

/** The event time, as an ISO string cast in SQL — a JS Date inside a raw
 *  drizzle fragment throws at bind time in postgres.js. */
function eventTime(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

/**
 * Graph's `location` and `status` sub-objects are flattened into their own
 * columns HERE. Nothing object-shaped is ever bound, which is what keeps the
 * table free of a jsonb column and out of the `excludedOpen` export bucket.
 */
function parseEvents(items: Record<string, unknown>[]): { rows: SigninEventRow[]; malformed: number } {
  const byGraphId = new Map<string, SigninEventRow>();
  let malformed = 0;
  for (const item of items) {
    const graphId = str(item.id);
    const signedInAt = eventTime(item.createdDateTime);
    // An event with no id cannot be deduplicated and one with no usable event
    // time cannot be placed in a period. Dropping beats inventing either — but
    // the count is reported, so a Graph payload that starts returning junk is
    // visible rather than a quietly shrinking evidence set. Counted separately
    // from de-duplication, which is expected on every overlapping window.
    if (!graphId || !signedInAt) { malformed += 1; continue; }
    const location = isRecord(item.location) ? item.location : {};
    const status = isRecord(item.status) ? item.status : {};
    byGraphId.set(graphId, {
      graphId,
      signedInAt,
      userGraphId: str(item.userId),
      userPrincipalName: str(item.userPrincipalName),
      appId: str(item.appId),
      appDisplayName: str(item.appDisplayName),
      clientAppUsed: str(item.clientAppUsed),
      locationCity: str(location.city),
      locationCountry: str(location.countryOrRegion),
      ipAddress: str(item.ipAddress),
      conditionalAccessStatus: str(item.conditionalAccessStatus),
      statusErrorCode: int(status.errorCode),
      statusFailureReason: str(status.failureReason),
      // Graph answers `hidden` without Entra ID P2 — stored verbatim so the
      // report can render "unmeasured" rather than inventing a risk level.
      riskLevelAggregated: str(item.riskLevelAggregated),
      riskState: str(item.riskState),
      isInteractive: typeof item.isInteractive === 'boolean' ? item.isInteractive : null,
    });
  }
  return { rows: [...byGraphId.values()], malformed };
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const rows = (result as { rows?: unknown[] }).rows ?? result;
  return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
}

export async function persistSigninEvents(
  ctx: PersistContext,
  result: M365SyncActionResult,
): Promise<SigninEventsPersistResult> {
  const unlicensed = result.sources.signinEvents === 'unlicensed';
  const continuation = typeof result.continuation === 'string' && result.continuation.length > 0
    ? result.continuation
    : null;
  const base: SigninEventsPersistResult = {
    inserted: 0,
    updated: 0,
    stale: 0,
    unchanged: 0,
    counts: {},
    // A page that still has a continuation has not covered the window, so it is
    // not a complete snapshot. An unlicensed tenant IS complete: there is
    // nothing to enumerate.
    complete: unlicensed
      || (continuation === null && result.sources.signinEvents === 'ok' && !result.truncated),
    continuation,
    unlicensed,
  };
  if (unlicensed) return base;

  const { rows: events, malformed } = parseEvents(result.items);
  // Dropping a malformed item is the right call (see parseEvents), but doing it
  // SILENTLY is not: this feeds a compliance artifact, so a Graph payload that
  // starts returning items with no id or an unparseable createdDateTime would
  // shrink the evidence set with no trace at all. Counts only — never a UPN, an
  // IP or any other row content.
  if (malformed > 0) {
    console.log('[M365Sync] m365.sync.signin_events.malformed_items', JSON.stringify({
      orgId: ctx.orgId, received: result.items.length, malformed,
    }));
  }
  if (events.length === 0) return base;

  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < events.length; i += M365_SYNC_PERSIST_CHUNK_SIZE) {
    const chunk = events.slice(i, i + M365_SYNC_PERSIST_CHUNK_SIZE);
    const values = sql.join(
      chunk.map((e) => sql`(
        ${ctx.orgId}::uuid,
        ${ctx.tenantId}::uuid,
        ${e.graphId}::text,
        ${e.signedInAt}::timestamptz,
        ${e.userGraphId}::text,
        ${e.userPrincipalName}::text,
        ${e.appId}::text,
        ${e.appDisplayName}::text,
        ${e.clientAppUsed}::text,
        ${e.ipAddress}::text,
        ${e.locationCity}::text,
        ${e.locationCountry}::text,
        ${e.conditionalAccessStatus}::text,
        ${e.statusErrorCode}::int,
        ${e.statusFailureReason}::text,
        ${e.riskLevelAggregated}::text,
        ${e.riskState}::text,
        ${e.isInteractive}::boolean
      )`),
      sql`, `,
    );

    const written = await inOwnedRunTransaction(ctx, 'm365SyncSigninEventsPersist', () => db.execute(sql`
      with written as (
        insert into m365_signin_events (
          org_id, tenant_id, graph_id, signed_in_at, user_graph_id, user_principal_name,
          app_id, app_display_name, client_app_used, ip_address, location_city,
          location_country, conditional_access_status, status_error_code,
          status_failure_reason, risk_level_aggregated, risk_state, is_interactive
        )
        values ${values}
        on conflict (org_id, graph_id) do update set
          tenant_id = excluded.tenant_id,
          signed_in_at = excluded.signed_in_at,
          user_graph_id = excluded.user_graph_id,
          user_principal_name = excluded.user_principal_name,
          app_id = excluded.app_id,
          app_display_name = excluded.app_display_name,
          client_app_used = excluded.client_app_used,
          ip_address = excluded.ip_address,
          location_city = excluded.location_city,
          location_country = excluded.location_country,
          conditional_access_status = excluded.conditional_access_status,
          status_error_code = excluded.status_error_code,
          status_failure_reason = excluded.status_failure_reason,
          risk_level_aggregated = excluded.risk_level_aggregated,
          risk_state = excluded.risk_state,
          is_interactive = excluded.is_interactive
        returning (xmax = 0) as inserted
      )
      select
        (select count(*) from written where inserted)::int     as inserted,
        (select count(*) from written where not inserted)::int as updated
    `));

    const row = rowsOf(written)[0] ?? {};
    inserted += Number(row.inserted ?? 0) || 0;
    updated += Number(row.updated ?? 0) || 0;
  }

  return {
    ...base,
    inserted,
    updated,
    counts: { signin_events: events.length },
  };
}

/**
 * The next run's window. `since` is MAX(signed_in_at) for the org MINUS an
 * overlap, because Graph sign-in records surface with delay — a bare watermark
 * would permanently skip anything that arrived late. Writes are idempotent
 * upserts on (org_id, graph_id), so the overlap costs nothing but a re-fetch.
 *
 * The checkpoint advances ONLY after pagination for the window completes: a
 * truncated page leaves the watermark where it was (nothing here writes it —
 * it IS the data) and the run returns a continuation.
 *
 * `since` is deliberately NOT clamped forward to a fixed lookback. An org whose
 * sync was down for a fortnight has a watermark older than any such clamp, and
 * clamping would move `since` PAST the gap — the missing range would never be
 * queried again, because every later run recomputes the clamp against a newer
 * `now` while the watermark sits inside it. Graph purges audit logs at ~30 days,
 * so those events would be unrecoverable, silently, with no error and no
 * `truncated` flag. The window's real bound is the per-run item cap
 * (`M365_SYNC_MAX_ITEMS_SIGNIN_EVENTS`) plus the executor's page and deadline
 * caps, which hand back a continuation and re-claim the domain immediately —
 * the walk finishes over successive pages rather than being silently truncated
 * in time.
 *
 * Only the COLD start (no events at all for the org) uses the fixed
 * `SIGNIN_EVENTS_DEFAULT_WINDOW_DAYS` lookback: there is no watermark to walk
 * forward from, and a first run has nothing to lose by starting a week back.
 */
export const SIGNIN_EVENTS_OVERLAP_MINUTES = 60;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/**
 * Runs on the AMBIENT DB context and opens none of its own. Phase A
 * (`loadSyncRunContext`) already holds one short system transaction and calls
 * this inside it; nesting `runOutsideDbContext(withSystemDbAccessContext(...))`
 * here would double-hold a pooled connection, which is the #1105 hang.
 */
export async function signinEventsWindow(
  orgId: string,
  now: Date,
): Promise<{ since: string; until: string }> {
  const read = await db.execute(sql`
    select max(signed_in_at) as watermark
    from m365_signin_events
    where org_id = ${orgId}::uuid
  `);
  const raw = rowsOf(read)[0]?.watermark;
  const watermark = raw instanceof Date
    ? raw.getTime()
    : (typeof raw === 'string' && Number.isFinite(Date.parse(raw)) ? Date.parse(raw) : null);

  const until = now.getTime();
  const since = watermark === null
    ? until - SIGNIN_EVENTS_DEFAULT_WINDOW_DAYS * MS_PER_DAY
    : watermark - SIGNIN_EVENTS_OVERLAP_MINUTES * MS_PER_MINUTE;

  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}
