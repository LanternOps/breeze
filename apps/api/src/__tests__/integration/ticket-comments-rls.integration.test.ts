/**
 * ticket_comments RLS — portal-comment visibility through the parent ticket.
 *
 * Migration under test: 2026-06-10-a-ticket-comments-portal-visibility.sql
 *
 * The Phase 6 user-scoped policy (2026-04-11-bucket-c-phase-6-user-scoped-rls.sql)
 * only exposed `user_id IS NULL` rows (portal-user-authored comments) to
 * system scope, so the technician detail endpoint (GET /tickets/:id)
 * silently dropped every customer reply under org/partner scope. The new
 * `breeze_ticket_parent_select` policy ORs in visibility for any comment
 * whose parent ticket is org-accessible.
 *
 * These tests run through the REAL postgres.js driver (db pool connects as
 * the unprivileged breeze_app role) with a BOUND ticket-id parameter, on
 * purpose: the #1016→#1026 bug class made EXISTS-join policies pass in psql
 * but fail under postgres.js bound parameters. tickets.org_id is NOT NULL
 * and the tickets SELECT policy has no OR branches, so the join is expected
 * to be safe — this suite is the proof.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { ticketComments, tickets, portalUsers } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

/**
 * Seeds (as the privileged test role, bypassing RLS):
 *   partner → org → ticket
 *     ├── staff comment   (user_id = partner-level technician, org_id NULL)
 *     └── portal comment  (portal_user_id set, user_id NULL)
 *
 * The technician is deliberately partner-level (org_id NULL) so that under
 * ORGANIZATION scope the Phase 6 users-join branch grants nothing for the
 * staff comment either — both rows must come back via the new
 * ticket-parent branch alone.
 */
async function seedTicketWithMixedComments() {
  const adminDb = getTestDb() as any;
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const tech = await createUser({
    partnerId: partner.id,
    orgId: null, // MSP staff — partner axis only
    email: `tc-rls-tech-${unique}@example.test`,
  });

  const [portalUser] = await adminDb
    .insert(portalUsers)
    .values({
      orgId: org.id,
      email: `tc-rls-portal-${unique}@example.test`,
      name: 'Portal Customer',
    })
    .returning();

  const [ticket] = await adminDb
    .insert(tickets)
    .values({
      orgId: org.id,
      partnerId: partner.id,
      ticketNumber: `TC-RLS-${unique}`,
      subject: 'ticket_comments RLS visibility test',
      submittedBy: portalUser.id,
      source: 'portal',
    })
    .returning();

  const [staffComment] = await adminDb
    .insert(ticketComments)
    .values({
      ticketId: ticket.id,
      userId: tech.id,
      authorType: 'technician',
      content: 'staff reply',
    })
    .returning();

  const [portalComment] = await adminDb
    .insert(ticketComments)
    .values({
      ticketId: ticket.id,
      portalUserId: portalUser.id,
      authorType: 'portal',
      content: 'customer reply',
    })
    .returning();

  return { partner, org, tech, portalUser, ticket, staffComment, portalComment };
}

/** Mirrors the comments query in GET /tickets/:id (bound ticket-id param). */
function selectCommentsByTicketId(ticketId: string) {
  return db
    .select({
      id: ticketComments.id,
      userId: ticketComments.userId,
      portalUserId: ticketComments.portalUserId,
      content: ticketComments.content,
    })
    .from(ticketComments)
    .where(eq(ticketComments.ticketId, ticketId))
    .orderBy(asc(ticketComments.createdAt));
}

describe('ticket_comments RLS — parent-ticket visibility (2026-06-10-a migration)', () => {
  it('partner scope sees both staff and portal comments through a bound ticket-id parameter', async () => {
    const { partner, org, tech, ticket, staffComment, portalComment } =
      await seedTicketWithMixedComments();

    const partnerContext: DbAccessContext = {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [org.id],
      accessiblePartnerIds: [partner.id],
      userId: tech.id,
    };

    const rows = await withDbAccessContext(partnerContext, () =>
      selectCommentsByTicketId(ticket.id)
    );

    expect(rows.map((r) => r.id).sort()).toEqual([staffComment.id, portalComment.id].sort());
    // The portal-authored row (user_id NULL) is the one Phase 6 hid.
    const portalRow = rows.find((r) => r.id === portalComment.id);
    expect(portalRow?.userId).toBeNull();
    expect(portalRow?.content).toBe('customer reply');
  });

  it('organization scope sees both comments (incl. partner-level staff author it cannot see directly)', async () => {
    const { partner, org, tech, ticket, staffComment, portalComment } =
      await seedTicketWithMixedComments();

    // Mirrors authMiddleware for organization scope:
    // accessiblePartnerIds is [] (computeAccessiblePartnerIds), so the
    // Phase 6 users-join branch fails for the partner-level technician —
    // both rows must arrive via the new ticket-parent policy.
    const orgContext: DbAccessContext = {
      scope: 'organization',
      orgId: org.id,
      accessibleOrgIds: [org.id],
      accessiblePartnerIds: [],
      userId: tech.id,
    };

    const rows = await withDbAccessContext(orgContext, () =>
      selectCommentsByTicketId(ticket.id)
    );

    expect(rows.map((r) => r.id).sort()).toEqual([staffComment.id, portalComment.id].sort());
  });

  it('a different partner (and its org scope) sees neither comment', async () => {
    const { ticket } = await seedTicketWithMixedComments();

    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    const otherTech = await createUser({
      partnerId: otherPartner.id,
      orgId: null,
      email: `tc-rls-other-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`,
    });

    const otherPartnerContext: DbAccessContext = {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [otherOrg.id],
      accessiblePartnerIds: [otherPartner.id],
      userId: otherTech.id,
    };
    const otherOrgContext: DbAccessContext = {
      scope: 'organization',
      orgId: otherOrg.id,
      accessibleOrgIds: [otherOrg.id],
      accessiblePartnerIds: [],
      userId: otherTech.id,
    };

    const partnerRows = await withDbAccessContext(otherPartnerContext, () =>
      selectCommentsByTicketId(ticket.id)
    );
    const orgRows = await withDbAccessContext(otherOrgContext, () =>
      selectCommentsByTicketId(ticket.id)
    );

    expect(partnerRows).toEqual([]);
    expect(orgRows).toEqual([]);
  });

  it('stays fail-closed without a DB access context (scope "none" — the portal bare-pool path)', async () => {
    // Portal routes (routes/portal/*) currently issue queries on the bare
    // pool without withDbAccessContext, i.e. breeze.scope is unset and
    // breeze_current_scope() = 'none'. The new ticket-parent policy must
    // not open anything to that path: breeze_has_org_access() is false
    // under scope 'none'.
    const { ticket } = await seedTicketWithMixedComments();

    const rows = await selectCommentsByTicketId(ticket.id);

    expect(rows).toEqual([]);
  });
});
