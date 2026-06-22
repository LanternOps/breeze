/**
 * ticket_comments UPDATE/DELETE RLS — edit/delete policy forge
 *
 * Migration under test: 2026-06-21-ticket-comment-edit.sql
 *
 * The Phase 6a migration adds breeze_ticket_parent_update and
 * breeze_ticket_parent_delete policies.  Both follow the EXISTS-join form:
 * the comment's parent ticket must be org-accessible to the caller.
 * ticket_comments has no org_id column — tenancy is inherited via the parent
 * ticket (shape 5 / child-via-parent).
 *
 * These tests run through the REAL postgres.js driver (db pool connects as
 * the unprivileged breeze_app role) with bound ticket-id parameters, on
 * purpose: the #1016→#1026 bug class made EXISTS-join policies pass in psql
 * but fail under postgres.js bound parameters.  tickets.org_id is NOT NULL
 * and the tickets SELECT policy has no OR branches, so the join is expected
 * to be safe — this suite is the proof.
 *
 * Each test re-seeds its own fixture inside the `it` body — NEVER module-scope
 * fixtures.  setup.ts TRUNCATEs between tests, so a memoized fixture silently
 * goes vacuous (rls-forge-test-memoized-fixture-vacuous).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { ticketComments, tickets, portalUsers } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/**
 * Seeds partner A → org A → ticket (in org A) → one comment.
 * All inserts go through the privileged test role (BYPASSRLS) so the
 * fixture is always visible regardless of the context under test.
 */
async function seedOrgATicketWithComment() {
  const adminDb = getTestDb() as any;
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const partnerA = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const techA = await createUser({
    partnerId: partnerA.id,
    orgId: null, // MSP staff — partner axis only
    email: `tc-edit-rls-tech-${unique}@example.test`,
  });

  const [portalUser] = await adminDb
    .insert(portalUsers)
    .values({
      orgId: orgA.id,
      email: `tc-edit-rls-portal-${unique}@example.test`,
      name: 'Portal Customer',
    })
    .returning();

  const [ticket] = await adminDb
    .insert(tickets)
    .values({
      orgId: orgA.id,
      partnerId: partnerA.id,
      ticketNumber: `TC-EDIT-RLS-${unique}`,
      subject: 'ticket_comments edit/delete RLS test',
      submittedBy: portalUser.id,
      source: 'portal',
    })
    .returning();

  const [comment] = await adminDb
    .insert(ticketComments)
    .values({
      ticketId: ticket.id,
      userId: techA.id,
      authorType: 'technician',
      content: 'original content',
    })
    .returning();

  return { partnerA, orgA, techA, portalUser, ticket, comment };
}

/**
 * Seeds a second, fully independent partner B → org B (no relationship to
 * org A whatsoever — different partner, different org).  Returns both tenants
 * plus a ticket+comment in org A so cross-tenant forge attempts are unambiguous.
 */
async function seedCrossTenant() {
  const fixtureA = await seedOrgATicketWithComment();

  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const partnerB = await createPartner();
  const orgB = await createOrganization({ partnerId: partnerB.id });
  const techB = await createUser({
    partnerId: partnerB.id,
    orgId: null,
    email: `tc-edit-rls-other-${unique}@example.test`,
  });

  return { ...fixtureA, partnerB, orgB, techB };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ticket_comments UPDATE/DELETE RLS (2026-06-21-ticket-comment-edit.sql)', () => {
  it('org-A-scoped connection can soft-delete (UPDATE deletedAt) a comment on an org-A ticket', async () => {
    const { partnerA, orgA, comment } = await seedOrgATicketWithComment();

    const ctxA: DbAccessContext = {
      scope: 'organization',
      orgId: orgA.id,
      accessibleOrgIds: [orgA.id],
      accessiblePartnerIds: [partnerA.id],
      userId: null,
    };

    const softDeletedAt = new Date();
    const result = await withDbAccessContext(ctxA, () =>
      db
        .update(ticketComments)
        .set({ deletedAt: softDeletedAt })
        .where(eq(ticketComments.id, comment.id))
        .returning({ id: ticketComments.id, deletedAt: ticketComments.deletedAt })
    );

    // Org-A caller MUST be able to update its own comment.
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(comment.id);
    expect(result[0].deletedAt).not.toBeNull();

    // Admin read confirms the row was actually mutated.
    const adminDb = getTestDb() as any;
    const [row] = await adminDb
      .select({ deletedAt: ticketComments.deletedAt })
      .from(ticketComments)
      .where(eq(ticketComments.id, comment.id));
    expect(row.deletedAt).not.toBeNull();
  });

  it('org-B-scoped connection CANNOT update a comment on an org-A ticket (0 rows, content unchanged)', async () => {
    const { orgB, partnerB, comment } = await seedCrossTenant();

    const ctxB: DbAccessContext = {
      scope: 'organization',
      orgId: orgB.id,
      accessibleOrgIds: [orgB.id],
      accessiblePartnerIds: [partnerB.id],
      userId: null,
    };

    // RLS USING clause filters the row out of the update — no error, just 0 rows.
    const result = await withDbAccessContext(ctxB, () =>
      db
        .update(ticketComments)
        .set({ content: 'forged content' })
        .where(eq(ticketComments.id, comment.id))
        .returning({ id: ticketComments.id })
    );

    // The forge must affect 0 rows — if > 0, RLS is broken.
    expect(result).toHaveLength(0);

    // Admin read proves content is genuinely unchanged (not a vacuous pass).
    const adminDb = getTestDb() as any;
    const [row] = await adminDb
      .select({ content: ticketComments.content })
      .from(ticketComments)
      .where(eq(ticketComments.id, comment.id));
    expect(row.content).toBe('original content');
  });

  it('org-B-scoped connection CANNOT hard-delete a comment on an org-A ticket (0 rows, comment still present)', async () => {
    const { orgB, partnerB, comment } = await seedCrossTenant();

    const ctxB: DbAccessContext = {
      scope: 'organization',
      orgId: orgB.id,
      accessibleOrgIds: [orgB.id],
      accessiblePartnerIds: [partnerB.id],
      userId: null,
    };

    // RLS USING clause filters the row — delete affects 0 rows, no error.
    const result = await withDbAccessContext(ctxB, () =>
      db
        .delete(ticketComments)
        .where(eq(ticketComments.id, comment.id))
        .returning({ id: ticketComments.id })
    );

    // Must be 0 rows — if > 0, RLS is broken.
    expect(result).toHaveLength(0);

    // Admin read proves the comment still exists (not a vacuous pass).
    const adminDb = getTestDb() as any;
    const [row] = await adminDb
      .select({ id: ticketComments.id })
      .from(ticketComments)
      .where(eq(ticketComments.id, comment.id));
    expect(row).toBeDefined();
    expect(row.id).toBe(comment.id);
  });
});
