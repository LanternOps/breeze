/**
 * Real-driver integration tests: time_entries + ticket_parts RLS isolation,
 * timer-race semantics (D3), category-default billing (D2), and approval flow (D1).
 *
 * Runs under vitest.integration.config.ts — code-under-test connects as the
 * unprivileged `breeze_app` role so RLS is actually enforced.
 *
 * Fixture topology:
 *   partnerA → orgA → categoryA (defaultBillable=true, defaultHourlyRate=125.00)
 *           → ticketA (linked to categoryA)
 *           → techA (partner staff), adminA (manageAll=true)
 *   partnerB → orgB → ticketB
 *           → techB (partner staff)
 *
 * Teardown: delete only what this file seeds (partner-keyed cascade).
 * audit_logs is append-only — cleaned via session_replication_role=replica inside
 * a transaction, matching the pattern in ticket-validation-rls.integration.test.ts.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  timeEntries,
  ticketParts,
  ticketCategories,
  tickets,
  users,
  organizations,
  partners,
  partnerTicketSequences,
  partnerUsers,
  rolePermissions,
  roles,
  sites,
  devices,
} from '../../db/schema';
import {
  createTimeEntry,
  startTimer,
  approveTimeEntries,
  updateTimeEntry,
  TimeEntryServiceError,
} from '../../services/timeEntryService';
import { getTimeEntryEventsQueue } from '../../services/timeEntryEvents';
import { createOrganization, createPartner, createSite, createUser, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { createAccessToken } from '../../services/jwt';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';

// Partner/org ids seeded by this file, for afterAll cleanup.
const seededPartnerIds: string[] = [];
const seededOrgIds: string[] = [];

interface Fixture {
  partnerA: { id: string };
  orgA: { id: string };
  categoryA: { id: string };
  ticketA: { id: string };
  techA: { id: string };
  adminA: { id: string };
  partnerB: { id: string };
  orgB: { id: string };
  ticketB: { id: string };
  techB: { id: string };
  partnerAContext: DbAccessContext;
  orgAContext: DbAccessContext;
  techAActor: { userId: string; partnerId: string; manageAll: false };
  adminAActor: { userId: string; partnerId: string; manageAll: true };
}

async function seedFixture(): Promise<Fixture> {
  const adminDb = getTestDb() as any;
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // ── Partner A ──────────────────────────────────────────────────────────
  const partnerA = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const techA = await createUser({
    partnerId: partnerA.id,
    orgId: null, // MSP staff
    email: `te-rls-techA-${unique}@example.test`,
  });
  const adminA = await createUser({
    partnerId: partnerA.id,
    orgId: null,
    email: `te-rls-adminA-${unique}@example.test`,
  });

  // ticket_categories: defaultBillable=true, defaultHourlyRate=125.00
  const [categoryA] = await adminDb
    .insert(ticketCategories)
    .values({
      partnerId: partnerA.id,
      name: `TE-RLS Cat A ${unique}`,
      defaultBillable: true,
      defaultHourlyRate: '125.00',
    })
    .returning();

  // tickets: must satisfy NOT NULL on ticketNumber, subject, source
  // Unique ticketNumber prevents unique-key collisions on re-run.
  const [ticketA] = await adminDb
    .insert(tickets)
    .values({
      orgId: orgA.id,
      partnerId: partnerA.id,
      categoryId: categoryA.id,
      ticketNumber: `TE-A-${unique}`,
      subject: `TE RLS ticket A ${unique}`,
      source: 'manual',
    })
    .returning();

  // ── Partner B ──────────────────────────────────────────────────────────
  const partnerB = await createPartner();
  const orgB = await createOrganization({ partnerId: partnerB.id });
  const techB = await createUser({
    partnerId: partnerB.id,
    orgId: null,
    email: `te-rls-techB-${unique}@example.test`,
  });
  const [ticketB] = await adminDb
    .insert(tickets)
    .values({
      orgId: orgB.id,
      partnerId: partnerB.id,
      ticketNumber: `TE-B-${unique}`,
      subject: `TE RLS ticket B ${unique}`,
      source: 'manual',
    })
    .returning();

  seededPartnerIds.push(partnerA.id, partnerB.id);
  seededOrgIds.push(orgA.id, orgB.id);

  // ── DbAccessContext shapes (mirrors authMiddleware) ───────────────────
  const partnerAContext: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [orgA.id],
    accessiblePartnerIds: [partnerA.id],
    userId: techA.id,
  };

  const orgAContext: DbAccessContext = {
    scope: 'organization',
    orgId: orgA.id,
    accessibleOrgIds: [orgA.id],
    accessiblePartnerIds: [],
    userId: techA.id,
  };

  const techAActor = { userId: techA.id, partnerId: partnerA.id, manageAll: false as const };
  const adminAActor = { userId: adminA.id, partnerId: partnerA.id, manageAll: true as const };

  return {
    partnerA, orgA, categoryA, ticketA, techA, adminA,
    partnerB, orgB, ticketB, techB,
    partnerAContext, orgAContext, techAActor, adminAActor,
  };
}

afterAll(async () => {
  // Close the BullMQ queue connection opened by emitTimeEntryEvent
  // (fire-and-forget; would dangle past the run otherwise).
  await getTimeEntryEventsQueue().close().catch(() => {});

  if (seededPartnerIds.length === 0) return;
  const adminDb = getTestDb() as any;
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);

  // audit_logs is append-only (trigger blocks DELETE/UPDATE) but has FK to
  // organizations. Delete those rows with triggers disabled via
  // session_replication_role — SET LOCAL must share the same connection as
  // the DELETE, hence a transaction.
  if (seededOrgIds.length > 0) {
    const orgList = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);
    await adminDb.transaction(async (tx: any) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`DELETE FROM audit_logs WHERE org_id IN (${orgList})`);
    });
  }

  // FK cascade order: time_entries / ticket_parts → tickets →
  // sequences / categories → partner_users / role_permissions / roles →
  // users → orgs → partners.
  await adminDb.delete(timeEntries).where(sql`${timeEntries.partnerId} IN (${partnerList})`);
  // ticket_parts cascades from tickets (ON DELETE CASCADE) but explicit delete
  // avoids ordering sensitivity.
  await adminDb
    .delete(ticketParts)
    .where(
      sql`${ticketParts.ticketId} IN (SELECT id FROM tickets WHERE partner_id IN (${partnerList}))`
    );
  await adminDb.delete(tickets).where(sql`${tickets.partnerId} IN (${partnerList})`);
  await adminDb
    .delete(partnerTicketSequences)
    .where(sql`${partnerTicketSequences.partnerId} IN (${partnerList})`);
  await adminDb
    .delete(ticketCategories)
    .where(sql`${ticketCategories.partnerId} IN (${partnerList})`);
  // partner_users and role_permissions (via roles created by setupTestEnvironment)
  // must be removed before users and partners to avoid FK violations.
  await adminDb
    .delete(partnerUsers)
    .where(sql`${partnerUsers.partnerId} IN (${partnerList})`);
  // roles created by setupTestEnvironment are partner-scoped; remove their
  // permission grants first, then the roles themselves.
  const partnerRoleIds = await adminDb
    .select({ id: roles.id })
    .from(roles)
    .where(sql`${roles.partnerId} IN (${partnerList})`);
  if (partnerRoleIds.length > 0) {
    const roleIdList = sql.join(partnerRoleIds.map((r: { id: string }) => sql`${r.id}`), sql`, `);
    await adminDb
      .delete(rolePermissions)
      .where(sql`${rolePermissions.roleId} IN (${roleIdList})`);
    await adminDb
      .delete(roles)
      .where(sql`${roles.id} IN (${roleIdList})`);
  }
  // Devices and sites must go before orgs (FK on org_id).
  // setupTestEnvironment creates a site; our moveOrg fixture creates two more.
  if (seededOrgIds.length > 0) {
    const orgList2 = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);
    await adminDb.delete(devices).where(sql`${devices.orgId} IN (${orgList2})`);
    await adminDb.delete(sites).where(sql`${sites.orgId} IN (${orgList2})`);
  }
  await adminDb.delete(users).where(sql`${users.partnerId} IN (${partnerList})`);
  await adminDb
    .delete(organizations)
    .where(sql`${organizations.partnerId} IN (${partnerList})`);
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

// ── 1. time_entries RLS isolation (partner-axis, Shape 3) ────────────────

describe('time_entries RLS isolation (partner-axis, Shape 3)', () => {
  it('a partner-scoped context cannot read another partner\'s entries', async () => {
    const { partnerA, partnerB, orgB, techB, partnerAContext } = await seedFixture();
    const adminDb = getTestDb() as any;

    // Insert a row for partnerB via the privileged test pool (bypasses RLS).
    await adminDb.insert(timeEntries).values({
      partnerId: partnerB.id,
      orgId: orgB.id,
      userId: techB.id,
      startedAt: new Date(Date.now() - 60_000),
      endedAt: new Date(),
      durationMinutes: 1,
    });

    // Under partnerA's RLS context (breeze_app), only partnerA rows are visible.
    const rows = await withDbAccessContext(partnerAContext, () =>
      db.select({ id: timeEntries.id, partnerId: timeEntries.partnerId }).from(timeEntries)
    );
    expect(rows.every((r) => r.partnerId === partnerA.id)).toBe(true);
    expect(rows.some((r) => r.partnerId === partnerB.id)).toBe(false);
  });

  it('a forged cross-partner insert rejects with an RLS violation', async () => {
    const { partnerB, techA, partnerAContext } = await seedFixture();

    // Drizzle wraps the driver error: the RLS signal is Postgres code 42501
    // (insufficient_privilege) on the underlying cause, not the wrapper message.
    await expect(
      withDbAccessContext(partnerAContext, () =>
        db.insert(timeEntries).values({
          partnerId: partnerB.id, // wrong partner — RLS must reject
          userId: techA.id,
          startedAt: new Date(),
          endedAt: new Date(Date.now() + 60_000),
          durationMinutes: 1,
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

// ── 2. ticket_parts RLS isolation (org-axis, Shape 1) ───────────────────

describe('ticket_parts RLS isolation (org-axis, Shape 1)', () => {
  it('a forged cross-org insert rejects with an RLS violation', async () => {
    const { ticketB, orgB, orgAContext } = await seedFixture();

    // Drizzle wraps the driver error: the RLS signal is Postgres code 42501.
    await expect(
      withDbAccessContext(orgAContext, () =>
        db.insert(ticketParts).values({
          ticketId: ticketB.id,
          orgId: orgB.id, // wrong org — RLS must reject
          description: 'forged part',
          quantity: '1.00',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

// ── 3. Timer semantics (D3) — real driver ────────────────────────────────

describe('timer semantics (D3) — real driver', () => {
  it('two racing startTimer calls leave exactly one running entry', async () => {
    const { partnerAContext, techAActor } = await seedFixture();

    // Each startTimer runs in its own withDbAccessContext (its own transaction)
    // to simulate two concurrent HTTP requests racing — exactly how it happens
    // in production. withDbAccessContext wraps everything in a single postgres.js
    // transaction, so if a unique-constraint violation occurs inside a context,
    // that transaction is aborted and the retry (which happens inside the same
    // aborted transaction) will also fail. This is expected: in production, one
    // concurrent request wins and the other surfaces a transient error to the
    // client, who can retry. What the DB-level unique index GUARANTEES is that
    // you can NEVER end up with two running entries simultaneously — at most one
    // survives. Promise.allSettled lets us accept that one call may throw while
    // proving the invariant: exactly one running entry in the DB.
    const results = await Promise.allSettled([
      withDbAccessContext(partnerAContext, () =>
        startTimer({ description: 'race-1' }, techAActor)
      ),
      withDbAccessContext(partnerAContext, () =>
        startTimer({ description: 'race-2' }, techAActor)
      ),
    ]);

    // At least one call must have succeeded.
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    // The DB-level partial unique index enforces the invariant: exactly one
    // running entry per user — regardless of which request(s) succeeded.
    const adminDb = getTestDb() as any;
    const running = await adminDb
      .select({ id: timeEntries.id })
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.userId, techAActor.userId),
          isNull(timeEntries.endedAt)
        )
      );
    expect(running).toHaveLength(1);
  });

  it('startTimer folds the previous timer with a floored duration (sub-minute → 0)', async () => {
    const { partnerAContext, techAActor } = await seedFixture();

    // Each call is its own context (its own transaction) — matches production.
    // First timer starts; second start immediately folds it (sub-minute gap).
    await withDbAccessContext(partnerAContext, () =>
      startTimer({ description: 'first' }, techAActor)
    );
    await withDbAccessContext(partnerAContext, () =>
      startTimer({ description: 'second' }, techAActor)
    );

    // The stopped (first) entry must have durationMinutes = 0 (sub-minute → floor 0).
    // This also validates the SQL-duration expression in stopRunningEntry against
    // the real postgres.js driver (Task 5 caveat).
    const adminDb = getTestDb() as any;
    const stopped = await adminDb
      .select({ id: timeEntries.id, durationMinutes: timeEntries.durationMinutes })
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.userId, techAActor.userId),
          sql`${timeEntries.endedAt} IS NOT NULL`
        )
      );
    expect(stopped).toHaveLength(1);
    // Both timer calls happen in the same test run — elapsed is well under a
    // minute, so FLOOR(seconds / 60) = 0.
    expect(stopped[0]!.durationMinutes).toBe(0);
  });
});

// ── 4. Category defaults (D2) — real driver ──────────────────────────────

describe('category defaults (D2) — real driver', () => {
  it('ticket-linked entry stamps isBillable + hourlyRate from category and denormalizes orgId', async () => {
    const { ticketA, orgA, partnerAContext, techAActor } = await seedFixture();

    let entry: Awaited<ReturnType<typeof createTimeEntry>>;
    await withDbAccessContext(partnerAContext, async () => {
      entry = await createTimeEntry(
        {
          ticketId: ticketA.id,
          startedAt: new Date(Date.now() - 30 * 60_000),
          endedAt: new Date(),
        },
        techAActor
      );
    });

    expect(entry!.isBillable).toBe(true);
    expect(entry!.hourlyRate).toBe('125.00');
    expect(entry!.orgId).toBe(orgA.id);
  });
});

// ── 5. Approval flow (D1) — real driver ──────────────────────────────────

describe('approval flow (D1) — real driver', () => {
  it('approve stamps fields (updated=1); a subsequent admin edit clears approval', async () => {
    const { partnerAContext, techAActor, adminAActor } = await seedFixture();

    let entry: Awaited<ReturnType<typeof createTimeEntry>>;
    await withDbAccessContext(partnerAContext, async () => {
      entry = await createTimeEntry(
        {
          startedAt: new Date(Date.now() - 60 * 60_000),
          endedAt: new Date(),
        },
        techAActor
      );
    });

    // Approve.
    let approvalResult: Awaited<ReturnType<typeof approveTimeEntries>>;
    await withDbAccessContext(partnerAContext, async () => {
      approvalResult = await approveTimeEntries([entry!.id], true, adminAActor);
    });
    expect(approvalResult!.updated).toBe(1);

    // Edit as admin — spec §3: any edit clears approval.
    let updated: Awaited<ReturnType<typeof updateTimeEntry>>;
    await withDbAccessContext(partnerAContext, async () => {
      updated = await updateTimeEntry(
        entry!.id,
        { description: 'edited post-approval' },
        adminAActor
      );
    });
    expect(updated!.isApproved).toBe(false);
    expect(updated!.approvedBy).toBeNull();
  });

  it('a non-admin cannot approve entries (ADMIN_REQUIRED)', async () => {
    const { techAActor } = await seedFixture();

    // No DB context needed — the service rejects before any DB call.
    await expect(
      approveTimeEntries(['00000000-0000-4000-8000-000000000001'], true, techAActor)
    ).rejects.toMatchObject({ code: 'ADMIN_REQUIRED', status: 403 });
  });
});

// ── 6. moveOrg org_id rewrite — real driver (spec §6 checklist) ──────────
//
// Verifies that POST /devices/:id/move-org rewrites org_id on tickets,
// time_entries, and ticket_parts in the same transaction so no row is
// stranded under the old org's RLS context (moveOrg.ts:166-171).
//
// Topology:
//   partnerA → orgA  → siteA  → deviceA
//            → orgA2 → siteA2 (move target, same partner → allowed)
//   ticketA linked to deviceA, org_id=orgA
//   timeEntryA linked to ticketA, org_id=orgA, partner_id=partnerA
//   partA linked to ticketA, org_id=orgA
//
// After move: tickets.org_id, time_entries.org_id, ticket_parts.org_id
// all equal orgA2. time_entries.partner_id unchanged (partnerA).

describe('moveOrg org_id rewrite — real driver (spec §6)', () => {
  it('rewrites tickets, time_entries, and ticket_parts org_id atomically', async () => {
    const adminDb = getTestDb() as any;
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // ── Seed fixture ────────────────────────────────────────────────────
    // Use setupTestEnvironment (partner scope) for the primary org/user/role.
    // This creates: partnerA, orgA, siteA, userA with orgAccess=all role + wildcard perms.
    const env = await setupTestEnvironment({ scope: 'partner' });
    const { partner: partnerA, organization: orgA, site: siteA, user: userA, role } = env;

    // Second org under the SAME partner (move target).
    const orgA2 = await createOrganization({ partnerId: partnerA.id });
    const siteA2 = await createSite({ orgId: orgA2.id });

    // Track for afterAll cleanup.
    seededPartnerIds.push(partnerA.id);
    seededOrgIds.push(orgA.id, orgA2.id);

    // Device in orgA.
    const [deviceA] = await adminDb.insert(devices).values({
      orgId: orgA.id,
      siteId: siteA.id,
      agentId: `move-org-test-agent-${unique}`,
      hostname: `move-host-${unique}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'offline',
    }).returning();

    // Ticket linked to deviceA, org_id=orgA.
    const [ticketA] = await adminDb.insert(tickets).values({
      orgId: orgA.id,
      partnerId: partnerA.id,
      deviceId: deviceA.id,
      ticketNumber: `MO-A-${unique}`,
      subject: `MoveOrg RLS ticket ${unique}`,
      source: 'manual',
    }).returning();

    // time_entries row: partner-axis RLS, org_id denormalized from ticket.
    const [timeEntryA] = await adminDb.insert(timeEntries).values({
      partnerId: partnerA.id,
      orgId: orgA.id,
      ticketId: ticketA.id,
      userId: userA.id,
      startedAt: new Date(Date.now() - 60_000),
      endedAt: new Date(),
      durationMinutes: 1,
    }).returning();

    // ticket_parts row: org-axis RLS.
    const [partA] = await adminDb.insert(ticketParts).values({
      ticketId: ticketA.id,
      orgId: orgA.id,
      description: `Test part ${unique}`,
      quantity: '1.00',
      unitPrice: '9.99',
    }).returning();

    // ── Verify pre-move state ───────────────────────────────────────────
    expect(ticketA.orgId).toBe(orgA.id);
    expect(timeEntryA.orgId).toBe(orgA.id);
    expect(timeEntryA.partnerId).toBe(partnerA.id);
    expect(partA.orgId).toBe(orgA.id);

    // ── Build Hono app and make the HTTP request ────────────────────────
    // Token: mfa=true required by requireMfa(); scope=partner required by
    // requireScope('partner','system'). Use a fresh token (the one from
    // setupTestEnvironment has mfa=false).
    const token = await createAccessToken({
      sub: userA.id,
      email: userA.email,
      roleId: role.id,
      orgId: null,         // MSP staff — no single-org pin
      partnerId: partnerA.id,
      scope: 'partner',
      mfa: true,           // satisfies requireMfa() step-up
    });

    const app = new Hono();
    app.route('/devices', moveOrgRoutes);

    const res = await app.request(`/devices/${deviceA.id}/move-org`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ orgId: orgA2.id, siteId: siteA2.id }),
    });

    // Must succeed.
    const body = await res.json() as any;
    expect(res.status, `move-org failed: ${JSON.stringify(body)}`).toBe(200);
    expect(body.success).toBe(true);

    // writeRouteAudit is fire-and-forget (void return). Give the floating
    // promise a moment to land so audit_logs rows exist before afterAll
    // tries to clean them via the session_replication_role=replica DELETE.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // ── Assert post-move org_id rewrites ────────────────────────────────

    // tickets.org_id → orgA2
    const [ticketAfter] = await adminDb
      .select({ orgId: tickets.orgId })
      .from(tickets)
      .where(eq(tickets.id, ticketA.id));
    expect(ticketAfter?.orgId, 'tickets.org_id not rewritten').toBe(orgA2.id);

    // time_entries.org_id → orgA2; partner_id unchanged
    const [teAfter] = await adminDb
      .select({ orgId: timeEntries.orgId, partnerId: timeEntries.partnerId })
      .from(timeEntries)
      .where(eq(timeEntries.id, timeEntryA.id));
    expect(teAfter?.orgId, 'time_entries.org_id not rewritten').toBe(orgA2.id);
    expect(teAfter?.partnerId, 'time_entries.partner_id must not change').toBe(partnerA.id);

    // ticket_parts.org_id → orgA2
    const [partAfter] = await adminDb
      .select({ orgId: ticketParts.orgId })
      .from(ticketParts)
      .where(eq(ticketParts.id, partA.id));
    expect(partAfter?.orgId, 'ticket_parts.org_id not rewritten').toBe(orgA2.id);
  });
});
