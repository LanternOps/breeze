import { and, asc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { ticketLinkLabel, type TicketLinkLabel, type TicketLinkType } from '@breeze/shared';
import { db } from '../db';
import { ticketComments, ticketLinks, tickets } from '../db/schema';
import { isPgUniqueViolation, pgErrorConstraint } from '../utils/pgErrors';
import { createAuditLogAsync } from './auditService';
import { emitTicketEvent } from './ticketEvents';
import { lockOrgTicketLinks } from './ticketLinkLock';
import {
  actorAuditIdentity,
  actorAuthorFields,
  actorUserFk,
  type TicketActor,
} from './ticketService';

/**
 * Ticket-to-ticket links (#7900, feature #8592 W02). One stored row per link
 * (`ticket_links`, "source <type> target"); the label seen from the other end
 * is derived (`ticketLinkLabel`). Same org only — enforced by the composite
 * FKs — and staff-only: no portal surface reads this table.
 *
 * Callers (routes) own the access decision: both tickets reach the service
 * already resolved through the caller's org and site scope
 * (`getScopedTicketOr404`), so an out-of-scope ticket is a 404 before the
 * service runs. The service re-checks what can change under it inside its
 * transaction: existence, soft delete, and same org.
 */

/** A ticket may carry at most this many links (both directions). Abuse guard. */
export const TICKET_LINK_LIMIT = 50;

export type TicketLinkErrorCode =
  | 'NOT_FOUND'
  | 'SELF_LINK'
  | 'CROSS_ORG'
  | 'ALREADY_LINKED'
  | 'LINK_CYCLE'
  | 'LINK_LIMIT'
  | 'SOURCE_ALREADY_DUPLICATE'
  | 'SOURCE_HAS_DUPLICATES'
  | 'DUPLICATE_TARGET_IS_DUPLICATE';

const STATUS: Record<TicketLinkErrorCode, 404 | 409 | 422> = {
  NOT_FOUND: 404,
  SELF_LINK: 422,
  CROSS_ORG: 422,
  ALREADY_LINKED: 409,
  LINK_CYCLE: 409,
  LINK_LIMIT: 409,
  SOURCE_ALREADY_DUPLICATE: 409,
  SOURCE_HAS_DUPLICATES: 409,
  DUPLICATE_TARGET_IS_DUPLICATE: 409,
};

export class TicketLinkError extends Error {
  readonly status: 404 | 409 | 422;
  constructor(
    readonly code: TicketLinkErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TicketLinkError';
    this.status = STATUS[code];
  }
}

export interface TicketLinkView {
  id: string;
  /** 'outgoing' when the viewed ticket is the stored source. */
  direction: 'outgoing' | 'incoming';
  linkType: TicketLinkType;
  /** How the link reads from the viewed ticket (inverse label when incoming). */
  label: TicketLinkLabel;
  other: {
    id: string;
    ticketNumber: string;
    subject: string;
    status: (typeof tickets.$inferSelect)['status'];
    ticketType: (typeof tickets.$inferSelect)['ticketType'];
  };
  createdAt: string;
}

interface TicketRef { id: string; orgId: string }

const displayNumber = (t: { internalNumber: string | null; ticketNumber: string }) => t.internalNumber ?? t.ticketNumber;
const readable = (label: TicketLinkLabel) => label.replace(/_/g, ' ');

/** Stored orientation: `related` is symmetric and kept source < target. */
function canonical(sourceId: string, targetId: string, linkType: TicketLinkType): [string, string] {
  return linkType === 'related' && sourceId > targetId ? [targetId, sourceId] : [sourceId, targetId];
}

/**
 * Links of one ticket, as seen from it. A counterpart that is soft-deleted, or
 * that `counterpartFilter` (the caller's site scope, written against `tickets`)
 * excludes, is omitted — the caller never learns it exists.
 */
export async function listTicketLinks(
  ticketId: string,
  opts: { counterpartFilter?: SQL } = {},
): Promise<TicketLinkView[]> {
  const counterpartId = sql`CASE WHEN ${ticketLinks.sourceTicketId} = ${ticketId}::uuid THEN ${ticketLinks.targetTicketId} ELSE ${ticketLinks.sourceTicketId} END`;
  const rows = await db
    .select({
      id: ticketLinks.id,
      sourceTicketId: ticketLinks.sourceTicketId,
      linkType: ticketLinks.linkType,
      createdAt: ticketLinks.createdAt,
      otherId: tickets.id,
      internalNumber: tickets.internalNumber,
      ticketNumber: tickets.ticketNumber,
      subject: tickets.subject,
      status: tickets.status,
      ticketType: tickets.ticketType,
    })
    .from(ticketLinks)
    .innerJoin(tickets, sql`${tickets.id} = ${counterpartId}`)
    .where(and(
      or(eq(ticketLinks.sourceTicketId, ticketId), eq(ticketLinks.targetTicketId, ticketId)),
      isNull(tickets.deletedAt),
      opts.counterpartFilter,
    ))
    .orderBy(asc(ticketLinks.createdAt), asc(ticketLinks.id));
  return rows.map((r) => {
    const direction = r.sourceTicketId === ticketId ? 'outgoing' as const : 'incoming' as const;
    return {
      id: r.id,
      direction,
      linkType: r.linkType,
      label: ticketLinkLabel(r.linkType, direction),
      other: {
        id: r.otherId,
        ticketNumber: displayNumber(r),
        subject: r.subject,
        status: r.status,
        ticketType: r.ticketType,
      },
      createdAt: r.createdAt.toISOString(),
    };
  });
}

/**
 * A live ticket of `orgId` by its displayed number (internal number, or the
 * legacy ticket number), or null. Scoped to ONE org on purpose: a link target
 * is only ever looked up inside the source ticket's org.
 */
export async function findTicketIdByNumber(orgId: string, ticketNumber: string): Promise<string | null> {
  const rows = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(
      eq(tickets.orgId, orgId),
      isNull(tickets.deletedAt),
      or(eq(tickets.internalNumber, ticketNumber), eq(tickets.ticketNumber, ticketNumber)),
    ))
    .limit(2);
  // Ambiguous (an internal number equal to another ticket's legacy number) is
  // answered as not found rather than guessed.
  return rows.length === 1 ? rows[0]!.id : null;
}

/** One link of `ticketId` (either leg), or null. For the route's counterpart scope check. */
export async function getTicketLinkForTicket(ticketId: string, linkId: string) {
  const [row] = await db
    .select()
    .from(ticketLinks)
    .where(and(
      eq(ticketLinks.id, linkId),
      or(eq(ticketLinks.sourceTicketId, ticketId), eq(ticketLinks.targetTicketId, ticketId)),
    ))
    .limit(1);
  if (!row) return null;
  return { ...row, otherTicketId: row.sourceTicketId === ticketId ? row.targetTicketId : row.sourceTicketId };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface LockedTicket { id: string; orgId: string; partnerId: string | null; deleted: boolean; number: string }

async function lockTickets(tx: Tx, ids: readonly [string, string]): Promise<Map<string, LockedTicket>> {
  const rows = await tx.execute(sql`
    SELECT id, org_id, partner_id, deleted_at IS NOT NULL AS deleted, COALESCE(internal_number, ticket_number) AS number
      FROM tickets
     WHERE id IN (${ids[0]}::uuid, ${ids[1]}::uuid)
     ORDER BY id
       FOR UPDATE`) as unknown as Array<{ id: string; org_id: string; partner_id: string | null; deleted: boolean; number: string }>;
  return new Map(rows.map((r) => [r.id, { id: r.id, orgId: r.org_id, partnerId: r.partner_id, deleted: r.deleted, number: r.number }]));
}

async function wouldCloseCycle(tx: Tx, sourceId: string, targetId: string, linkType: TicketLinkType): Promise<boolean> {
  // Is `source` reachable from `target` along edges of this type? UNION (not
  // UNION ALL) de-duplicates visited ids, so the walk terminates on any graph.
  const rows = await tx.execute(sql`
    WITH RECURSIVE reach(id) AS (
      SELECT target_ticket_id FROM ticket_links
       WHERE source_ticket_id = ${targetId}::uuid AND link_type = ${linkType}::ticket_link_type
      UNION
      SELECT l.target_ticket_id FROM ticket_links l JOIN reach r ON l.source_ticket_id = r.id
       WHERE l.link_type = ${linkType}::ticket_link_type
    )
    SELECT 1 AS hit FROM reach WHERE id = ${sourceId}::uuid LIMIT 1`) as unknown as unknown[];
  return rows.length > 0;
}

async function assertDuplicateRules(tx: Tx, sourceId: string, targetId: string): Promise<void> {
  const rows = await tx.execute(sql`
    SELECT source_ticket_id, target_ticket_id FROM ticket_links
     WHERE link_type = 'duplicate_of'
       AND (source_ticket_id IN (${sourceId}::uuid, ${targetId}::uuid) OR target_ticket_id = ${sourceId}::uuid)`) as unknown as Array<{ source_ticket_id: string; target_ticket_id: string }>;
  // No third-ticket id in the error details: the canonical ticket may be one
  // the caller cannot see (site scope), and only source/target passed scope.
  if (rows.some((r) => r.source_ticket_id === sourceId)) {
    throw new TicketLinkError('SOURCE_ALREADY_DUPLICATE', 'This ticket is already marked as a duplicate of another ticket');
  }
  if (rows.some((r) => r.source_ticket_id === targetId)) {
    throw new TicketLinkError('DUPLICATE_TARGET_IS_DUPLICATE', 'The target is itself a duplicate; link to its canonical ticket instead');
  }
  if (rows.some((r) => r.target_ticket_id === sourceId)) {
    throw new TicketLinkError('SOURCE_HAS_DUPLICATES', 'Other tickets are duplicates of this ticket, so it cannot itself be a duplicate');
  }
}

async function assertUnderLimit(tx: Tx, ids: readonly [string, string]): Promise<void> {
  const rows = await tx.execute(sql`
    SELECT t.id, count(l.id)::int AS n
      FROM unnest(ARRAY[${ids[0]}::uuid, ${ids[1]}::uuid]) AS t(id)
      LEFT JOIN ticket_links l ON l.source_ticket_id = t.id OR l.target_ticket_id = t.id
     GROUP BY t.id`) as unknown as Array<{ id: string; n: number }>;
  const full = rows.find((r) => r.n >= TICKET_LINK_LIMIT);
  if (full) {
    throw new TicketLinkError('LINK_LIMIT', `A ticket can have at most ${TICKET_LINK_LIMIT} links`, { limit: TICKET_LINK_LIMIT });
  }
}

export async function addTicketLink(
  input: { source: TicketRef; target: TicketRef; linkType: TicketLinkType },
  actor: TicketActor,
): Promise<TicketLinkView> {
  const { source, target, linkType } = input;
  if (source.id === target.id) throw new TicketLinkError('SELF_LINK', 'A ticket cannot be linked to itself');
  if (source.orgId !== target.orgId) {
    throw new TicketLinkError('CROSS_ORG', 'Tickets can only be linked within one organization');
  }
  const orgId = source.orgId;
  const [storedSource, storedTarget] = canonical(source.id, target.id, linkType);

  const { linkId, locked } = await db.transaction(async (tx) => {
    // Exclusive per-org link lock, before any row lock (services/ticketLinkLock.ts):
    // keeps the cycle / duplicate-depth / cap checks race-free and keeps
    // link writes from interleaving with an org move of this org.
    await lockOrgTicketLinks(tx, orgId, 'exclusive');
    const locked = await lockTickets(tx, [storedSource, storedTarget].sort() as [string, string]);
    const s = locked.get(source.id);
    const t = locked.get(target.id);
    if (!s || !t || s.deleted || t.deleted) throw new TicketLinkError('NOT_FOUND', 'Ticket not found');
    // Re-checked under the lock: a concurrent org move may have moved either.
    if (s.orgId !== orgId || t.orgId !== orgId) {
      throw new TicketLinkError('CROSS_ORG', 'Tickets can only be linked within one organization');
    }

    const [existing] = await tx.select({ id: ticketLinks.id }).from(ticketLinks).where(and(
      eq(ticketLinks.sourceTicketId, storedSource),
      eq(ticketLinks.targetTicketId, storedTarget),
      eq(ticketLinks.linkType, linkType),
    )).limit(1);
    if (existing) throw new TicketLinkError('ALREADY_LINKED', 'These tickets are already linked this way');

    if (linkType === 'duplicate_of') await assertDuplicateRules(tx, storedSource, storedTarget);
    if ((linkType === 'caused_by' || linkType === 'resolves') && await wouldCloseCycle(tx, storedSource, storedTarget, linkType)) {
      throw new TicketLinkError('LINK_CYCLE', 'This link would create a cycle');
    }
    await assertUnderLimit(tx, [storedSource, storedTarget]);

    let inserted: { id: string } | undefined;
    try {
      [inserted] = await tx.insert(ticketLinks).values({
        orgId,
        sourceTicketId: storedSource,
        targetTicketId: storedTarget,
        linkType,
        createdBy: actorUserFk(actor),
      }).returning({ id: ticketLinks.id });
    } catch (err) {
      // Unreachable while the org lock above is held; kept so a future
      // writer that skips the lock still answers a clean 409.
      if (isPgUniqueViolation(err)) {
        const constraint = pgErrorConstraint(err);
        if (constraint === 'ticket_links_one_canonical_uq') {
          throw new TicketLinkError('SOURCE_ALREADY_DUPLICATE', 'This ticket is already marked as a duplicate of another ticket');
        }
        throw new TicketLinkError('ALREADY_LINKED', 'These tickets are already linked this way');
      }
      throw err;
    }

    const sLocked = locked.get(storedSource)!;
    const tLocked = locked.get(storedTarget)!;
    await tx.insert(ticketComments).values([
      {
        ticketId: storedSource,
        ...actorAuthorFields(actor),
        commentType: 'system' as const,
        content: `Linked: ${readable(ticketLinkLabel(linkType, 'outgoing'))} ${tLocked.number}`,
        isPublic: false,
        newValue: storedTarget,
      },
      {
        ticketId: storedTarget,
        ...actorAuthorFields(actor),
        commentType: 'system' as const,
        content: `Linked: ${readable(ticketLinkLabel(linkType, 'incoming'))} ${sLocked.number}`,
        isPublic: false,
        newValue: storedSource,
      },
    ]);
    return { linkId: inserted!.id, locked };
  });

  const partnerId = locked.get(source.id)?.partnerId ?? null;
  const actorUserId = actorUserFk(actor);
  for (const [ticketId, otherTicketId, direction] of [
    [storedSource, storedTarget, 'outgoing'],
    [storedTarget, storedSource, 'incoming'],
  ] as const) {
    await emitTicketEvent({
      type: 'ticket.link_added', ticketId, orgId, partnerId, actorUserId,
      payload: { linkId, linkType, otherTicketId, direction },
    });
  }
  await createAuditLogAsync({
    orgId,
    ...actorAuditIdentity(actor),
    action: 'ticket.link_add',
    resourceType: 'ticket',
    resourceId: source.id,
    details: { linkId, linkType, sourceTicketId: storedSource, targetTicketId: storedTarget },
    result: 'success',
  });

  const view = (await listTicketLinks(source.id)).find((l) => l.id === linkId);
  if (!view) throw new TicketLinkError('NOT_FOUND', 'Ticket not found');
  return view;
}

export async function removeTicketLink(ticketId: string, linkId: string, actor: TicketActor): Promise<void> {
  const removed = await db.transaction(async (tx) => {
    // Same lock order as addTicketLink — org link lock, then both tickets in
    // id order, then the link row — so a remove never holds the link row while
    // waiting for a ticket row (the comment feed trigger below locks both).
    const [found] = await tx.select({ orgId: ticketLinks.orgId, sourceTicketId: ticketLinks.sourceTicketId, targetTicketId: ticketLinks.targetTicketId })
      .from(ticketLinks)
      .where(and(eq(ticketLinks.id, linkId), or(eq(ticketLinks.sourceTicketId, ticketId), eq(ticketLinks.targetTicketId, ticketId))))
      .limit(1);
    if (!found) throw new TicketLinkError('NOT_FOUND', 'Link not found');
    await lockOrgTicketLinks(tx, found.orgId, 'exclusive');
    await lockTickets(tx, [found.sourceTicketId, found.targetTicketId].sort() as [string, string]);
    const [row] = await tx.delete(ticketLinks).where(and(
      eq(ticketLinks.id, linkId),
      or(eq(ticketLinks.sourceTicketId, ticketId), eq(ticketLinks.targetTicketId, ticketId)),
    )).returning();
    if (!row) throw new TicketLinkError('NOT_FOUND', 'Link not found');
    const numbers = new Map((await tx
      .select({ id: tickets.id, internalNumber: tickets.internalNumber, ticketNumber: tickets.ticketNumber, partnerId: tickets.partnerId })
      .from(tickets)
      .where(or(eq(tickets.id, row.sourceTicketId), eq(tickets.id, row.targetTicketId))))
      .map((t) => [t.id, t]));
    const num = (id: string) => { const t = numbers.get(id); return t ? displayNumber(t) : id; };
    await tx.insert(ticketComments).values([
      {
        ticketId: row.sourceTicketId,
        ...actorAuthorFields(actor),
        commentType: 'system' as const,
        content: `Unlinked: ${readable(ticketLinkLabel(row.linkType, 'outgoing'))} ${num(row.targetTicketId)}`,
        isPublic: false,
        oldValue: row.targetTicketId,
      },
      {
        ticketId: row.targetTicketId,
        ...actorAuthorFields(actor),
        commentType: 'system' as const,
        content: `Unlinked: ${readable(ticketLinkLabel(row.linkType, 'incoming'))} ${num(row.sourceTicketId)}`,
        isPublic: false,
        oldValue: row.sourceTicketId,
      },
    ]);
    return { row, partnerId: numbers.get(ticketId)?.partnerId ?? null };
  });

  const { row, partnerId } = removed;
  const actorUserId = actorUserFk(actor);
  for (const [tid, otherTicketId] of [[row.sourceTicketId, row.targetTicketId], [row.targetTicketId, row.sourceTicketId]] as const) {
    await emitTicketEvent({
      type: 'ticket.link_removed', ticketId: tid, orgId: row.orgId, partnerId, actorUserId,
      payload: { linkType: row.linkType, otherTicketId, reason: 'user' },
    });
  }
  await createAuditLogAsync({
    orgId: row.orgId,
    ...actorAuditIdentity(actor),
    action: 'ticket.link_remove',
    resourceType: 'ticket',
    resourceId: ticketId,
    details: { linkId, linkType: row.linkType, sourceTicketId: row.sourceTicketId, targetTicketId: row.targetTicketId },
    result: 'success',
  });
}
