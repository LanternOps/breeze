export interface EvidenceCursor {
  ts: string;
  createdAt: string;
  id: string;
  logName?: string;
  recordId?: number;
}

function compare(a: number | string, b: number | string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

/**
 * Order: device timestamp, then (only when timestamps are equal) the Windows
 * record id of the same log, then server ingest time, then row id.
 *
 * Ingest clamps unparseable/future device timestamps to the batch receipt
 * time, so a trigger and its recovery can share a timestamp; the same-log
 * record id breaks that tie causally. Record ids never outrank timestamps:
 * they are per channel and reset when a log is cleared or wraps, so a newer
 * event can carry a lower id. Ids from different logs are never compared.
 */
export function compareEvidence(a: EvidenceCursor, b: EvidenceCursor): -1 | 0 | 1 {
  return compareCausal(a, b) || compare(a.id, b.id);
}

/**
 * Order without the row-id tiebreak. Two different rows with the same
 * timestamp and ingest time (one clamped batch) are not causally ordered, so
 * `isAfterCursor` treats them as a tie instead of letting UUID order decide.
 */
function compareCausal(a: EvidenceCursor, b: EvidenceCursor): -1 | 0 | 1 {
  const byTs = compare(timestamp(a.ts), timestamp(b.ts));
  if (byTs !== 0) return byTs;
  if (
    a.logName !== undefined && a.logName === b.logName &&
    typeof a.recordId === 'number' && Number.isFinite(a.recordId) &&
    typeof b.recordId === 'number' && Number.isFinite(b.recordId)
  ) {
    const byRecord = compare(a.recordId, b.recordId);
    if (byRecord !== 0) return byRecord;
  }
  return compare(timestamp(a.createdAt), timestamp(b.createdAt));
}

/** Tie (same causal position) → consumed on the trigger side, after on the resolve side. */
export function isAfterCursor(
  row: EvidenceCursor,
  cursor: EvidenceCursor | undefined,
  side: 'trigger' | 'resolve',
): boolean {
  if (cursor === undefined) return true;
  const order = compareCausal(row, cursor);
  return order > 0 || (order === 0 && side === 'resolve');
}

export function maxEvidence(a?: EvidenceCursor, b?: EvidenceCursor): EvidenceCursor | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return compareEvidence(a, b) >= 0 ? a : b;
}
