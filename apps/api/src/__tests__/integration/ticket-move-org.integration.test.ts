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
import { randomUUID } from 'node:crypto';
import {
  contacts,
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
  ticketDrafts,
  actionIntents,
  aiAgents,
  aiAgentRuns,
  users,
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
      blockedByCurrency: [{ currencyCode: 'USD', timeEntries: 1, parts: 0 }],
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
        blockedByCurrency: [{ currencyCode: 'USD', timeEntries: 1, parts: 0 }],
      },
    });

    const feed = await adminDb
      .select({ content: ticketComments.content })
      .from(ticketComments)
      .where(eq(ticketComments.ticketId, ticket.id));
    expect(feed.some((r: { content: string }) => r.content.includes('1 unbilled items stay in USD'))).toBe(true);
  });

  it('moving back to a USD org after an accepted USD→EUR move is not blocked: the preserved USD rows already match (review #4)', async () => {
    const adminDb = getTestDb() as any;
    const { orgA, orgB, actor, ticket, timeEntry, ticketPart } = await seedMoveOrgFixture();
    await setOrgCurrency(orgB.id, 'EUR');
    await adminDb.update(timeEntries)
      .set({ hourlyRate: '100.00', isBillable: true, billingStatus: 'not_billed' })
      .where(eq(timeEntries.id, timeEntry.id));
    await adminDb.delete(ticketParts).where(eq(ticketParts.id, ticketPart.id));

    await withSystemDbAccessContext(() => moveTicketOrg(ticket.id, orgB.id, actor, { acceptCurrencyMismatch: true }));
    expect((await readTimeEntry(timeEntry.id))?.currencyCode).toBe('USD');

    // EUR org → USD org, no acceptance: the row's snapshot IS the target currency.
    const back = await withSystemDbAccessContext(() => moveTicketOrg(ticket.id, orgA.id, actor));
    expect(back.orgId).toBe(orgA.id);
    const entryAfter = await readTimeEntry(timeEntry.id);
    expect(entryAfter?.orgId).toBe(orgA.id);
    expect(entryAfter?.currencyCode).toBe('USD');
    const feed = await adminDb
      .select({ content: ticketComments.content })
      .from(ticketComments)
      .where(eq(ticketComments.ticketId, ticket.id))
      .orderBy(ticketComments.createdAt);
    const moves = feed.filter((r: { content: string }) => r.content.startsWith('Moved to '));
    expect(moves).toHaveLength(2);
    // First move stranded the USD row under EUR; the move back strands nothing.
    expect(moves[0]!.content).toContain('1 unbilled items stay in USD');
    expect(moves[1]!.content).not.toContain('stay in');
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

// ── C1 fix (final review #4191): ticket_drafts cleanup + scope_ticket_id
// tombstone (ALL statuses) inside moveTicketOrg's own transaction ──────────

/**
 * Seeds an agent (in orgA) + a live ai_agent_runs row + one action_intents
 * row scoped to the given ticket via scope_kind='ticket'/scope_ticket_id,
 * at the given terminal/live status. Mirrors
 * `actionIntentsImmutabilityTrigger.integration.test.ts`'s `seedPendingIntent`
 * fixture shape (same required-column set), parameterized by status so both
 * a completed (terminal) and a pending_approval (live) row can be seeded in
 * the same test — proving the C1 tombstone applies to BOTH, not just the
 * two live pre-release statuses the old AI-tool-path-only tombstone covered.
 */
/**
 * Seeds one `ai_agents` row for the org (a fixture prerequisite for the
 * `ai_agent_runs` that `seedTicketScopedIntent` needs). `ai_agents` has a
 * `(org_id, kind)` unique constraint, so this must be called ONCE per org
 * and its id reused across every intent seeded for that org in the same
 * test — NOT re-seeded per intent.
 */
async function seedTriageAgent(orgId: string, partnerId: string): Promise<{ id: string }> {
  const adminDb = getTestDb() as any;
  const unique = uid();
  const [user] = await adminDb
    .insert(users)
    .values({
      partnerId,
      orgId,
      email: `move-org-intent-actor-${unique}@example.test`,
      name: 'Move Org Intent Actor',
      status: 'active',
    })
    .returning();
  const [agent] = await adminDb
    .insert(aiAgents)
    .values({ orgId, partnerId: null, kind: 'triage', name: 'Triage', createdBy: user.id })
    .returning();
  return { id: agent.id };
}

/**
 * Seeds one live `ai_agent_runs` row plus one `action_intents` row scoped to
 * `ticketId` via scope_kind='ticket'/scope_ticket_id, at the given
 * terminal/live `status`. Reuses the given `agentId` (see `seedTriageAgent`
 * — `ai_agents` has a `(org_id, kind)` unique constraint, so a fresh agent
 * per intent would collide when two intents are seeded for the same org in
 * one test). Parameterized by status so both a completed (terminal) and a
 * pending_approval (live) row can be seeded in the same test — proving the
 * C1 tombstone applies to BOTH, not just the two live pre-release statuses
 * the old AI-tool-path-only tombstone covered.
 */
async function seedTicketScopedIntent(
  orgId: string,
  partnerId: string,
  agentId: string,
  ticketId: string,
  status: (typeof actionIntents.$inferSelect)['status'],
): Promise<{ id: string }> {
  const adminDb = getTestDb() as any;
  const unique = uid();

  const [run] = await adminDb
    .insert(aiAgentRuns)
    .values({
      agentId,
      orgId,
      triggerKind: 'ticket',
      dedupeKey: `move-org-intent-${unique}`,
      modeAtStart: 'shadow',
      policySnapshot: { schemaVersion: 1 },
    })
    .returning();
  const [intent] = await adminDb
    .insert(actionIntents)
    .values({
      orgId,
      partnerId,
      requestedByUserId: null,
      requestingApiKeyId: null,
      requestingAgentRunId: run.id,
      source: 'ai_agent',
      originPrincipalKind: 'ai_agent',
      originPrincipalId: agentId,
      actionName: 'manage_tickets',
      actionVersion: 1,
      arguments: { ticketId },
      argumentDigest: 'b'.repeat(64),
      targetSummary: `Ticket ${ticketId}`,
      impactSummary: 'Ticket triage action',
      reason: 'Triage proposal',
      riskTier: 1,
      connectionId: randomUUID(),
      tenantId: randomUUID(),
      idempotencyKey: `move-org-idem-${unique}`,
      correlationId: randomUUID(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      status,
      scopeKind: 'ticket',
      scopeTicketId: ticketId,
    })
    .returning();
  return { id: intent.id };
}

async function readDraftsForTicket(ticketId: string) {
  const adminDb = getTestDb() as any;
  return adminDb.select().from(ticketDrafts).where(eq(ticketDrafts.ticketId, ticketId));
}

async function readIntent(id: string) {
  const adminDb = getTestDb() as any;
  const [row] = await adminDb.select().from(actionIntents).where(eq(actionIntents.id, id)).limit(1);
  return row as (typeof actionIntents.$inferSelect) | undefined;
}

describe('moveTicketOrg — ticket_drafts cleanup + scope_ticket_id tombstone (C1, final review #4191)', () => {
  it('deletes ticket_drafts and nulls scope_ticket_id on BOTH a completed and a pending intent', async () => {
    const { orgA, orgB, partner, actor, ticket } = await seedMoveOrgFixture();
    const adminDb = getTestDb() as any;

    const [draft] = await adminDb
      .insert(ticketDrafts)
      .values({
        orgId: orgA.id,
        ticketId: ticket.id,
        kind: 'reply',
        content: 'Proposed reply draft',
        state: 'active',
      })
      .returning();

    const agent = await seedTriageAgent(orgA.id, partner.id);
    const completedIntent = await seedTicketScopedIntent(orgA.id, partner.id, agent.id, ticket.id, 'completed');
    const pendingIntent = await seedTicketScopedIntent(orgA.id, partner.id, agent.id, ticket.id, 'pending_approval');

    // Sanity: both rows exist and are scoped to the pre-move ticket/org before the move.
    expect((await readDraftsForTicket(ticket.id))).toHaveLength(1);
    expect((await readIntent(completedIntent.id))?.scopeTicketId).toBe(ticket.id);
    expect((await readIntent(pendingIntent.id))?.scopeTicketId).toBe(ticket.id);

    await withSystemDbAccessContext(() => moveTicketOrg(ticket.id, orgB.id, actor));

    // Ticket actually moved (would previously 23503 before draft/intent rows
    // referencing the old (ticket_id, org_id) pair were cleared).
    expect((await readTicket(ticket.id))?.orgId).toBe(orgB.id);

    // ticket_drafts rows for this ticket are gone — both the query by
    // ticket_id and a direct by-id lookup of the specific seeded row.
    expect(await readDraftsForTicket(ticket.id)).toHaveLength(0);
    const draftAfter = await adminDb.select().from(ticketDrafts).where(eq(ticketDrafts.id, draft.id)).limit(1);
    expect(draftAfter).toHaveLength(0);

    // scope_ticket_id is NULL on BOTH the completed (terminal) and the
    // pending (live) intent — proving the tombstone is not status-gated.
    const completedAfter = await readIntent(completedIntent.id);
    const pendingAfter = await readIntent(pendingIntent.id);
    expect(completedAfter?.scopeTicketId).toBeNull();
    expect(completedAfter?.status).toBe('completed');
    expect(pendingAfter?.scopeTicketId).toBeNull();
    expect(pendingAfter?.status).toBe('pending_approval');
  });

  it('a second move of the same ticket to a third org does not 23503 (regression: this is exactly how the bug reproduced)', async () => {
    const { orgA, orgB, partner, actor, ticket } = await seedMoveOrgFixture();
    const orgC = await createOrganization({ partnerId: partner.id });
    const adminDb = getTestDb() as any;

    await adminDb.insert(ticketDrafts).values({
      orgId: orgA.id,
      ticketId: ticket.id,
      kind: 'resolution_note',
      content: 'Proposed resolution',
      state: 'active',
    });
    const agent = await seedTriageAgent(orgA.id, partner.id);
    await seedTicketScopedIntent(orgA.id, partner.id, agent.id, ticket.id, 'failed');

    await withSystemDbAccessContext(() => moveTicketOrg(ticket.id, orgB.id, actor));
    // Before the fix, this second move would 23503 on the leftover
    // ticket_drafts_ticket_org_fk / action_intents_scope_ticket_org_fk rows.
    await withSystemDbAccessContext(() => moveTicketOrg(ticket.id, orgC.id, actor));

    expect((await readTicket(ticket.id))?.orgId).toBe(orgC.id);
  });
});

// ── #3258 W03 review C1: the requester contact does not move with the ticket ──

describe('moveTicketOrg — requester contact detach (#3258 W03)', () => {
  it('moves a contact-linked ticket without 23503 and leaves the link null', async () => {
    const { orgA, orgB, partner, actor, ticket } = await seedMoveOrgFixture();
    const adminDb = getTestDb() as any;

    const [contact] = await adminDb
      .insert(contacts)
      .values({ orgId: orgA.id, email: `requester-${uid()}@example.test`, name: 'Requester Person' })
      .returning();
    await adminDb
      .update(tickets)
      .set({ requesterContactId: contact.id, submitterEmail: contact.email, submitterName: contact.name })
      .where(eq(tickets.id, ticket.id));

    // `tickets_requester_contact_org_fk` is DEFERRABLE INITIALLY IMMEDIATE and
    // this transaction issues no `SET CONSTRAINTS ... DEFERRED`, so it is
    // checked the instant the org_id UPDATE completes. Before the fix this
    // threw 23503 and NO part of the move landed.
    await withSystemDbAccessContext(() => moveTicketOrg(ticket.id, orgB.id, actor));

    const moved = await readTicket(ticket.id);
    expect(moved?.orgId).toBe(orgB.id);
    expect(moved?.requesterContactId).toBeNull();
    // The point-in-time snapshot is deliberately untouched — the move drops the
    // link to a live contact row, not the record of who filed the ticket.
    expect(moved?.submitterEmail).toBe(contact.email);
    expect(moved?.submitterName).toBe('Requester Person');

    // The contact stays in its own organization; nothing about it was moved.
    const [after] = await adminDb.select().from(contacts).where(eq(contacts.id, contact.id));
    expect(after.orgId).toBe(orgA.id);
  });
});
