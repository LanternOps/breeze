/**
 * Email-first replies W1 (Refs #8758): Reply-To stored at ingest and read back as
 * the requester's reply address, against a real Postgres.
 *
 * Seeding mirrors inboundEmail.integration.test.ts: partner/org factories on the
 * superuser pool, a partner_inbound_domains row so recipient resolution is
 * deterministic, and processInboundEmail under the worker's system context.
 */
import '../../__tests__/integration/setup';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import {
  organizations,
  partnerInboundDomains,
  partners,
  portalUsers,
  ticketComments,
  ticketEmailInbound,
  ticketMailboxConnections,
  tickets,
  users,
} from '../../db/schema';
import { createOrganization, createPartner } from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { processInboundEmail } from './inboundEmailService';
import { requesterReplyAddress } from './requesterReplyAddress';
import { uniqueInternalNumber } from './fixtureNumbering';
import type { NormalizedInboundEmail } from './types';

const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function admin() {
  return getTestDb() as any;
}

const seeded = { partnerIds: [] as string[], orgIds: [] as string[] };

let fx: { partnerId: string; orgId: string; domain: string; janeEmail: string; mailbox: string };

function buildEmail(overrides: Partial<NormalizedInboundEmail> & { from: string }): NormalizedInboundEmail {
  return {
    provider: 'mailgun',
    providerMessageId: `<msg-${uniqueSuffix()}@customer.test>`,
    to: `support@${fx.domain}`,
    subject: 'Hello support',
    text: 'I need help with my printer.',
    senderAuth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', verified: true, authenticatedDomain: overrides.from.split('@')[1]!.toLowerCase() },
    attachments: [],
    raw: {},
    ...overrides,
  };
}

beforeEach(async () => {
  const db = admin();
  const suffix = uniqueSuffix();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  seeded.partnerIds.push(partner.id);
  seeded.orgIds.push(org.id);

  const domain = `rt-${suffix}.tickets.test`;
  await db.insert(partnerInboundDomains).values({ partnerId: partner.id, domain, provider: 'mailgun', verificationStatus: 'verified' });

  const janeEmail = `jane-${suffix}@known.test`;
  await db.insert(portalUsers).values({ orgId: org.id, email: janeEmail, name: 'Jane Known' });

  // A connected-mailbox row of this partner (status does not matter to the guard).
  const mailbox = `helpdesk-${suffix}@msp.test`;
  await db.insert(ticketMailboxConnections).values({ partnerId: partner.id, mailboxAddress: mailbox, status: 'disabled' });

  fx = { partnerId: partner.id, orgId: org.id, domain, janeEmail, mailbox };
});

afterAll(async () => {
  const db = admin();
  if (seeded.partnerIds.length === 0) return;
  const partnerList = sql.join(seeded.partnerIds.map((id) => sql`${id}`), sql`, `);
  const orgList = sql.join(seeded.orgIds.map((id) => sql`${id}`), sql`, `);
  await db.delete(ticketComments).where(
    sql`${ticketComments.ticketId} IN (SELECT id FROM tickets WHERE partner_id IN (${partnerList}))`
  );
  await db.delete(ticketEmailInbound).where(sql`${ticketEmailInbound.partnerId} IN (${partnerList})`);
  await db.delete(tickets).where(sql`${tickets.partnerId} IN (${partnerList})`);
  await db.delete(portalUsers).where(sql`${portalUsers.orgId} IN (${orgList})`);
  await db.delete(users).where(sql`${users.partnerId} IN (${partnerList})`);
  await db.delete(ticketMailboxConnections).where(sql`${ticketMailboxConnections.partnerId} IN (${partnerList})`);
  await db.delete(partnerInboundDomains).where(sql`${partnerInboundDomains.partnerId} IN (${partnerList})`);
  await db.execute(sql`DELETE FROM partner_ticket_sequences WHERE partner_id IN (${partnerList})`);
  await db.transaction(async (tx: any) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`DELETE FROM audit_logs WHERE org_id IN (${orgList})`);
  });
  await db.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  await db.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

async function inboundRow(providerMessageId: string) {
  const rows = await admin().select().from(ticketEmailInbound)
    .where(and(eq(ticketEmailInbound.partnerId, fx.partnerId), eq(ticketEmailInbound.providerMessageId, providerMessageId)));
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function ticketRow(id: string) {
  const rows = await admin().select().from(tickets).where(eq(tickets.id, id)).limit(1);
  return rows[0];
}

const asSystem = <T,>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

describe('Reply-To at ingest (real driver, system context)', () => {
  it('stores reply_to_address on the creating row, and the reply goes there', async () => {
    const email = buildEmail({ from: fx.janeEmail, replyTo: 'jane.home@customer.test' });
    await asSystem(() => processInboundEmail(email));

    const row = await inboundRow(email.providerMessageId);
    expect(row.parseStatus).toBe('created');
    expect(row.replyToAddress).toBe('jane.home@customer.test');
    const ticket = await ticketRow(row.ticketId);
    // From stays the identity.
    expect(ticket.submitterEmail).toBe(fx.janeEmail);
    await expect(asSystem(() => requesterReplyAddress(ticket))).resolves.toBe('jane.home@customer.test');
  });

  it("an unverified sender's Reply-To is not stored on the quarantined row", async () => {
    // A forged From naming a real customer plus an attacker Reply-To: if staff
    // convert this row from the review queue, replies must not reach the attacker.
    const email = buildEmail({
      from: fx.janeEmail,
      replyTo: 'attacker@evil.test',
      senderAuth: { spf: 'fail', dkim: 'fail', dmarc: 'fail', verified: false },
    });
    await asSystem(() => processInboundEmail(email));

    const row = await inboundRow(email.providerMessageId);
    expect(row.parseStatus).toBe('quarantined');
    expect(row.replyToAddress).toBeNull();
  });

  it.each([
    ['a connected mailbox', () => fx.mailbox.toUpperCase()],
    ['a plus-subaddress of a connected mailbox', () => fx.mailbox.replace('@', '+t1@')],
    ['a partner inbound domain', () => `other@${fx.domain}`],
  ])('Reply-To equal to %s is not stored', async (_label, replyTo) => {
    const email = buildEmail({ from: fx.janeEmail, replyTo: replyTo().toLowerCase() });
    await asSystem(() => processInboundEmail(email));

    const row = await inboundRow(email.providerMessageId);
    expect(row.parseStatus).toBe('created');
    expect(row.replyToAddress).toBeNull();
    const ticket = await ticketRow(row.ticketId);
    await expect(asSystem(() => requesterReplyAddress(ticket))).resolves.toBe(fx.janeEmail);
  });
});

describe('requesterReplyAddress (real driver)', () => {
  async function seedTicket(submitterEmail: string, source: 'email' | 'portal') {
    const [t] = await admin().insert(tickets).values({
      orgId: fx.orgId,
      partnerId: fx.partnerId,
      ticketNumber: `RT-${uniqueSuffix()}`,
      internalNumber: uniqueInternalNumber(),
      subject: 'Printer',
      status: 'open',
      source,
      submitterEmail,
    }).returning();
    return t;
  }

  async function seedInbound(ticketId: string, parseStatus: string, fromAddress: string, replyToAddress: string | null, createdAt: Date) {
    await admin().insert(ticketEmailInbound).values({
      partnerId: fx.partnerId,
      provider: 'mailgun',
      providerMessageId: `<seed-${uniqueSuffix()}@customer.test>`,
      fromAddress,
      replyToAddress,
      toAddress: `support@${fx.domain}`,
      parseStatus,
      ticketId,
      createdAt,
    });
  }

  it("a follow-up's Reply-To does not change the address", async () => {
    const t = await seedTicket('no-reply@forms.test', 'email');
    await seedInbound(t.id, 'created', 'no-reply@forms.test', 'jane@customer.test', new Date('2027-01-01T00:00:00Z'));
    await seedInbound(t.id, 'matched', 'no-reply@forms.test', 'attacker@evil.test', new Date('2027-01-02T00:00:00Z'));
    await expect(asSystem(() => requesterReplyAddress(t))).resolves.toBe('jane@customer.test');
  });

  it('a ticket that did not start as email falls back to submitterEmail despite a follow-up Reply-To', async () => {
    const t = await seedTicket(fx.janeEmail, 'portal');
    await seedInbound(t.id, 'matched', fx.janeEmail, 'attacker@evil.test', new Date('2027-01-02T00:00:00Z'));
    await expect(asSystem(() => requesterReplyAddress(t))).resolves.toBe(fx.janeEmail);
  });

  it('no Reply-To falls back to submitterEmail', async () => {
    const t = await seedTicket(fx.janeEmail, 'email');
    await seedInbound(t.id, 'created', fx.janeEmail, null, new Date('2027-01-01T00:00:00Z'));
    await expect(asSystem(() => requesterReplyAddress(t))).resolves.toBe(fx.janeEmail);
  });

  it('a staff edit of submitterEmail wins over the stored Reply-To', async () => {
    const t = await seedTicket('new-requester@customer.test', 'email');
    await seedInbound(t.id, 'created', 'no-reply@forms.test', 'jane@customer.test', new Date('2027-01-01T00:00:00Z'));
    await expect(asSystem(() => requesterReplyAddress(t))).resolves.toBe('new-requester@customer.test');
  });
});
