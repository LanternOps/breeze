import type { SuggestionSignalRef } from './timeSuggestions';

/**
 * W06 (#3900). The offline-replay decision table for suggestion writes, kept
 * pure and separate from `timeEntryQueue.ts` so the branching is testable
 * without a queue runtime.
 *
 * Why suggestion writes do NOT reuse the queue's `PERMANENT_STATUSES` parking:
 * a parked row is "real work the server refused, keep it for the technician to
 * re-enter". A rejected suggestion is not that. The window is still visible in
 * the sheet and can simply be re-offered after a refetch, so the right
 * disposition is to DROP the queued write and tell the UI what happened —
 * parking it would strand a duplicate that later re-bills the same minutes.
 */
export type DrainOutcome =
  /** The server has the decision. Remove the write; apply it locally. */
  | 'success'
  /** Gone or superseded. Remove the write and refetch the day, silently. */
  | 'drop'
  /** Remove the write and tell the technician why it did not land. */
  | 'dropAndToast'
  /** Remove the write AND hide the suggestion entry points: the flag is off. */
  | 'dropAndDisable'
  /** Keep the write queued and try again later. */
  | 'retry';

/**
 * `status` is `undefined` for a transport failure that never reached a server.
 *
 * The branch most likely to be got wrong is **200**: it means the decisions
 * ledger already held this confirm (the server answers 201 only for a fresh
 * one). From the technician's point of view their time IS logged, so it is a
 * success — treating it as a conflict would show a spurious error and, worse,
 * tempt a caller into re-sending.
 */
export function classifyDrainOutcome(status: number | undefined): DrainOutcome {
  if (status === undefined) return 'retry';

  // 408 Request Timeout and 429 Too Many Requests are the only 4xx that a later
  // attempt can turn into a success; an unpaced reconnect backlog trips 429
  // routinely, and dropping those would lose real billable work.
  if (status === 408 || status === 429) return 'retry';

  if (status >= 200 && status < 300) return 'success';

  if (status === 409) return 'drop';
  if (status === 403) return 'dropAndDisable';
  if (status === 404 || status === 410 || status === 400 || status === 422) return 'dropAndToast';

  // Any other 4xx is a client-side defect that a retry cannot fix. Surface it
  // rather than silently dropping, so it is visible in the field.
  if (status >= 400 && status < 500) return 'dropAndToast';

  // 5xx, 3xx and anything else (including a literal 0) are transient or
  // uninterpretable — the safe disposition for billable work is to keep it.
  return 'retry';
}

export type SuggestionWriteKind = 'confirm' | 'dismiss';

/**
 * Identity of a suggestion write, so a double tap enqueues once. Signal ids are
 * SORTED: the sheet may hand the same window's signals in a different order
 * after a refetch, and an order-sensitive key would let that through as a
 * second queued confirm — a duplicate billable entry on drain.
 */
export function suggestionDedupeKey(
  kind: SuggestionWriteKind,
  signals: SuggestionSignalRef[]
): string {
  const ids = signals.map((signal) => `${signal.kind}:${signal.id}`).sort();
  return `suggestion.${kind}:${ids.join('+')}`;
}
