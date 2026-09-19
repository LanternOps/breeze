import { getRedis } from '../redis';

/**
 * Daily partner-lane cap hits, recorded for the abuse sweep (spec §9.2).
 *
 * WHY REDIS AND NOT A TABLE. The recorder is called from the SEND PATH, through
 * W04's synchronous `recordPartnerLaneCapHit(partnerId): void`. The send path is
 * forbidden from writing a partner-axis table (W04 Global Constraints, enforced
 * by partner-wide-write-coverage.test.ts), and a `void` function cannot await a
 * database write anyway.
 *
 * WHY KEYED BY DAY AND NOT BY PARTNER. The only consumer is the fleet-wide abuse
 * sweep, which asks "who hit the cap in the last 7 days". A hash per day, with
 * the partner id as the field, answers that with 7 bounded HGETALLs. A key per
 * partner would force either a SCAN over the keyspace or a full partner
 * enumeration on every sweep.
 *
 * A Redis outage silently drops a record, which is the correct direction and
 * matches W04: `tryCountPartnerLaneSend` already declines to report a cap hit
 * when Redis cannot answer, so our own outage can never accuse a partner.
 */

/** Matches deliveryStats.STATS_WINDOW_DAYS; both feed spec §9.2/§9.3 windows. */
export const CAP_HIT_WINDOW_DAYS = 7;

/** One clear day past the read window, so a sweep at the edge still sees day 7. */
const CAP_HIT_TTL_SECONDS = (CAP_HIT_WINDOW_DAYS + 1) * 24 * 60 * 60;

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function capHitDayKey(day: string): string {
  return `email-domains:cap-hits:${day}`;
}

/**
 * Fire-and-forget. Returns immediately; the write is not awaited and every
 * failure path is swallowed, because the caller is a send in flight.
 */
export function recordCapHit(partnerId: string, now: Date = new Date()): void {
  try {
    const redis = getRedis();
    if (!redis) return;
    const key = capHitDayKey(utcDay(now));
    void redis
      .multi()
      .hincrby(key, partnerId, 1)
      .expire(key, CAP_HIT_TTL_SECONDS)
      .exec()
      .catch((err: unknown) => {
        console.warn(
          '[emailDomains/capHits] failed to record a cap hit:',
          err instanceof Error ? err.message : err,
        );
      });
  } catch (err) {
    console.warn(
      '[emailDomains/capHits] failed to record a cap hit:',
      err instanceof Error ? err.message : err,
    );
  }
}

/** partnerId -> total cap hits across the trailing CAP_HIT_WINDOW_DAYS UTC days. */
export async function loadCapHitWindow(now: Date = new Date()): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  try {
    const redis = getRedis();
    if (!redis) return totals;
    for (let offset = CAP_HIT_WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
      const day = new Date(now.getTime());
      day.setUTCDate(day.getUTCDate() - offset);
      const entries = await redis.hgetall(capHitDayKey(utcDay(day)));
      for (const [partnerId, raw] of Object.entries(entries ?? {})) {
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) continue;
        totals.set(partnerId, (totals.get(partnerId) ?? 0) + value);
      }
    }
  } catch (err) {
    // The sweep must keep running: an unreadable cap-hit window means "no cap
    // signal this pass", never a failed sweep for every other detector.
    console.warn(
      '[emailDomains/capHits] failed to read the cap-hit window:',
      err instanceof Error ? err.message : err,
    );
    return new Map();
  }
  return totals;
}
