/**
 * Ticket create-validation reads vs RLS — regression proof for the
 * system-context move in ticketService.ts.
 *
 * createTicket validates `assigneeId` / `categoryId` as same-partner. Those
 * validation reads (getAssigneeForValidation / assertCategoryInPartner) run
 * in a system-scope DB context (`runOutsideDbContext` +
 * `withSystemDbAccessContext`) on purpose:
 *
 *   - `ticket_categories` is partner-axis RLS (`breeze_has_partner_access`),
 *     and an ORGANIZATION-scope request context has empty
 *     accessible_partner_ids (that is exactly what authMiddleware sets), so
 *     under the request context the category row is invisible.
 *   - Partner-level staff (`users.org_id IS NULL`) are likewise hidden from
 *     org scope by the users RLS policy.
 *
 * Before the fix, both lookups ran inside the org-scoped request context, so
 * a perfectly legitimate org-scope create with a same-partner category /
 * partner-staff assignee blew up with a bogus TicketServiceError 404
 * ('Category not found' / 'Assignee not found'). The controller verified the
 * pre-fix behavior — these tests are the real-database regression proof that
 * unit tests (which mock the db) cannot provide.
 *
 * The negative cases prove the system-context reads did NOT weaken the
 * tenant boundary: the explicit partner comparison still rejects
 * cross-partner categories/assignees with 400 + machine-readable codes.
 *
 * Runs under vitest.integration.config.ts (real postgres.js driver; the
 * code-under-test pool connects as unprivileged `breeze_app`, so RLS is
 * actually enforced — see setup.ts).
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import {
  tickets,
  ticketCategories,
  partnerTicketSequences,
  users,
  organizations,
  partners,
} from '../../db/schema';
import { createTicket, TicketServiceError } from '../../services/ticketService';
import { getTicketEventsQueue } from '../../services/ticketEvents';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

/**
 * Partner ids seeded by this file, for afterAll cleanup. beforeEach in
 * setup.ts TRUNCATE-CASCADEs core tables between tests, so usually only the
 * last test's rows survive — deleting everything registered is a harmless
 * superset.
 */
const seededPartnerIds: string[] = [];
const seededOrgIds: string[] = [];

/**
 * Seeds (as the privileged test role, bypassing RLS):
 *   P1 → O1, U_actor (org-level, the request actor), U_staff (partner-level
 *        MSP technician, org_id NULL — invisible to org scope), C1 (category)
 *   P2 → C2 (category), U2 (cross-partner negatives)
 */
async function seedFixture() {
  const adminDb = getTestDb() as any;
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const p1 = await createPartner();
  const o1 = await createOrganization({ partnerId: p1.id });
  const actor = await createUser({
    partnerId: p1.id,
    orgId: o1.id,
    email: `tv-rls-actor-${unique}@example.test`,
  });
  const staff = await createUser({
    partnerId: p1.id,
    orgId: null, // MSP staff — hidden from org scope by the users RLS policy
    email: `tv-rls-staff-${unique}@example.test`,
  });
  const [c1] = await adminDb
    .insert(ticketCategories)
    .values({ partnerId: p1.id, name: `TV-RLS Cat P1 ${unique}` })
    .returning();

  const p2 = await createPartner();
  const u2 = await createUser({
    partnerId: p2.id,
    orgId: null,
    email: `tv-rls-other-${unique}@example.test`,
  });
  const [c2] = await adminDb
    .insert(ticketCategories)
    .values({ partnerId: p2.id, name: `TV-RLS Cat P2 ${unique}` })
    .returning();

  seededPartnerIds.push(p1.id, p2.id);
  seededOrgIds.push(o1.id);

  // Mirrors authMiddleware for organization scope: accessiblePartnerIds is []
  // (computeAccessiblePartnerIds grants no partner axis to org-scope callers).
  const orgContext: DbAccessContext = {
    scope: 'organization',
    orgId: o1.id,
    accessibleOrgIds: [o1.id],
    accessiblePartnerIds: [],
    userId: actor.id,
  };

  return { p1, o1, actor, staff, c1, p2, u2, c2, orgContext };
}

afterAll(async () => {
  // Release the BullMQ ticket-events queue connection opened by
  // emitTicketEvent (event emission is fire-and-forget and not under test,
  // but the redis connection would otherwise dangle past the run).
  await getTicketEventsQueue().close().catch(() => {});

  if (seededPartnerIds.length === 0) return;
  const adminDb = getTestDb() as any;
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);

  // audit_logs is append-only (row triggers block UPDATE/DELETE, a statement
  // trigger blocks TRUNCATE) but has an FK to organizations, so our org rows
  // can't be deleted while createTicket's audit entries reference them.
  // Delete those rows with triggers disabled via session_replication_role —
  // SET LOCAL inside a single transaction so the setting and the DELETE are
  // guaranteed to share one pooled connection.
  if (seededOrgIds.length > 0) {
    const orgList = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);
    await adminDb.transaction(async (tx: any) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`DELETE FROM audit_logs WHERE org_id IN (${orgList})`);
    });
  }

  // FK order: tickets → sequences/categories → users → orgs → partners.
  await adminDb.delete(tickets).where(sql`${tickets.partnerId} IN (${partnerList})`);
  await adminDb
    .delete(partnerTicketSequences)
    .where(sql`${partnerTicketSequences.partnerId} IN (${partnerList})`);
  await adminDb
    .delete(ticketCategories)
    .where(sql`${ticketCategories.partnerId} IN (${partnerList})`);
  await adminDb.delete(users).where(sql`${users.partnerId} IN (${partnerList})`);
  await adminDb.delete(organizations).where(sql`${organizations.partnerId} IN (${partnerList})`);
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

async function captureTicketServiceError(fn: () => Promise<unknown>): Promise<TicketServiceError> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TicketServiceError);
  return caught as TicketServiceError;
}

describe('ticket validation reads under org-scoped RLS (system-context regression)', () => {
  it('org-scope create succeeds with a same-partner category and partner-staff assignee', async () => {
    const { o1, actor, staff, c1, orgContext } = await seedFixture();

    // THE regression case. Pre-fix, the category/assignee lookups ran inside
    // this org-scoped request context, RLS hid both rows, and this exact call
    // threw TicketServiceError 404 'Category not found' (controller-verified).
    const ticket = await withDbAccessContext(orgContext, () =>
      createTicket(
        {
          orgId: o1.id,
          subject: 'rls probe',
          source: 'manual',
          categoryId: c1.id,
          assigneeId: staff.id,
        },
        { userId: actor.id, name: actor.name, email: actor.email }
      )
    );

    expect(ticket.categoryId).toBe(c1.id);
    expect(ticket.assignedTo).toBe(staff.id);
    expect(ticket.orgId).toBe(o1.id);
    expect(ticket.internalNumber).toMatch(/^T-\d{4}-\d{4,}$/);
  });

  it('still rejects a cross-partner category under the same org-scope context (400 CATEGORY_WRONG_PARTNER)', async () => {
    const { o1, actor, c2, orgContext } = await seedFixture();

    const err = await captureTicketServiceError(() =>
      withDbAccessContext(orgContext, () =>
        createTicket(
          { orgId: o1.id, subject: 'rls probe x-partner category', source: 'manual', categoryId: c2.id },
          { userId: actor.id }
        )
      )
    );

    // 400 (not 404): the system-context read SEES the foreign row — the
    // explicit partner comparison is the tenant boundary, and it holds.
    expect(err.status).toBe(400);
    expect(err.code).toBe('CATEGORY_WRONG_PARTNER');
  });

  it('still rejects a cross-partner assignee under the same org-scope context (400 ASSIGNEE_WRONG_PARTNER)', async () => {
    const { o1, actor, u2, orgContext } = await seedFixture();

    const err = await captureTicketServiceError(() =>
      withDbAccessContext(orgContext, () =>
        createTicket(
          { orgId: o1.id, subject: 'rls probe x-partner assignee', source: 'manual', assigneeId: u2.id },
          { userId: actor.id }
        )
      )
    );

    expect(err.status).toBe(400);
    expect(err.code).toBe('ASSIGNEE_WRONG_PARTNER');
  });
});
