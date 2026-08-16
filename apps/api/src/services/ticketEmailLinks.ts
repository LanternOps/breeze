import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { ticketEmailLinks } from '../db/schema';

// Cross-channel email<->ticket association + idempotency ledger (spec §4).
// See apps/api/src/db/schema/ticketEmailLinks.ts for the tenancy contract.

export interface TicketEmailLink {
  id: string;
  ticketId: string;
  orgId: string;
  partnerId: string;
  messageId: string;
  commentId: string | null;
  origin: string;
  visibility: string;
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
  origin: 'addin_link' | 'addin_create' | 'inbound';
  visibility: 'public' | 'internal';
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
  const existing = await findLinkByMessageId(input.partnerId, messageId);
  if (!existing) throw new Error('claim conflict but no existing link visible'); // RLS-invisible winner; treat as retryable
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

// Looks up every ticket that has a claimed link row for any of the given
// message-ids, scoped to the partner. `messageIds` arrives as raw header
// values (In-Reply-To / References — already angle-bracket wrapped, but not
// guaranteed trimmed/normalized the same way stored rows are), so normalize
// each one the same way claimMessageLink does before querying — and filter
// empties first since normalizeMessageId throws on an empty string.
export async function findTicketIdsByMessageIds(partnerId: string, messageIds: string[]): Promise<string[]> {
  const normalized = Array.from(
    new Set(
      messageIds
        .filter((id): id is string => !!id && id.trim().length > 0)
        .map((id) => normalizeMessageId(id))
    )
  );
  if (normalized.length === 0) return [];
  const rows = await db
    .selectDistinct({ ticketId: ticketEmailLinks.ticketId })
    .from(ticketEmailLinks)
    .where(and(eq(ticketEmailLinks.partnerId, partnerId), inArray(ticketEmailLinks.messageId, normalized)));
  return rows.map((r) => r.ticketId);
}
