import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';

/**
 * Per-partner delivery counters (spec §9.3).
 *
 * WRITE PATH. The only writer is the Resend delivery webhook
 * (routes/webhooks/emailProvider.ts). The send path never writes here: a
 * partner-axis write from sendEmail is forbidden by W04's Global Constraints,
 * so `sent` is counted from the provider's own `email.sent` event.
 *
 * The increment is ONE statement whose row source is a SELECT over `partners`:
 *
 *   INSERT INTO partner_sending_daily_stats (partner_id, day, <col>)
 *   SELECT p.id, $day, 1 FROM partners p WHERE p.id = $partner
 *   ON CONFLICT (partner_id, day) DO UPDATE SET <col> = … + 1
 *
 * Two properties fall out of that shape and both are load-bearing:
 *
 *  1. A provider tag naming a partner that does not exist inserts ZERO rows.
 *     The alternative — letting the FK raise 23503 and catching it — would
 *     abort the surrounding transaction even though the error was handled
 *     (utils/pgErrors.ts; production incident 2026-09-15).
 *  2. Concurrent deliveries for the same (partner, day) serialise on the
 *     primary key inside ON CONFLICT DO UPDATE, so two workers processing two
 *     events never lose an increment. A read-modify-write in application code
 *     would.
 *
 * The column name is interpolated with sql.raw, which is safe because it is
 * looked up in the frozen STAT_COLUMNS set below and never taken from input;
 * anything else throws before a statement is built.
 */

export type DeliveryStatColumn = 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed' | 'suppressed';

const STAT_COLUMNS: ReadonlySet<string> = new Set<DeliveryStatColumn>([
  'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed',
]);

/** Spec §9.3: "7-day bounce rate", "3 complaints in 7 days". */
export const STATS_WINDOW_DAYS = 7;

export interface PartnerSendingWindowStats {
  partnerId: string;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  suppressed: number;
  /**
   * The rate denominator. GREATEST(sent, delivered + bounced + failed) is
   * correct whether or not the operator subscribed `email.sent` on the provider
   * webhook: with it, `sent` is the true denominator and is never smaller than
   * the outcomes; without it, the observed outcomes are the best estimate. It
   * can never be smaller than the number of bounces, so a rate can never exceed 1.
   */
  messages: number;
  /** bounced / messages, or 0 when nothing was observed. */
  bounceRate: number;
}

/** `YYYY-MM-DD` in UTC. The stats day is the provider event's UTC calendar day. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function windowStartDay(now: Date): string {
  const start = new Date(now.getTime());
  start.setUTCDate(start.getUTCDate() - (STATS_WINDOW_DAYS - 1));
  return utcDay(start);
}

function extractRows<T>(result: unknown): T[] {
  const rows = (result as { rows?: T[] }).rows ?? (result as T[]);
  return Array.isArray(rows) ? rows : [];
}

interface RawWindowRow {
  partner_id: string;
  sent: string | number;
  delivered: string | number;
  bounced: string | number;
  complained: string | number;
  failed: string | number;
  suppressed: string | number;
}

/** bigint arrives from postgres.js as a string; Number() is exact well past any real volume. */
function num(value: string | number | null | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toWindowStats(row: RawWindowRow): PartnerSendingWindowStats {
  const sent = num(row.sent);
  const delivered = num(row.delivered);
  const bounced = num(row.bounced);
  const complained = num(row.complained);
  const failed = num(row.failed);
  const suppressed = num(row.suppressed);
  const messages = Math.max(sent, delivered + bounced + failed);
  return {
    partnerId: row.partner_id,
    sent, delivered, bounced, complained, failed, suppressed,
    messages,
    bounceRate: messages > 0 ? bounced / messages : 0,
  };
}

function zeroStats(partnerId: string): PartnerSendingWindowStats {
  return {
    partnerId, sent: 0, delivered: 0, bounced: 0,
    complained: 0, failed: 0, suppressed: 0, messages: 0, bounceRate: 0,
  };
}

/**
 * Increment one counter for (partner, UTC day of `at`).
 *
 * @returns true when the row was inserted or updated; false when `partnerId`
 *          matched no partner, which is how an unknown or forged provider tag
 *          is counted nowhere.
 */
export async function incrementPartnerSendingStat(
  partnerId: string,
  column: DeliveryStatColumn,
  at: Date = new Date(),
): Promise<boolean> {
  if (!STAT_COLUMNS.has(column)) {
    // Never reachable from the webhook (its map is exhaustive over the handled
    // event types); this is the guard that makes the sql.raw below safe to read.
    throw new Error(`[emailDomains/deliveryStats] unknown delivery stat column: ${String(column)}`);
  }
  const col = sql.raw(column);
  const day = utcDay(at);

  const result = await withSystemDbAccessContext(
    () => db.execute(sql`
      insert into partner_sending_daily_stats (partner_id, day, ${col})
      select p.id, ${day}::date, 1
      from partners p
      where p.id = ${partnerId}::uuid
      on conflict (partner_id, day) do update
        set ${col} = partner_sending_daily_stats.${col} + 1,
            updated_at = now()
      returning partner_id
    `),
    'emailDomainsDeliveryStatIncrement',
  );
  return extractRows<{ partner_id: string }>(result).length > 0;
}

/** The trailing STATS_WINDOW_DAYS days, inclusive of today, for one partner. */
export async function loadPartnerSendingWindowStats(
  partnerId: string,
  now: Date = new Date(),
): Promise<PartnerSendingWindowStats> {
  const from = windowStartDay(now);
  const result = await withSystemDbAccessContext(
    () => db.execute(sql`
      select
        ${partnerId}::uuid              as partner_id,
        coalesce(sum(s.sent), 0)        as sent,
        coalesce(sum(s.delivered), 0)   as delivered,
        coalesce(sum(s.bounced), 0)     as bounced,
        coalesce(sum(s.complained), 0)  as complained,
        coalesce(sum(s.failed), 0)      as failed,
        coalesce(sum(s.suppressed), 0)  as suppressed
      from partner_sending_daily_stats s
      where s.partner_id = ${partnerId}::uuid
        and s.day >= ${from}::date
      having count(*) > 0
    `),
    'emailDomainsWindowStats',
  );
  const row = extractRows<RawWindowRow>(result)[0];
  return row ? toWindowStats(row) : zeroStats(partnerId);
}

/**
 * The same window for EVERY partner that has any row in it, in ONE grouped
 * query. Both consumers — the admin list (spec §9.3) and the abuse sweep
 * (spec §9.2) — need the whole fleet, and a per-partner call would be an N+1
 * over the partner table.
 */
export async function loadAllPartnerSendingWindowStats(
  now: Date = new Date(),
): Promise<PartnerSendingWindowStats[]> {
  const from = windowStartDay(now);
  const result = await withSystemDbAccessContext(
    () => db.execute(sql`
      select
        s.partner_id                    as partner_id,
        coalesce(sum(s.sent), 0)        as sent,
        coalesce(sum(s.delivered), 0)   as delivered,
        coalesce(sum(s.bounced), 0)     as bounced,
        coalesce(sum(s.complained), 0)  as complained,
        coalesce(sum(s.failed), 0)      as failed,
        coalesce(sum(s.suppressed), 0)  as suppressed
      from partner_sending_daily_stats s
      where s.day >= ${from}::date
      group by s.partner_id
    `),
    'emailDomainsWindowStatsAll',
  );
  return extractRows<RawWindowRow>(result).map(toWindowStats);
}
