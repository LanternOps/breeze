import { eq, or } from 'drizzle-orm';
import { tickets } from '../../db/schema';

/**
 * "This portal user's own tickets" (#3258 W03).
 *
 * Two ways a ticket can belong to the person sitting in the portal:
 *  - `submitted_by` — they filed it through the portal, with their LOGIN;
 *  - `requester_contact_id` — they are the CONTACT the ticket names, which is
 *    how every emailed ticket is attributed now that inbound mail no longer
 *    mints a password-less login. Without this arm a customer who emails
 *    support and then logs in sees none of their own tickets.
 *
 * The contact arm is added ONLY when the session carries a contact link.
 * `eq(col, null)` compiles to a literal `= NULL`, which is never true — a
 * portal user with no linked contact would get a dead OR arm that reads like a
 * working filter. Omitting it says what is meant and keeps the compiled
 * predicate honest.
 *
 * Its own module rather than a member of `./helpers` on purpose: every portal
 * route suite mocks `./helpers` wholesale, so a predicate living there would be
 * stubbed out of the very tests that exist to assert the compiled WHERE.
 *
 * READ paths only. Comment authoring still keys on `ticket_comments.portal_user_id`:
 * writing as a login is a different claim from being named as the requester.
 */
export function portalTicketOwnership(user: { id: string; contactId?: string | null }) {
  const contactId = user.contactId ?? null;
  return contactId === null
    ? eq(tickets.submittedBy, user.id)
    : or(eq(tickets.submittedBy, user.id), eq(tickets.requesterContactId, contactId))!;
}
