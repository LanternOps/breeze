/**
 * ticket_comments SELECT/UPDATE/DELETE follow the parent ticket's organization.
 *
 * Migration under test: 2026-11-14-100700-ticket-comments-parent-org-policies.sql
 *
 * ticket_comments has no org_id column; its tenancy is the parent ticket's
 * org. Every policy on the table — including the author-keyed
 * breeze_user_isolation_* ones — requires the parent ticket to be
 * org-accessible. Exercised with a partner technician whose org list is a
 * subset of the partner's orgs.
 *
 * Runs through the real postgres.js driver (breeze_app, bound parameters) so
 * the EXISTS join is exercised the way production executes it. Fixtures are
 * seeded inside each `it` — setup.ts truncates between tests.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { ticketComments, tickets, portalUsers } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

/**
 * One partner with two orgs. The technician's context reaches `allowedOrg`
 * only (partner_users.org_access = 'selected'). Both orgs have a ticket with a
 * comment authored by the technician, and the other-org ticket also carries a
 * comment by a colleague on the same partner.
 */
async function seedSelectedOrgTechnician() {
  const adminDb = getTestDb() as any;
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const partner = await createPartner();
  const allowedOrg = await createOrganization({ partnerId: partner.id });
  const otherOrg = await createOrganization({ partnerId: partner.id });
  const tech = await createUser({
    partnerId: partner.id,
    orgId: null,
    email: `tc-parent-org-tech-${unique}@example.test`,
  });
  const colleague = await createUser({
    partnerId: partner.id,
    orgId: null,
    email: `tc-parent-org-colleague-${unique}@example.test`,
  });

  async function ticketIn(orgId: string, label: string) {
    const [portalUser] = await adminDb
      .insert(portalUsers)
      .values({ orgId, email: `tc-parent-org-${label}-${unique}@example.test`, name: 'Customer' })
      .returning();
    const [ticket] = await adminDb
      .insert(tickets)
      .values({
        orgId,
        partnerId: partner.id,
        ticketNumber: `TC-PARENT-ORG-${label}-${unique}`,
        subject: `ticket in ${label}`,
        submittedBy: portalUser.id,
        source: 'portal',
      })
      .returning();
    return ticket;
  }

  const allowedTicket = await ticketIn(allowedOrg.id, 'allowed');
  const otherTicket = await ticketIn(otherOrg.id, 'other');

  async function commentOn(ticketId: string, userId: string, content: string) {
    const [comment] = await adminDb
      .insert(ticketComments)
      .values({ ticketId, userId, authorType: 'technician', content })
      .returning();
    return comment;
  }

  const ownAllowedComment = await commentOn(allowedTicket.id, tech.id, 'own comment, allowed org');
  const ownOtherComment = await commentOn(otherTicket.id, tech.id, 'own comment, other org');
  const colleagueOtherComment = await commentOn(otherTicket.id, colleague.id, 'colleague comment, other org');

  const ctx: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [allowedOrg.id],
    accessiblePartnerIds: [partner.id],
    userId: tech.id,
  };

  return { ctx, ownAllowedComment, ownOtherComment, colleagueOtherComment };
}

async function adminRead(id: string) {
  const adminDb = getTestDb() as any;
  const [row] = await adminDb
    .select({ id: ticketComments.id, content: ticketComments.content })
    .from(ticketComments)
    .where(eq(ticketComments.id, id));
  return row as { id: string; content: string } | undefined;
}

describe('ticket_comments policies follow the parent ticket organization', () => {
  it('reads only comments whose parent ticket is in an accessible org', async () => {
    const { ctx, ownAllowedComment, ownOtherComment, colleagueOtherComment } =
      await seedSelectedOrgTechnician();

    const rows = await withDbAccessContext(ctx, () =>
      db.select({ id: ticketComments.id }).from(ticketComments)
    );
    const ids = rows.map((r) => r.id).sort();

    expect(ids).toEqual([ownAllowedComment.id]);
    expect(ids).not.toContain(ownOtherComment.id);
    expect(ids).not.toContain(colleagueOtherComment.id);
  });

  it('updates a comment on an accessible-org ticket', async () => {
    const { ctx, ownAllowedComment } = await seedSelectedOrgTechnician();

    const result = await withDbAccessContext(ctx, () =>
      db
        .update(ticketComments)
        .set({ content: 'edited' })
        .where(eq(ticketComments.id, ownAllowedComment.id))
        .returning({ id: ticketComments.id })
    );

    expect(result).toHaveLength(1);
    expect((await adminRead(ownAllowedComment.id))?.content).toBe('edited');
  });

  it.each([
    ['own', 'ownOtherComment'],
    ['colleague', 'colleagueOtherComment'],
  ] as const)('does not update a %s comment on another org ticket', async (_label, key) => {
    const fixture = await seedSelectedOrgTechnician();
    const target = fixture[key];

    const result = await withDbAccessContext(fixture.ctx, () =>
      db
        .update(ticketComments)
        .set({ content: 'changed' })
        .where(eq(ticketComments.id, target.id))
        .returning({ id: ticketComments.id })
    );

    expect(result).toHaveLength(0);
    expect((await adminRead(target.id))?.content).toBe(target.content);
  });

  it.each([
    ['own', 'ownOtherComment'],
    ['colleague', 'colleagueOtherComment'],
  ] as const)('does not delete a %s comment on another org ticket', async (_label, key) => {
    const fixture = await seedSelectedOrgTechnician();
    const target = fixture[key];

    const result = await withDbAccessContext(fixture.ctx, () =>
      db
        .delete(ticketComments)
        .where(eq(ticketComments.id, target.id))
        .returning({ id: ticketComments.id })
    );

    expect(result).toHaveLength(0);
    expect(await adminRead(target.id)).toBeDefined();
  });

  it('deletes a comment on an accessible-org ticket', async () => {
    const { ctx, ownAllowedComment } = await seedSelectedOrgTechnician();

    const result = await withDbAccessContext(ctx, () =>
      db
        .delete(ticketComments)
        .where(eq(ticketComments.id, ownAllowedComment.id))
        .returning({ id: ticketComments.id })
    );

    expect(result).toHaveLength(1);
    expect(await adminRead(ownAllowedComment.id)).toBeUndefined();
  });
});
