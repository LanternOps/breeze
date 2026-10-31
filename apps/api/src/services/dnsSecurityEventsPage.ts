/**
 * Paging for GET /dns-security/events (#10054).
 *
 * dns_security_events grows by up to ~1M rows a day per busy org. The old
 * route answered every request with `ORDER BY timestamp DESC OFFSET n` plus an
 * exact `count(*)` over the same predicate, with no time bound: a blocked-only
 * list walked the org's whole history (131 s on a 30M-row table, so the
 * reverse proxy answered 504). Three changes bound the work:
 *
 *  - A default time window ({@link DNS_EVENTS_DEFAULT_WINDOW_DAYS}) when the
 *    caller gives no `start`, and the 90-day ceiling applied to an open-ended
 *    `start` as well as to an explicit range.
 *  - Keyset pagination on (timestamp, id). The cursor carries the timestamp as
 *    Postgres text at microsecond precision, not as a JS Date: a Date keeps
 *    milliseconds only, and a truncated bound would skip rows that sort between
 *    the truncated and the real value.
 *  - A capped count ({@link DNS_EVENTS_COUNT_CAP}) on the first page only: the
 *    count stops reading after the cap, and the response says when it did.
 *
 * The blocked-only list is served by the partial index
 * dns_security_events_org_blocked_ts_idx (migration
 * 2027-01-18-160000-dns-security-events-blocked-index.sql.sql). Under forced RLS
 * only leakproof clauses become index conditions; org_id = (uuid_eq) and the
 * (timestamp, id) row comparison (timestamp_lt, uuid_lt) are, and the
 * partial-index predicate is proved statically, so the non-leakproof enum
 * comparison on `action` does not stop the planner from choosing it.
 */
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';

import { db } from '../db';
import { devices, dnsSecurityEvents, type DnsAction } from '../db/schema';

export const DNS_EVENTS_DEFAULT_WINDOW_DAYS = 7;
export const DNS_EVENTS_MAX_WINDOW_DAYS = 90;
export const DNS_EVENTS_COUNT_CAP = 10_000;

const DAY_MS = 86_400_000;

export interface DnsEventsCursor {
  /** `timestamp` column as Postgres renders it, microsecond precision, no zone. */
  ts: string;
  id: string;
}

const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeDnsEventsCursor(cursor: DnsEventsCursor): string {
  return Buffer.from(JSON.stringify({ ts: cursor.ts, id: cursor.id }), 'utf8').toString('base64url');
}

/** Returns null for anything that is not a cursor this module issued. */
export function decodeDnsEventsCursor(raw: string): DnsEventsCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { ts, id } = parsed as Record<string, unknown>;
  if (typeof ts !== 'string' || !CURSOR_TS_RE.test(ts)) return null;
  // Shape is not enough: '2026-02-30...' would reach Postgres' ::timestamp
  // cast and fail the request with a 500 instead of a 400. Round-trip the
  // seconds part through Date to reject impossible calendar values.
  const ms = Date.parse(`${ts.slice(0, 19)}Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== ts.slice(0, 19)) return null;
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
  return { ts, id };
}

export type DnsEventsWindow =
  | { ok: true; start: Date; end: Date | null }
  | { ok: false; error: string };

/**
 * Resolve the time window a list request reads. A missing `start` becomes
 * `(end ?? now) - 7 days`; an open `end` stays open (newest rows). The 90-day
 * ceiling applies to the effective span, so an open-ended `start` older than
 * 90 days is refused like an explicit 91-day range.
 */
export function resolveDnsEventsWindow(
  start: Date | null,
  end: Date | null,
  now: Date = new Date(),
): DnsEventsWindow {
  if (start && end && start.getTime() > end.getTime()) {
    return { ok: false, error: 'start must be before or equal to end' };
  }
  const effectiveStart = start ?? new Date((end ?? now).getTime() - DNS_EVENTS_DEFAULT_WINDOW_DAYS * DAY_MS);
  const spanEnd = end ?? now;
  if (spanEnd.getTime() - effectiveStart.getTime() > DNS_EVENTS_MAX_WINDOW_DAYS * DAY_MS) {
    return { ok: false, error: `Time range cannot exceed ${DNS_EVENTS_MAX_WINDOW_DAYS} days` };
  }
  return { ok: true, start: effectiveStart, end };
}

const cursorTsExpr = sql<string>`to_char(${dnsSecurityEvents.timestamp}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

// Literal, never a bound parameter: partial-index predicate proof is static,
// so `action = $1` cannot match dns_security_events_org_blocked_ts_idx under a
// generic (cached) plan, while `action = 'blocked'` always can. The values are
// a fixed map, so no caller input reaches sql.raw.
const ACTION_LITERALS: Record<DnsAction, SQL> = {
  allowed: sql.raw(`'allowed'`),
  blocked: sql.raw(`'blocked'`),
  redirected: sql.raw(`'redirected'`),
};

export function dnsEventsActionCondition(action: DnsAction): SQL {
  const literal = ACTION_LITERALS[action];
  if (!literal) throw new Error(`Unknown DNS action: ${String(action)}`);
  return sql`${dnsSecurityEvents.action} = ${literal}`;
}

export interface DnsEventsPageOptions {
  /** Every filter except the cursor: org, window, action, site narrowing, ... */
  where: SQL | undefined;
  limit: number;
  cursor?: DnsEventsCursor | null;
  /** Legacy offset paging; never combined with a cursor. */
  offset?: number;
}

export interface DnsEventsPage {
  rows: Array<Record<string, unknown>>;
  nextCursor: string | null;
  /** Matching rows up to the cap; null on a cursor page (the first page carries it). */
  total: number | null;
  /** True when more than {@link DNS_EVENTS_COUNT_CAP} rows match; `total` is then the cap. */
  totalCapped: boolean;
}

/** The page query (limit + 1 rows), exported so the plan can be asserted against real Postgres. */
export function buildDnsEventsPageQuery(opts: DnsEventsPageOptions) {
  // `timestamp <= cursor` is implied by the row comparison and is there for the
  // planner. Under a generic (cached) plan it estimates the row comparison from
  // its first column as an open-ended inequality, but `>= start AND <= cursor`
  // as a narrow range; without the explicit upper bound the narrow range exists
  // only on (org_id, timestamp), and the cursor page walks that index filtering
  // out allowed rows instead of reading the blocked-only partial index.
  const pageWhere = opts.cursor
    ? and(
        opts.where,
        sql`${dnsSecurityEvents.timestamp} <= ${opts.cursor.ts}::timestamp`,
        sql`(${dnsSecurityEvents.timestamp}, ${dnsSecurityEvents.id}) < (${opts.cursor.ts}::timestamp, ${opts.cursor.id}::uuid)`,
      )
    : opts.where;

  const pageQuery = db
    .select({
      id: dnsSecurityEvents.id,
      orgId: dnsSecurityEvents.orgId,
      integrationId: dnsSecurityEvents.integrationId,
      deviceId: dnsSecurityEvents.deviceId,
      timestamp: dnsSecurityEvents.timestamp,
      domain: dnsSecurityEvents.domain,
      queryType: dnsSecurityEvents.queryType,
      action: dnsSecurityEvents.action,
      category: dnsSecurityEvents.category,
      threatType: dnsSecurityEvents.threatType,
      sourceIp: dnsSecurityEvents.sourceIp,
      sourceHostname: dnsSecurityEvents.sourceHostname,
      providerEventId: dnsSecurityEvents.providerEventId,
      metadata: dnsSecurityEvents.metadata,
      deviceHostname: devices.hostname,
      cursorTs: cursorTsExpr,
    })
    .from(dnsSecurityEvents)
    .leftJoin(devices, eq(dnsSecurityEvents.deviceId, devices.id))
    .where(pageWhere)
    .orderBy(desc(dnsSecurityEvents.timestamp), desc(dnsSecurityEvents.id))
    // One extra row tells us whether another page exists without a count.
    .limit(opts.limit + 1)
    .$dynamic();
  return !opts.cursor && opts.offset ? pageQuery.offset(opts.offset) : pageQuery;
}

/** count(*) that stops reading after DNS_EVENTS_COUNT_CAP + 1 matching rows. */
export function buildDnsEventsCappedCountQuery(where: SQL | undefined) {
  return db
    .select({ count: sql<number>`count(*)::int` })
    .from(
      db
        .select({ one: sql`1`.as('one') })
        .from(dnsSecurityEvents)
        .where(where)
        .limit(DNS_EVENTS_COUNT_CAP + 1)
        .as('capped'),
    );
}

export async function listDnsSecurityEventsPage(opts: DnsEventsPageOptions): Promise<DnsEventsPage> {
  // The count runs on the first page only; later pages keep the first total.
  const [fetched, countRows] = await Promise.all([
    buildDnsEventsPageQuery(opts),
    opts.cursor ? Promise.resolve(null) : buildDnsEventsCappedCountQuery(opts.where),
  ]);

  const hasMore = fetched.length > opts.limit;
  const pageRows = hasMore ? fetched.slice(0, opts.limit) : fetched;
  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? encodeDnsEventsCursor({ ts: last.cursorTs, id: last.id }) : null;

  let total: number | null = null;
  let totalCapped = false;
  if (countRows) {
    const matched = Number(countRows[0]?.count ?? 0);
    totalCapped = matched > DNS_EVENTS_COUNT_CAP;
    total = totalCapped ? DNS_EVENTS_COUNT_CAP : matched;
  }

  return {
    rows: pageRows.map(({ cursorTs: _cursorTs, ...row }) => row),
    nextCursor,
    total,
    totalCapped,
  };
}
