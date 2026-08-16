/**
 * ticket_email_links claim service — real Postgres integration coverage (Task 4).
 *
 * Proves three things the mocked unit tests can't:
 *  1) The (partner_id, message_id) unique-index claim is genuinely exactly-once
 *     under a real concurrent race — same precedent as CASE 5 in
 *     inboundEmail.integration.test.ts.
 *  2) processInboundEmail's matched-reply path records the reply's own
 *     Message-ID as a link row (origin: 'inbound').
 *  3) A link row on a CLOSED ticket does NOT resurrect it in the live matcher
 *     (findTicketInPartner) — it must still fall through to
 *     findClosedTicketInPartner, which DOES find it via the widened OR arm.
 *
 * Runs under system scope (withSystemDbAccessContext), matching how the
 * inbound worker and threadMatcher actually execute in production.
 */
import './setup';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { ticketEmailLinks, tickets, ticketComments, organizations, partners } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';
import { claimMessageLink, findLinkByMessageId } from '../../services/ticketEmailLinks';
import { findTicketInPartner, findClosedTicketInPartner } from '../../services/inboundEmail/threadMatcher';
import { processInboundEmail } from '../../services/inboundEmail/inboundEmailService';
import type { NormalizedInboundEmail } from '../../services/inboundEmail/types';
import { partnerInboundDomains, portalUsers } from '../../db/schema';

const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function admin() {
  return getTestDb() as any;
}

const seeded = {
  partnerIds: [] as string[],
  orgIds: [] as string[]
};

interface Fixture {
  partnerId: string;
  orgId: string;
}

let fx: Fixture;

beforeEach(async () => {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  seeded.partnerIds.push(partner.id);
  seeded.orgIds.push(org.id);
  fx = { partnerId: partner.id, orgId: org.id };
});

afterAll(async () => {
  const db = admin();
  if (seeded.partnerIds.length === 0) return;
  const partnerList = sql.join(seeded.partnerIds.map((id) => sql`${id}`), sql`, `);
  const orgList = sql.join(seeded.orgIds.map((id) => sql`${id}`), sql`, `);

  await db.delete(ticketEmailLinks).where(sql`${ticketEmailLinks.partnerId} IN (${partnerList})`);
  await db.delete(ticketComments).where(
    sql`${ticketComments.ticketId} IN (SELECT id FROM tickets WHERE partner_id IN (${partnerList}))`
  );
  await db.delete(partnerInboundDomains).where(sql`${partnerInboundDomains.partnerId} IN (${partnerList})`);
  await db.delete(portalUsers).where(sql`${portalUsers.orgId} IN (${orgList})`);
  await db.delete(tickets).where(sql`${tickets.partnerId} IN (${partnerList})`);
  await db.execute(sql`DELETE FROM partner_ticket_sequences WHERE partner_id IN (${partnerList})`);
  await db.transaction(async (tx: any) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`DELETE FROM audit_logs WHERE org_id IN (${orgList})`);
  });
  await db.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  await db.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

async function seedTicket(status: string, extra: Record<string, unknown> = {}) {
  const suffix = uniqueSuffix();
  const [t] = await admin()
    .insert(tickets)
    .values({
      orgId: fx.orgId,
      partnerId: fx.partnerId,
      ticketNumber: `LEGACY-${suffix}`,
      internalNumber: `T-2026-${suffix.slice(-4)}`,
      subject: 'Test ticket',
      status,
      source: 'email',
      ...extra
    })
    .returning({ id: tickets.id });
  return t.id as string;
}

describe('ticket_email_links claim', () => {
  it('concurrent claims: exactly one created', async () => {
    const ticketId = await seedTicket('open');
    const messageId = `<race-${uniqueSuffix()}@customer.test>`;
    const input = {
      ticketId,
      orgId: fx.orgId,
      partnerId: fx.partnerId,
      messageId,
      origin: 'inbound' as const,
      visibility: 'public' as const
    };

    const [a, b] = await withSystemDbAccessContext(() =>
      Promise.all([claimMessageLink(input), claimMessageLink(input)])
    );

    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    // The loser received the winner's association — both results point at the
    // SAME link row.
    const winnerLink = a.created ? a.link : (a as { existing: unknown }).existing;
    const loserLink = b.created ? b.link : (b as { existing: unknown }).existing;
    expect((loserLink as { id: string }).id).toBe((winnerLink as { id: string }).id);

    // Exactly one row exists in the table for this (partner, message_id).
    const rows = await admin()
      .select()
      .from(ticketEmailLinks)
      .where(and(eq(ticketEmailLinks.partnerId, fx.partnerId), eq(ticketEmailLinks.messageId, messageId)));
    expect(rows).toHaveLength(1);
  });

  it("inbound reply records its own message-id as a link row", async () => {
    const suffix = uniqueSuffix();
    const domain = `links-${suffix}.tickets.test`;
    await admin()
      .insert(partnerInboundDomains)
      .values({ partnerId: fx.partnerId, domain, provider: 'mailgun', verificationStatus: 'verified' });

    const janeEmail = `jane-${suffix}@known.test`;
    await admin().insert(portalUsers).values({ orgId: fx.orgId, email: janeEmail, name: 'Jane Known' });

    const threadKey = `<thread-${suffix}@known.test>`;
    const ticketId = await seedTicket('open', { emailThreadKey: threadKey });

    const replyMessageId = `<reply-${suffix}@customer.test>`;
    const email: NormalizedInboundEmail = {
      provider: 'mailgun',
      providerMessageId: `<provider-${suffix}@customer.test>`,
      to: `support@${domain}`,
      from: janeEmail,
      fromName: 'Jane Known',
      subject: 'Re: Test ticket',
      text: 'Still broken.',
      inReplyTo: threadKey,
      references: [threadKey],
      messageId: replyMessageId,
      senderAuth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', verified: true },
      attachments: [],
      raw: {}
    } as NormalizedInboundEmail;

    await withSystemDbAccessContext(() => processInboundEmail(email));

    const link = await withSystemDbAccessContext(() => findLinkByMessageId(fx.partnerId, replyMessageId));
    expect(link).not.toBeNull();
    expect(link!.ticketId).toBe(ticketId);
    expect(link!.origin).toBe('inbound');
    expect(link!.visibility).toBe('public');
    expect(link!.commentId).not.toBeNull();
  });

  it('link rows never re-enable closed tickets in the live matcher', async () => {
    const closedTicketId = await seedTicket('closed');
    const key = `<closed-link-${uniqueSuffix()}@customer.test>`;

    await withSystemDbAccessContext(() =>
      claimMessageLink({
        ticketId: closedTicketId,
        orgId: fx.orgId,
        partnerId: fx.partnerId,
        messageId: key,
        origin: 'inbound',
        visibility: 'public'
      })
    );

    const liveMatch = await withSystemDbAccessContext(() =>
      findTicketInPartner({ inReplyTo: key, references: [] }, fx.partnerId)
    );
    expect(liveMatch).toBeNull();

    const closedMatch = await withSystemDbAccessContext(() =>
      findClosedTicketInPartner({ inReplyTo: key, references: [] }, fx.partnerId)
    );
    expect(closedMatch).not.toBeNull();
    expect(closedMatch!.id).toBe(closedTicketId);
  });
});
