/**
 * #11965 — step (action intent) statuses that still owe a parked run
 * something: a decision, a release or a result. A run parked
 * `awaiting_approval` is settled only when none of its steps is in one of
 * these. No imports, so readers (check-in triggers, the Wisp post and chat
 * turn) stay off the settlement module's import closure.
 */
export const OPEN_STEP_STATUSES = ['pending_approval', 'approved', 'executing'] as const;

/** How a final step ended, in the words a technician reads, in the order a tally lists them. */
const STEP_OUTCOME_WORDS: ReadonlyArray<readonly [status: string, word: string]> = [
  ['completed', 'ran'],
  ['failed', 'failed'],
  ['rejected', 'denied'],
  ['expired', 'expired'],
  ['cancelled', 'cancelled'],
];

/**
 * "2 ran, 1 denied" from per-status step counts; null when no step is final.
 * Fixed words and numbers only (no device or model text), so it is safe
 * outside an untrusted-data fence. Open statuses are not listed.
 */
export function formatStepTally(rows: ReadonlyArray<{ status: string; count: number | string }>): string | null {
  const parts: string[] = [];
  for (const [status, word] of STEP_OUTCOME_WORDS) {
    const n = rows.filter((r) => r.status === status).reduce((sum, r) => sum + Number(r.count), 0);
    if (n > 0) parts.push(`${n} ${word}`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}
