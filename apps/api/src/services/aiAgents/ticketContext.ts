/**
 * Bounded hostile-context assembler for a ticket-triggered agent run (wave 6
 * PR 3, #3828 — Task 4).
 *
 * ## Threat model
 *
 * Ticket content is attacker-controlled: `subject`/`description` arrive
 * unauthenticated from the portal or inbound email, and comments can be
 * posted by any authenticated portal user. This module is the trust boundary
 * between that content and the model's context window — every property below
 * is enforced HERE, not left to the caller:
 *
 *  - **HTML-stripped.** `sanitize-html` with `allowedTags: []` — the model
 *    never sees a raw tag, so it can never be tricked by a
 *    `<system>`/`<operator-guidance>`-shaped fragment smuggled in as ticket
 *    content (see runnerPrompt.ts's header for why that fence matters).
 *  - **PII-excluded.** `submitterEmail`/`submitterName`/`submittedBy`,
 *    `customFields`, `attachments`, and `externalTicketUrl` are never
 *    selected off the `tickets` row at all — there is no field to
 *    accidentally forward. The same applies to comments: `authorName` (for a
 *    portal/email comment, the REQUESTER's own display name) is never
 *    selected either — only `authorType`, a non-identifying role label, is.
 *  - **Agent-note-excluded.** Only comments with `originPrincipalKind =
 *    'user'` are read (see `ticketHelpdeskSubscriber.ts`'s
 *    `HUMAN_ORIGIN_KIND`) — an agent's own prior proposal (were one ever
 *    written back, which this PR does not do) must never feed the next run's
 *    context, which would be a prompt-injection self-loop.
 *  - **Size-bounded.** 8KiB soft target / 12KiB hard ceiling — see
 *    `TICKET_CONTEXT_SOFT_LIMIT_BYTES`/`TICKET_CONTEXT_HARD_LIMIT_BYTES`.
 *
 * `assembleTicketContext` is the pure core (fixture-testable, no DB) that
 * `loadTicketContext` wraps with the actual reads.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import sanitizeHtml from 'sanitize-html';
import { db } from '../../db';
import { tickets, ticketComments } from '../../db/schema/portal';

/** Aim: a typical ticket's context should fit comfortably under this. Not
 *  independently enforced — the hard ceiling below is the real invariant —
 *  but comments/description are trimmed toward it first when both apply. */
export const TICKET_CONTEXT_SOFT_LIMIT_BYTES = 8 * 1024;

/** Never exceeded: `assembleTicketContext` always returns a context whose
 *  subject + description + comment bodies fit under this many UTF-8 bytes. */
export const TICKET_CONTEXT_HARD_LIMIT_BYTES = 12 * 1024;

/** `ticketHelpdeskSubscriber.ts`'s HUMAN_ORIGIN_KIND — duplicated as a literal
 *  rather than imported to avoid coupling this read-only module to the
 *  subscriber's module graph; both are asserted against the same migration
 *  comment / design authority. */
const HUMAN_ORIGIN_KIND = 'user';

/** Oldest-first — a comment is dropped a full CHARS_PER_TRUNCATE_STEP at a
 *  time off the description tail once every comment has already been cut. */
const DESCRIPTION_TRUNCATE_STEP_CHARS = 256;

const TRUNCATION_SUFFIX = '… [truncated]';

export interface TicketContextComment {
  /** `ticket_comments.author_type` ('portal' | 'email' | 'internal' | ...) —
   *  NEVER `authorName`: that column holds the actor's own display name
   *  (for a portal/email comment, the REQUESTER's name), which is exactly
   *  the `submitterName` PII the design authority excludes from context. */
  authorType: string | null;
  content: string;
  createdAt: string;
}

export interface TicketRunContext {
  id: string;
  subject: string;
  description: string | null;
  status: string;
  priority: string;
  category: string | null;
  tags: string[];
  dueDate: string | null;
  /** Oldest first — chronological reading order for the model. */
  comments: TicketContextComment[];
  /** True when comments and/or the description were cut to fit the hard
   *  ceiling — surfaced in the prompt so the model knows the context is
   *  partial rather than silently missing history. */
  truncated: boolean;
}

function stripHtml(input: string | null | undefined): string {
  if (!input) return '';
  return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} }).trim();
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.toISOString();
}

interface RawTicketRow {
  id: string;
  subject: string;
  description: string | null;
  status: string;
  priority: string;
  category: string | null;
  tags: string[] | null;
  dueDate: Date | string | null;
}

interface RawCommentRow {
  authorType: string | null;
  content: string;
  createdAt: Date | string;
}

/**
 * Pure assembly from already-fetched rows. Exported so unit tests can drive
 * every truncation branch deterministically without a DB.
 *
 * `comments` is expected NEWEST-FIRST (what an `ORDER BY created_at DESC
 * LIMIT N` query returns) — this function reverses it to oldest-first before
 * truncating (dropping the OLDEST comment first preserves the most recent,
 * most relevant history) and before returning (chronological order reads
 * naturally in the prompt).
 */
export function assembleTicketContext(args: {
  ticket: RawTicketRow;
  comments: RawCommentRow[];
}): TicketRunContext {
  const subject = stripHtml(args.ticket.subject);
  let description = stripHtml(args.ticket.description);
  const comments: TicketContextComment[] = args.comments
    .slice()
    .reverse()
    .map((c) => ({
      authorType: c.authorType,
      content: stripHtml(c.content),
      createdAt: isoString(c.createdAt) as string,
    }));

  let truncated = false;

  function totalBytes(): number {
    return byteLength(subject) + byteLength(description)
      + comments.reduce((sum, c) => sum + byteLength(c.content), 0);
  }

  // Oldest comment first (index 0, post-reverse) — the design authority's
  // stated order (plan Task 4).
  while (totalBytes() > TICKET_CONTEXT_HARD_LIMIT_BYTES && comments.length > 0) {
    comments.shift();
    truncated = true;
  }
  while (totalBytes() > TICKET_CONTEXT_HARD_LIMIT_BYTES && description.length > 0) {
    description = description.slice(0, Math.max(0, description.length - DESCRIPTION_TRUNCATE_STEP_CHARS));
    truncated = true;
  }
  if (truncated && description) description = `${description}${TRUNCATION_SUFFIX}`;

  return {
    id: args.ticket.id,
    subject,
    description: description || null,
    status: args.ticket.status,
    priority: args.ticket.priority,
    category: args.ticket.category,
    tags: args.ticket.tags ?? [],
    dueDate: isoString(args.ticket.dueDate),
    comments,
    truncated,
  };
}

/** ≤10 per the plan's design authority — plenty for a helpdesk agent's
 *  read-only context, and small enough that the byte ceiling above is the
 *  binding constraint only for unusually long individual comments. */
export const TICKET_CONTEXT_MAX_COMMENTS = 10;

/**
 * DB-touching wrapper. Called from `runLoop.ts`'s `loadRunContext`, which
 * already runs inside a system DB context (see that module's header) — no
 * context management here.
 *
 * Returns `null` when the ticket is missing, soft-deleted (`deletedAt IS NOT
 * NULL` — a ticket removed from every staff/portal surface must not still
 * reach the model), or not (or no longer) in `orgId` — same "moved/deleted
 * reads as absent" posture `loadRunContext` already applies to `device`/
 * `alert`.
 */
export async function loadTicketContext(ticketId: string, orgId: string): Promise<TicketRunContext | null> {
  const [ticketRow] = await db
    .select({
      id: tickets.id,
      subject: tickets.subject,
      description: tickets.description,
      status: tickets.status,
      priority: tickets.priority,
      category: tickets.category,
      tags: tickets.tags,
      dueDate: tickets.dueDate,
    })
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)))
    .limit(1);
  if (!ticketRow) return null;

  // Human, public, non-deleted comments only — see this module's header.
  // NOTE: authorType (a role label), never authorName — see
  // `TicketContextComment`'s docstring for why that column is excluded.
  const commentRows = await db
    .select({
      authorType: ticketComments.authorType,
      content: ticketComments.content,
      createdAt: ticketComments.createdAt,
    })
    .from(ticketComments)
    .where(and(
      eq(ticketComments.ticketId, ticketId),
      eq(ticketComments.isPublic, true),
      eq(ticketComments.originPrincipalKind, HUMAN_ORIGIN_KIND),
      isNull(ticketComments.deletedAt),
    ))
    .orderBy(desc(ticketComments.createdAt))
    .limit(TICKET_CONTEXT_MAX_COMMENTS);

  return assembleTicketContext({ ticket: ticketRow as RawTicketRow, comments: commentRows as RawCommentRow[] });
}
