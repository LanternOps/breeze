import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { portalUsers } from '../../db/schema/portal';
import { linkLoginToContact, type LoginContactOutcome } from '../contacts/loginLink';
import type { ContactActor } from '../contacts/crud';

/**
 * Resolve the Outlook tech add-in's "create contact" requester option to the
 * org's CONTACT for that address, creating one when the org has none
 * (spec §3.2, Task 16; repointed onto `contacts` by the #3258 follow-up).
 *
 * ── Why this no longer mints a `portal_users` row ───────────────────────────
 * It used to insert a password-less LOGIN so the ticket route could set
 * `tickets.submitted_by`. Under #3258 `contacts` is the person and
 * `portal_users` is a login attached to one, minted only where portal access is
 * actually granted — and the add-in grants none. The old row was write-only:
 * its single consumer was `submitted_by`, and it cost three real things.
 *
 *   1. The customer could not see their own ticket. `portalTicketOwnership`
 *      matches `submitted_by = me OR requester_contact_id = my contact`; the
 *      orphan login had `contact_id` NULL, so neither arm could ever match a
 *      login the customer actually holds.
 *   2. Identity split by channel. The same human emailing support got a
 *      `contacts` row from ingest and a `portal_users` row from the pane — two
 *      records for one person in one org.
 *   3. The orphan was undeletable: `hasPortalUserReferences` pins it forever
 *      through the ticket FK.
 *
 * `createTicket` already accepts `requesterContactId`, validates it same-org
 * before allocating a ticket number, and backfills the name/email snapshot from
 * the contact when there is no login — so nothing downstream needed a login.
 * `ticket_comments.portal_user_id` and the notify worker both already tolerate
 * its absence (the worker keys on `submitter_email` alone).
 *
 * ── Why it is still its own entry point ─────────────────────────────────────
 * Deliberately NOT `inboundEmail/resolveOrg.resolveEmailRequester`: that one is
 * an ingest side effect on the poller path, in a system context with no acting
 * user. This is a TECHNICIAN-CONFIRMED action inside a request — the tech
 * explicitly chose "create a contact for this sender" — so it runs under the
 * caller's partner-scope RLS context and stamps the technician as
 * `contacts.created_by`. It grants the `portal` role for the same reason the
 * invite does: the tech has named this person as the ticket's requester.
 *
 * Both paths share `linkLoginToContact`, so both take the SAME advisory lock on
 * the same (org, address) key — a tech confirming a sender while that sender's
 * first email is being ingested cannot produce two contacts.
 */
export async function resolveConfirmedContact(
  orgId: string,
  input: { email: string; name?: string | null },
  actor: ContactActor
): Promise<{ contactId: string | null; outcome: LoginContactOutcome }> {
  return linkLoginToContact(db, {
    orgId,
    email: input.email,
    name: input.name ?? null,
    actor,
  });
}

/**
 * Look up (never create) the portal user a sender address resolves to within
 * ONE org, for Task 17's link-email route. Mirrors
 * `inboundEmailService.findPortalUserInPartner` but org-scoped (the caller
 * already has the target ticket's org) rather than partner-scoped, and read-only
 * — linking an email to an existing ticket is not licensed to mint a contact,
 * unlike `createConfirmedContact` above which is a technician-confirmed action.
 */
export async function findPortalUserByEmail(
  orgId: string,
  email: string
): Promise<{ id: string; name: string | null } | null> {
  const lower = email.trim().toLowerCase();
  const rows = await db
    .select({ id: portalUsers.id, name: portalUsers.name })
    .from(portalUsers)
    .where(and(eq(portalUsers.orgId, orgId), eq(portalUsers.email, lower)))
    .limit(1);
  return rows[0] ?? null;
}
