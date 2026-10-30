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
 * Same-log finite record IDs take precedence over timestamps. Ingest clamps
 * unparseable/future device timestamps to the batch receipt time, so trigger
 * and recovery can share a timestamp; record IDs break that tie causally.
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
  if (
    a.logName !== undefined && a.logName === b.logName &&
    typeof a.recordId === 'number' && Number.isFinite(a.recordId) &&
    typeof b.recordId === 'number' && Number.isFinite(b.recordId)
  ) {
    const order = compare(a.recordId, b.recordId);
    if (order !== 0) return order;
  }

  return compare(timestamp(a.ts), timestamp(b.ts)) ||
    compare(timestamp(a.createdAt), timestamp(b.createdAt));
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
