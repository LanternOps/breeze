/**
 * Throttle the "this list is partial" reports to state CHANGES.
 *
 * `getDevicesPaged` / `getAlertsPaged` report truncation to Sentry, and
 * truncation is true for any tenant above the 100-row page limit — the ordinary
 * steady state for a real fleet, not an anomaly. Those fetches run on mount, tab
 * focus, pull-to-refresh, push delivery and WS updates, so a 216-device tenant
 * emitted one on essentially every interaction, indefinitely (#3783).
 *
 * The reports are TRUE, which is what makes them awkward: they aren't false
 * positives to delete, they're correct statements at a volume that destroys
 * their value — crowding out the case actually worth seeing, a server that
 * reported no count at all.
 *
 * So: report on entry to a non-complete state, then stay quiet until the state
 * changes. Deliberately module scope and deliberately not persisted — surviving
 * a cold start would mean a genuinely new session never reports.
 */

export type TruncationState =
  /** The server's count matched what came back. Nothing to say. */
  | 'complete'
  /** The server counted more rows than it returned. Expected above the limit. */
  | 'partial'
  /** The server reported NO count, so completeness is unknowable. Diagnostic. */
  | 'unknown-total';

export function classifyTruncation(total: number | null, returned: number): TruncationState {
  if (total === null) return 'unknown-total';
  return returned < total ? 'partial' : 'complete';
}

/**
 * Report on a CHANGE into `partial`, and EVERY TIME for `unknown-total`.
 *
 * The asymmetry is deliberate (#3783). `partial` is the ordinary steady state
 * of any tenant above the page limit, so repeating it says nothing new.
 * `unknown-total` means the server reported no count at all — rare, and each
 * occurrence carries information a first report cannot: whether it is still
 * happening, how many tenants or servers it spans, whether it returned after an
 * account change, and it survives the first event being sampled or dropped.
 * Throttling it would trade a real diagnostic for volume that was never the
 * problem.
 */
export function shouldReportTruncation(
  previous: TruncationState | undefined,
  next: TruncationState
): boolean {
  if (next === 'complete') return false;
  if (next === 'unknown-total') return true;
  return previous !== next;
}

/**
 * Only `partial` keys are retained.
 *
 * `complete` needs no suppression and `unknown-total` reports every time, so
 * storing either would just accumulate — a partner browsing thousands of orgs
 * would retain a UUID per org for the life of the runtime. Holding only what
 * actually suppresses something bounds this by the number of CURRENTLY partial
 * lists.
 */
const partialKeys = new Set<string>();

/** Bumped by {@link resetTruncationTracking}; see the epoch note below. */
let epoch = 0;

/** Capture BEFORE issuing the request whose result you will track. */
export function currentTruncationEpoch(): number {
  return epoch;
}

/**
 * Stateful wrapper over the pure functions above.
 *
 * Returns the state when it should be reported, or `null` to stay quiet. The
 * caller owns what a report looks like, so this module stays free of Sentry.
 *
 * `startedAtEpoch` closes a race that clearing on sign-out alone does not: a
 * request issued by the OLD session can resolve after the reset and write its
 * state back, which would then suppress the first report of the NEXT session —
 * possibly a different user on a different server. A result from a superseded
 * session is dropped rather than recorded.
 */
export function trackTruncation(
  key: string,
  total: number | null,
  returned: number,
  startedAtEpoch: number
): TruncationState | null {
  const next = classifyTruncation(total, returned);
  const report = shouldReportTruncation(partialKeys.has(key) ? 'partial' : undefined, next);

  // Stale session: report nothing and, crucially, record nothing.
  if (startedAtEpoch !== epoch) return null;

  if (next === 'partial') partialKeys.add(key);
  else partialKeys.delete(key);

  return report ? next : null;
}

/**
 * Clear all tracking.
 *
 * MUST be called on sign-out. The Map lives for the life of the JS runtime,
 * which outlives a session: without this, user A's `partial` would suppress the
 * FIRST report for user B — possibly on a different server, since the login
 * screen can change it — and that report would simply never exist. Also the
 * test seam, since module state would otherwise leak between cases.
 */
export function resetTruncationTracking(): void {
  partialKeys.clear();
  // Invalidate anything already in flight, so a request issued by the session
  // being torn down cannot repopulate what we just cleared.
  epoch += 1;
}
