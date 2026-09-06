import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { db } from '../../db';
import { tickets } from '../../db/schema';
import { findTicketIdsByMessageIds } from '../ticketEmailLinks';

// Per-partner ticket display number, e.g. T-2026-0001.
export const TICKET_TOKEN_RE = /\bT-(\d{4})-(\d{4,})\b/;

// Shared shape consumed by the live/closed thread matchers. A NormalizedInboundEmail
// structurally satisfies this (it carries these four fields plus more) — callers pass
// it through directly without adapting it.
export interface ThreadMatchInput {
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string[] | null;
  subject?: string | null;
  from?: string | null;
}

export interface MatchedTicket {
  id: string;
  partnerId: string | null;
  orgId: string;
  status: string;
  emailThreadKey: string | null;
  internalNumber: string | null;
  submittedBy: string | null;
  submitterEmail: string | null;
}

const MATCH_COLS = {
  id: tickets.id,
  partnerId: tickets.partnerId,
  orgId: tickets.orgId,
  status: tickets.status,
  emailThreadKey: tickets.emailThreadKey,
  internalNumber: tickets.internalNumber,
  submittedBy: tickets.submittedBy,
  submitterEmail: tickets.submitterEmail
};

// Lazy, memoized sender-identity lookups, provided by the caller. Only the
// UNAUTHENTICATED inbound-email path supplies one (see senderIsBoundToTicket);
// authenticated callers (Office add-in: a partner-scoped tech) omit it and get
// pure partner-scoped matching.
export interface SenderResolver {
  // `contactId` (#3258 W03) is the person behind the LOGIN. Carried here rather
  // than re-read at the create path so the one portal_users lookup this
  // resolver memoises answers both "who is the sender" and "can the ticket be
  // attributed to a person".
  portalUser(): Promise<{ id: string; orgId: string; name: string | null; contactId: string | null } | null>;
  domainOrg(): Promise<{ orgId: string; autoCreateContact: boolean } | null>;
}

/**
 * Bind a subject-token (ticket-number) match to the sender (#3643). Ticket numbers
 * are sequential and enumerable and the token path carries no org predicate, so
 * without this ANY authenticated-domain sender could append a public comment to
 * another customer org's ticket (and reopen it). The thread-key path is
 * unguessable and needs no binding.
 */
export async function senderIsBoundToTicket(
  from: string,
  ticket: MatchedTicket,
  sender: SenderResolver
): Promise<boolean> {
  if (ticket.submitterEmail && ticket.submitterEmail.trim().toLowerCase() === from.trim().toLowerCase()) {
    return true;
  }

  const pu = await sender.portalUser();
  if (pu && (pu.orgId === ticket.orgId || pu.id === ticket.submittedBy)) return true;

  const dom = await sender.domainOrg();
  return !!dom && dom.orgId === ticket.orgId;
}

// Candidate threading keys: In-Reply-To + every References entry (a reply's parent
// can be anywhere in the References chain), deduped.
export function candidateThreadKeys(input: ThreadMatchInput): string[] {
  return Array.from(new Set([input.inReplyTo, ...(input.references ?? [])].filter(Boolean) as string[]));
}

// (3) Thread-match within the resolved partner. BOTH queries carry an explicit
// partner_id predicate (spec §6 layer 1) — ticket numbers are per-partner sequences, so an
// unscoped token match would hit the wrong tenant.
//
// CLOSED tickets are EXCLUDED (`ne(status,'closed')`): a closed→new-linked continuation
// is stamped with the SAME email_thread_key as its closed original (no unique constraint
// on that column), so an unordered LIMIT 1 could otherwise re-return the closed original
// and fork the thread into N tickets. Excluding closed here makes a reply to a closed
// ticket fall through to the dedicated closed lookup (-> ONE new linked ticket), while
// subsequent replies match the LIVE continuation. Resolved tickets still match (reopen).
export async function findTicketInPartner(
  input: ThreadMatchInput,
  partnerId: string,
  sender?: SenderResolver
): Promise<MatchedTicket | null> {
  // 1) thread headers -> email_thread_key OR email_message_id (scoped to partner,
  // live tickets only). Candidate keys (In-Reply-To ∪ References) are matched
  // against EITHER column: email_thread_key carries the generated anchor (so a
  // reply to the autoresponse / outbound reply threads), and email_message_id
  // carries the customer's OWN original Message-Id (so an autoresponder-OFF
  // partner's customer replying to their own original — In-Reply-To = their
  // original Message-Id, NOT the anchor — still threads instead of forking a
  // duplicate). The partner predicate stays mandatory (spec §6 layer 1).
  const candidateKeys = candidateThreadKeys(input);
  if (candidateKeys.length > 0) {
    // Link-table widening (Task 4): a claimed ticket_email_links row for one of the
    // candidate keys is an EXTRA OR arm on top of the existing header match — never a
    // replacement for the status/deleted_at guards below, so a link row can never
    // re-enable appending to a closed or soft-deleted ticket.
    const linkTicketIds = await findTicketIdsByMessageIds(partnerId, candidateKeys);
    const rows = await db
      .select(MATCH_COLS)
      .from(tickets)
      .where(and(
        eq(tickets.partnerId, partnerId),
        ne(tickets.status, 'closed'),
        isNull(tickets.deletedAt), // never thread a reply onto a soft-deleted ticket
        or(
          inArray(tickets.emailThreadKey, candidateKeys),
          inArray(tickets.emailMessageId, candidateKeys),
          ...(linkTicketIds.length > 0 ? [inArray(tickets.id, linkTicketIds)] : [])
        )
      ))
      .limit(1);
    if (rows[0]) return rows[0] as MatchedTicket;
  }

  // 2) subject token [T-YYYY-NNNN] (scoped to partner, live tickets only)
  const m = (input.subject ?? '').match(TICKET_TOKEN_RE);
  if (m) {
    const rows = await db
      .select(MATCH_COLS)
      .from(tickets)
      .where(and(
        eq(tickets.partnerId, partnerId),
        ne(tickets.status, 'closed'),
        isNull(tickets.deletedAt),
        eq(tickets.internalNumber, m[0])
      ))
      .limit(1);
    const row = rows[0] as MatchedTicket | undefined;
    if (row) {
      // The token is enumerable, so when the caller is unauthenticated (a sender
      // resolver is supplied) require proof that this sender belongs to the ticket.
      if (sender && !(await senderIsBoundToTicket(input.from ?? '', row, sender))) return null;
      return row;
    }
  }

  return null;
}

// Looks up the CLOSED original for a reply, by the same thread-key / subject-token
// signals findTicketInPartner uses — but matching ONLY closed tickets. Used to spawn a
// single new linked ticket when a customer replies to a closed thread. Kept separate from
// findTicketInPartner (which returns live tickets only) so the closed original is never
// re-matched for an append. Still partner-scoped (spec §6 layer 1).
export async function findClosedTicketInPartner(
  input: ThreadMatchInput,
  partnerId: string,
  sender?: SenderResolver
): Promise<MatchedTicket | null> {
  const candidateKeys = candidateThreadKeys(input);
  if (candidateKeys.length > 0) {
    // Link-table widening (Task 4): same additive OR arm as the live matcher, but
    // gated on status = 'closed' here — a link row only ever surfaces a ticket
    // that is ALREADY closed via this path, never re-opens/re-matches a live one.
    const linkTicketIds = await findTicketIdsByMessageIds(partnerId, candidateKeys);
    const rows = await db
      .select(MATCH_COLS)
      .from(tickets)
      .where(and(
        eq(tickets.partnerId, partnerId),
        eq(tickets.status, 'closed'),
        isNull(tickets.deletedAt), // a deleted closed original must not spawn a continuation
        // Header match here is INTENTIONALLY email_thread_key ONLY (not OR'd with
        // email_message_id like the live matcher). email_message_id carries the
        // customer's own original Message-Id, which a live continuation ticket does
        // NOT carry — only the closed original does. Matching it here would let a
        // reply that has already matched (and appended to) a live continuation ALSO
        // re-match the closed original on every subsequent reply, which is exactly
        // the fork this function exists to prevent.
        or(
          inArray(tickets.emailThreadKey, candidateKeys),
          ...(linkTicketIds.length > 0 ? [inArray(tickets.id, linkTicketIds)] : [])
        )
      ))
      .limit(1);
    if (rows[0]) return rows[0] as MatchedTicket;
  }

  const m = (input.subject ?? '').match(TICKET_TOKEN_RE);
  if (m) {
    const rows = await db
      .select(MATCH_COLS)
      .from(tickets)
      .where(and(
        eq(tickets.partnerId, partnerId),
        eq(tickets.status, 'closed'),
        isNull(tickets.deletedAt),
        eq(tickets.internalNumber, m[0])
      ))
      .limit(1);
    const row = rows[0] as MatchedTicket | undefined;
    if (row) {
      // The token is enumerable, so when the caller is unauthenticated (a sender
      // resolver is supplied) require proof that this sender belongs to the ticket.
      if (sender && !(await senderIsBoundToTicket(input.from ?? '', row, sender))) return null;
      return row;
    }
  }

  return null;
}
