import { and, desc, eq, inArray } from 'drizzle-orm';
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
import type { OpenWindow, TicketWriteMode } from '../ticketWriteMode';
import { parseImportedTicket, type ImportedComment, type ImportedTicket } from './importedTicket';
import { chargeWindowThroughput } from './throughput';
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
 * user set them since (see `headerChanges`).
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
  ticketId: string;
  outcome: 'created' | 'resumed';
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
};

export type ImportTicketOptions = {
  /** Comments per transaction, 1..100 (tests use a smaller one). */
  chunkSize?: number;
  /**
   * The partner the caller acts for. Required: the window is read in system
   * scope by its id AND this partner, so a job can only write through its own
   * partner's window, and another partner's window is not found whatever its
   * state.
   */
  partnerId: string;
};

type WriteScope = {
  actor: TicketActor;
  at: (time: Date) => TicketWriteMode;
  window: OpenWindow;
};

type StoredTicket = {
  id: string;
  orgId: string;
  migrationWindowId: string | null;
  deletedAt: Date | null;
  status: TicketStatus;
  subject: string;
  description: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  categoryId: string | null;
  tags: string[] | null;
  ticketType: string;
  assignedTo: string | null;
  fieldProvenance: Record<string, string>;
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

/** The createTicket input for a first import (requester: a contact, or display-only name and email). */
function toCreateInput(t: ImportedTicket): CreateTicketInput {
  const requester = 'contactId' in t.requester
    ? { requesterContactId: t.requester.contactId }
    : { submitterName: t.requester.name, submitterEmail: t.requester.email };
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

async function readStoredTicket(ticketId: string): Promise<StoredTicket | null> {
  const [row] = await db
    .select({
      id: tickets.id,
      orgId: tickets.orgId,
      migrationWindowId: tickets.migrationWindowId,
      deletedAt: tickets.deletedAt,
      status: tickets.status,
      subject: tickets.subject,
      description: tickets.description,
      priority: tickets.priority,
      categoryId: tickets.categoryId,
      tags: tickets.tags,
      ticketType: tickets.ticketType,
      assignedTo: tickets.assignedTo,
      fieldProvenance: tickets.fieldProvenance,
    })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  return (row as StoredTicket | undefined) ?? null;
}

/** The author of a feed row: its origin principal kind and id. */
type FeedAuthor = { kind: string; principalId: string | null };

/**
 * Who wrote the ticket's latest feed row of `type`, or null when it has none
 * (never assigned; status never changed through changeTicketStatus).
 */
async function lastFeedRowBy(ticketId: string, type: 'assignment' | 'status_change'): Promise<FeedAuthor | null> {
  const [row] = await db
    .select({ kind: ticketComments.originPrincipalKind, principalId: ticketComments.originPrincipalId })
    .from(ticketComments)
    .where(and(eq(ticketComments.ticketId, ticketId), eq(ticketComments.commentType, type)))
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
 * - The assignee has no field provenance. Its latest assignment feed row
 *   stands in for it: the source assignee is applied only when that row was
 *   written by this import principal, or the ticket was never assigned.
 * - An optional field left undefined by the module is not compared; null
 *   clears it.
 */
export function headerChanges(
  stored: StoredTicket,
  ref: StoredRef | null,
  lastAssignment: FeedAuthor | null,
  t: ImportedTicket,
  principalId: string,
): HeaderChanges {
  const provenance = stored.fieldProvenance ?? {};
  const userOwned = (field: string) => provenance[field] === 'user';
  const fields: UpdateTicketFieldsInput = {};
  const fieldNames: string[] = [];
  const consider = <K extends keyof UpdateTicketFieldsInput>(field: K, differs: boolean, value: UpdateTicketFieldsInput[K]) => {
    if (!differs || userOwned(field)) return;
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
 * Breeze status, and `skipped` reports it. All or nothing: a resolve-then-
 * close or reopen-then-resolve pair is applied whole or not at all.
 *
 * Ordering by created_at is sound although import rows carry source times: a
 * source time is never later than the pass that writes it, so a Breeze change
 * made after a pass sorts after that pass's rows, and a later pass then writes
 * nothing. Like the assignee rule, this assumes the API's clock and the
 * database's agree. Assigning a `new` ticket opens it without a status_change
 * row, so that implicit open does not own the status.
 */
export function statusSteps(
  current: TicketStatus,
  lastStatusChange: FeedAuthor | null,
  t: ImportedTicket,
  principalId: string,
): { steps: StatusStep[]; skipped: boolean } {
  const steps = finalStatusSteps(current, t);
  if (steps.length === 0 || lastStatusChange === null || writtenByImport(lastStatusChange, principalId)) {
    return { steps, skipped: false };
  }
  return { steps: [], skipped: true };
}

/**
 * Under the lock, the resume conditions the plan checked still hold: the
 * ticket is visible to the window, still imported, and not deleted.
 */
async function assertStillImportable(ticketId: string, sourceId: string): Promise<void> {
  const [row] = await db
    .select({ migrationWindowId: tickets.migrationWindowId, deletedAt: tickets.deletedAt })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  if (!row) throw inUse(sourceId, { reason: 'org_outside_window', ticketId });
  if (!row.migrationWindowId) throw inUse(sourceId, { reason: 'live_ticket', ticketId });
  if (row.deletedAt) throw inUse(sourceId, { reason: 'deleted', ticketId });
}

/**
 * Applies `statusSteps` under the lock; returns whether a Breeze change kept
 * the status. The plan's status may be stale, so the ticket is re-read FOR NO
 * KEY UPDATE: a concurrent status change either committed first, and its feed
 * row is seen below, or waits for this transaction. Not FOR UPDATE: that
 * would conflict with the KEY SHARE lock a concurrent comment insert's
 * foreign-key check takes, and deadlock with its parent-touch trigger.
 */
async function applyFinalStatus(scope: WriteScope, ticketId: string, t: ImportedTicket): Promise<boolean> {
  const [row] = await db.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, ticketId)).limit(1).for('no key update');
  if (!row) throw new Error(`imported ticket ${ticketId} is not visible to its window`);
  const lastStatusChange = await lastFeedRowBy(ticketId, 'status_change');
  const { steps, skipped } = statusSteps(row.status as TicketStatus, lastStatusChange, t, scope.window.principalId);
  for (const step of steps) {
    await changeTicketStatus(
      ticketId,
      { status: step.status },
      step.resolutionNote ? { resolutionNote: step.resolutionNote } : {},
      scope.actor,
      scope.at(step.at),
    );
  }
  return skipped;
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

async function writeComments(
  scope: WriteScope,
  ticketId: string,
  chunk: readonly ImportedComment[],
): Promise<{ written: number; skipped: number }> {
  let written = 0;
  let skipped = 0;
  // Re-checked under the lock: a concurrent run may have written some.
  const present = await presentCommentSourceIds(scope.window.principalId, chunk.map((c) => c.sourceId));
  for (const comment of chunk) {
    if (present.has(comment.sourceId)) {
      skipped += 1;
      continue;
    }
    try {
      await addTicketComment(
        ticketId,
        {
          content: comment.content,
          isPublic: comment.isPublic,
          imported: { sourceId: comment.sourceId, author: comment.author },
        },
        scope.actor,
        scope.at(comment.createdAt),
      );
      written += 1;
    } catch (err) {
      // Held by a ticket outside the window (RLS hides it from the check
      // above), or written by a concurrent run since: the comment is already
      // imported. addTicketComment's own transaction is a savepoint inside
      // this one, so the conflict undoes only that insert and the chunk goes
      // on (pinned by ticketImport.integration.test.ts).
      if (!isImportSourceConflict(err)) throw err;
      skipped += 1;
    }
  }
  return { written, skipped };
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
    if (!stored || !stored.migrationWindowId) throw inUse(t.sourceId, { reason: 'live_ticket', ticketId: ref.ticketId });
    if (stored.deletedAt) throw inUse(t.sourceId, { reason: 'deleted', ticketId: stored.id });
    if (!descriptor.orgIds.includes(stored.orgId)) throw inUse(t.sourceId, { reason: 'org_outside_window', ticketId: stored.id });
    const presentIds = await presentCommentSourceIds(principalId, t.comments.map((c) => c.sourceId));
    const missing = inSourceOrder(t.comments.filter((c) => !presentIds.has(c.sourceId)));
    const changes = headerChanges(stored, ref, await lastFeedRowBy(stored.id, 'assignment'), t, principalId);
    const statusAfterHeader: TicketStatus = changes.assign?.to && stored.status === 'new' ? 'open' : stored.status;
    const status = statusSteps(statusAfterHeader, await lastFeedRowBy(stored.id, 'status_change'), t, principalId);
    return {
      kind: 'resume' as const,
      stored,
      missing,
      present: t.comments.length - missing.length,
      headerCost: headerCost(changes),
      statusCost: status.steps.length,
      statusSkipped: status.skipped,
    };
  });

  if (plan.kind === 'create' && !descriptor.orgIds.includes(t.orgId)) {
    throw new MigrationWindowError(
      'MIGRATION_WINDOW_ORG_NOT_ALLOWED',
      'The organization is not part of this migration window',
      403,
      { orgIds: [t.orgId] },
    );
  }

  const orgId = plan.kind === 'create' ? t.orgId : plan.stored.orgId;
  const chunks = chunkComments(plan.missing, chunkSize, IMPORT_COMMENT_CHUNK_BYTES);
  const statusCost = plan.kind === 'create'
    ? finalStatusSteps(t.assigneeUserId ? 'open' : 'new', t).length
    : plan.statusCost;
  let ticketId = plan.kind === 'create' ? '' : plan.stored.id;
  let fieldsUpdated = 0;
  let commentsWritten = 0;
  let commentsSkipped = plan.present;
  // The last transaction decides the status again under the lock; its answer
  // is the one reported. A transaction that fails throws, so a rolled-back
  // answer is never returned.
  let statusSkipped = plan.kind === 'resume' && plan.statusSkipped;
  const finalStatus = async (scope: WriteScope, id: string) => {
    statusSkipped = await applyFinalStatus(scope, id, t);
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
    fieldsUpdated = await inImportTransaction(descriptor, context, orgId, cost, async (scope) => {
      // Recomputed under the lock, so a user edit since the plan still wins.
      await assertStillImportable(ticketId, t.sourceId);
      const stored = await readStoredTicket(ticketId);
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
      return changes.fieldNames.length + (changes.assign ? 1 : 0);
    });
  }

  for (const [index, chunk] of chunks.entries()) {
    const last = index === chunks.length - 1;
    const cost = chunk.length + (last ? statusCost : 0);
    const result = await inImportTransaction(descriptor, context, orgId, cost, async (scope) => {
      await assertStillImportable(ticketId, t.sourceId);
      const counts = await writeComments(scope, ticketId, chunk);
      if (last) await finalStatus(scope, ticketId);
      return counts;
    });
    commentsWritten += result.written;
    commentsSkipped += result.skipped;
  }

  // A resume with nothing but a status change still needs its transaction.
  if (!headerRuns && chunks.length === 0 && statusCost > 0) {
    await inImportTransaction(descriptor, context, orgId, statusCost, async (scope) => {
      await assertStillImportable(ticketId, t.sourceId);
      await finalStatus(scope, ticketId);
    });
  }

  return {
    ticketId,
    outcome: plan.kind === 'create' ? 'created' : 'resumed',
    commentsWritten,
    commentsSkipped,
    fieldsUpdated,
    statusSkipped,
  };
}
