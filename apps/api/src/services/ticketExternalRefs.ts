import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { ticketExternalRefs, tickets } from '../db/schema';
import { pgErrorConstraint } from '../utils/pgErrors';
import { isPgUniqueViolation } from '../utils/pgErrors';

/**
 * A ticket's id/url in an external PSA/ITSM, namespaced by the partner service
 * principal that owns the integration (`ticket_external_refs`, migration
 * 2026-12-04-101300). Every function runs in the CALLER's DB context — the
 * table is org-scoped, so a principal only ever sees refs on tickets it can
 * read; nothing here escapes to system scope.
 */

export interface TicketExternalRef {
  ticketId: string;
  externalId: string;
  externalUrl: string | null;
}

/** 409 for `(principal, external_id)` already held by another ticket. */
export class TicketExternalRefConflictError extends Error {
  readonly status = 409;
  readonly code = 'EXTERNAL_ID_CONFLICT';
  constructor(
    readonly details: { externalTicketId: string; existingTicketId: string | null; existingDeleted: boolean | null },
  ) {
    super('External ticket id already in use for this integration');
    this.name = 'TicketExternalRefConflictError';
  }
}

const EXTERNAL_UNIQUE_INDEX = 'ticket_external_refs_principal_external_uq';

async function describeHolder(principalId: string, externalId: string): Promise<{ existingTicketId: string | null; existingDeleted: boolean | null }> {
  const [row] = await db
    .select({ ticketId: ticketExternalRefs.ticketId, deletedAt: tickets.deletedAt })
    .from(ticketExternalRefs)
    .innerJoin(tickets, eq(tickets.id, ticketExternalRefs.ticketId))
    .where(and(
      eq(ticketExternalRefs.partnerServicePrincipalId, principalId),
      eq(ticketExternalRefs.externalId, externalId),
    ))
    .limit(1);
  // Null when RLS hides the holder from this context: the code alone tells
  // the integration to re-link.
  return row ? { existingTicketId: row.ticketId, existingDeleted: row.deletedAt != null } : { existingTicketId: null, existingDeleted: null };
}

/**
 * Point the principal's ref for `ticketId` at `externalId` (creating or
 * re-pointing it). Runs the write inside a savepoint so a 23505 on the
 * (principal, external_id) index leaves the caller's transaction usable for
 * the conflict lookup.
 *
 * The ref's `org_id` is read from the TICKET row, in the caller's context —
 * never taken from the caller (#7490 review). The composite
 * (ticket_id, org_id) -> tickets(id, org_id) FK enforces the same thing in the
 * database; reading it here means a correct caller can never trip it, and a
 * ticket that moves concurrently surfaces as that FK's 23503 rather than a
 * ref filed under the wrong org. Callers authorize the ticket first, so a
 * ticket that is not visible here is an invariant violation, not a 404.
 */
export async function upsertTicketExternalRef(input: {
  principalId: string;
  partnerId: string;
  ticketId: string;
  externalId: string;
  externalUrl?: string | null;
}): Promise<TicketExternalRef> {
  const [ticket] = await db
    .select({ orgId: tickets.orgId })
    .from(tickets)
    .where(eq(tickets.id, input.ticketId))
    .limit(1);
  if (!ticket) throw new Error(`ticket ${input.ticketId} is not visible to this context; authorize it before writing an external ref`);
  try {
    const [row] = await db.transaction((tx) =>
      tx.insert(ticketExternalRefs)
        .values({
          ticketId: input.ticketId,
          orgId: ticket.orgId,
          partnerId: input.partnerId,
          partnerServicePrincipalId: input.principalId,
          externalId: input.externalId,
          externalUrl: input.externalUrl ?? null,
        })
        .onConflictDoUpdate({
          target: [ticketExternalRefs.partnerServicePrincipalId, ticketExternalRefs.ticketId],
          set: { orgId: ticket.orgId, externalId: input.externalId, externalUrl: input.externalUrl ?? null, updatedAt: new Date() },
        })
        .returning({ ticketId: ticketExternalRefs.ticketId, externalId: ticketExternalRefs.externalId, externalUrl: ticketExternalRefs.externalUrl }),
    );
    if (!row) throw new Error('ticket external ref upsert returned no row');
    return row;
  } catch (err) {
    if (isPgUniqueViolation(err) && pgErrorConstraint(err) === EXTERNAL_UNIQUE_INDEX) {
      const holder = await describeHolder(input.principalId, input.externalId);
      // The same ticket already holds it under this principal: that is a no-op, not a conflict.
      if (holder.existingTicketId === input.ticketId) {
        return { ticketId: input.ticketId, externalId: input.externalId, externalUrl: input.externalUrl ?? null };
      }
      throw new TicketExternalRefConflictError({ externalTicketId: input.externalId, ...holder });
    }
    throw err;
  }
}

/** Drop the principal's ref for a ticket (a PATCH with `externalTicketId: null`). */
export async function clearTicketExternalRef(principalId: string, ticketId: string): Promise<void> {
  await db.delete(ticketExternalRefs).where(and(
    eq(ticketExternalRefs.partnerServicePrincipalId, principalId),
    eq(ticketExternalRefs.ticketId, ticketId),
  ));
}

/** The ticket this principal knows by `externalId`, if visible. */
export async function findTicketIdByExternalRef(principalId: string, externalId: string): Promise<string | null> {
  const [row] = await db
    .select({ ticketId: ticketExternalRefs.ticketId })
    .from(ticketExternalRefs)
    .where(and(eq(ticketExternalRefs.partnerServicePrincipalId, principalId), eq(ticketExternalRefs.externalId, externalId)))
    .limit(1);
  return row?.ticketId ?? null;
}

/** This principal's refs for a page of tickets, keyed by ticket id. */
export async function ticketExternalRefsFor(principalId: string, ticketIds: readonly string[]): Promise<Map<string, TicketExternalRef>> {
  const out = new Map<string, TicketExternalRef>();
  if (ticketIds.length === 0) return out;
  const rows = await db
    .select({ ticketId: ticketExternalRefs.ticketId, externalId: ticketExternalRefs.externalId, externalUrl: ticketExternalRefs.externalUrl })
    .from(ticketExternalRefs)
    .where(and(eq(ticketExternalRefs.partnerServicePrincipalId, principalId), inArray(ticketExternalRefs.ticketId, [...ticketIds])));
  for (const row of rows) out.set(row.ticketId, row);
  return out;
}
