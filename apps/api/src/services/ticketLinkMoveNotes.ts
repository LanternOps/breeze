import { inArray } from 'drizzle-orm';
import { ticketLinkLabel, ticketLinkTypeSchema, type TicketLinkType } from '@breeze/shared';
import { db, runAfterDbContextCommit, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { ticketComments, tickets } from '../db/schema';
import { emitTicketEvent } from './ticketEvents';
import { captureException } from './sentry';

/**
 * A `ticket_links` row an org mover deleted (#7900 W02), as returned by its
 * `DELETE … RETURNING`, plus which of its legs moved in that transaction.
 */
export interface RemovedTicketLink {
  orgId: string;
  sourceTicketId: string;
  targetTicketId: string;
  linkType: TicketLinkType;
  sourceMoved: boolean;
  targetMoved: boolean;
}

/** Maps raw `DELETE FROM ticket_links … RETURNING` rows (snake_case) to {@link RemovedTicketLink}. */
export function removedTicketLinksFromRows(rows: unknown): RemovedTicketLink[] {
  // Runs inside the move transaction, so a bad shape must not throw (it would
  // roll the move back over a missing note). It is reported loudly instead:
  // the links are already deleted, and a dropped note is otherwise invisible.
  if (rows === undefined || rows === null) return [];
  if (!Array.isArray(rows)) {
    reportMalformed('DELETE … RETURNING did not return an array', { kind: typeof rows });
    return [];
  }
  const out: RemovedTicketLink[] = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    const linkType = ticketLinkTypeSchema.safeParse(r.link_type);
    if (typeof r.org_id !== 'string' || typeof r.source_ticket_id !== 'string'
      || typeof r.target_ticket_id !== 'string' || !linkType.success) {
      reportMalformed('unexpected DELETE … RETURNING row', { columns: Object.keys(r) });
      continue;
    }
    out.push({
      orgId: r.org_id,
      sourceTicketId: r.source_ticket_id,
      targetTicketId: r.target_ticket_id,
      linkType: linkType.data,
      sourceMoved: r.source_moved === true,
      targetMoved: r.target_moved === true,
    });
  }
  return out;
}

function reportMalformed(message: string, extra: Record<string, unknown>): void {
  console.error(`[ticketLinks] org-move link removal: ${message}; notes will be skipped`, extra);
  captureException(new Error(`[ticketLinks] ${message}`));
}

interface Note {
  ticketId: string;
  otherTicketId: string;
  linkType: TicketLinkType;
  direction: 'outgoing' | 'incoming';
}

/**
 * Which tickets get a "link removed" note. A leg is noted unless it moved
 * while its counterpart stayed behind: that leg now sits in another org, and
 * its note would name a ticket of the org it left. So a surviving counterpart
 * is always noted (approved decision 10), and when BOTH legs moved together
 * (two tickets on one moved device) both are noted, since they now share an org.
 */
export function plannedLinkRemovalNotes(removed: readonly RemovedTicketLink[]): Note[] {
  const notes: Note[] = [];
  for (const link of removed) {
    if (!link.sourceMoved || link.targetMoved) {
      notes.push({ ticketId: link.sourceTicketId, otherTicketId: link.targetTicketId, linkType: link.linkType, direction: 'outgoing' });
    }
    if (!link.targetMoved || link.sourceMoved) {
      notes.push({ ticketId: link.targetTicketId, otherTicketId: link.sourceTicketId, linkType: link.linkType, direction: 'incoming' });
    }
  }
  return notes;
}

/**
 * Schedules {@link noteTicketLinksRemovedByOrgMove} to run once the OUTERMOST
 * DB transaction commits (a rollback drops it). Movers run inside a request or
 * system transaction, so "after my db.transaction returned" is not "after
 * commit". Register only once the move is final — after the mover's own
 * transaction/savepoint completed — because a savepoint rolled back inside a
 * transaction that still commits does not drop registered work.
 */
export function scheduleTicketLinkRemovalNotes(removed: readonly RemovedTicketLink[]): void {
  if (removed.length === 0) return;
  runAfterDbContextCommit('ticketLinks.orgMoveNotes', () => noteTicketLinksRemovedByOrgMove(removed));
}

/**
 * Writes the internal system note for every link an org move deleted. Runs
 * AFTER the move commits, never inside it (see
 * {@link scheduleTicketLinkRemovalNotes}): a comment insert re-stamps its
 * parent ticket's feed column (takes that ticket's row lock), so inside the
 * move two concurrent moves of linked tickets could wait on each other.
 * Best-effort: each note is its own short system-context statement, and a
 * failure is logged and reported, never thrown — the move has committed.
 */
export async function noteTicketLinksRemovedByOrgMove(removed: readonly RemovedTicketLink[]): Promise<void> {
  const notes = plannedLinkRemovalNotes(removed);
  if (notes.length === 0) return;
  try {
    const ids = [...new Set(notes.flatMap((n) => [n.ticketId, n.otherTicketId]))];
    const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db.select({
        id: tickets.id,
        orgId: tickets.orgId,
        partnerId: tickets.partnerId,
        internalNumber: tickets.internalNumber,
        ticketNumber: tickets.ticketNumber,
        deletedAt: tickets.deletedAt,
      }).from(tickets).where(inArray(tickets.id, ids))));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const note of notes) {
      const ticket = byId.get(note.ticketId);
      if (ticket?.deletedAt) continue; // soft-deleted survivor: nothing to tell
      if (!ticket) {
        console.warn('[ticketLinks] org-move link-removal note skipped: ticket not found', `ticketId=${note.ticketId}`);
        continue;
      }
      const other = byId.get(note.otherTicketId);
      const otherNumber = other ? (other.internalNumber ?? other.ticketNumber) : note.otherTicketId;
      const label = ticketLinkLabel(note.linkType, note.direction).replace(/_/g, ' ');
      try {
        await runOutsideDbContext(() => withSystemDbAccessContext(() =>
          db.insert(ticketComments).values({
            ticketId: note.ticketId,
            userId: null,
            authorName: null,
            authorType: 'internal',
            originPrincipalKind: 'user',
            originPrincipalId: null,
            commentType: 'system',
            content: `Removed link "${label} ${otherNumber}" because of an organization move`,
            isPublic: false,
            oldValue: note.otherTicketId,
          })));
        await emitTicketEvent({
          type: 'ticket.link_removed',
          ticketId: note.ticketId,
          orgId: ticket.orgId,
          partnerId: ticket.partnerId ?? null,
          actorUserId: null,
          payload: { linkType: note.linkType, otherTicketId: note.otherTicketId, reason: 'org_move' },
        });
      } catch (err) {
        console.error('[ticketLinks] failed to write org-move link-removal note or its event',
          `ticketId=${note.ticketId}`, `otherTicketId=${note.otherTicketId}`, `linkType=${note.linkType}`, `orgId=${ticket.orgId}`, err);
        captureException(err instanceof Error ? err : new Error(String(err)));
      }
    }
  } catch (err) {
    console.error('[ticketLinks] failed to load tickets for org-move link-removal notes; notes skipped', `noteCount=${notes.length}`, err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}
