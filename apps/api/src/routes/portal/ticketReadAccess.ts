import { and, isNull, or, sql } from 'drizzle-orm';
import { tickets } from '../../db/schema';
import { portalTicketOwnership } from './ticketOwnership';

/**
 * "Tickets this portal user may READ" (#8972, decision D1(b), spec §6.1).
 *
 * Ownership (portalTicketOwnership) OR "the survivor of a merged ticket this
 * user owns": when a technician merges the user's request into another ticket,
 * the user keeps public read — and public reply — on the survivor, the same
 * thread their email replies already reach (§3.8). The survivor arm keys on the
 * TOMBSTONE's requester (`t2.submitted_by` / `t2.requester_contact_id`), never
 * on the survivor's, and only through a one-hop `merged_into_ticket_id`
 * (merge compresses paths, so a tombstone always names a live ticket).
 *
 * WHAT THIS DOES NOT WIDEN. Portal reads still show public comments only, so
 * internal notes — including the merge's copy of the source description —
 * stay hidden. Writes keep portalTicketOwnership; the one exception is the
 * public comment POST, which D1(b) grants explicitly. Comment edit/delete keep
 * their author check (ticket_comments.portal_user_id) and approvals their own
 * approver checks.
 *
 * Callers still AND it with the org and not-deleted filters, exactly as with
 * portalTicketOwnership; the subquery runs on the caller's (portal RLS)
 * connection.
 */
export function portalTicketReadAccess(user: { id: string; contactId: string | null }) {
  // `== null` for the same reason as portalTicketOwnership: an `= NULL` arm is
  // never true and reads like a working filter.
  const ownsTombstone = user.contactId == null
    ? sql`t2.submitted_by = ${user.id}::uuid`
    : sql`(t2.submitted_by = ${user.id}::uuid OR t2.requester_contact_id = ${user.contactId}::uuid)`;
  return or(
    portalTicketOwnership(user),
    // A soft-deleted tombstone grants nothing (deleting the request revokes
    // the access it carried), and the grant never crosses orgs (the composite
    // FK already pins a tombstone to its survivor's org; defence in depth).
    sql`${tickets.id} IN (
      SELECT t2.merged_into_ticket_id FROM tickets t2
       WHERE t2.merged_into_ticket_id IS NOT NULL
         AND t2.deleted_at IS NULL
         AND t2.org_id = ${tickets.orgId}
         AND ${ownsTombstone})`,
  )!;
}

/**
 * The portal dashboard's ticket set (#8972): what the ticket list shows — own
 * tickets and the survivors of merged ones — never a tombstone. Shared by the
 * portal dashboard and the staff "view as customer" preview so the two stay
 * equal (orgPortalPreview parity test).
 */
export function portalDashboardTicketScope(user: { id: string; contactId: string | null }) {
  return and(portalTicketReadAccess(user), isNull(tickets.mergedIntoTicketId))!;
}
