/**
 * AI chargeback billing periods (#7608): UTC calendar months, the same clock
 * as contract billing (contractMath.ts) and the ai_cost_usage monthly key.
 * An invocation bills in the UTC month of ai_invocations.created_at — the
 * ledger write — so a deferred settlement replayed after midnight bills in the
 * replay month (decided 2026-10-02, #7598). Every boundary is an explicit UTC
 * instant; never cast a bare date to timestamptz in SQL (that reads the
 * session TimeZone).
 */
export const CHARGEBACK_CLOSE_GRACE_MS = 60 * 60 * 1000;
export const CHARGEBACK_LOOKBACK_DAYS = 92;

export type ChargePeriod = { periodStart: string; periodEnd: string };

const MONTH_START = /^(\d{4})-(\d{2})-01$/;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function monthPeriod(periodStart: string): ChargePeriod {
  const m = MONTH_START.exec(periodStart);
  const month = m ? Number(m[2]) : 0;
  if (!m || month < 1 || month > 12) throw new Error(`chargePeriods: not a UTC month start: ${periodStart}`);
  const start = new Date(Date.UTC(Number(m[1]), month - 1, 1));
  const end = new Date(Date.UTC(Number(m[1]), month, 1));
  return { periodStart: iso(start), periodEnd: iso(end) };
}

export function utcStartIso(date: string): string {
  return new Date(`${date}T00:00:00Z`).toISOString();
}

export function isPeriodClosed(p: ChargePeriod, now: Date): boolean {
  return now.getTime() >= new Date(`${p.periodEnd}T00:00:00Z`).getTime() + CHARGEBACK_CLOSE_GRACE_MS;
}

/** The most recent UTC month that is closed at `now`. */
export function previousClosedPeriod(now: Date): ChargePeriod {
  const current = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  let candidate = monthPeriod(iso(new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1))));
  if (!isPeriodClosed(candidate, now)) {
    candidate = monthPeriod(iso(new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 2, 1))));
  }
  return candidate;
}

export function lookbackStartIso(p: ChargePeriod): string {
  return new Date(new Date(`${p.periodStart}T00:00:00Z`).getTime() - CHARGEBACK_LOOKBACK_DAYS * 86_400_000).toISOString();
}
