import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { ticketEmailInbound } from '../../db/schema/emailInbound';
import { normalizeReplyTo } from './replyTo';

/**
 * The address customer mail about a ticket goes to (email-first replies W1,
 * Refs #8758): the Reply-To stored at ingest on the ticket's creating inbound
 * row, else `submitterEmail` (the message's From).
 *
 * The creating row is the earliest `parse_status = 'created'` row for this
 * ticket and partner whose `from_address` is the submitter. So:
 *  - a later follow-up's Reply-To never changes the address (follow-ups log
 *    'matched', never 'created');
 *  - a ticket that did not start as email (portal, technician, API) has no
 *    creating row and is answered at `submitterEmail`;
 *  - a staff edit of `submitterEmail` wins, because the row's From no longer
 *    matches it.
 * The stored value is re-checked with the same parser ingest used.
 *
 * `submitterEmail` stays the requester's identity everywhere else; this is
 * only the delivery address. The worker runs in system context, so the
 * partner scope here is the tenant boundary. Errors propagate: the notify job
 * retries rather than mailing a guessed address.
 */
export async function requesterReplyAddress(ticket: {
  id: string;
  partnerId: string | null;
  submitterEmail: string | null;
}): Promise<string | null> {
  const submitter = ticket.submitterEmail?.trim();
  if (!submitter) return null;
  if (!ticket.partnerId) return submitter;

  const rows = await db
    .select({ replyToAddress: ticketEmailInbound.replyToAddress })
    .from(ticketEmailInbound)
    .where(and(
      eq(ticketEmailInbound.ticketId, ticket.id),
      eq(ticketEmailInbound.partnerId, ticket.partnerId),
      eq(ticketEmailInbound.parseStatus, 'created'),
      sql`lower(${ticketEmailInbound.fromAddress}) = ${submitter.toLowerCase()}`,
    ))
    .orderBy(asc(ticketEmailInbound.createdAt), asc(ticketEmailInbound.id))
    .limit(1);

  return normalizeReplyTo(rows[0]?.replyToAddress ?? undefined) ?? submitter;
}
