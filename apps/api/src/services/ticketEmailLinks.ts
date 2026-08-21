import { and, eq, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { ticketEmailLinks } from '../db/schema';

// Cross-channel email<->ticket association + idempotency ledger (spec §4).
// See apps/api/src/db/schema/ticketEmailLinks.ts for the tenancy contract.

/** Mirrors ticket_email_links_origin_chk (2026-08-22-ticket-email-links.sql). */
export type TicketEmailLinkOrigin = 'addin_link' | 'addin_create' | 'inbound' | 'backfill';
/** Mirrors ticket_email_links_visibility_chk (same migration). */
export type TicketEmailLinkVisibility = 'public' | 'internal';

export interface TicketEmailLink {
  id: string;
  ticketId: string;
  orgId: string;
  partnerId: string;
  messageId: string;
  commentId: string | null;
  origin: TicketEmailLinkOrigin;
  visibility: TicketEmailLinkVisibility;
  linkedBy: string | null;
}

// Normalize an RFC 5322 Message-ID for storage/lookup: trim whitespace, and wrap
// bare ids in angle brackets (so 'abc@x.test' and '<abc@x.test>' normalize to the
// same stored/looked-up value). Throws on empty input — callers with a list of
// candidate keys must filter empties BEFORE mapping through this function.
export function normalizeMessageId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('empty message id');
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed : `<${trimmed}>`;
}

export interface ClaimInput {
  ticketId: string;
  orgId: string;
  partnerId: string;
  messageId: string;
  // 'backfill' is a DB-legal origin (see the CHECK constraint) but is never
  // written through this claim path — only the three live channels are.
  origin: Exclude<TicketEmailLinkOrigin, 'backfill'>;
  visibility: TicketEmailLinkVisibility;
  linkedBy?: string | null;
  commentId?: string | null;
}

export type ClaimResult =
  | { created: true; link: TicketEmailLink }
  | { created: false; existing: TicketEmailLink };

// Claim the (partner_id, message_id) idempotency slot for a ticket. Concurrent
// claimants race on the unique index — the loser's INSERT is a no-op
// (onConflictDoNothing) and it reads back the winner's row instead.
export async function claimMessageLink(input: ClaimInput): Promise<ClaimResult> {
  const messageId = normalizeMessageId(input.messageId);
  const inserted = await db
    .insert(ticketEmailLinks)
    .values({
      ticketId: input.ticketId,
      orgId: input.orgId,
      partnerId: input.partnerId,
      messageId,
      origin: input.origin,
      visibility: input.visibility,
      linkedBy: input.linkedBy ?? null,
      commentId: input.commentId ?? null,
    })
    .onConflictDoNothing({ target: [ticketEmailLinks.partnerId, ticketEmailLinks.messageId] })
    .returning();
  if (inserted.length > 0) return { created: true, link: inserted[0] as TicketEmailLink };
  // Conflict read-back, in two steps:
  //   1. Caller-scoped, on the CURRENT connection — finds an org-visible winner,
  //      including one written earlier in this same (uncommitted) transaction.
  //   2. Fallback under a short system context on a fresh connection. The
  //      unique index is (partner_id, message_id) but RLS on this table is
  //      ORG-scoped, so a committed winner in an org outside the caller's grant
  //      (e.g. the poller claimed the message for an org a 'selected'-access
  //      technician cannot see) is invisible to step 1 — without this step the
  //      route 500'd instead of answering its designed 409
  //      (message_linked_elsewhere). No data leak: the route responders
  //      re-check canAccessOrg before echoing the winner's ticket.
  const existing =
    (await findLinkByMessageId(input.partnerId, messageId)) ??
    (await runOutsideDbContext(() =>
      withSystemDbAccessContext(() => findLinkByMessageId(input.partnerId, messageId))
    ));
  if (!existing) {
    // True impossibility: the unique index just rejected our insert, so the
    // winner is either in this transaction (step 1) or committed (a cross-
    // transaction conflict blocks until the winner commits), and system scope
    // sees every committed row.
    throw new Error('claim conflict but no existing link found');
  }
  return { created: false, existing };
}

export async function findLinkByMessageId(partnerId: string, messageId: string): Promise<TicketEmailLink | null> {
  const rows = await db
    .select()
    .from(ticketEmailLinks)
    .where(and(eq(ticketEmailLinks.partnerId, partnerId), eq(ticketEmailLinks.messageId, normalizeMessageId(messageId))))
    .limit(1);
  return (rows[0] as TicketEmailLink) ?? null;
}

// Normalize a list of raw header values (In-Reply-To / References) into the
// distinct set of stored-form message ids: drop empties (normalizeMessageId
// throws on an empty string), normalize each the same way claimMessageLink
// does, and dedupe. Exported for direct unit coverage.
export function normalizeMessageIds(messageIds: string[]): string[] {
  return Array.from(
    new Set(
      messageIds
        .filter((id): id is string => !!id && id.trim().length > 0)
        .map((id) => normalizeMessageId(id))
    )
  );
}

// Looks up every ticket that has a claimed link row for any of the given
// message-ids, scoped to the partner. `messageIds` arrives as raw header
// values (already angle-bracket wrapped, but not guaranteed trimmed/normalized
// the same way stored rows are) — see normalizeMessageIds above.
export async function findTicketIdsByMessageIds(partnerId: string, messageIds: string[]): Promise<string[]> {
  const normalized = normalizeMessageIds(messageIds);
  if (normalized.length === 0) return [];
  const rows = await db
    .selectDistinct({ ticketId: ticketEmailLinks.ticketId })
    .from(ticketEmailLinks)
    .where(and(eq(ticketEmailLinks.partnerId, partnerId), inArray(ticketEmailLinks.messageId, normalized)));
  return rows.map((r) => r.ticketId);
}
