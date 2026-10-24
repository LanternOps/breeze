/**
 * Ticket merge errors (#8972, spec §3.1 / §3.2).
 *
 * - `TicketMergedError` — a write reached a tombstone (a ticket merged into
 *   another). Every ticket writer checks for it UNDER the ticket row lock
 *   (`assertTicketNotMerged` right after `lockTicketForWrite`), because an
 *   unlocked pre-check races with a merge. It is an `HTTPException` so a route
 *   that lets it propagate still answers 409 with the code through the app's
 *   `onError`; the ticket routes' `handleServiceError` adds the survivor id.
 * - `MergeRefusedError` — the merge itself is refused (eligibility, §3.1).
 */
import { HTTPException } from 'hono/http-exception';

export const TICKET_MERGED_CODE = 'TICKET_MERGED' as const;

export class TicketMergedError extends HTTPException {
  readonly code = TICKET_MERGED_CODE;

  constructor(
    readonly ticketId: string,
    readonly mergedIntoTicketId: string,
  ) {
    super(409, { message: 'This ticket was merged into another ticket and is read-only' });
    this.name = 'TicketMergedError';
  }

  /** The body every staff surface answers with. */
  toBody(): { error: string; code: typeof TICKET_MERGED_CODE; details: { mergedIntoTicketId: string } } {
    return { error: this.message, code: this.code, details: { mergedIntoTicketId: this.mergedIntoTicketId } };
  }

  // A fresh Response every call: a Response body may only be read once.
  override getResponse(): Response {
    return Response.json(this.toBody(), { status: 409 });
  }
}

/** The locked-row shape the guard needs (`LockedTicketRow` satisfies it). */
export interface MergeGuardRow {
  id: string;
  mergedIntoTicketId: string | null;
}

/**
 * The tombstone guard. Call it on the row returned by `lockTicketForWrite` /
 * `lockTicketsForWrite`, immediately after the lock and before any write: the
 * merge transaction holds the same row lock, so the answer cannot change until
 * this transaction ends. A `null` row (not found / not visible) passes: the
 * caller keeps its own not-found answer.
 */
export function assertTicketNotMerged(row: MergeGuardRow | null | undefined): void {
  if (row?.mergedIntoTicketId) throw new TicketMergedError(row.id, row.mergedIntoTicketId);
}

/** `assertTicketNotMerged` for every row a `lockTicketsForWrite` batch returned. */
export function assertTicketsNotMerged(rows: Iterable<MergeGuardRow>): void {
  for (const row of rows) assertTicketNotMerged(row);
}

/**
 * The guard for a background or fan-out writer that must SKIP a tombstone
 * rather than fail its whole batch (a sweep, a mover's side note). Same rule as
 * `assertTicketNotMerged`: call it on the locked row, before any write.
 */
export function isMergedTombstone(row: MergeGuardRow | null | undefined): boolean {
  return !!row?.mergedIntoTicketId;
}

/** A route `handleServiceError` branch: 409 with the survivor id. */
export function ticketMergedResponse(
  c: { json: (b: unknown, s: number) => Response },
  err: unknown,
): Response | null {
  return err instanceof TicketMergedError ? c.json(err.toBody(), 409) : null;
}

// ── Merge refusals (§3.1) ─────────────────────────────────────────────────

export type MergeRefusalCode =
  | 'MERGE_SAME_TICKET'
  | 'MERGE_CROSS_ORG'
  | 'MERGE_SOURCE_INELIGIBLE'
  | 'MERGE_SURVIVOR_INELIGIBLE'
  | 'MERGE_DELIVERABLE_PINNED'
  | 'MERGE_IMPORT_WINDOW'
  | 'MERGE_APPROVAL_STATE'
  | 'MERGE_WORK_KIND_MISMATCH'
  | 'MERGE_PENDING_INTENTS'
  | 'ORG_MERGING'
  | 'MERGE_SCOPE_DENIED';

export type MergeRefusalSide = 'source' | 'survivor' | 'both';

export interface MergeRefusal {
  code: MergeRefusalCode;
  side: MergeRefusalSide;
  message: string;
}

export class MergeRefusedError extends Error {
  readonly status = 409 as const;

  constructor(
    readonly code: MergeRefusalCode,
    readonly side: MergeRefusalSide,
    message: string,
  ) {
    super(message);
    this.name = 'MergeRefusedError';
  }

  static from(r: MergeRefusal): MergeRefusedError {
    return new MergeRefusedError(r.code, r.side, r.message);
  }
}
