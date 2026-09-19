/**
 * A one-way "a finding changed" signal (#5365).
 *
 * `useSystemsData` is a bespoke per-mount hook — there is no react-query
 * cache, no store, and no cross-screen invalidation channel in this app. So
 * after the finding detail screen acknowledges/dismisses/reopens something,
 * nothing tells the Systems tab that its open-findings counts are stale, and
 * its focus refresh is debounced to 60s: the hero would keep claiming
 * "1 open finding" for up to a minute after the tech cleared it.
 *
 * Rather than introduce a store for one number, the mutation bumps a
 * module-level revision and the Systems screen compares it against the one it
 * last fetched with. A monotonic counter (not a boolean flag) means several
 * screens can consume it independently without racing to clear it.
 *
 * Pure module — no React Native imports — so the staleness rule is testable.
 */

let revision = 0;

/** Call after a finding lifecycle action succeeds. */
export function markFindingsChanged(): void {
  revision += 1;
}

export function findingsChangedRevision(): number {
  return revision;
}

export interface FocusRefreshInput {
  now: number;
  /** Epoch ms of the last successful fetch; 0 when none has landed. */
  lastFetchAt: number;
  debounceMs: number;
  signalRevision: number;
  /** The revision in effect when this consumer last fetched. */
  seenRevision: number;
}

export function shouldRefreshOnFocus({
  now,
  lastFetchAt,
  debounceMs,
  signalRevision,
  seenRevision,
}: FocusRefreshInput): boolean {
  // A finding was acted on since this consumer last fetched — the counts are
  // known-stale, so the debounce does not apply.
  if (signalRevision !== seenRevision) return true;
  if (lastFetchAt === 0) return true;
  const elapsed = now - lastFetchAt;
  // A backwards clock (NTP correction, manual change) would otherwise wedge
  // the debounce until real time caught back up.
  if (elapsed < 0) return true;
  return elapsed >= debounceMs;
}
