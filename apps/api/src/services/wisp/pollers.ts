/**
 * Wisp W05 pollers — time-derived events the bus has no natural publisher for.
 *
 * `pollStaleTickets` publishes `ticket.stale` once per ticket per threshold.
 * It is stateless: each call scans a sliding window one scan-interval wide that
 * ends exactly `staleHours` ago, so a ticket falls into exactly one window per
 * threshold crossing when ticks run every `TICKET_STALE_SCAN_WINDOW_MINUTES`.
 * The deterministic eventId (see `ticketStaleEventId`) makes an overlapping or
 * repeated scan collapse to one logical event downstream.
 *
 * LIMITS, by design: a scheduler outage longer than the window misses the
 * crossings that fell inside the gap. The Wisp floor tick (30 minute sweep of
 * every active grant) covers that case, so no watermark table is kept here.
 * A ticket updated again before it goes stale simply never enters a window.
 *
 * Only orgs covered by an active `wisp_grants` row are scanned (the grant
 * predicate is in the SQL, not a TS filter), so a partner without Wisp never
 * pays for the scan.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { wispEnabled } from '../../config/env';
import { publishEvent } from '../eventBus';
import { captureException } from '../sentry';

export const TICKET_STALE_DEFAULT_HOURS = 72;
/** Equals the wake tick interval; the window must be at least one tick wide. */
export const TICKET_STALE_SCAN_WINDOW_MINUTES = 5;
const TICKET_STALE_SCAN_LIMIT = 500;

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** `lower < updated_at <= upper` selects tickets that crossed `staleHours` within the last window. */
export function ticketStaleWindow(
  now: Date,
  staleHours: number,
  windowMinutes: number,
): { lower: Date; upper: Date } {
  const upper = new Date(now.getTime() - staleHours * HOUR_MS);
  const lower = new Date(upper.getTime() - windowMinutes * MINUTE_MS);
  return { lower, upper };
}

/**
 * Stable logical id for one ticket crossing one threshold. The event bus
 * requires a UUID, so the logical key `ticket-stale:<ticketId>:<staleHours>` is
 * hashed into a name-based (version 5 shaped) UUID.
 */
export function ticketStaleEventId(ticketId: string, staleHours: number): string {
  const h = createHash('sha1').update(`ticket-stale:${ticketId}:${staleHours}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

type StaleTicketRow = { id: string; org_id: string; updated_at: Date | string };

/** `tickets.updated_at` is timestamp WITHOUT time zone, stored in UTC; a bare driver string is UTC. */
function toUtcDate(v: Date | string): Date {
  if (v instanceof Date) return v;
  const s = String(v);
  const hasZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(s);
  return new Date(hasZone ? s : `${s.replace(' ', 'T')}Z`);
}

export async function pollStaleTickets(
  now: Date,
  opts: { staleHours?: number; windowMinutes?: number; limit?: number } = {},
): Promise<{ scanned: number; published: number }> {
  if (!wispEnabled()) return { scanned: 0, published: 0 };
  const staleHours = opts.staleHours ?? TICKET_STALE_DEFAULT_HOURS;
  const windowMinutes = opts.windowMinutes ?? TICKET_STALE_SCAN_WINDOW_MINUTES;
  const limit = opts.limit ?? TICKET_STALE_SCAN_LIMIT;
  const { lower, upper } = ticketStaleWindow(now, staleHours, windowMinutes);
  const lowerIso = lower.toISOString();
  const upperIso = upper.toISOString();

  // `resolved`, `closed` and `on_hold` (a deliberate wait) are not stale.
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const result = (await db.execute(sql`
      SELECT t.id, t.org_id, t.updated_at
        FROM tickets t
        JOIN organizations o ON o.id = t.org_id
       WHERE t.status IN ('new', 'open', 'pending')
         AND t.updated_at > (${lowerIso}::timestamptz AT TIME ZONE 'UTC')
         AND t.updated_at <= (${upperIso}::timestamptz AT TIME ZONE 'UTC')
         AND EXISTS (
           SELECT 1 FROM wisp_grants g
            WHERE g.status = 'active'
              AND g.partner_id = o.partner_id
              AND (g.org_id IS NULL OR g.org_id = t.org_id)
         )
       ORDER BY t.updated_at
       LIMIT ${limit}`)) as unknown as StaleTicketRow[];
    return [...result];
  }, 'wisp-poll-stale-tickets'));

  // Publish only after the DB block has returned (#1105).
  let published = 0;
  for (const row of rows) {
    const updatedAt = toUtcDate(row.updated_at);
    try {
      await publishEvent(
        'ticket.stale',
        row.org_id,
        { ticketId: row.id, orgId: row.org_id, staleHours, updatedAt: updatedAt.toISOString() },
        'wisp-pollers',
        {
          eventId: ticketStaleEventId(row.id, staleHours),
          occurredAt: new Date(updatedAt.getTime() + staleHours * HOUR_MS).toISOString(),
        },
      );
      published += 1;
    } catch (err) {
      captureException(err instanceof Error ? err : new Error(String(err)));
      console.error('[wisp] ticket.stale publish failed', err instanceof Error ? err.message : err);
    }
  }
  return { scanned: rows.length, published };
}
