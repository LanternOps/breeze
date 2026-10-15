import type { PresenceState } from '@breeze/shared';

/**
 * Wrong-site suggestion eligibility (site location W3, #7887), spec S§10.2 applied literally:
 * docs/superpowers/specs/monitoring/2026-10-03-topology-site-location-design.md.
 *
 * Pure: the evaluator hands it the device's current presence, its confirmation and its daily summary rows. The
 * result is a SUGGESTION stored on the presence row; nothing here (or downstream) moves a device. A move happens
 * only when a technician explicitly accepts it through the guarded PATCH /devices/:id.
 */
export type PresenceDayRow = {
  day: string; assignedSiteId: string; state: PresenceState; matchedSiteId: string | null;
  firstObservedAt: string; lastObservedAt: string;
};
export type Suggestion = { siteId: string; days: number; firstObservedAt: string; lastObservedAt: string };

export const SUGGESTION_MIN_DAYS = 7;
export const SUGGESTION_MIN_SPAN_MS = 7 * 86_400_000;
export const SUGGESTION_WINDOW_MS = 30 * 86_400_000;
export const SUGGESTION_MAX_GAP_MS = 36 * 3_600_000;
/** Each row covers [first_observed_at, last_observed_at + 60 min] (the write throttle, S§10.1). */
export const DAY_ROW_EXTENSION_MS = 3_600_000;
/** Day rows the evaluator reads per device (30-day window plus the partial first day). */
export const SUGGESTION_READ_DAYS = 31;

export type SuggestionInput = {
  now: Date;
  /** A: the current assignment. Only rows recorded under A count. */
  assignedSiteId: string;
  confirmedAt: string | null;
  /** The current presence row (S§7.3 validity), as just evaluated. */
  current: { valid: boolean; state: PresenceState; matchedSiteId: string | null };
  /** B's fingerprint for the current attachment is `anchored` and no other site declares the prefix (S§10.2 rule 6). */
  anchoredUniquely: boolean;
  days: PresenceDayRow[];
};

export function evaluateSuggestion(input: SuggestionInput): Suggestion | null {
  const { now, assignedSiteId, confirmedAt, current, anchoredUniquely } = input;
  // Rules 1, 2 and 6.
  if (confirmedAt || !current.valid || current.state !== 'visiting' || !current.matchedSiteId || !anchoredUniquely) return null;
  if (current.matchedSiteId === assignedSiteId) return null;
  const site = current.matchedSiteId;
  const since = now.getTime() - SUGGESTION_WINDOW_MS;
  const rows = input.days.filter((r) => r.assignedSiteId === assignedSiteId && Date.parse(r.lastObservedAt) >= since);

  // Rule 3: >= 7 distinct UTC days of B visits inside the window, spanning >= 7 x 24 h.
  const visits = rows.filter((r) => r.state === 'visiting' && r.matchedSiteId === site)
    .sort((x, y) => Date.parse(x.firstObservedAt) - Date.parse(y.firstObservedAt));
  const distinct = new Set(visits.map((r) => r.day));
  if (distinct.size < SUGGESTION_MIN_DAYS) return null;
  const first = Date.parse(visits[0]!.firstObservedAt);
  const last = Math.max(...visits.map((r) => Date.parse(r.lastObservedAt)));
  if (last - first < SUGGESTION_MIN_SPAN_MS) return null;

  // Rule 4: since the first B observation, no competing attachment (home, another site, ambiguous).
  const tail = rows.filter((r) => Date.parse(r.lastObservedAt) >= first);
  if (tail.some((r) => r.state === 'home' || r.state === 'ambiguous' || (r.state === 'visiting' && r.matchedSiteId !== site))) return null;

  // Rule 5: no unexplained gap > 36 h from the first B observation to now. Stale rows explain a gap (the device
  // was off); unknown rows do not (limited coverage), and neither does a stretch with no row at all.
  const covered = tail.filter((r) => r.state !== 'unknown')
    .map((r) => [Date.parse(r.firstObservedAt), Date.parse(r.lastObservedAt) + DAY_ROW_EXTENSION_MS] as const)
    .sort((x, y) => x[0] - y[0]);
  let reach = first;
  for (const [start, end] of covered) {
    if (start - reach > SUGGESTION_MAX_GAP_MS) return null;
    reach = Math.max(reach, end);
  }
  if (now.getTime() - reach > SUGGESTION_MAX_GAP_MS) return null;

  return { siteId: site, days: distinct.size, firstObservedAt: new Date(first).toISOString(), lastObservedAt: new Date(last).toISOString() };
}
