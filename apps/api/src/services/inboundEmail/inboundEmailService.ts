import { and, eq, inArray, ne } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { ticketEmailInbound, tickets, ticketComments, portalUsers, organizations, partners } from '../../db/schema';
import { createTicket } from '../ticketService';
import { resolvePartnerByRecipient } from './resolvePartner';
import { emitTicketEvent } from '../ticketEvents';
import { captureException } from '../sentry';
import type { NormalizedInboundEmail, InboundParseStatus } from './types';

// Synthetic actor for the inbound pipeline. Only ever written to audit_logs.actor_id
// (NOT NULL, but no FK to users — same pattern as auditEvents.ANONYMOUS_ACTOR_ID /
// notificationDispatcher). createTicket does NOT write actor.userId to any tickets FK
// column. The resolved-ticket reopen is performed as a direct partner-scoped UPDATE here
// (NOT via changeTicketStatus) precisely because changeTicketStatus inserts a
// ticket_comments row with user_id = actor.userId, and ticket_comments.user_id IS FK'd to
// users(id) — a synthetic id would FK-violate at runtime. The direct UPDATE keeps the
// reopen FK-safe while honoring the partner re-assertion guard.
const SYSTEM_ACTOR = { userId: '00000000-0000-0000-0000-000000000000', name: 'Inbound Email' };

// Per-partner ticket display number, e.g. T-2026-0001.
const TOKEN_RE = /\bT-(\d{4})-(\d{4,})\b/;

async function logInbound(
  n: NormalizedInboundEmail,
  partnerId: string | null,
  parseStatus: InboundParseStatus,
  ticketId: string | null,
  error?: string
): Promise<void> {
  // partnerId is intentionally null for the `ignored` path (recipient resolves to no
  // partner). ticket_email_inbound.partner_id is nullable; under system scope a null
  // partner is write-permitted, and partner-scope reads can never see it. NO sentinel.
  await db.insert(ticketEmailInbound).values({
    partnerId,
    provider: n.provider,
    providerMessageId: n.providerMessageId,
    fromAddress: n.from,
    toAddress: n.to,
    subject: n.subject,
    messageId: n.messageId ?? null,
    inReplyTo: n.inReplyTo ?? null,
    references: n.references?.join(' ') ?? null,
    parseStatus,
    ticketId,
    error: error ?? null,
    raw: n.raw
  });
}

// Durable `failed` logging that SURVIVES a poisoned outer transaction.
//
// The worker wraps the entire `processInboundEmail` in ONE Postgres transaction
// (`withSystemDbAccessContext` -> `withDbAccessContext` -> `baseDb.transaction`,
// db/index.ts:107). When a DB write inside the try fails, that tx enters the
// aborted state (25P02) — every subsequent statement on it errors out, so a
// `logInbound('failed')` issued on the SAME tx would also throw and roll back,
// committing NO terminal row (the provider already 202'd, so the message vanishes).
//
// `runOutsideDbContext` clears the AsyncLocalStorage DB context, so the inner
// `withSystemDbAccessContext` resolves `db` back to `baseDb` (the pool) and opens
// a BRAND-NEW transaction on a FRESH pooled connection — fully independent of the
// poisoned outer tx, which is still aborted on its own connection. This insert
// therefore commits even though the outer tx will roll back its partial writes.
async function logInboundFailedDurable(
  n: NormalizedInboundEmail,
  partnerId: string | null,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.insert(ticketEmailInbound).values({
          partnerId,
          provider: n.provider,
          providerMessageId: n.providerMessageId,
          fromAddress: n.from,
          toAddress: n.to,
          subject: n.subject,
          messageId: n.messageId ?? null,
          inReplyTo: n.inReplyTo ?? null,
          references: n.references?.join(' ') ?? null,
          parseStatus: 'failed' as InboundParseStatus,
          ticketId: null,
          error: message,
          raw: n.raw
        })
      )
    );
  } catch (logErr) {
    // A 23505 here means a concurrent retry already logged the failed row (the
    // (partner_id, provider_message_id) unique index) — or any other write error.
    // A failure to LOG must never crash the worker; record it and swallow.
    captureException(logErr instanceof Error ? logErr : new Error(String(logErr)));
  }
}

export async function processInboundEmail(n: NormalizedInboundEmail): Promise<void> {
  // partnerId is tracked outside the try so the durable-failed log records whatever
  // tenant was resolved before the failure (may be null if resolution itself failed).
  let partnerId: string | null = null;
  try {
    // (1) Tenant identity is established ONLY from the recipient. Sender data is untrusted.
    // Resolution runs INSIDE the try so a failure here still routes to the durable
    // failed-log instead of escaping (and being silently retried / lost).
    partnerId = await resolvePartnerByRecipient(n.to);
    if (!partnerId) {
      // Distinguish a malformed/empty recipient (no `@`, can never resolve) from a
      // well-formed address for a domain we simply don't host. Both log `ignored`,
      // but the malformed case carries an explanatory note so the audit row is
      // self-describing (FIX 4).
      const malformed = !n.to || !n.to.includes('@');
      await logInbound(n, null, 'ignored', null, malformed ? 'malformed/empty recipient' : undefined);
      return;
    }

    // (1b) Gate ingestion on partner status = active. A suspended/pending/churned
    // partner must not generate or mutate tickets, but we STILL log the inbound row
    // (parse_status: 'skipped') to preserve the audit trail.
    const partnerRow = await db
      .select({ status: partners.status })
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1);
    const status = partnerRow[0]?.status;
    if (status !== 'active') {
      await logInbound(n, partnerId, 'skipped', null, `partner ${partnerId} status=${status ?? 'unknown'}`);
      return;
    }

    // (2) Idempotency — provider retries / at-least-once delivery. Scoped to the partner.
    // This SELECT alone is NOT the exactly-once guarantee: under CONCURRENT delivery two
    // workers can both miss the dup here and race to insert. Exactly-once is enforced by the
    // `(partner_id, provider_message_id)` UNIQUE index combined with the surrounding
    // `withSystemDbAccessContext` transaction — the losing insert hits 23505, its transaction
    // rolls back, BullMQ retries the job, and the retry's dedup SELECT then finds the row the
    // winner committed and returns early. This SELECT is the fast path; the index is the lock.
    const dup = await db
      .select({ id: ticketEmailInbound.id })
      .from(ticketEmailInbound)
      .where(and(
        eq(ticketEmailInbound.partnerId, partnerId),
        eq(ticketEmailInbound.providerMessageId, n.providerMessageId)
      ))
      .limit(1);
    if (dup[0]) return;

    const matched = await findTicketInPartner(n, partnerId);
    if (matched) {
      // GUARD (spec §6 layer 2): never act across partners. A partner-scoped match query
      // should already make this impossible, but re-assert before ANY write and throw
      // (-> failed) rather than risk a silent cross-tenant append. `findTicketInPartner`
      // only returns LIVE (non-closed) tickets, so this never sees a closed original.
      if (matched.partnerId !== partnerId) {
        throw new Error(`cross-partner match: ticket ${matched.id} (partner ${matched.partnerId}) for resolved partner ${partnerId}`);
      }

      // Append a public inbound comment, then reopen if resolved.
      await appendInboundComment(matched.id, n, partnerId);
      if (matched.status === 'resolved') {
        await reopenResolvedTicket(matched.id, partnerId);
      }
      await logInbound(n, partnerId, 'matched', matched.id);
      return;
    }

    // No LIVE thread match. A reply to a CLOSED ticket is immutable -> create a NEW
    // linked ticket carrying the original thread key. This lookup is intentionally
    // SEPARATE from findTicketInPartner (which excludes closed) so the live-continuation
    // it spawns is what future replies match — the closed original is never re-matched,
    // which is what prevents a thread from forking into N tickets (FIX 2).
    const closedOriginal = await findClosedTicketInPartner(n, partnerId);
    if (closedOriginal) {
      const t = await createFromEmail(n, partnerId, closedOriginal.orgId, closedOriginal.emailThreadKey, closedOriginal.internalNumber);
      await logInbound(n, partnerId, 'created', t.id);
      return;
    }

    // (5)/(6) Unmatched: known portal-user sender -> create; unknown -> quarantine.
    const sender = await findPortalUserInPartner(n.from, partnerId);
    if (!sender) {
      await logInbound(n, partnerId, 'quarantined', null);
      return;
    }
    const t = await createFromEmail(n, partnerId, sender.orgId, null, null, sender.id);
    await logInbound(n, partnerId, 'created', t.id);
  } catch (err) {
    // (7) Any guard/error -> failed, logged under the RESOLVED partner (or null if
    // resolution failed). Never a cross-tenant write.
    //
    // The outer work transaction is now poisoned (25P02): we CANNOT log on it. Record
    // the terminal `failed` row in a FRESH transaction (logInboundFailedDurable) so it
    // survives the rollback. Then RETURN (swallow) so the outer tx rolls back its partial
    // writes and BullMQ does NOT retry — the durable `failed` row is the terminal record
    // surfaced by the review queue.
    captureException(err instanceof Error ? err : new Error(String(err)));
    await logInboundFailedDurable(n, partnerId, err);
  }
}

interface MatchedTicket {
  id: string;
  partnerId: string | null;
  orgId: string;
  status: string;
  emailThreadKey: string | null;
  internalNumber: string | null;
}

const MATCH_COLS = {
  id: tickets.id,
  partnerId: tickets.partnerId,
  orgId: tickets.orgId,
  status: tickets.status,
  emailThreadKey: tickets.emailThreadKey,
  internalNumber: tickets.internalNumber
};

// Candidate threading keys: In-Reply-To + every References entry (a reply's parent
// can be anywhere in the References chain), deduped.
function candidateThreadKeys(n: NormalizedInboundEmail): string[] {
  return Array.from(new Set([n.inReplyTo, ...(n.references ?? [])].filter(Boolean) as string[]));
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
async function findTicketInPartner(n: NormalizedInboundEmail, partnerId: string): Promise<MatchedTicket | null> {
  // 1) thread headers -> email_thread_key (scoped to partner, live tickets only).
  const candidateKeys = candidateThreadKeys(n);
  if (candidateKeys.length > 0) {
    const rows = await db
      .select(MATCH_COLS)
      .from(tickets)
      .where(and(
        eq(tickets.partnerId, partnerId),
        ne(tickets.status, 'closed'),
        inArray(tickets.emailThreadKey, candidateKeys)
      ))
      .limit(1);
    if (rows[0]) return rows[0] as MatchedTicket;
  }

  // 2) subject token [T-YYYY-NNNN] (scoped to partner, live tickets only)
  const m = n.subject.match(TOKEN_RE);
  if (m) {
    const rows = await db
      .select(MATCH_COLS)
      .from(tickets)
      .where(and(
        eq(tickets.partnerId, partnerId),
        ne(tickets.status, 'closed'),
        eq(tickets.internalNumber, m[0])
      ))
      .limit(1);
    if (rows[0]) return rows[0] as MatchedTicket;
  }

  return null;
}

// Looks up the CLOSED original for a reply, by the same thread-key / subject-token
// signals findTicketInPartner uses — but matching ONLY closed tickets. Used to spawn a
// single new linked ticket when a customer replies to a closed thread. Kept separate from
// findTicketInPartner (which returns live tickets only) so the closed original is never
// re-matched for an append. Still partner-scoped (spec §6 layer 1).
async function findClosedTicketInPartner(n: NormalizedInboundEmail, partnerId: string): Promise<MatchedTicket | null> {
  const candidateKeys = candidateThreadKeys(n);
  if (candidateKeys.length > 0) {
    const rows = await db
      .select(MATCH_COLS)
      .from(tickets)
      .where(and(
        eq(tickets.partnerId, partnerId),
        eq(tickets.status, 'closed'),
        inArray(tickets.emailThreadKey, candidateKeys)
      ))
      .limit(1);
    if (rows[0]) return rows[0] as MatchedTicket;
  }

  const m = n.subject.match(TOKEN_RE);
  if (m) {
    const rows = await db
      .select(MATCH_COLS)
      .from(tickets)
      .where(and(
        eq(tickets.partnerId, partnerId),
        eq(tickets.status, 'closed'),
        eq(tickets.internalNumber, m[0])
      ))
      .limit(1);
    if (rows[0]) return rows[0] as MatchedTicket;
  }

  return null;
}

// (4) Sender -> portal user, scoped to the resolved partner via the org->partner join.
// portal_users has no partner_id; a same-email user under a DIFFERENT partner must not match.
async function findPortalUserInPartner(email: string, partnerId: string): Promise<{ id: string; orgId: string } | null> {
  const rows = await db
    .select({ id: portalUsers.id, orgId: portalUsers.orgId })
    .from(portalUsers)
    .innerJoin(organizations, eq(portalUsers.orgId, organizations.id))
    .where(and(eq(portalUsers.email, email.toLowerCase()), eq(organizations.partnerId, partnerId)))
    .limit(1);
  return rows[0] ?? null;
}

async function createFromEmail(
  n: NormalizedInboundEmail,
  partnerId: string,
  orgId: string,
  carryThreadKey: string | null,
  priorNumber: string | null,
  submittedBy?: string
) {
  // GUARD (spec §6 layer 2): the resolved org MUST belong to the resolved partner before create.
  const orgOk = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), eq(organizations.partnerId, partnerId)))
    .limit(1);
  if (!orgOk[0]) throw new Error(`org ${orgId} not in partner ${partnerId}`);

  const description = priorNumber ? `Re: ${priorNumber} (continued)\n\n${n.text}` : n.text;
  const ticket = await createTicket(
    {
      orgId,
      subject: n.subject.replace(TOKEN_RE, '').trim() || '(no subject)',
      description,
      source: 'email',
      submitterEmail: n.from,
      submitterName: n.fromName,
      submittedBy
    },
    SYSTEM_ACTOR
  );

  // Stamp the threading key so future replies match. Carry the old key for closed-continuations.
  await db.update(tickets)
    .set({ emailThreadKey: carryThreadKey ?? n.messageId ?? null })
    .where(eq(tickets.id, ticket.id));
  return ticket;
}

async function appendInboundComment(ticketId: string, n: NormalizedInboundEmail, partnerId: string): Promise<void> {
  // Inserted directly (NOT via addTicketComment, which forces authorType:'internal' /
  // user_id=actor). Under system scope the ticket_comments INSERT policy permits user_id IS
  // NULL. Email-sourced comments are ALWAYS public (spec §4: email can never create an internal note).
  const sender = await findPortalUserInPartner(n.from, partnerId);
  const inserted = await db.insert(ticketComments).values({
    ticketId,
    userId: null,
    portalUserId: sender?.id ?? null,
    authorName: n.fromName ?? n.from,
    authorType: 'email',
    commentType: 'comment',
    content: n.text,
    isPublic: true,
    oldValue: null,
    newValue: null
  }).returning();
  const comment = inserted[0];
  if (!comment) throw new Error('failed to insert inbound comment');

  // inbound:true -> the notify worker's live guard (ticketNotifyWorker.ts:205-207 reads
  // `!event.payload.inbound`) skips echoing the email back to the sender, preventing a loop.
  await emitTicketEvent({
    type: 'ticket.commented',
    ticketId,
    orgId: '',
    partnerId,
    actorUserId: null,
    payload: { commentId: comment.id, isPublic: true, inbound: true }
  });
}

// Reopen a resolved ticket via a direct partner-scoped UPDATE (FK-safe — see SYSTEM_ACTOR note).
// The partner_id predicate is a defense-in-depth re-assertion: even though the matched ticket
// was already partner-checked, the write itself is bounded to the resolved partner.
async function reopenResolvedTicket(ticketId: string, partnerId: string): Promise<void> {
  await db.update(tickets)
    .set({ status: 'open', resolvedAt: null, updatedAt: new Date() })
    .where(and(eq(tickets.id, ticketId), eq(tickets.partnerId, partnerId), eq(tickets.status, 'resolved')));
}
