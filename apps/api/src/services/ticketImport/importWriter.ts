import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, getCurrentDbAccessContext, withDbAccessContext, type DbAccessContext } from '../../db';
import { ticketComments, ticketExternalRefs, tickets } from '../../db/schema';
import { isPgUniqueViolation, pgErrorConstraint } from '../../utils/pgErrors';
import { MigrationWindowError } from '../migrationWindows';
import { TicketExternalRefConflictError, upsertTicketExternalRef } from '../ticketExternalRefs';
import {
  addTicketComment,
  assignTicket,
  changeTicketStatus,
  createTicket,
  type CreateTicketInput,
  type TicketActor,
  type TicketStatus,
  type UpdateTicketFieldsInput,
  updateTicketFields,
} from '../ticketService';
import { selectBackend } from '../ticketAttachmentStorage';
import type { OpenWindow, TicketWriteMode } from '../ticketWriteMode';
import {
  hasAttachments,
  NO_CHUNK_FILES,
  prepareChunkAttachments,
  type ChunkFiles,
} from './chunkAttachments';
import {
  deleteSkippedReservations,
  importAttachmentStates,
  markReservationStored,
  reserveImportAttachments,
  withAttachmentSkipNote,
  type ImportAttachmentSkip,
} from './importAttachments';
import { parseImportedTicket, type ImportedComment, type ImportedTicket } from './importedTicket';
import {
  importedCommentsOf,
  noSourceChanges,
  sourceChanges,
  storedCommentContent,
  type SourceChanges,
} from './sourceChanges';
import type { FetchImportAttachment } from './storeAttachments';
import { chargeWindowBytes, chargeWindowThroughput } from './throughput';
export type { CommentChangedInSource, SourceChanges } from './sourceChanges';
export type { ImportAttachmentSkip, ImportAttachmentSkipReason } from './importAttachments';
export { ImportAttachmentFetchError, type FetchImportAttachment } from './storeAttachments';
import { lockOpenWindowForWrite, readWindowDescriptor, windowWriteContext, type WindowDescriptor } from './windowLock';

/**
 * The import writer (#8313; spec
 * docs/superpowers/specs/api-platform/2026-10-10-ticket-migration-windows-design.md
 * §4.6): the only caller of import mode. Step 3's modules call `importTicket`
 * and never call ticketService directly.
 *
 * One ticket is written in a few transactions, each charged to the window's
 * throughput bucket first (§4.7) at one unit per service write, and each
 * holding the window FOR SHARE (§4.4):
 *   - header: create, external ref, assign (cost <= 3);
 *   - comments, in source order, in chunks of up to 100 comments and
 *     IMPORT_COMMENT_CHUNK_BYTES of content;
 *   - the final status, in the last transaction (cost <= 2).
 * A window that closes mid-ticket leaves a ticket complete up to its last
 * committed transaction; the next window resumes it.
 *
 * Resume: a source id that already has a ref for this principal is resumed —
 * only when its ticket was imported (carries a migration_window_id), is not
 * deleted, and its CURRENT org is in the window; otherwise 409
 * MIGRATION_SOURCE_ID_IN_USE. A resumed ticket gets the comments whose source
 * id is missing, then its final status unless a Breeze change owns the status
 * (see `statusSteps`), and — a deviation from §4.6 for the delta pass of a
 * cutover — the header fields that changed in the source, unless a Breeze
 * user set them since (see `headerChanges`). It also reports, without
 * applying, what changed in the source that it does not converge on: the
 * requester, the org, edited, flipped or deleted comments (`SourceChanges`).
 *
 * Merged in Breeze (#8972): a ticket merged into another is a read-only
 * tombstone. Resuming one this principal imported writes nothing, charges
 * nothing and returns `outcome: 'skipped'` with `skip.reason:
 * 'merged_in_breeze'` and the survivor (see `lockImportedTicket`). A ref that
 * resolves to a ticket this principal did not import (a live ticket, merged
 * or not, or another principal's import) is refused, never resumed.
 *
 * Attachments (#8313 W1; spec 2026-10-19 §4): the files of each comment chunk
 * are reserved (pending rows, one unit each, at most 100 per transaction),
 * then fetched and stored with no DB context, then claimed by their comments
 * in the chunk's own transaction (chunkAttachments.ts, importAttachments.ts).
 * Object storage only: a ticket with files to write and no S3 is refused
 * before anything is written.
 *
 * Must be called with no ambient DB context: it opens its own transactions,
 * and the throughput charge is a Redis round trip that must not hold one.
 */

export const IMPORT_COMMENT_CHUNK_SIZE = 100;

/**
 * Comment content per transaction, in UTF-8 bytes. A comment may hold 200,000
 * characters, up to 600,000 bytes in UTF-8, so a count-only chunk of 100 could
 * write up to 60 MB in one transaction: one long transaction holding the
 * window FOR SHARE and the ticket row locked, and one large WAL burst. 1 MiB
 * leaves a chunk of ordinary mail (a few KB a comment) at the full 100 and
 * still fits the largest comment the schema allows. A comment over the bound,
 * should the schema's limit ever pass it, goes in a chunk of its own. Smaller
 * chunks cost more transactions, not more throughput units: each comment is
 * one unit.
 */
export const IMPORT_COMMENT_CHUNK_BYTES = 1024 * 1024;

export type ImportTicketResult = {
  /** The ticket written, or for a skip the one the source id resolves to. */
  ticketId: string;
  /** 'skipped': nothing (more) is written for this source ticket; `skip` says why. */
  outcome: 'created' | 'resumed' | 'skipped';
  skip?: ImportSkip;
  commentsWritten: number;
  commentsSkipped: number;
  /** Header fields a resume re-applied from the source (0 on a first import). */
  fieldsUpdated: number;
  /**
   * The source's final status differed from the ticket's and was not applied,
   * because a Breeze change owns the status (see `statusSteps`): on a resume,
   * or on a first import whose ticket was changed in Breeze between two of its
   * transactions.
   */
  statusSkipped: boolean;
  /** Why, when `statusSkipped` is true (absent otherwise): see `StatusSkip`. */
  statusSkip?: StatusSkip;
  /** Files claimed by the comments this run wrote (spec 2026-10-19 §5.3 item 1). */
  attachmentsWritten: number;
  /**
   * Files of the comments this run wrote that were not imported with them,
   * and why, in the source's order: the four permanent reasons (a later pass
   * skips them again; each is also named in the note appended to its
   * comment), and `present_elsewhere` (already in Breeze; not in the note).
   * `attachmentsWritten` + this list's length is the source's file count of
   * those comments.
   */
  attachmentsSkipped: ImportAttachmentSkip[];
  /** Bytes of the files claimed (`attachmentsWritten`). */
  attachmentBytes: number;
} & SourceChanges;

/**
 * Why a resume wrote nothing (more). `merged_in_breeze`: a technician merged
 * the ticket this principal imported into `mergedIntoTicketId` with Breeze's
 * native merge (#8972), so it is a read-only tombstone that still holds the
 * source id's ref. Final, like a ticket removed in Breeze (spec 2026-10-19
 * §5.9): every later pass gets the same answer. Found by the plan, nothing
 * was written or charged; found under the lock of a later transaction (a
 * merge that committed mid-ticket), the transactions before it stay
 * committed, that transaction's charge is spent and it writes nothing.
 *
 * Known limit: when the survivor had no ref from this principal, the merge
 * moves the tombstone's ref onto the survivor (ticketMerge/repoint.ts). The
 * source id then resolves to a ticket this principal did not import, and the
 * resume is refused (`live_ticket` or `other_principal_ticket`) on every pass:
 * nothing on the moved ref says where it came from.
 */
export type ImportSkip = { reason: 'merged_in_breeze'; mergedIntoTicketId: string };

/**
 * Why a source status was not applied (#8884 review, finding 1), for the run
 * report's `status_kept` issue: who wrote the ticket's latest status_change
 * row (the Breeze change that owns the status), the source's final status,
 * and the ticket's status when the writer decided.
 */
export type StatusSkip = {
  statusOwner: { kind: string; principalId: string | null };
  sourceStatus: TicketStatus;
  currentStatus: TicketStatus;
};

export type ImportTicketOptions = {
  /** Comments per transaction, 1..100 (tests use a smaller one). */
  chunkSize?: number;
  /**
   * Comment content per transaction in UTF-8 bytes, 1..IMPORT_COMMENT_CHUNK_BYTES
   * (tests use a smaller one, like `chunkSize`).
   */
  chunkBytes?: number;
  /**
   * The partner the caller acts for. Required: the window is read in system
   * scope by its id AND this partner, so a job can only write through its own
   * partner's window, and another partner's window is not found whatever its
   * state.
   */
  partnerId: string;
  /**
   * Tells a source article id from a comment id the module composed (a
   * time-accounting note, an owner note), for `commentsMissingInSource`: a
   * composed note a later pass does not send is not an article deleted in
   * the source. Without it, nothing is counted as missing. The module also
   * answers false for an article it knows the source moved to another ticket
   * (a merge in the source), which is not deleted either.
   */
  isSourceArticleId?: (sourceId: string) => boolean;
  /**
   * Reads one source file (spec 2026-10-19 §5.3 item 1, §4.3 step 2): the
   * original bytes, at most `maxBytes`. Its failures say whether they are
   * permanent (`ImportAttachmentFetchError`, see `FetchImportAttachment`).
   * Required when a comment to write carries attachments.
   */
  fetchAttachment?: FetchImportAttachment;
};

type WriteScope = {
  actor: TicketActor;
  at: (time: Date) => TicketWriteMode;
  window: OpenWindow;
};

/** The stored header `headerChanges` compares the source against. */
type HeaderRow = {
  subject: string;
  description: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  categoryId: string | null;
  tags: string[] | null;
  ticketType: string;
  assignedTo: string | null;
  fieldProvenance: Record<string, string>;
  /** A Breeze merge folded another ticket into this one (#8972): see `MERGE_SURVIVOR_FIELDS`. */
  receivedMerge: boolean;
};

/**
 * The header fields a native merge (#8972) writes on its survivor that a
 * resume would otherwise re-apply. The survivor update in
 * ticketMerge/execute.ts sets `tags` (the union of both tickets'),
 * `deviceId` and `updatedAt`, and stamps no field_provenance; the import
 * re-applies only `tags`. On a ticket that has received a merge they are
 * Breeze's, like a field a user set (importWriter.test.ts pins the list
 * against execute.ts).
 */
export const MERGE_SURVIVOR_FIELDS: readonly string[] = ['tags'];

/** The plan's read of the ticket a source id resolves to. */
type StoredTicket = HeaderRow & {
  id: string;
  orgId: string;
  migrationWindowId: string | null;
  deletedAt: Date | null;
  status: TicketStatus;
  requesterContactId: string | null;
  submitterEmail: string | null;
  /** Set on a tombstone (#8972): the survivor, always a live ticket (one hop). */
  mergedIntoTicketId: string | null;
  /** The principal of the window that created the ticket; null for a live ticket. */
  windowPrincipalId: string | null;
};

type StoredRef = { ticketId: string; externalNumber: string | null; externalUrl: string | null };

type HeaderChanges = {
  fields: UpdateTicketFieldsInput;
  fieldNames: string[];
  assign: { to: string | null } | null;
  refreshRef: boolean;
};

type StatusStep = { status: TicketStatus; at: Date; resolutionNote?: string };

function inUse(sourceId: string, details: Record<string, unknown> = {}): MigrationWindowError {
  return new MigrationWindowError(
    'MIGRATION_SOURCE_ID_IN_USE',
    'This source id belongs to a ticket the import cannot resume',
    409,
    { sourceId, ...details },
  );
}

function isImportSourceConflict(err: unknown): boolean {
  return isPgUniqueViolation(err) && pgErrorConstraint(err) === 'ticket_comments_import_source_uq';
}

function normalizedSubject(t: ImportedTicket): string {
  return t.subject.trim().slice(0, 255);
}

function normalizedDescription(t: ImportedTicket): string {
  return t.description.trim();
}

/**
 * The createTicket input for a first import (requester: a contact, or a
 * display-only name with an optional email; with none, submitter_email stays
 * NULL).
 */
function toCreateInput(t: ImportedTicket): CreateTicketInput {
  const requester = 'contactId' in t.requester
    ? { requesterContactId: t.requester.contactId }
    : { submitterName: t.requester.name, ...(t.requester.email ? { submitterEmail: t.requester.email } : {}) };
  // A 'portal' ticket from another desk has no Breeze portal login, so it
  // carries no submittedBy; createTicket accepts that at run time.
  return {
    orgId: t.orgId,
    subject: normalizedSubject(t),
    description: normalizedDescription(t),
    priority: t.priority,
    ...(t.categoryId ? { categoryId: t.categoryId } : {}),
    ...(t.ticketType ? { ticketType: t.ticketType } : {}),
    ...(t.tags?.length ? { tags: t.tags } : {}),
    source: t.source,
    ...requester,
  } as CreateTicketInput;
}

async function readRef(principalId: string, sourceId: string): Promise<StoredRef | null> {
  const [row] = await db
    .select({
      ticketId: ticketExternalRefs.ticketId,
      externalNumber: ticketExternalRefs.externalNumber,
      externalUrl: ticketExternalRefs.externalUrl,
    })
    .from(ticketExternalRefs)
    .where(and(eq(ticketExternalRefs.partnerServicePrincipalId, principalId), eq(ticketExternalRefs.externalId, sourceId)))
    .limit(1);
  return row ?? null;
}

const headerColumns = () => ({
  subject: tickets.subject,
  description: tickets.description,
  priority: tickets.priority,
  categoryId: tickets.categoryId,
  tags: tickets.tags,
  ticketType: tickets.ticketType,
  assignedTo: tickets.assignedTo,
  fieldProvenance: tickets.fieldProvenance,
  // The outer row is named `tickets`: drizzle leaves a one-table select's
  // columns unqualified. An indexed probe (tickets_merged_into_idx).
  receivedMerge: sql<boolean>`EXISTS (SELECT 1 FROM tickets m WHERE m.merged_into_ticket_id = tickets.id)`,
});

/**
 * The plan's read: the header, the resume conditions and the merge state. The
 * window's principal is a primary-key probe; the SQL names the outer row
 * `tickets` because drizzle leaves a one-table select's columns unqualified.
 */
async function readStoredTicket(ticketId: string): Promise<StoredTicket | null> {
  const [row] = await db
    .select({
      id: tickets.id,
      orgId: tickets.orgId,
      migrationWindowId: tickets.migrationWindowId,
      deletedAt: tickets.deletedAt,
      status: tickets.status,
      ...headerColumns(),
      requesterContactId: tickets.requesterContactId,
      submitterEmail: tickets.submitterEmail,
      mergedIntoTicketId: tickets.mergedIntoTicketId,
      windowPrincipalId: sql<string | null>`(
        SELECT mw.partner_service_principal_id FROM migration_windows mw WHERE mw.id = tickets.migration_window_id)`,
    })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  return (row as StoredTicket | undefined) ?? null;
}

/**
 * The header alone, for the header transaction, which has locked and
 * re-checked the ticket already (`lockImportedTicket`).
 */
async function readHeaderRow(ticketId: string): Promise<HeaderRow | null> {
  const [row] = await db.select(headerColumns()).from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  return (row as HeaderRow | undefined) ?? null;
}

/** The author of a feed row: its origin principal kind and id. */
type FeedAuthor = { kind: string; principalId: string | null };

/**
 * Who wrote the ticket's latest feed row of `type`, or null when it has none
 * (never assigned; status never changed through changeTicketStatus). Only
 * the ticket's own rows: a row a Breeze merge moved in from a tombstone
 * (`merged_from_ticket_id` set, ticketMerge/repoint.ts) is that ticket's
 * history, and must not decide who owns this ticket's status or assignee.
 */
async function lastFeedRowBy(ticketId: string, type: 'assignment' | 'status_change'): Promise<FeedAuthor | null> {
  const [row] = await db
    .select({ kind: ticketComments.originPrincipalKind, principalId: ticketComments.originPrincipalId })
    .from(ticketComments)
    .where(and(eq(ticketComments.ticketId, ticketId), eq(ticketComments.commentType, type), isNull(ticketComments.mergedFromTicketId)))
    .orderBy(desc(ticketComments.createdAt), desc(ticketComments.id))
    .limit(1);
  return row ?? null;
}

function writtenByImport(row: FeedAuthor, principalId: string): boolean {
  return row.kind === 'service_principal' && row.principalId === principalId;
}

/**
 * Comment source ids this principal already wrote, among `sourceIds`. Keyed
 * by principal, like the unique index: a source comment already imported on
 * another ticket (a merge in the source moved it) is skipped, not duplicated.
 */
async function presentCommentSourceIds(principalId: string, sourceIds: readonly string[]): Promise<Set<string>> {
  const present = new Set<string>();
  for (let i = 0; i < sourceIds.length; i += 500) {
    const slice = sourceIds.slice(i, i + 500);
    const rows = await db
      .select({ sourceId: ticketComments.importSourceId })
      .from(ticketComments)
      .where(and(eq(ticketComments.originPrincipalId, principalId), inArray(ticketComments.importSourceId, slice)));
    for (const row of rows) if (row.sourceId) present.add(row.sourceId);
  }
  return present;
}

/**
 * The header fields a resume re-applies so a re-import converges on the
 * source (deviation from spec §4.6, for a cutover's delta pass).
 *
 * - A field whose `field_provenance` is 'user' was set by a Breeze user after
 *   the import and keeps the Breeze value. Every other stamp (the import's
 *   own 'service_principal', 'ai_agent', 'system', none) yields to the source.
 * - On a ticket that has received a native merge, the fields the merge wrote
 *   (`MERGE_SURVIVOR_FIELDS`) keep the Breeze value too: the merge stamps no
 *   provenance.
 * - The assignee has no field provenance. Its latest assignment feed row
 *   stands in for it: the source assignee is applied only when that row was
 *   written by this import principal, or the ticket was never assigned.
 * - An optional field left undefined by the module is not compared; null
 *   clears it.
 */
export function headerChanges(
  stored: HeaderRow,
  ref: StoredRef | null,
  lastAssignment: FeedAuthor | null,
  t: ImportedTicket,
  principalId: string,
): HeaderChanges {
  const provenance = stored.fieldProvenance ?? {};
  const breezeOwned = (field: string) => provenance[field] === 'user'
    || (stored.receivedMerge && MERGE_SURVIVOR_FIELDS.includes(field));
  const fields: UpdateTicketFieldsInput = {};
  const fieldNames: string[] = [];
  const consider = <K extends keyof UpdateTicketFieldsInput>(field: K, differs: boolean, value: UpdateTicketFieldsInput[K]) => {
    if (!differs || breezeOwned(field)) return;
    fields[field] = value;
    fieldNames.push(field);
  };

  consider('subject', stored.subject !== normalizedSubject(t), normalizedSubject(t));
  consider('description', (stored.description ?? '') !== normalizedDescription(t), normalizedDescription(t));
  consider('priority', stored.priority !== t.priority, t.priority);
  if (t.categoryId !== undefined) consider('categoryId', (stored.categoryId ?? null) !== t.categoryId, t.categoryId);
  if (t.tags !== undefined) consider('tags', JSON.stringify(stored.tags ?? []) !== JSON.stringify(t.tags), t.tags);
  if (t.ticketType !== undefined) consider('ticketType', stored.ticketType !== t.ticketType, t.ticketType);

  let assign: HeaderChanges['assign'] = null;
  if (t.assigneeUserId !== undefined && (stored.assignedTo ?? null) !== t.assigneeUserId) {
    const ours = lastAssignment === null
      ? stored.assignedTo === null
      : writtenByImport(lastAssignment, principalId);
    if (ours) assign = { to: t.assigneeUserId };
  }

  const refreshRef = ref !== null && (
    (t.sourceNumber !== undefined && t.sourceNumber !== ref.externalNumber)
    || (t.sourceUrl !== undefined && t.sourceUrl !== ref.externalUrl)
  );
  return { fields, fieldNames, assign, refreshRef };
}

function headerCost(changes: HeaderChanges): number {
  return (changes.fieldNames.length > 0 ? 1 : 0) + (changes.assign ? 1 : 0) + (changes.refreshRef ? 1 : 0);
}

/**
 * The status changes that take a ticket from `current` to the source's final
 * status (at most two). Only `open` leaves resolved/closed. When the source
 * knows when a closed ticket was resolved, it is resolved then closed, so both
 * times are kept. A ticket cannot return to `new`: an assigned import is
 * `open`, as a live one is.
 */
export function finalStatusSteps(current: TicketStatus, t: ImportedTicket): StatusStep[] {
  const final = t.finalStatus as TicketStatus;
  if (final === current || final === 'new') return [];
  const note = t.resolutionNote ? { resolutionNote: t.resolutionNote } : {};
  if (final === 'closed') {
    const steps: StatusStep[] = [];
    const closedAt = t.closedAt ?? t.updatedAt;
    // Only a resolve stores the resolution note, so a closed ticket with a
    // note is resolved first even when the source has no separate resolve
    // time (Zammad has only close_at): then both happen at the close.
    if (current !== 'resolved' && (t.resolvedAt || t.resolutionNote)) {
      steps.push({ status: 'resolved', at: t.resolvedAt ?? closedAt, ...note });
    }
    steps.push({ status: 'closed', at: closedAt });
    return steps;
  }
  if (current === 'resolved' || current === 'closed') {
    const reopen: StatusStep = { status: 'open', at: t.updatedAt };
    if (final === 'open') return [reopen];
    if (final === 'resolved') {
      // Reopen no later than the resolve, so the timeline reads in order.
      const resolvedAt = t.resolvedAt ?? t.updatedAt;
      const reopenAt = resolvedAt.getTime() < t.updatedAt.getTime() ? resolvedAt : t.updatedAt;
      return [{ status: 'open', at: reopenAt }, { status: 'resolved', at: resolvedAt, ...note }];
    }
    return [reopen, { status: final, at: t.updatedAt }];
  }
  if (final === 'resolved') return [{ status: 'resolved', at: t.resolvedAt ?? t.updatedAt, ...note }];
  return [{ status: final, at: t.updatedAt }];
}

/**
 * The status steps a write applies: the source's final status
 * (`finalStatusSteps`), unless a Breeze change owns the status — the header
 * rule (a Breeze user's edit wins), applied to the status on resume.
 *
 * The status has no field provenance, so its latest status_change feed row
 * stands in for it, as the assignment row does for the assignee. The source
 * status applies only when this import principal wrote that row, or the
 * ticket has none: a first import, or one whose earlier pass stopped before
 * its final status. Anyone else's row (a technician, an AI agent, automation,
 * the inbound pipeline's requester reopen, another integration) keeps the
 * Breeze status, and `skip` reports it. All or nothing: a resolve-then-
 * close or reopen-then-resolve pair is applied whole or not at all.
 *
 * Ordering by created_at is sound although import rows carry source times: a
 * source time is never later than the pass that writes it, so a Breeze change
 * made after a pass sorts after that pass's rows, and a later pass then writes
 * nothing. Like the assignee rule, this assumes the API's clock and the
 * database's agree. Assigning a `new` ticket opens it without a status_change
 * row, so that implicit open does not own the status.
 *
 * One limit (#8884 review, finding 2): a live row's created_at defaults to
 * now(), the START of its transaction, not its commit. A source edit that
 * lands inside a live request's lifetime can therefore sort before it: a
 * technician's request that starts at T0 and is still open when an import
 * commits a row stamped with a source time S > T0 leaves the technician's row
 * sorting first, and a later pass treats the import as owning the status.
 * That needs a source edit inside one request's lifetime during a live delta
 * pass.
 *
 * `skip` says why a source status was not applied (`StatusSkip`); it is null
 * when the steps apply or there is nothing to do.
 */
export function statusSteps(
  current: TicketStatus,
  lastStatusChange: FeedAuthor | null,
  t: ImportedTicket,
  principalId: string,
): { steps: StatusStep[]; skip: StatusSkip | null } {
  const steps = finalStatusSteps(current, t);
  if (steps.length === 0 || lastStatusChange === null || writtenByImport(lastStatusChange, principalId)) {
    return { steps, skip: null };
  }
  return {
    steps: [],
    skip: {
      statusOwner: { kind: lastStatusChange.kind, principalId: lastStatusChange.principalId },
      sourceStatus: t.finalStatus as TicketStatus,
      currentStatus: current,
    },
  };
}

/**
 * Locks the ticket row at the start of a write transaction and re-checks
 * under the lock what the plan checked: the ticket is visible to the window,
 * was imported, and is not deleted. A tombstone (#8972) is not an error: it
 * returns the survivor, and the transaction writes nothing. The merge locks
 * the same row, so a merge that committed first is seen here, and one that
 * comes later waits for this transaction. (Which principal imported the
 * ticket was decided by the plan; it never changes.)
 *
 * One statement: the ticket-first FOR UPDATE of `lockTicketForWrite`
 * (services/ticketRowLock.ts), selecting the import's own columns. It is
 * taken before any child write: since #8972 W0 no writer holds a child row
 * and then waits for the ticket, the import's own addTicketComment included,
 * so taking it this early forms no cycle. The service calls that follow
 * re-lock the row, a no-op.
 */
async function lockImportedTicket(ticketId: string, sourceId: string): Promise<{ mergedIntoTicketId: string } | null> {
  const [row] = await db
    .select({ migrationWindowId: tickets.migrationWindowId, deletedAt: tickets.deletedAt, mergedIntoTicketId: tickets.mergedIntoTicketId })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1)
    .for('update');
  if (!row) throw inUse(sourceId, { reason: 'org_outside_window', ticketId });
  if (!row.migrationWindowId) throw inUse(sourceId, { reason: 'live_ticket', ticketId });
  if (row.mergedIntoTicketId) return { mergedIntoTicketId: row.mergedIntoTicketId };
  if (row.deletedAt) throw inUse(sourceId, { reason: 'deleted', ticketId });
  return null;
}

/**
 * Applies `statusSteps` under the lock; returns why a Breeze change kept the
 * status, or null. The plan's status may be stale, so the ticket is re-read
 * here, where the transaction already holds its row (`lockImportedTicket`, or
 * the row a create just inserted): a concurrent status change either
 * committed first, and its feed row is seen below, or waits for this
 * transaction. The FOR NO KEY UPDATE adds nothing to the lock already held.
 */
async function applyFinalStatus(scope: WriteScope, ticketId: string, t: ImportedTicket): Promise<StatusSkip | null> {
  const [row] = await db.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, ticketId)).limit(1).for('no key update');
  if (!row) throw new Error(`imported ticket ${ticketId} is not visible to its window`);
  const lastStatusChange = await lastFeedRowBy(ticketId, 'status_change');
  const { steps, skip } = statusSteps(row.status as TicketStatus, lastStatusChange, t, scope.window.principalId);
  for (const step of steps) {
    await changeTicketStatus(
      ticketId,
      { status: step.status },
      step.resolutionNote ? { resolutionNote: step.resolutionNote } : {},
      scope.actor,
      scope.at(step.at),
    );
  }
  return skip;
}

/** Charge the bucket, open the narrowed context, lock the window FOR SHARE, run `fn`. */
async function inImportTransaction<T>(
  descriptor: WindowDescriptor,
  context: DbAccessContext,
  orgId: string,
  cost: number,
  fn: (scope: WriteScope) => Promise<T>,
): Promise<T> {
  await chargeWindowThroughput(descriptor, cost);
  return withDbAccessContext(context, async () => {
    const window = await lockOpenWindowForWrite(descriptor.id, orgId);
    const actor: TicketActor = { kind: 'service_principal', principalId: window.principalId, keyId: null, name: window.principalName };
    return fn({ actor, window, at: (time) => ({ kind: 'import', window, at: time }) });
  });
}

type ChunkCounts = {
  written: number;
  skipped: number;
  attachmentsWritten: number;
  attachmentBytes: number;
  attachmentsSkipped: ImportAttachmentSkip[];
};

/**
 * The comments of one chunk, each with the files `files` holds for it: the
 * stored ones claimed in the comment's own insert (addTicketComment's import
 * claim), the skipped ones named in a note appended to its text. A comment
 * skipped here (already imported) leaves its stored files pending, for the
 * run that imported it or for the reaper.
 */
async function writeComments(
  scope: WriteScope,
  ticketId: string,
  chunk: readonly ImportedComment[],
  files: ChunkFiles,
): Promise<ChunkCounts> {
  const counts: ChunkCounts = { written: 0, skipped: 0, attachmentsWritten: 0, attachmentBytes: 0, attachmentsSkipped: [] };
  // Re-checked under the lock: a concurrent run may have written some.
  const present = await presentCommentSourceIds(scope.window.principalId, chunk.map((c) => c.sourceId));
  for (const comment of chunk) {
    if (present.has(comment.sourceId)) {
      counts.skipped += 1;
      continue;
    }
    const own = files.byComment.get(comment.sourceId);
    try {
      await addTicketComment(
        ticketId,
        {
          content: withAttachmentSkipNote(storedCommentContent(comment), own?.skips ?? []),
          isPublic: comment.isPublic,
          imported: {
            sourceId: comment.sourceId,
            author: comment.author,
            ...(own && own.claims.length > 0 ? { attachments: own.claims } : {}),
          },
        },
        scope.actor,
        scope.at(comment.createdAt),
      );
      counts.written += 1;
      if (own) {
        counts.attachmentsWritten += own.claims.length;
        counts.attachmentBytes += own.claims.reduce((sum, c) => sum + c.byteSize, 0);
        counts.attachmentsSkipped.push(...own.skips.map(({ sourceId, reason }) => ({ sourceId, reason })));
      }
    } catch (err) {
      // Held by a ticket outside the window (RLS hides it from the check
      // above), or written by a concurrent run since: the comment is already
      // imported. addTicketComment's own transaction is a savepoint inside
      // this one, so the conflict undoes only that insert and the chunk goes
      // on (pinned by ticketImport.integration.test.ts).
      if (!isImportSourceConflict(err)) throw err;
      counts.skipped += 1;
    }
  }
  return counts;
}

/**
 * Splits comments, in order, into chunks of at most `maxCount` comments and
 * `maxBytes` of content (UTF-8). A comment larger than `maxBytes` goes in a
 * chunk of its own.
 */
export function chunkComments(
  comments: readonly ImportedComment[],
  maxCount: number,
  maxBytes: number,
): ImportedComment[][] {
  const out: ImportedComment[][] = [];
  let current: ImportedComment[] = [];
  let bytes = 0;
  for (const comment of comments) {
    const size = Buffer.byteLength(comment.content, 'utf8');
    if (current.length > 0 && (current.length >= maxCount || bytes + size > maxBytes)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(comment);
    bytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Comments in source order; ties keep the module's order. */
function inSourceOrder(comments: readonly ImportedComment[]): ImportedComment[] {
  return comments
    .map((comment, index) => ({ comment, index }))
    .sort((a, b) => a.comment.createdAt.getTime() - b.comment.createdAt.getTime() || a.index - b.index)
    .map((entry) => entry.comment);
}

type RunCounts = {
  commentsWritten: number;
  commentsSkipped: number;
  fieldsUpdated: number;
  attachmentsWritten: number;
  attachmentsSkipped: ImportAttachmentSkip[];
  attachmentBytes: number;
};

/** The result of a source ticket merged in Breeze (`ImportSkip`). */
function mergedInBreeze(
  ticketId: string,
  mergedIntoTicketId: string,
  counts: RunCounts,
): ImportTicketResult {
  return {
    ticketId,
    outcome: 'skipped',
    skip: { reason: 'merged_in_breeze', mergedIntoTicketId },
    ...counts,
    statusSkipped: false,
    ...noSourceChanges(),
  };
}

/**
 * Imports one ticket through the window `windowId` (spec §4.6). `input` is
 * validated first (`parseImportedTicket`); nothing is written for an invalid
 * ticket.
 */
export async function importTicket(
  windowId: string,
  input: ImportedTicket,
  options: ImportTicketOptions,
): Promise<ImportTicketResult> {
  if (getCurrentDbAccessContext()) {
    throw new Error('importTicket opens its own transactions; call it outside any DB context');
  }
  const chunkSize = Math.min(IMPORT_COMMENT_CHUNK_SIZE, Math.max(1, Math.floor(options.chunkSize ?? IMPORT_COMMENT_CHUNK_SIZE)));
  const chunkBytes = Math.min(IMPORT_COMMENT_CHUNK_BYTES, Math.max(1, Math.floor(options.chunkBytes ?? IMPORT_COMMENT_CHUNK_BYTES)));
  const t = parseImportedTicket(input);
  const descriptor = await readWindowDescriptor(windowId, options.partnerId);
  const context = windowWriteContext(descriptor);
  const principalId = descriptor.principalId;

  // Plan with a read in the window's own context: which ticket, which
  // comments are missing, what the header and status need. Each write
  // transaction re-checks what it depends on under the lock.
  const plan = await withDbAccessContext(context, async () => {
    const ref = await readRef(principalId, t.sourceId);
    if (!ref) return { kind: 'create' as const, missing: inSourceOrder(t.comments), present: 0 };
    const stored = await readStoredTicket(ref.ticketId);
    // A ref whose ticket the window's RLS hides: the same reason code the
    // locked re-check gives (lockImportedTicket).
    if (!stored) throw inUse(t.sourceId, { reason: 'org_outside_window', ticketId: ref.ticketId });
    // A ticket this principal did not import is never resumed, merged or not
    // (checked first, so a never-imported live ticket that was merged stays a
    // conflict, not a final skip): a live ticket, or another principal's
    // import, which a merge can leave this principal's ref on.
    if (!stored.migrationWindowId) throw inUse(t.sourceId, { reason: 'live_ticket', ticketId: ref.ticketId });
    if (stored.windowPrincipalId !== principalId) {
      throw inUse(t.sourceId, { reason: 'other_principal_ticket', ticketId: ref.ticketId });
    }
    // Merged in Breeze (#8972): this import's ticket is a tombstone, and the
    // ref is still on it.
    if (stored.mergedIntoTicketId) {
      return { kind: 'merged' as const, ticketId: stored.id, mergedIntoTicketId: stored.mergedIntoTicketId };
    }
    if (stored.deletedAt) throw inUse(t.sourceId, { reason: 'deleted', ticketId: stored.id });
    if (!descriptor.orgIds.includes(stored.orgId)) throw inUse(t.sourceId, { reason: 'org_outside_window', ticketId: stored.id });
    // Present: on this ticket (the read the report also uses), or imported by
    // this principal onto another ticket, which is asked only for the rest.
    const storedComments = await importedCommentsOf(stored.id, principalId, t.comments.map((c) => c.sourceId));
    const onTicket = new Set(storedComments.map((c) => c.sourceId));
    const elsewhere = await presentCommentSourceIds(principalId, t.comments.map((c) => c.sourceId).filter((id) => !onTicket.has(id)));
    const missing = inSourceOrder(t.comments.filter((c) => !onTicket.has(c.sourceId) && !elsewhere.has(c.sourceId)));
    const changes = headerChanges(stored, ref, await lastFeedRowBy(stored.id, 'assignment'), t, principalId);
    const statusAfterHeader: TicketStatus = changes.assign?.to && stored.status === 'new' ? 'open' : stored.status;
    const status = statusSteps(statusAfterHeader, await lastFeedRowBy(stored.id, 'status_change'), t, principalId);
    return {
      kind: 'resume' as const,
      stored,
      missing,
      present: t.comments.length - missing.length,
      headerCost: headerCost(changes),
      // Charged whenever the source status differs, even when the plan
      // predicts a skip (#8884 review, finding 3): the last transaction
      // decides again under the lock, and only units already charged may be
      // written. At most 2.
      statusCost: finalStatusSteps(statusAfterHeader, t).length,
      statusApplies: status.steps.length > 0,
      statusSkip: status.skip,
      sourceChanges: sourceChanges(stored, storedComments, t, options.isSourceArticleId),
    };
  });

  if (plan.kind === 'merged') {
    return mergedInBreeze(plan.ticketId, plan.mergedIntoTicketId, {
      commentsWritten: 0, commentsSkipped: 0, fieldsUpdated: 0, attachmentsWritten: 0, attachmentsSkipped: [], attachmentBytes: 0,
    });
  }

  // Attachments (§4.1): object storage only, refused before anything is
  // written. A module that sends files must say how to read them.
  if (hasAttachments(plan.missing)) {
    if (selectBackend() !== 's3') {
      throw new MigrationWindowError(
        'TICKET_IMPORT_OBJECT_STORAGE_REQUIRED',
        'Importing attachments needs object storage (S3)',
        409,
        { sourceId: t.sourceId },
      );
    }
    if (!options.fetchAttachment) {
      throw new MigrationWindowError('MIGRATION_IMPORT_INVALID', 'Comments with attachments need fetchAttachment', 400, { sourceId: t.sourceId });
    }
  }

  if (plan.kind === 'create' && !descriptor.orgIds.includes(t.orgId)) {
    throw new MigrationWindowError(
      'MIGRATION_WINDOW_ORG_NOT_ALLOWED',
      'The organization is not part of this migration window',
      403,
      { orgIds: [t.orgId] },
    );
  }

  const orgId = plan.kind === 'create' ? t.orgId : plan.stored.orgId;
  const chunks = chunkComments(plan.missing, chunkSize, chunkBytes);
  const statusCost = plan.kind === 'create'
    ? finalStatusSteps(t.assigneeUserId ? 'open' : 'new', t).length
    : plan.statusCost;
  let ticketId = plan.kind === 'create' ? '' : plan.stored.id;
  const counts: RunCounts = {
    commentsWritten: 0,
    commentsSkipped: plan.present,
    fieldsUpdated: 0,
    attachmentsWritten: 0,
    attachmentsSkipped: [],
    attachmentBytes: 0,
  };
  // Which answer is reported (#8884 review, finding 4). When a transaction
  // runs, the last one decides the status again under the lock, and its
  // answer is reported; a transaction that fails throws, so a rolled-back
  // answer is never returned. When there is nothing to write, no transaction
  // opens, and the reported skip is the plan's answer, read without the lock.
  // Only another run of this principal can turn that skip into an apply, and
  // that run applies the status itself.
  let statusSkip: StatusSkip | null = plan.kind === 'resume' ? plan.statusSkip : null;
  const finalStatus = async (scope: WriteScope, id: string) => {
    statusSkip = await applyFinalStatus(scope, id, t);
  };

  // The header: a create (create + ref + assign), or a resume's re-applied
  // fields. The final status rides on the last transaction.
  const headerRuns = plan.kind === 'create' || plan.headerCost > 0;
  const lastIsHeader = headerRuns && chunks.length === 0;
  if (plan.kind === 'create') {
    const cost = 2 + (t.assigneeUserId ? 1 : 0) + (lastIsHeader ? statusCost : 0);
    ticketId = await inImportTransaction(descriptor, context, orgId, cost, async (scope) => {
      const created = await createTicket(toCreateInput(t), scope.actor, scope.at(t.createdAt));
      try {
        await upsertTicketExternalRef({
          principalId,
          partnerId: descriptor.partnerId,
          ticketId: created.id,
          externalId: t.sourceId,
          externalUrl: t.sourceUrl ?? null,
          externalNumber: t.sourceNumber ?? null,
        });
      } catch (err) {
        // Held by a ticket this window cannot see (moved out of its orgs), or
        // won by a concurrent import of the same source id.
        if (err instanceof TicketExternalRefConflictError) throw inUse(t.sourceId, { reason: 'held_elsewhere' });
        throw err;
      }
      if (t.assigneeUserId) await assignTicket(created.id, t.assigneeUserId, scope.actor, scope.at(t.createdAt));
      if (lastIsHeader) await finalStatus(scope, created.id);
      return created.id;
    });
  } else if (headerRuns) {
    const cost = plan.headerCost + (lastIsHeader ? plan.statusCost : 0);
    const header = await inImportTransaction(descriptor, context, orgId, cost, async (scope) => {
      const merged = await lockImportedTicket(ticketId, t.sourceId);
      if (merged) return { fieldsUpdated: 0, merged };
      // Recomputed under the lock, so a user edit since the plan still wins.
      const stored = await readHeaderRow(ticketId);
      const ref = await readRef(principalId, t.sourceId);
      if (!stored || ref?.ticketId !== ticketId) throw inUse(t.sourceId, { reason: 'changed', ticketId });
      const changes = headerChanges(stored, ref, await lastFeedRowBy(ticketId, 'assignment'), t, principalId);
      const at = scope.at(t.updatedAt);
      if (changes.fieldNames.length > 0) await updateTicketFields(ticketId, changes.fields, scope.actor, at);
      if (changes.assign) await assignTicket(ticketId, changes.assign.to, scope.actor, at);
      if (changes.refreshRef) {
        await upsertTicketExternalRef({
          principalId,
          partnerId: descriptor.partnerId,
          ticketId,
          externalId: t.sourceId,
          externalUrl: t.sourceUrl ?? ref.externalUrl,
          externalNumber: t.sourceNumber ?? ref.externalNumber,
        });
      }
      if (lastIsHeader) await finalStatus(scope, ticketId);
      return { fieldsUpdated: changes.fieldNames.length + (changes.assign ? 1 : 0), merged: null };
    });
    if (header.merged) {
      return mergedInBreeze(ticketId, header.merged.mergedIntoTicketId, counts);
    }
    counts.fieldsUpdated = header.fieldsUpdated;
  }

  for (const [index, chunk] of chunks.entries()) {
    const last = index === chunks.length - 1;
    // §4.3 steps 1 and 2: reserve the chunk's files (each reservation
    // transaction locks the ticket first and charges one unit per new file),
    // then fetch and store them with no DB context, marking each stored in a
    // short transaction of its own (no unit: an update of the same row).
    const prepared = hasAttachments(chunk)
      ? await prepareChunkAttachments({
        chunk,
        readStates: (sourceIds) => withDbAccessContext(context, () => importAttachmentStates(principalId, sourceIds)),
        reserve: (files, cost) => inImportTransaction(descriptor, context, orgId, cost, async (scope) => {
          const merged = await lockImportedTicket(ticketId, t.sourceId);
          if (merged) return { merged };
          const reserved = await reserveImportAttachments({ ticketId, windowId: scope.window.id, principalId: scope.window.principalId, files });
          return { merged: null, reserved };
        }),
        markStored: (claim) => inImportTransaction(descriptor, context, orgId, 0, async (scope) => {
          // A merge since the reservation: the chunk transaction answers it.
          if (await lockImportedTicket(ticketId, t.sourceId)) return false;
          return markReservationStored(ticketId, scope.window.principalId, claim);
        }),
        fetchAttachment: options.fetchAttachment!,
        chargeBytes: (bytes) => chargeWindowBytes(descriptor, bytes),
      })
      : { merged: null, files: NO_CHUNK_FILES };
    if (prepared.merged) return mergedInBreeze(ticketId, prepared.merged.mergedIntoTicketId, counts);
    const files = prepared.files;

    // Step 3: the comments claim their stored files; the reservations of
    // files skipped after they were reserved go (nothing was stored for them).
    const cost = chunk.length + (last ? statusCost : 0);
    const result = await inImportTransaction(descriptor, context, orgId, cost, async (scope) => {
      const merged = await lockImportedTicket(ticketId, t.sourceId);
      if (merged) return { merged };
      await deleteSkippedReservations(ticketId, principalId, files.skippedReservations);
      const written = await writeComments(scope, ticketId, chunk, files);
      if (last) await finalStatus(scope, ticketId);
      return { ...written, merged: null };
    });
    if (result.merged) {
      return mergedInBreeze(ticketId, result.merged.mergedIntoTicketId, counts);
    }
    counts.commentsWritten += result.written;
    counts.commentsSkipped += result.skipped;
    counts.attachmentsWritten += result.attachmentsWritten;
    counts.attachmentBytes += result.attachmentBytes;
    counts.attachmentsSkipped.push(...result.attachmentsSkipped);
  }

  // A resume with nothing but a status change still needs its transaction. A
  // predicted skip with nothing else to write opens none (see above).
  if (!headerRuns && chunks.length === 0 && plan.kind === 'resume' && plan.statusApplies) {
    const merged = await inImportTransaction(descriptor, context, orgId, statusCost, async (scope) => {
      const tombstone = await lockImportedTicket(ticketId, t.sourceId);
      if (!tombstone) await finalStatus(scope, ticketId);
      return tombstone;
    });
    if (merged) return mergedInBreeze(ticketId, merged.mergedIntoTicketId, counts);
  }

  return {
    ticketId,
    outcome: plan.kind === 'create' ? 'created' : 'resumed',
    ...counts,
    statusSkipped: statusSkip !== null,
    ...(statusSkip ? { statusSkip } : {}),
    ...(plan.kind === 'resume' ? plan.sourceChanges : noSourceChanges()),
  };
}
