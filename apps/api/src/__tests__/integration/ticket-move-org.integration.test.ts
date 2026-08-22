/**
 * Integration test: moveTicketOrg child re-stamp + cross-partner isolation + comment visibility.
 *
 * Proves:
 *   (1) All three denormalized child tables (time_entries, ticket_parts, ticket_alert_links)
 *       get their org_id re-stamped to the target org after moveTicketOrg.
 *   (2) The ticket's deviceId is set to null after the move.
 *   (3) A cross-partner target org is rejected with status 400.
 *   (4) ticket_comments (no org_id column; parent-join tenancy) remain visible to the
 *       target org scope after the move.
 *   (5) Multi-currency (#3776, Task 13): a move into an org billing in another
 *       currency is blocked (409 TICKET_MOVE_CURRENCY_BLOCKED) while unbilled
 *       monetary rows exist — regardless of is_billable — and nothing moves;
 *       with acceptCurrencyMismatch the move succeeds, the snapshots keep the
 *       OLD currency, and the audit row records the accepted counts; billed rows
 *       never block.
 *
 * Test strategy: seed all fixtures inside each `it` (setup.ts TRUNCATEs beforeEach).
 * Call moveTicketOrg directly at the service level — no HTTP — wrapped in
 * withSystemDbAccessContext (mirrors the trusted server-side call path the route uses).
 * Read-back assertions use the privileged admin pool (getTestDb()) to bypass RLS.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  tickets,
  ticketComments,
  ticketAlertLinks,
  ticketParts,
  timeEntries,
  alerts,
  alertRules,
  alertTemplates,
  auditLogs,
  devices,
  organizations,
  sites,
} from '../../db/schema';
import { moveTicketOrg, TicketServiceError } from '../../services/ticketService';
import { TicketMoveCurrencyBlockedError } from '../../services/ticketMoveCurrencyGuard';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

// ── Seed helpers ─────────────────────────────────────────────────────────────

/** Unique-ifier for ticket numbers and emails within the same test run. */
function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface MoveOrgFixture {
  partner: { id: string };
  orgA: { id: string };
  orgB: { id: string };
  actor: { userId: string };
  ticket: { id: string; orgId: string; deviceId: string | null };
  device: { id: string };
  timeEntry: { id: string };
  ticketPart: { id: string };
  alertLink: { id: string };
}

/**
 * Seeds partner P → orgA, orgB, device in orgA, ticket in orgA with device,
 * plus one time_entry, one ticket_part, and one ticket_alert_link (with an
 * alert) all tied to the ticket.
 */
async function seedMoveOrgFixture(): Promise<MoveOrgFixture> {
  const adminDb = getTestDb() as any;
  const unique = uid();

  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const actor = await createUser({
    partnerId: partner.id,
    orgId: null,
    email: `move-org-actor-${unique}@example.test`,
  });

  // Site and device in orgA (device_id FK on tickets references devices).
  const siteA = await createSite({ orgId: orgA.id });
  const [device] = await adminDb
    .insert(devices)
    .values({
      orgId: orgA.id,
      siteId: siteA.id,
      agentId: `move-org-device-${unique}`,
      hostname: `host-${unique}`,
      osType: 'windows',
      osVersion: '10.0.19041',
      architecture: 'x64',
      agentVersion: '0.1.0',
    })
    .returning();

  // Ticket in orgA, linked to the device.
  const [ticket] = await adminDb
    .insert(tickets)
    .values({
      orgId: orgA.id,
      partnerId: partner.id,
      ticketNumber: `MO-${unique}`,
      subject: `move-org test ${unique}`,
      deviceId: device.id,
      source: 'manual',
    })
    .returning();

  // time_entry: partner-axis table; orgId is denormalized from the ticket.
  const [timeEntry] = await adminDb
    .insert(timeEntries)
    .values({
      partnerId: partner.id,
      orgId: orgA.id,
      ticketId: ticket.id,
      userId: actor.id,
      startedAt: new Date(Date.now() - 60_000),
      endedAt: new Date(),
      durationMinutes: 1,
      currencyCode: 'USD',
    })
    .returning();

  // ticket_part: org-axis table.
  const [ticketPart] = await adminDb
    .insert(ticketParts)
    .values({
      ticketId: ticket.id,
      orgId: orgA.id,
      description: 'test part',
      quantity: '1.00',
      currencyCode: 'USD',
    })
    .returning();

  // Alert and alert_link: alerts requires a device_id; alert_rule is optional.
  const [alertTemplate] = await adminDb
    .insert(alertTemplates)
    .values({
      partnerId: partner.id,
      name: `move-org-template-${unique}`,
      conditions: {},
      severity: 'info',
      titleTemplate: 'test',
      messageTemplate: 'test',
    })
    .returning();

  const [alertRule] = await adminDb
    .insert(alertRules)
    .values({
      orgId: orgA.id,
      templateId: alertTemplate.id,
      name: `move-org-rule-${unique}`,
      targetType: 'device',
      targetId: device.id,
    })
    .returning();

  const [alert] = await adminDb
    .insert(alerts)
    .values({
      ruleId: alertRule.id,
      deviceId: device.id,
      orgId: orgA.id,
      severity: 'info',
      title: `move-org alert ${unique}`,
    })
    .returning();

  const [alertLink] = await adminDb
    .insert(ticketAlertLinks)
    .values({
      ticketId: ticket.id,
      orgId: orgA.id,
      alertId: alert.id,
      linkType: 'attached',
    })
    .returning();

  return {
    partner,
    orgA,
    orgB,
    actor: { userId: actor.id },
    ticket,
    device,
    timeEntry,
    ticketPart,
    alertLink,
  };
}

interface CrossPartnerFixture {
  ticket: { id: string };
  orgOtherPartner: { id: string };
}

/**
 * Seeds two completely separate partners (different partners, so cross-partner
 * move is attempted). ticketP1 is in partner1/orgA; target is partner2/orgC.
 */
async function seedCrossPartnerFixture(): Promise<CrossPartnerFixture> {
  const adminDb = getTestDb() as any;
  const unique = uid();

  const partner1 = await createPartner();
  const partner2 = await createPartner();
  const orgA = await createOrganization({ partnerId: partner1.id });
  const orgC = await createOrganization({ partnerId: partner2.id });
  const actor = await createUser({
    partnerId: partner1.id,
    orgId: null,
    email: `cross-partner-actor-${unique}@example.test`,
  });

  const [ticket] = await adminDb
    .insert(tickets)
    .values({
      orgId: orgA.id,
      partnerId: partner1.id,
      ticketNumber: `CP-${unique}`,
      subject: `cross-partner test ${unique}`,
      source: 'manual',
    })
    .returning();

  return { ticket, orgOtherPartner: orgC };
}

// ── Read-back helpers (admin pool, bypasses RLS) ──────────────────────────────

async function readTicket(id: string) {
  const adminDb = getTestDb() as any;
  const [row] = await adminDb.select().from(tickets).where(eq(tickets.id, id)).limit(1);
  return row as (typeof tickets.$inferSelect) | undefined;
}

async function readTimeEntry(id: string) {
  const adminDb = getTestDb() as any;
  const [row] = await adminDb.select().from(timeEntries).where(eq(timeEntries.id, id)).limit(1);
  return row as (typeof timeEntries.$inferSelect) | undefined;
}

async function readTicketPart(id: string) {
  const adminDb = getTestDb() as any;
  const [row] = await adminDb.select().from(ticketParts).where(eq(ticketParts.id, id)).limit(1);
  return row as (typeof ticketParts.$inferSelect) | undefined;
}

async function readAlertLink(id: string) {
  const adminDb = getTestDb() as any;
  const [row] = await adminDb
    .select()
    .from(ticketAlertLinks)
    .where(eq(ticketAlertLinks.id, id))
    .limit(1);
  return row as (typeof ticketAlertLinks.$inferSelect) | undefined;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('moveTicketOrg — service-level integration', () => {
  it('re-stamps org_id on all denormalized children and detaches the device', async () => {
    const { orgB, actor, ticket, timeEntry, ticketPart, alertLink } =
      await seedMoveOrgFixture();

    await withSystemDbAccessContext(() =>
      moveTicketOrg(ticket.id, orgB.id, actor)
    );

    const movedTicket = await readTicket(ticket.id);
    expect(movedTicket?.orgId).toBe(orgB.id);
    expect(movedTicket?.deviceId).toBeNull();

    const movedTimeEntry = await readTimeEntry(timeEntry.id);
    expect(movedTimeEntry?.orgId).toBe(orgB.id);

    const movedPart = await readTicketPart(ticketPart.id);
    expect(movedPart?.orgId).toBe(orgB.id);

    const movedLink = await readAlertLink(alertLink.id);
    expect(movedLink?.orgId).toBe(orgB.id);
  });

  it('rejects a cross-partner target org with status 400', async () => {
    const { ticket, orgOtherPartner } = await seedCrossPartnerFixture();
    const unique = uid();
    const actor = { userId: (await createUser({
      partnerId: (await createPartner()).id,
      email: `cross-actor-${unique}@example.test`,
    })).id };

    await expect(
      withSystemDbAccessContext(() =>
        moveTicketOrg(ticket.id, orgOtherPartner.id, actor)
      )
    ).rejects.toMatchObject({ status: 400 });
  });

  it('comments remain visible to target org after move (parent-join tenancy)', async () => {
    const adminDb = getTestDb() as any;
    const { partner, orgA, orgB, actor, ticket } = await seedMoveOrgFixture();
    const unique = uid();

    // Seed a comment on the ticket before the move.
    const [comment] = await adminDb
      .insert(ticketComments)
      .values({
        ticketId: ticket.id,
        userId: actor.userId,
        authorType: 'technician',
        content: `pre-move comment ${unique}`,
      })
      .returning();

    // Move the ticket from orgA to orgB.
    await withSystemDbAccessContext(() =>
      moveTicketOrg(ticket.id, orgB.id, actor)
    );

    // After the move the ticket belongs to orgB; a connection scoped to orgB
    // should still see the comment via the ticket-parent RLS join.
    const orgBContext: DbAccessContext = {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [orgB.id],
      accessiblePartnerIds: [partner.id],
      userId: actor.userId,
    };

    const rows = await withDbAccessContext(orgBContext, () =>
      db
        .select({ id: ticketComments.id, content: ticketComments.content })
        .from(ticketComments)
        .where(eq(ticketComments.ticketId, ticket.id))
    );

    // The user-seeded comment plus the system "Moved to …" comment written by
    // moveTicketOrg should both appear.
    const commentIds = rows.map((r) => r.id);
    expect(commentIds).toContain(comment.id);
  });
});

// ── Multi-currency guard (#3776, Task 13) ────────────────────────────────────

async function setOrgCurrency(orgId: string, currencyCode: string) {
  const adminDb = getTestDb() as any;
  await adminDb.update(organizations).set({ currencyCode }).where(eq(organizations.id, orgId));
}

describe('moveTicketOrg — cross-currency guard (#3776)', () => {
  it('blocks a USD→EUR move while an unbilled rated entry exists, even when it is not billable; nothing moves', async () => {
    const adminDb = getTestDb() as any;
    const { orgA, orgB, actor, ticket, timeEntry, ticketPart } = await seedMoveOrgFixture();
    await setOrgCurrency(orgB.id, 'EUR');
    // Rated, not_billed, NOT billable — the guard protects the snapshot regardless.
    await adminDb.update(timeEntries)
      .set({ hourlyRate: '100.00', isBillable: false, billingStatus: 'not_billed' })
      .where(eq(timeEntries.id, timeEntry.id));
    // The seeded part is unit_price NOT NULL (money) — drop it so the count
    // isolates the time-entry case.
    await adminDb.delete(ticketParts).where(eq(ticketParts.id, ticketPart.id));

    const err = await withSystemDbAccessContext(() =>
      moveTicketOrg(ticket.id, orgB.id, actor)
    ).catch((e) => e);
    expect(err).toBeInstanceOf(TicketMoveCurrencyBlockedError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('TICKET_MOVE_CURRENCY_BLOCKED');
    expect(err.details).toEqual({
      sourceCurrency: 'USD', targetCurrency: 'EUR', unbilledTimeEntries: 1, unbilledParts: 0, accepted: false,
    });

    // The transaction rolled back: ticket, device link and children untouched.
    const after = await readTicket(ticket.id);
    expect(after?.orgId).toBe(orgA.id);
    expect(after?.deviceId).toBe(ticket.deviceId);
    const entryAfter = await readTimeEntry(timeEntry.id);
    expect(entryAfter?.orgId).toBe(orgA.id);
    expect(entryAfter?.currencyCode).toBe('USD');
    // No "Moved to" feed entry either.
    const feed = await adminDb.select({ id: ticketComments.id }).from(ticketComments).where(eq(ticketComments.ticketId, ticket.id));
    expect(feed).toHaveLength(0);
    // No audit row for the blocked move.
    const audits = await adminDb.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.resourceId, ticket.id));
    expect(audits).toHaveLength(0);
  });

  it('acceptCurrencyMismatch moves the ticket, keeps the USD snapshot under the EUR org, and audits the accepted counts', async () => {
    const adminDb = getTestDb() as any;
    const { orgB, actor, ticket, timeEntry, ticketPart } = await seedMoveOrgFixture();
    await setOrgCurrency(orgB.id, 'EUR');
    await adminDb.update(timeEntries)
      .set({ hourlyRate: '100.00', isBillable: false, billingStatus: 'not_billed' })
      .where(eq(timeEntries.id, timeEntry.id));
    await adminDb.delete(ticketParts).where(eq(ticketParts.id, ticketPart.id));

    const moved = await withSystemDbAccessContext(() =>
      moveTicketOrg(ticket.id, orgB.id, actor, { acceptCurrencyMismatch: true })
    );
    expect(moved.orgId).toBe(orgB.id);

    const entryAfter = await readTimeEntry(timeEntry.id);
    expect(entryAfter?.orgId).toBe(orgB.id);
    expect(entryAfter?.currencyCode).toBe('USD'); // snapshot never restamped
    expect(entryAfter?.hourlyRate).toBe('100.00');

    const [sourceAudit] = await adminDb
      .select({ details: auditLogs.details })
      .from(auditLogs)
      .where(and(eq(auditLogs.resourceId, ticket.id), eq(auditLogs.action, 'ticket.move_org.source')));
    expect(sourceAudit?.details).toMatchObject({
      currencyMismatchAccepted: {
        sourceCurrency: 'USD', targetCurrency: 'EUR', unbilledTimeEntries: 1, unbilledParts: 0, accepted: true,
      },
    });

    const feed = await adminDb
      .select({ content: ticketComments.content })
      .from(ticketComments)
      .where(eq(ticketComments.ticketId, ticket.id));
    expect(feed.some((r: { content: string }) => r.content.includes('1 unbilled items stay in USD'))).toBe(true);
  });

  it('a billed entry never blocks: the plain cross-currency move succeeds and the snapshot stays USD', async () => {
    const adminDb = getTestDb() as any;
    const { orgB, actor, ticket, timeEntry, ticketPart } = await seedMoveOrgFixture();
    await setOrgCurrency(orgB.id, 'EUR');
    await adminDb.update(timeEntries)
      .set({ hourlyRate: '100.00', isBillable: true, billingStatus: 'billed' })
      .where(eq(timeEntries.id, timeEntry.id));
    await adminDb.update(ticketParts)
      .set({ billingStatus: 'billed' })
      .where(eq(ticketParts.id, ticketPart.id));

    const moved = await withSystemDbAccessContext(() =>
      moveTicketOrg(ticket.id, orgB.id, actor)
    );
    expect(moved.orgId).toBe(orgB.id);
    const entryAfter = await readTimeEntry(timeEntry.id);
    expect(entryAfter?.orgId).toBe(orgB.id);
    expect(entryAfter?.currencyCode).toBe('USD');
    const partAfter = await readTicketPart(ticketPart.id);
    expect(partAfter?.orgId).toBe(orgB.id);
    expect(partAfter?.currencyCode).toBe('USD');

    const [sourceAudit] = await adminDb
      .select({ details: auditLogs.details })
      .from(auditLogs)
      .where(and(eq(auditLogs.resourceId, ticket.id), eq(auditLogs.action, 'ticket.move_org.source')));
    expect(sourceAudit?.details).not.toHaveProperty('currencyMismatchAccepted');
  });

  it('an unbilled part (unit_price is always money) blocks on its own', async () => {
    const { orgA, orgB, actor, ticket, ticketPart } = await seedMoveOrgFixture();
    await setOrgCurrency(orgB.id, 'EUR');
    // Seeded entry carries no hourly_rate → not money; the part (unit_price NOT NULL) is.
    const err = await withSystemDbAccessContext(() =>
      moveTicketOrg(ticket.id, orgB.id, actor)
    ).catch((e) => e);
    expect(err).toBeInstanceOf(TicketMoveCurrencyBlockedError);
    expect(err.details).toMatchObject({ unbilledTimeEntries: 0, unbilledParts: 1 });
    expect((await readTicketPart(ticketPart.id))?.orgId).toBe(orgA.id);
    expect((await readTicket(ticket.id))?.orgId).toBe(orgA.id);
  });
});
