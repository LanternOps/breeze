/**
 * Real-driver integration tests: ticket configuration RLS isolation,
 * seeding idempotency, SLA chain ordering, changeTicketStatus end-to-end,
 * and time-entry org-rate defaults.
 *
 * Runs under vitest.integration.config.ts — code-under-test connects as the
 * unprivileged `breeze_app` role so RLS is actually enforced.
 *
 * Fixture topology:
 *   partnerA → orgA  (ticket_statuses + ticket_priority_settings seeded per test)
 *   partnerB → orgB  (ticket_statuses seeded per test)
 *
 * Teardown: deletes only what this file seeds (partner-keyed cascade).
 * audit_logs is append-only — cleaned via session_replication_role=replica.
 * No assertions on audit rows (per plan notes).
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql, and } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  ticketStatuses,
  ticketPrioritySettings,
  orgTicketSettings,
  tickets,
  ticketComments,
  organizations,
  partners,
  partnerTicketSequences,
  ticketCategories,
  timeEntries,
  users,
  sites,
  roles,
  partnerUsers,
  rolePermissions,
} from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';
import { getTestDb } from './setup';
import { createTicket, changeTicketStatus } from '../../services/ticketService';
import { createTimeEntry } from '../../services/timeEntryService';

// Partner/org ids seeded by this file, for afterAll cleanup.
const seededPartnerIds: string[] = [];
const seededOrgIds: string[] = [];

interface Fixture {
  partnerA: { id: string };
  orgA: { id: string };
  partnerB: { id: string };
  orgB: { id: string };
  partnerAContext: DbAccessContext;
  orgAContext: DbAccessContext;
  userA: { id: string };
}

async function seedFixture(): Promise<Fixture> {
  const adminDb = getTestDb() as any;
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const partnerA = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });

  const [userA] = await adminDb
    .insert(users)
    .values({
      partnerId: partnerA.id,
      orgId: null,
      email: `cfg-rls-userA-${unique}@example.test`,
      name: 'Tech A',
      passwordHash: 'x',
      status: 'active',
    })
    .returning();

  const partnerB = await createPartner();
  const orgB = await createOrganization({ partnerId: partnerB.id });

  seededPartnerIds.push(partnerA.id, partnerB.id);
  seededOrgIds.push(orgA.id, orgB.id);

  const partnerAContext: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [orgA.id],
    accessiblePartnerIds: [partnerA.id],
    userId: userA.id,
  };

  const orgAContext: DbAccessContext = {
    scope: 'organization',
    orgId: orgA.id,
    accessibleOrgIds: [orgA.id],
    accessiblePartnerIds: [],
    userId: userA.id,
  };

  return { partnerA, orgA, partnerB, orgB, partnerAContext, orgAContext, userA };
}

/** Seed the 6 system statuses for a partner (idempotent). */
async function seedSystemStatuses(adminDb: any, partnerId: string): Promise<void> {
  await adminDb.execute(sql`
    WITH defaults(core_status, name, sort_order) AS (
      VALUES ('new'::ticket_status, 'New', 0), ('open'::ticket_status, 'Open', 1),
             ('pending'::ticket_status, 'Pending', 2), ('on_hold'::ticket_status, 'On hold', 3),
             ('resolved'::ticket_status, 'Resolved', 4), ('closed'::ticket_status, 'Closed', 5)
    )
    INSERT INTO ticket_statuses (partner_id, name, core_status, sort_order, is_system)
    SELECT ${partnerId}::uuid, d.name, d.core_status, d.sort_order, true
    FROM defaults d
    WHERE NOT EXISTS (
      SELECT 1 FROM ticket_statuses ts
      WHERE ts.partner_id = ${partnerId}::uuid AND ts.is_system AND ts.core_status = d.core_status
    )
  `);
}

afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  const adminDb = getTestDb() as any;
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);

  // audit_logs is append-only (trigger blocks DELETE/UPDATE).
  // Clear with session_replication_role to avoid FK constraint errors.
  if (seededOrgIds.length > 0) {
    const orgList = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);
    await adminDb.transaction(async (tx: any) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`DELETE FROM audit_logs WHERE org_id IN (${orgList})`);
    });
  }

  // Cleanup in FK-safe order.
  // time_entries.user_id → users; time_entries.ticket_id → tickets.
  // ticket_comments.ticket_id → tickets.
  // tickets.status_id → ticket_statuses.
  await adminDb.delete(timeEntries).where(sql`${timeEntries.partnerId} IN (${partnerList})`);
  await adminDb
    .delete(ticketComments)
    .where(
      sql`${ticketComments.ticketId} IN (SELECT id FROM tickets WHERE partner_id IN (${partnerList}))`
    );
  await adminDb.delete(tickets).where(sql`${tickets.partnerId} IN (${partnerList})`);
  await adminDb
    .delete(partnerTicketSequences)
    .where(sql`${partnerTicketSequences.partnerId} IN (${partnerList})`);
  await adminDb
    .delete(ticketCategories)
    .where(sql`${ticketCategories.partnerId} IN (${partnerList})`);
  await adminDb
    .delete(ticketStatuses)
    .where(sql`${ticketStatuses.partnerId} IN (${partnerList})`);
  await adminDb
    .delete(ticketPrioritySettings)
    .where(sql`${ticketPrioritySettings.partnerId} IN (${partnerList})`);

  if (seededOrgIds.length > 0) {
    const orgList2 = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);
    await adminDb
      .delete(orgTicketSettings)
      .where(sql`${orgTicketSettings.orgId} IN (${orgList2})`);
    await adminDb.delete(sites).where(sql`${sites.orgId} IN (${orgList2})`);
  }

  await adminDb.delete(partnerUsers).where(sql`${partnerUsers.partnerId} IN (${partnerList})`);
  const partnerRoleIds = await adminDb
    .select({ id: roles.id })
    .from(roles)
    .where(sql`${roles.partnerId} IN (${partnerList})`);
  if (partnerRoleIds.length > 0) {
    const roleIdList = sql.join(partnerRoleIds.map((r: { id: string }) => sql`${r.id}`), sql`, `);
    await adminDb.delete(rolePermissions).where(sql`${rolePermissions.roleId} IN (${roleIdList})`);
    await adminDb.delete(roles).where(sql`${roles.id} IN (${roleIdList})`);
  }
  await adminDb.delete(users).where(sql`${users.partnerId} IN (${partnerList})`);
  await adminDb.delete(organizations).where(sql`${organizations.partnerId} IN (${partnerList})`);
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

// ── 1. ticket_statuses cross-partner isolation (partner-axis, Shape 3) ──────

describe('ticket_statuses RLS isolation (partner-axis, Shape 3)', () => {
  it('partner A context cannot read partner B rows', async () => {
    const { partnerA, partnerB, partnerAContext } = await seedFixture();
    const adminDb = getTestDb() as any;
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Insert a row for partnerB via the privileged test pool (bypasses RLS).
    const [insertedRow] = await adminDb
      .insert(ticketStatuses)
      .values({
        partnerId: partnerB.id,
        name: `B-Status-${unique}`,
        coreStatus: 'open',
        isSystem: false,
      })
      .returning({ id: ticketStatuses.id });

    // Confirm the row actually exists (superuser-side) before testing invisibility.
    const existenceCheck = await adminDb
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.id, insertedRow.id));
    expect(existenceCheck).toHaveLength(1);

    // Under partnerA's RLS context (breeze_app), only partnerA rows visible.
    const rows = await withDbAccessContext(partnerAContext, () =>
      db
        .select({ id: ticketStatuses.id, partnerId: ticketStatuses.partnerId })
        .from(ticketStatuses)
    );
    expect(rows.every((r) => r.partnerId === partnerA.id)).toBe(true);
    expect(rows.some((r) => r.partnerId === partnerB.id)).toBe(false);
  });

  it('forged cross-partner insert rejects with RLS violation (42501)', async () => {
    const { partnerB, partnerAContext } = await seedFixture();
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    await expect(
      withDbAccessContext(partnerAContext, () =>
        db.insert(ticketStatuses).values({
          partnerId: partnerB.id, // wrong partner — RLS must reject
          name: `Forged-${unique}`,
          coreStatus: 'open',
          isSystem: false,
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

// ── 1b. ticket_priority_settings cross-partner isolation ────────────────────

describe('ticket_priority_settings RLS isolation (partner-axis, Shape 3)', () => {
  it('forged cross-partner insert rejects with RLS violation (42501)', async () => {
    const { partnerB, partnerAContext } = await seedFixture();

    await expect(
      withDbAccessContext(partnerAContext, () =>
        db.insert(ticketPrioritySettings).values({
          partnerId: partnerB.id, // wrong partner — RLS must reject
          priority: 'urgent',
          responseSlaMinutes: 60,
          resolutionSlaMinutes: 240,
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

// ── 1c. org_ticket_settings cross-org isolation (org-axis, Shape 1) ─────────

describe('org_ticket_settings RLS isolation (org-axis, Shape 1)', () => {
  it('forged cross-org insert rejects with RLS violation (42501)', async () => {
    const { orgB, orgAContext } = await seedFixture();

    await expect(
      withDbAccessContext(orgAContext, () =>
        db.insert(orgTicketSettings).values({
          orgId: orgB.id, // wrong org — RLS must reject
          slaOverrides: {},
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

// ── 2. System-context reads work for all three tables ───────────────────────
//
// `breeze_has_org_access` already returns TRUE for system scope, so the
// org_ticket_settings policy works correctly under system scope without
// a separate `breeze_current_scope() = 'system'` bypass.
// `breeze_has_partner_access` similarly grants system scope full access.

describe('system-context reads (scope=system) bypass partner/org RLS', () => {
  it('org_ticket_settings rows readable under system scope', async () => {
    const { orgA } = await seedFixture();
    const adminDb = getTestDb() as any;

    await adminDb.insert(orgTicketSettings).values({
      orgId: orgA.id,
      slaOverrides: { urgent: { responseMinutes: 120 } },
      defaultHourlyRate: '99.00',
    });

    // System context must see the row.
    const rows = await withSystemDbAccessContext(() =>
      db
        .select({ orgId: orgTicketSettings.orgId })
        .from(orgTicketSettings)
        .where(eq(orgTicketSettings.orgId, orgA.id))
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orgId).toBe(orgA.id);
  });

  it('ticket_statuses rows readable under system scope', async () => {
    const { partnerA } = await seedFixture();
    const adminDb = getTestDb() as any;
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    await adminDb.insert(ticketStatuses).values({
      partnerId: partnerA.id,
      name: `Sys-Readable-${unique}`,
      coreStatus: 'pending',
      isSystem: false,
    });

    const rows = await withSystemDbAccessContext(() =>
      db
        .select({ id: ticketStatuses.id })
        .from(ticketStatuses)
        .where(
          and(
            eq(ticketStatuses.partnerId, partnerA.id),
            eq(ticketStatuses.name, `Sys-Readable-${unique}`)
          )
        )
    );
    expect(rows).toHaveLength(1);
  });
});

// ── 3. Seeding idempotency ───────────────────────────────────────────────────

describe('seeding idempotency (migration seed block)', () => {
  it('re-running the seed block inserts 0 rows for an already-seeded partner', async () => {
    const adminDb = getTestDb() as any;
    const { partnerA } = await seedFixture();

    // Seed once.
    await seedSystemStatuses(adminDb, partnerA.id);
    const [{ cnt: before }] = await adminDb.execute(sql`
      SELECT count(*)::int AS cnt FROM ticket_statuses
      WHERE partner_id = ${partnerA.id}::uuid AND is_system
    `);
    expect(before).toBe(6);

    // Seed again — must be idempotent (0 new rows).
    await seedSystemStatuses(adminDb, partnerA.id);
    const [{ cnt: after }] = await adminDb.execute(sql`
      SELECT count(*)::int AS cnt FROM ticket_statuses
      WHERE partner_id = ${partnerA.id}::uuid AND is_system
    `);
    expect(after).toBe(6);
  });

  it('a new partner seeded by the migration block gets exactly 6 system rows', async () => {
    const adminDb = getTestDb() as any;
    // Create a fresh partner that has NOT had statuses seeded yet.
    const freshPartner = await createPartner();
    seededPartnerIds.push(freshPartner.id);

    const [{ cnt: before }] = await adminDb.execute(sql`
      SELECT count(*)::int AS cnt FROM ticket_statuses
      WHERE partner_id = ${freshPartner.id}::uuid AND is_system
    `);
    expect(before).toBe(0);

    await seedSystemStatuses(adminDb, freshPartner.id);

    const [{ cnt: after }] = await adminDb.execute(sql`
      SELECT count(*)::int AS cnt FROM ticket_statuses
      WHERE partner_id = ${freshPartner.id}::uuid AND is_system
    `);
    expect(after).toBe(6);
  });
});

// ── 4. System-slot uniqueness constraint ────────────────────────────────────

describe('system-slot uniqueness (ticket_statuses_partner_core_status_system_uq)', () => {
  it('forging a second is_system row for the same (partner, core_status) violates the unique index', async () => {
    const adminDb = getTestDb() as any;
    const { partnerA } = await seedFixture();
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Insert first is_system row for core_status='new'.
    await adminDb.insert(ticketStatuses).values({
      partnerId: partnerA.id,
      name: `Sys-New-A-${unique}`,
      coreStatus: 'new',
      isSystem: true,
    });

    // Second is_system row for same (partner, core_status) must fail.
    // Drizzle wraps the postgres.js error: the 23505 code is on the nested cause.
    await expect(
      adminDb.insert(ticketStatuses).values({
        partnerId: partnerA.id,
        name: `Sys-New-B-${unique}`,
        coreStatus: 'new',
        isSystem: true,
      })
    ).rejects.toMatchObject({ cause: { code: '23505', constraint_name: 'ticket_statuses_partner_core_status_system_uq' } });
  });
});

// ── 5. changeTicketStatus end-to-end (service against real DB) ──────────────

describe('changeTicketStatus end-to-end (real DB)', () => {
  it('statusId path: stamps both core status and status_id; cross-partner statusId → STATUS_NOT_FOUND', async () => {
    const adminDb = getTestDb() as any;
    const { partnerA, orgA, partnerB, partnerAContext, userA } = await seedFixture();
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Seed system statuses for both partners.
    await seedSystemStatuses(adminDb, partnerA.id);
    await seedSystemStatuses(adminDb, partnerB.id);

    // Create a custom "Waiting on Vendor" status for partnerA mapped to pending.
    const [customStatus] = await adminDb
      .insert(ticketStatuses)
      .values({
        partnerId: partnerA.id,
        name: `Waiting-${unique}`,
        coreStatus: 'pending',
        isSystem: false,
        isActive: true,
      })
      .returning();

    // Get partnerB's pending status id (for cross-partner rejection test).
    const [partnerBPendingStatus] = await adminDb
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(
        and(
          eq(ticketStatuses.partnerId, partnerB.id),
          eq(ticketStatuses.coreStatus, 'pending'),
          eq(ticketStatuses.isSystem, true)
        )
      );

    // Create a ticket for orgA starting in 'new' state.
    let ticket: any;
    await withDbAccessContext(partnerAContext, async () => {
      ticket = await createTicket(
        { orgId: orgA.id, subject: `cfg-rls-ticket-${unique}`, source: 'manual' },
        { userId: userA.id }
      );
    });

    expect(ticket.status).toBe('new');

    // ── statusId path: transition to custom "Waiting-..." status (→ pending) ──
    let updated: any;
    await withDbAccessContext(partnerAContext, async () => {
      updated = await changeTicketStatus(
        ticket.id,
        { statusId: customStatus.id },
        {},
        { userId: userA.id }
      );
    });

    expect(updated.status).toBe('pending');
    expect(updated.statusId).toBe(customStatus.id);

    // ── cross-partner statusId → STATUS_NOT_FOUND ────────────────────────────
    await expect(
      withDbAccessContext(partnerAContext, async () =>
        changeTicketStatus(
          ticket.id,
          { statusId: partnerBPendingStatus.id }, // belongs to partnerB — must reject
          {},
          { userId: userA.id }
        )
      )
    ).rejects.toMatchObject({ code: 'STATUS_NOT_FOUND' });
  });
});

// ── 6. SLA chain end-to-end (real DB) ───────────────────────────────────────

describe('SLA chain end-to-end (D7 chain order, real DB)', () => {
  it('org override (120) beats partner setting (90) when no category', async () => {
    const adminDb = getTestDb() as any;
    const { partnerA, orgA, partnerAContext, userA } = await seedFixture();
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Partner-level priority setting: response=90.
    await adminDb.insert(ticketPrioritySettings).values({
      partnerId: partnerA.id,
      priority: 'urgent',
      responseSlaMinutes: 90,
      resolutionSlaMinutes: 360,
    });

    // Org-level override: response=120 (should win over partner's 90).
    await adminDb.insert(orgTicketSettings).values({
      orgId: orgA.id,
      slaOverrides: { urgent: { responseMinutes: 120, resolutionMinutes: 480 } },
    });

    await seedSystemStatuses(adminDb, partnerA.id);

    let ticket: any;
    await withDbAccessContext(partnerAContext, async () => {
      ticket = await createTicket(
        {
          orgId: orgA.id,
          subject: `SLA-chain-${unique}`,
          source: 'manual',
          priority: 'urgent',
        },
        { userId: userA.id }
      );
    });

    // org override (120) must beat partner setting (90).
    expect(ticket.responseSlaMinutes).toBe(120);
    expect(ticket.resolutionSlaMinutes).toBe(480);
  });

  it('partner setting (90) used when no org override row exists', async () => {
    const adminDb = getTestDb() as any;
    const { partnerA, orgA, partnerAContext, userA } = await seedFixture();
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Partner-level priority setting only; no org_ticket_settings row.
    await adminDb.insert(ticketPrioritySettings).values({
      partnerId: partnerA.id,
      priority: 'urgent',
      responseSlaMinutes: 90,
      resolutionSlaMinutes: 360,
    });

    await seedSystemStatuses(adminDb, partnerA.id);

    let ticket: any;
    await withDbAccessContext(partnerAContext, async () => {
      ticket = await createTicket(
        {
          orgId: orgA.id,
          subject: `SLA-partner-only-${unique}`,
          source: 'manual',
          priority: 'urgent',
        },
        { userId: userA.id }
      );
    });

    // Partner setting (90) should win since no org override.
    expect(ticket.responseSlaMinutes).toBe(90);
    expect(ticket.resolutionSlaMinutes).toBe(360);
  });
});

// ── 7. Time-entry org-rate end-to-end (real DB) ─────────────────────────────

describe('time-entry org-rate end-to-end (D6 chain, real DB)', () => {
  it('org default_hourly_rate (150) wins over category rate (100)', async () => {
    const adminDb = getTestDb() as any;
    const { partnerA, orgA, partnerAContext, userA } = await seedFixture();
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Category with default_hourly_rate=100.
    const [categoryA] = await adminDb
      .insert(ticketCategories)
      .values({
        partnerId: partnerA.id,
        name: `Cat-${unique}`,
        defaultBillable: true,
        defaultHourlyRate: '100.00',
      })
      .returning();

    // Org override: default_hourly_rate=150 (should win over category's 100).
    await adminDb.insert(orgTicketSettings).values({
      orgId: orgA.id,
      slaOverrides: {},
      defaultHourlyRate: '150.00',
      defaultBillable: true,
    });

    await seedSystemStatuses(adminDb, partnerA.id);

    let ticket: any;
    await withDbAccessContext(partnerAContext, async () => {
      ticket = await createTicket(
        {
          orgId: orgA.id,
          subject: `rate-test-${unique}`,
          source: 'manual',
          categoryId: categoryA.id,
        },
        { userId: userA.id }
      );
    });

    const actor = { userId: userA.id, partnerId: partnerA.id, manageAll: false as const };
    let entry: any;
    await withDbAccessContext(partnerAContext, async () => {
      entry = await createTimeEntry(
        {
          ticketId: ticket.id,
          startedAt: new Date(Date.now() - 30 * 60_000),
          endedAt: new Date(),
        },
        actor
      );
    });

    // org rate (150) must win over category rate (100).
    expect(entry.hourlyRate).toBe('150.00');
    expect(entry.isBillable).toBe(true);
    expect(entry.orgId).toBe(orgA.id);
  });

  it('category rate (100) wins when org row has null default_hourly_rate', async () => {
    const adminDb = getTestDb() as any;
    const { partnerA, orgA, partnerAContext, userA } = await seedFixture();
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Category with rate=100.
    const [categoryB] = await adminDb
      .insert(ticketCategories)
      .values({
        partnerId: partnerA.id,
        name: `CatB-${unique}`,
        defaultBillable: true,
        defaultHourlyRate: '100.00',
      })
      .returning();

    // Org row with null default_hourly_rate (no rate override).
    await adminDb.insert(orgTicketSettings).values({
      orgId: orgA.id,
      slaOverrides: {},
      defaultHourlyRate: null,
      defaultBillable: null,
    });

    await seedSystemStatuses(adminDb, partnerA.id);

    let ticket: any;
    await withDbAccessContext(partnerAContext, async () => {
      ticket = await createTicket(
        {
          orgId: orgA.id,
          subject: `rate-cat-fallback-${unique}`,
          source: 'manual',
          categoryId: categoryB.id,
        },
        { userId: userA.id }
      );
    });

    const actor = { userId: userA.id, partnerId: partnerA.id, manageAll: false as const };
    let entry: any;
    await withDbAccessContext(partnerAContext, async () => {
      entry = await createTimeEntry(
        {
          ticketId: ticket.id,
          startedAt: new Date(Date.now() - 30 * 60_000),
          endedAt: new Date(),
        },
        actor
      );
    });

    // category rate (100) wins since org has null override.
    expect(entry.hourlyRate).toBe('100.00');
    expect(entry.isBillable).toBe(true);
  });
});
