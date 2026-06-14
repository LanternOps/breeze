/**
 * Cross-partner isolation integration test for the inbound email pipeline
 * (real postgres.js driver).
 *
 * Task 12 of docs/superpowers/plans/2026-06-13-ticketing-phase4-email-ingest-backend.md.
 *
 * The unit tests in inboundEmailService.test.ts mock the DB; this suite proves
 * the app-level isolation guards in `processInboundEmail` hold against a REAL
 * Postgres under the worker's actual context — `withSystemDbAccessContext`,
 * where RLS is BYPASSED for the app role (system scope sees all partners). In
 * that context the only thing stopping a cross-tenant write is the application
 * code's partner-scoped reads + write-boundary re-assertion guards (spec §6).
 *
 * Partner resolution: we SEED a `partner_inbound_domains` row per partner and
 * address each test email to that partner's custom domain. This makes the
 * resolver deterministic without depending on the `TICKETS_INBOUND_DOMAIN` env
 * var being set in the test process (the resolver checks partner_inbound_domains
 * FIRST, then the slug address).
 *
 * Seeding strategy mirrors emailInboundRls.integration.test.ts: partners/orgs via
 * the integration db-utils factories (superuser pool, RLS-bypassing), and the
 * feature rows (domains, portal users, tickets) inserted directly on the
 * superuser test pool so they are committed and visible to the separate
 * `breeze_app` pool that `processInboundEmail` runs against.
 */
import '../../__tests__/integration/setup';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import {
  ticketEmailInbound,
  partnerInboundDomains,
  tickets,
  ticketComments,
  portalUsers,
  organizations,
  partners
} from '../../db/schema';
import { createOrganization, createPartner } from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { processInboundEmail } from './inboundEmailService';
import type { NormalizedInboundEmail } from './types';

const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Superuser pool used for seeding + assertions (RLS-bypassing). Separate from the
// `breeze_app` pool that `processInboundEmail` connects through.
function admin() {
  return getTestDb() as any;
}

// All ids seeded by this suite, accumulated across tests for a final FK-safe
// afterAll sweep. The integration setup's global beforeEach TRUNCATEs core tenant
// tables CASCADE between tests, so the fixture is re-seeded per test (beforeEach
// below, which runs AFTER setup's cleanup because it is registered later).
const seeded = {
  partnerIds: [] as string[],
  orgIds: [] as string[]
};

interface Fixture {
  partnerA: { id: string };
  partnerB: { id: string };
  orgA: { id: string };
  orgB: { id: string };
  domainA: string;
  domainB: string;
  // A known portal user under partner A's org.
  janeEmail: string;
  // Partner B's victim ticket (forged-reference target).
  bTicketId: string;
  bThreadKey: string;
  bInternalNumber: string;
  // A resolved partner-A ticket for the reopen case.
  aResolvedTicketId: string;
  aResolvedThreadKey: string;
}

let fx: Fixture;

function buildEmail(overrides: Partial<NormalizedInboundEmail> & { to: string; from: string }): NormalizedInboundEmail {
  return {
    provider: 'mailgun',
    providerMessageId: `<msg-${uniqueSuffix()}@customer.test>`,
    subject: 'Hello support',
    text: 'I need help with my printer.',
    attachments: [],
    raw: {},
    ...overrides
  };
}

beforeEach(async () => {
  const db = admin();
  const suffix = uniqueSuffix();

  const partnerA = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const partnerB = await createPartner();
  const orgB = await createOrganization({ partnerId: partnerB.id });

  seeded.partnerIds.push(partnerA.id, partnerB.id);
  seeded.orgIds.push(orgA.id, orgB.id);

  const domainA = `a-${suffix}.tickets.test`;
  const domainB = `b-${suffix}.tickets.test`;

  await db.insert(partnerInboundDomains).values([
    { partnerId: partnerA.id, domain: domainA, provider: 'mailgun', verificationStatus: 'verified' },
    { partnerId: partnerB.id, domain: domainB, provider: 'mailgun', verificationStatus: 'verified' }
  ]);

  // Known portal user under partner A's org (the "created" + comment-author cases).
  const janeEmail = `jane-${suffix}@known.test`;
  await db.insert(portalUsers).values({ orgId: orgA.id, email: janeEmail, name: 'Jane Known' });

  // Partner B's victim ticket. Known thread key + internal number so a forged
  // reference addressed to partner A could only match it if the guards failed.
  const bThreadKey = `<thread-b-${suffix}@b.test>`;
  const bInternalNumber = `T-2026-${suffix.slice(-4)}`;
  const [bTicket] = await db
    .insert(tickets)
    .values({
      orgId: orgB.id,
      partnerId: partnerB.id,
      ticketNumber: `LEGACY-B-${suffix}`,
      internalNumber: bInternalNumber,
      subject: 'Partner B printer down',
      status: 'open',
      source: 'email',
      emailThreadKey: bThreadKey
    })
    .returning({ id: tickets.id });

  // A resolved partner-A ticket for the reopen case (distinct thread key).
  const aResolvedThreadKey = `<thread-a-${suffix}@a.test>`;
  const [aTicket] = await db
    .insert(tickets)
    .values({
      orgId: orgA.id,
      partnerId: partnerA.id,
      ticketNumber: `LEGACY-A-${suffix}`,
      internalNumber: `T-2026-${(Number(suffix.slice(-4)) + 1).toString().padStart(4, '0')}`,
      subject: 'Partner A laptop issue',
      status: 'resolved',
      source: 'email',
      emailThreadKey: aResolvedThreadKey,
      resolvedAt: new Date()
    })
    .returning({ id: tickets.id });

  fx = {
    partnerA,
    partnerB,
    orgA,
    orgB,
    domainA,
    domainB,
    janeEmail,
    bTicketId: bTicket.id,
    bThreadKey,
    bInternalNumber,
    aResolvedTicketId: aTicket.id,
    aResolvedThreadKey
  };
});

afterAll(async () => {
  const db = admin();
  if (seeded.partnerIds.length === 0) return;
  const partnerList = sql.join(seeded.partnerIds.map((id) => sql`${id}`), sql`, `);
  const orgList = sql.join(seeded.orgIds.map((id) => sql`${id}`), sql`, `);

  // FK-safe order: comments -> tickets -> portal_users -> inbound rows -> domains
  //   -> ticket-number sequences -> audit_logs (createTicket writes ticket.create
  //   rows FK'd to organizations) -> orgs -> partners.
  await db.delete(ticketComments).where(
    sql`${ticketComments.ticketId} IN (SELECT id FROM tickets WHERE partner_id IN (${partnerList}))`
  );
  await db.delete(ticketEmailInbound).where(sql`${ticketEmailInbound.partnerId} IN (${partnerList})`);
  await db.delete(tickets).where(sql`${tickets.partnerId} IN (${partnerList})`);
  await db.delete(portalUsers).where(sql`${portalUsers.orgId} IN (${orgList})`);
  await db.delete(partnerInboundDomains).where(sql`${partnerInboundDomains.partnerId} IN (${partnerList})`);
  await db.execute(sql`DELETE FROM partner_ticket_sequences WHERE partner_id IN (${partnerList})`);
  // audit_logs is append-only (BEFORE DELETE / BEFORE TRUNCATE triggers raise),
  // so setup.ts's TRUNCATE-CASCADE silently no-ops on it and createTicket's
  // ticket.create rows survive, FK-blocking the org delete. Drop the triggers for
  // this one DELETE via session_replication_role=replica (same approach as the
  // audit-logs-rls flakiness fix), scoped to the seeded orgs. Run inside a single
  // transaction so the SET and the DELETE land on the SAME pooled connection.
  await db.transaction(async (tx: any) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`DELETE FROM audit_logs WHERE org_id IN (${orgList})`);
  });
  await db.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  await db.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

// Reads on the superuser pool (RLS-bypassing) — used for cross-partner assertions.
async function inboundRowsFor(partnerId: string, providerMessageId: string) {
  return admin()
    .select()
    .from(ticketEmailInbound)
    .where(and(eq(ticketEmailInbound.partnerId, partnerId), eq(ticketEmailInbound.providerMessageId, providerMessageId)));
}

async function ticketById(id: string) {
  const rows = await admin().select().from(tickets).where(eq(tickets.id, id)).limit(1);
  return rows[0];
}

async function commentsForTicket(id: string) {
  return admin().select().from(ticketComments).where(eq(ticketComments.ticketId, id));
}

describe('processInboundEmail — cross-partner isolation (real driver, system context)', () => {
  it('CASE 1: a forged cross-partner reference is contained — partner B is untouched, outcome logged under A only', async () => {
    // Snapshot partner B's victim ticket + its comment count BEFORE.
    const bBefore = await ticketById(fx.bTicketId);
    const bCommentsBefore = await commentsForTicket(fx.bTicketId);
    expect(bBefore.status).toBe('open');

    // Email addressed to PARTNER A, but every threading signal points at partner B's
    // ticket: In-Reply-To / References = B's thread key, subject token = B's number.
    // Sender is unknown so the (correctly contained) outcome is a quarantine under A.
    const providerMessageId = `<forge-${uniqueSuffix()}@attacker.test>`;
    const email = buildEmail({
      to: `support@${fx.domainA}`,
      from: `attacker-${uniqueSuffix()}@nowhere.test`,
      subject: `Re: [${fx.bInternalNumber}] printer down`,
      inReplyTo: fx.bThreadKey,
      references: [fx.bThreadKey],
      providerMessageId
    });

    await withSystemDbAccessContext(() => processInboundEmail(email));

    // Partner B's ticket is UNCHANGED.
    const bAfter = await ticketById(fx.bTicketId);
    expect(bAfter.status).toBe('open');
    expect(bAfter.updatedAt).toEqual(bBefore.updatedAt);
    const bCommentsAfter = await commentsForTicket(fx.bTicketId);
    expect(bCommentsAfter.length).toBe(bCommentsBefore.length);

    // The outcome is recorded under PARTNER A only — and never `matched` against B.
    const aRows = await inboundRowsFor(fx.partnerA.id, providerMessageId);
    expect(aRows.length).toBe(1);
    expect(aRows[0].partnerId).toBe(fx.partnerA.id);
    expect(['created', 'quarantined', 'failed']).toContain(aRows[0].parseStatus);
    expect(aRows[0].parseStatus).not.toBe('matched');
    // With an unknown sender the contained outcome is a quarantine (no ticket).
    expect(aRows[0].parseStatus).toBe('quarantined');
    expect(aRows[0].ticketId).toBeNull();

    // No inbound row was ever written under partner B for this message.
    const bRows = await inboundRowsFor(fx.partnerB.id, providerMessageId);
    expect(bRows.length).toBe(0);

    // CRITICAL: if partner B's ticket was touched, this is a REAL isolation hole.
    if (bAfter.status !== 'open' || bCommentsAfter.length !== bCommentsBefore.length) {
      throw new Error('ISOLATION HOLE: forged cross-partner reference mutated partner B');
    }
  });

  it('CASE 2: created path — unmatched email from a known partner-A portal user creates a source:email ticket', async () => {
    const providerMessageId = `<created-${uniqueSuffix()}@known.test>`;
    const email = buildEmail({
      to: `support@${fx.domainA}`,
      from: fx.janeEmail,
      fromName: 'Jane Known',
      subject: 'My monitor is flickering',
      text: 'It started this morning.',
      providerMessageId
    });

    await withSystemDbAccessContext(() => processInboundEmail(email));

    const aRows = await inboundRowsFor(fx.partnerA.id, providerMessageId);
    expect(aRows.length).toBe(1);
    expect(aRows[0].partnerId).toBe(fx.partnerA.id);
    expect(aRows[0].parseStatus).toBe('created');
    expect(aRows[0].ticketId).not.toBeNull();

    // A source:'email' ticket exists under A's org with the submitter email set.
    const created = await ticketById(aRows[0].ticketId!);
    expect(created).toBeDefined();
    expect(created.orgId).toBe(fx.orgA.id);
    expect(created.partnerId).toBe(fx.partnerA.id);
    expect(created.source).toBe('email');
    expect(created.submitterEmail).toBe(fx.janeEmail);
  });

  it('CASE 3: quarantine path — unmatched email from an unknown sender creates no ticket', async () => {
    const providerMessageId = `<quarantine-${uniqueSuffix()}@nowhere.test>`;
    const email = buildEmail({
      to: `support@${fx.domainA}`,
      from: `stranger-${uniqueSuffix()}@nowhere.test`,
      subject: 'Random unsolicited message',
      providerMessageId
    });

    await withSystemDbAccessContext(() => processInboundEmail(email));

    const aRows = await inboundRowsFor(fx.partnerA.id, providerMessageId);
    expect(aRows.length).toBe(1);
    expect(aRows[0].partnerId).toBe(fx.partnerA.id);
    expect(aRows[0].parseStatus).toBe('quarantined');
    expect(aRows[0].ticketId).toBeNull();
  });

  it('CASE 4: idempotency — the same provider_message_id processed twice yields exactly one outcome', async () => {
    const providerMessageId = `<idem-${uniqueSuffix()}@known.test>`;
    const messageId = providerMessageId; // stamped onto the created ticket's emailThreadKey
    const email = buildEmail({
      to: `support@${fx.domainA}`,
      from: fx.janeEmail,
      fromName: 'Jane Known',
      subject: 'Duplicate delivery',
      text: 'This will arrive twice.',
      providerMessageId,
      messageId
    });

    await withSystemDbAccessContext(() => processInboundEmail(email));
    await withSystemDbAccessContext(() => processInboundEmail(email));

    // Exactly one ticket_email_inbound row for this (partner, provider_message_id).
    const aRows = await inboundRowsFor(fx.partnerA.id, providerMessageId);
    expect(aRows.length).toBe(1);
    expect(aRows[0].parseStatus).toBe('created');

    // The second call must not have double-created a ticket: exactly one ticket
    // carries the threading key stamped on create (n.messageId).
    const ticketsWithKey = await admin()
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.partnerId, fx.partnerA.id), eq(tickets.emailThreadKey, messageId)));
    expect(ticketsWithKey.length).toBe(1);
  });

  it('CASE 5 (concurrent idempotency): two concurrent processInboundEmail calls for the same (partner, providerMessageId) produce exactly one inbound row and one ticket', async () => {
    // This proves the (partner_id, provider_message_id) unique index + BullMQ retry
    // story under a real concurrent race — the losing worker's tx hits 23505, rolls
    // back, and the winner's committed row is the terminal record.
    const providerMessageId = `<concurrent-${uniqueSuffix()}@known.test>`;
    const messageId = providerMessageId;
    const emailA = buildEmail({
      to: `support@${fx.domainA}`,
      from: fx.janeEmail,
      fromName: 'Jane Known',
      subject: 'Concurrent delivery test',
      text: 'Arrived twice at the same instant.',
      providerMessageId,
      messageId
    });
    // Fire both calls concurrently, each in its own withSystemDbAccessContext (matching
    // what two separate BullMQ workers would do).
    const results = await Promise.allSettled([
      withSystemDbAccessContext(() => processInboundEmail(emailA)),
      withSystemDbAccessContext(() => processInboundEmail(emailA))
    ]);
    // Both may resolve OR one may reject with the 23505 unique violation — both are
    // acceptable (processInboundEmail swallows the error via logInboundFailedDurable,
    // but an aborted tx means the durable insert also may 23505 and be swallowed).
    // What MUST be true: exactly ONE ticket_email_inbound row with a terminal status.
    const aRows = await inboundRowsFor(fx.partnerA.id, providerMessageId);
    expect(aRows.length).toBe(1);
    // And exactly one ticket carries the thread key stamped on create.
    const ticketsWithKey = await admin()
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.partnerId, fx.partnerA.id), eq(tickets.emailThreadKey, messageId)));
    expect(ticketsWithKey.length).toBe(1);
    // Suppress the lint warning about unused results — we inspected the DB state above.
    void results;
  });

  it('CASE 6 (reopen): a matched same-partner reply to a RESOLVED partner-A ticket reopens it and appends a public comment', async () => {
    const ticketBefore = await ticketById(fx.aResolvedTicketId);
    expect(ticketBefore.status).toBe('resolved');
    const commentsBefore = await commentsForTicket(fx.aResolvedTicketId);

    const providerMessageId = `<reopen-${uniqueSuffix()}@known.test>`;
    const email = buildEmail({
      to: `support@${fx.domainA}`,
      from: fx.janeEmail,
      fromName: 'Jane Known',
      subject: 'Re: Partner A laptop issue',
      text: 'Actually it is back — please reopen.',
      inReplyTo: fx.aResolvedThreadKey,
      references: [fx.aResolvedThreadKey],
      providerMessageId
    });

    await withSystemDbAccessContext(() => processInboundEmail(email));

    // Ticket row reopened (NOTE: reopen is a direct UPDATE; there is no
    // ticket.status_changed event — assert on the row state, not an event).
    const ticketAfter = await ticketById(fx.aResolvedTicketId);
    expect(ticketAfter.status).toBe('open');
    expect(ticketAfter.resolvedAt).toBeNull();

    // A public inbound comment row was appended.
    const commentsAfter = await commentsForTicket(fx.aResolvedTicketId);
    expect(commentsAfter.length).toBe(commentsBefore.length + 1);
    const inboundComment = commentsAfter.find(
      (c: any) => c.authorType === 'email' && c.content === 'Actually it is back — please reopen.'
    );
    expect(inboundComment).toBeDefined();
    expect(inboundComment.isPublic).toBe(true);
    expect(inboundComment.commentType).toBe('comment');

    // Logged as `matched` under partner A.
    const aRows = await inboundRowsFor(fx.partnerA.id, providerMessageId);
    expect(aRows.length).toBe(1);
    expect(aRows[0].parseStatus).toBe('matched');
    expect(aRows[0].ticketId).toBe(fx.aResolvedTicketId);
  });
});
