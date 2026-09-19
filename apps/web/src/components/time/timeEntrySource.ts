/**
 * W06 (#3900) — the one place that decides how a time entry's `source` is
 * labelled. Both the timesheet row and the ticket Time & Billing rail import
 * this, so the two surfaces cannot drift into calling the same provenance
 * different things.
 *
 * `manual` returns null on purpose. It is the column default, so nearly every
 * hand-typed entry in the fleet carries it — badging it would put a chip on
 * almost every row while telling the reader nothing. Same for `undefined`,
 * which is what an older API that predates the column returns.
 *
 * Keys live in the `common` namespace under `longTail.time.sourceBadge.*`,
 * alongside the timesheet's own copy.
 */
export const TIME_ENTRY_SOURCE_BADGE_KEYS = {
  timer: 'longTail.time.sourceBadge.timer',
  location: 'longTail.time.sourceBadge.location',
  remote_session: 'longTail.time.sourceBadge.remote_session',
  support_session: 'longTail.time.sourceBadge.support_session',
} as const;

export function sourceBadgeLabelKey(source: string | null | undefined): string | null {
  if (!source) return null;
  return (TIME_ENTRY_SOURCE_BADGE_KEYS as Record<string, string>)[source] ?? null;
}
