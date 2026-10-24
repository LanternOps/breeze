import type { ImportedAttachmentClaim } from '../ticketService';
import type { ImportedComment } from './importedTicket';
import {
  IMPORT_RESERVATION_BATCH,
  importedAttachmentFilename,
  reservationSkip,
  type ImportAttachmentSkip,
  type ImportAttachmentSkipReason,
  type ImportAttachmentState,
  type ReservationFile,
  type ReservedRow,
} from './importAttachments';
import { storeReservedAttachment, type FetchImportAttachment } from './storeAttachments';

/**
 * Reserve and store, for one comment chunk of importTicket (#8313 W1; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §4.3 steps 1 and 2). The chunk's own transaction then claims what was
 * stored (step 3). The database work comes in as callbacks from the writer,
 * which owns the window transactions; everything else here is the protocol:
 *
 *   - a file the source declares over the cap or empty, or whose name is
 *     denylisted, is skipped and never reserved;
 *   - a file this principal already attached is neither reserved nor
 *     charged again (a source that reuses an attachment id: the file is not
 *     duplicated, exactly like a comment, F3);
 *   - every other file is reserved, in transactions of at most 100 files,
 *     each charged one unit per file that has no row yet (spec §4.3: one unit
 *     per new file; a reused reservation costs nothing);
 *   - a reservation an earlier pass already stored is claimed as it is: no
 *     fetch, no byte charge. The rest are stored with no DB context, then
 *     marked stored, so progress accumulates across passes and a chunk whose
 *     files exceed one pass of the byte budget still finishes. A permanent
 *     failure is a skip whose reservation the chunk transaction deletes; a
 *     transient one throws, and the reservations stay for the next run (or
 *     the reaper).
 */

export type SkippedFile = ImportAttachmentSkip & { filename: string };

/** What the chunk transaction does with one comment's files. */
export type CommentFiles = {
  /** Stored files, claimed by the comment in its own transaction, in the source's order. */
  claims: ImportedAttachmentClaim[];
  /** Skipped files, named in the note appended to the comment, in the source's order. */
  skips: SkippedFile[];
};

export type ChunkFiles = {
  byComment: ReadonlyMap<string, CommentFiles>;
  /** Reservations of files skipped after they were reserved: deleted in the chunk transaction. */
  skippedReservations: string[];
};

export const NO_CHUNK_FILES: ChunkFiles = Object.freeze({ byComment: new Map(), skippedReservations: [] });

export type ReservedBatch =
  | { merged: { mergedIntoTicketId: string }; reserved?: undefined }
  | { merged: null; reserved: ReservedRow[] };

export type ChunkAttachmentsInput = {
  chunk: readonly ImportedComment[];
  /** This principal's rows for these source ids (importAttachmentStates, in the window's context). */
  readStates: (sourceIds: string[]) => Promise<ReadonlyMap<string, ImportAttachmentState>>;
  /**
   * One reservation transaction (reserveImportAttachments after
   * lockImportedTicket), charged `cost` units: one per file the read found
   * no row for.
   */
  reserve: (files: ReservationFile[], cost: number) => Promise<ReservedBatch>;
  /** Marks a stored reservation (markReservationStored, in its own import transaction); false when it is no longer pending. */
  markStored: (claim: ImportedAttachmentClaim) => Promise<boolean>;
  fetchAttachment: FetchImportAttachment;
  /** The window's byte bucket (chargeWindowBytes). */
  chargeBytes: (bytes: number) => Promise<void>;
};

/** Whether any comment of `comments` carries a file. */
export function hasAttachments(comments: readonly ImportedComment[]): boolean {
  return comments.some((c) => (c.attachments?.length ?? 0) > 0);
}

type Planned = {
  commentId: string;
  sourceId: string;
  filename: string;
  declaredBytes?: number;
  /** Decided before the reservation. */
  skip: ImportAttachmentSkipReason | null;
};

/**
 * Steps 1 and 2 of §4.3 for `input.chunk`. Returns the merged survivor when a
 * reservation transaction finds the ticket merged in Breeze (#8972); nothing
 * is stored then.
 */
export async function prepareChunkAttachments(
  input: ChunkAttachmentsInput,
): Promise<{ merged: { mergedIntoTicketId: string } } | { merged: null; files: ChunkFiles }> {
  const planned: Planned[] = input.chunk.flatMap((comment) => (comment.attachments ?? []).map((a) => {
    const filename = importedAttachmentFilename(a.filename);
    return { commentId: comment.sourceId, sourceId: a.sourceId, filename, declaredBytes: a.declaredBytes, skip: reservationSkip(a.declaredBytes, filename) };
  }));
  if (planned.length === 0) return { merged: null, files: NO_CHUNK_FILES };

  const fetchable = planned.filter((p) => p.skip === null);
  const states = fetchable.length > 0 ? await input.readStates(fetchable.map((p) => p.sourceId)) : new Map();
  const toReserve = fetchable.filter((p) => states.get(p.sourceId) !== 'attached');

  const reserved = new Map<string, ReservedRow>();
  for (let i = 0; i < toReserve.length; i += IMPORT_RESERVATION_BATCH) {
    const slice = toReserve.slice(i, i + IMPORT_RESERVATION_BATCH);
    const batch = slice.map((p): ReservationFile => ({
      sourceId: p.sourceId,
      filename: p.filename,
      ...(p.declaredBytes !== undefined ? { declaredBytes: p.declaredBytes } : {}),
    }));
    const newFiles = slice.filter((p) => !states.has(p.sourceId)).length;
    const result = await input.reserve(batch, newFiles);
    if (result.merged) return { merged: result.merged };
    for (const row of result.reserved) reserved.set(row.sourceId, row);
  }

  const byComment = new Map<string, CommentFiles>();
  const skippedReservations: string[] = [];
  const entry = (commentId: string): CommentFiles => {
    let files = byComment.get(commentId);
    if (!files) {
      files = { claims: [], skips: [] };
      byComment.set(commentId, files);
    }
    return files;
  };
  // In the source's order, so claims and the note read as the source does.
  for (const p of planned) {
    if (p.skip) {
      entry(p.commentId).skips.push({ sourceId: p.sourceId, filename: p.filename, reason: p.skip });
      continue;
    }
    // Not reserved: attached already (found by the read, or under the lock).
    const row = reserved.get(p.sourceId);
    if (!row) continue;
    // Stored by an earlier pass: claimed as it is.
    if (row.stored) {
      entry(p.commentId).claims.push(row.stored);
      continue;
    }
    const outcome = await storeReservedAttachment({
      id: row.id,
      sourceId: p.sourceId,
      ...(p.declaredBytes !== undefined ? { declaredBytes: p.declaredBytes } : {}),
      fetchAttachment: input.fetchAttachment,
      chargeBytes: input.chargeBytes,
    });
    if (outcome.kind === 'stored') {
      // Not pending any more (claimed, re-pointed or reaped since): not ours to claim.
      if (!(await input.markStored(outcome.claim))) continue;
      entry(p.commentId).claims.push(outcome.claim);
    } else {
      entry(p.commentId).skips.push({ sourceId: p.sourceId, filename: p.filename, reason: outcome.reason });
      skippedReservations.push(row.id);
    }
  }
  return { merged: null, files: { byComment, skippedReservations } };
}
