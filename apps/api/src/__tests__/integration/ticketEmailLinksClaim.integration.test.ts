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
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { buildDbAccessContext } from '../../middleware/auth';
import { ticketEmailLinks, tickets, ticketComments, organizations, partners } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';
import { claimMessageLink, findLinkByMessageId } from '../../services/ticketEmailLinks';
import { findTicketInPartner, findClosedTicketInPartner } from '../../services/inboundEmail/threadMatcher';
import { processInboundEmail } from '../../services/inboundEmail/inboundEmailService';
import type { NormalizedInboundEmail } from '../../services/inboundEmail/types';
import { partnerInboundDomains, portalUsers, users } from '../../db/schema';
import { officeAddinTicketRoutes } from '../../routes/officeAddin/tickets';

// --- Task 16 harness ---------------------------------------------------------
// The add-in route is exercised for real (HTTP -> Hono -> handler -> Postgres);
// only the tech-auth middleware is replaced, with a stub that publishes the same
// `officeAddinAuth` principal AND opens the SAME partner-scope
// withDbAccessContext transaction the real middleware opens. That transaction is
// the thing under test: the route's nested db.transaction(...) must behave as a
// SAVEPOINT inside it.
const addinAuthRef: {
  current: { userId: string; partnerId: string; orgIds: string[] } | null;
} = { current: null };

// One-shot switch that makes the route's `findLinkByMessageId` pre-check miss
// exactly once, which is how a real interleave looks: the poller commits its
// claim AFTER the add-in's pre-check ran and BEFORE its own claim. Only the
// ROUTE's import is affected — `claimMessageLink` reads back the winner through
// the module's internal binding, which stays real.
const preCheckBlindOnce = { armed: false };

vi.mock('../../middleware/officeAddinTechAuth', () => ({
  officeAddinTechAuthMiddleware: async (c: any, next: any) => {
    const principal = addinAuthRef.current!;
    c.set('officeAddinAuth', {
      userId: principal.userId,
      partnerId: principal.partnerId,
      bindingId: '00000000-0000-4000-8000-000000000001',
      token: 'integration-token',
      user: { email: 'tech@partner.test', name: 'Integration Tech' },
      accessibleOrgIds: principal.orgIds,
      partnerOrgAccess: 'selected',
      permissions: {},
      canAccessOrg: (orgId: string) => principal.orgIds.includes(orgId),
      canAccessSite: () => true,
    });
    return withDbAccessContext(
      buildDbAccessContext({
        scope: 'partner',
        orgId: null,
        accessibleOrgIds: principal.orgIds,
        partnerId: principal.partnerId,
        userId: principal.userId,
      }),
      next
    );
  },
  requireAddinCapability: () => async (_c: any, next: any) => next(),
}));

vi.mock('../../services/ticketEmailLinks', async () => {
  const actual = await vi.importActual<typeof import('../../services/ticketEmailLinks')>(
    '../../services/ticketEmailLinks'
  );
  return {
    ...actual,
    findLinkByMessageId: async (partnerId: string, messageId: string) => {
      if (preCheckBlindOnce.armed) {
        preCheckBlindOnce.armed = false;
        return null;
      }
      return actual.findLinkByMessageId(partnerId, messageId);
    },
  };
});

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
  // tickets BEFORE portal_users: tickets.submitted_by references portal_users
  // with no ON DELETE, and the Task 16 poller path stamps a requester.
  await db.delete(tickets).where(sql`${tickets.partnerId} IN (${partnerList})`);
  await db.delete(portalUsers).where(sql`${portalUsers.orgId} IN (${orgList})`);
  await db.execute(sql`DELETE FROM partner_ticket_sequences WHERE partner_id IN (${partnerList})`);
  await db.transaction(async (tx: any) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`DELETE FROM audit_logs WHERE org_id IN (${orgList})`);
  });
  await db.execute(sql`DELETE FROM ticket_email_inbound WHERE partner_id IN (${partnerList})`);
  await db.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  await db.delete(users).where(sql`${users.partnerId} IN (${partnerList})`);
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

/**
 * Task 16 — POST /office-addin/tickets/from-email vs. the inbound poller.
 *
 * The route creates the ticket, stamps threading and claims the Message-ID
 * inside a NESTED db.transaction(...), which under drizzle's postgres-js driver
 * is a SAVEPOINT on the request transaction. Losing the claim throws out of that
 * callback, so ROLLBACK TO SAVEPOINT discards the duplicate ticket while the
 * request transaction survives to read back the winner's association. These
 * tests prove that against real Postgres — the mocked route tests cannot.
 */
describe('add-in create vs. inbound poller (Task 16)', () => {
  async function seedTechAndSender() {
    const suffix = uniqueSuffix();
    const domain = `addin-${suffix}.tickets.test`;
    await admin()
      .insert(partnerInboundDomains)
      .values({ partnerId: fx.partnerId, domain, provider: 'mailgun', verificationStatus: 'verified' });

    const senderEmail = `sender-${suffix}@known.test`;
    await admin().insert(portalUsers).values({ orgId: fx.orgId, email: senderEmail, name: 'Known Sender' });

    const tech = await createUser({ partnerId: fx.partnerId, email: `tech-${suffix}@partner.test` });
    addinAuthRef.current = { userId: tech.id, partnerId: fx.partnerId, orgIds: [fx.orgId] };
    return { suffix, domain, senderEmail };
  }

  function pollerEmail(args: { domain: string; senderEmail: string; messageId: string; suffix: string }) {
    return {
      provider: 'mailgun',
      providerMessageId: `<provider-${args.suffix}@customer.test>`,
      to: `support@${args.domain}`,
      from: args.senderEmail,
      fromName: 'Known Sender',
      subject: `Poller ${args.suffix}`,
      text: 'Sent from the customer mailbox.',
      inReplyTo: null,
      references: [],
      messageId: args.messageId,
      senderAuth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', verified: true },
      attachments: [],
      raw: {}
    } as unknown as NormalizedInboundEmail;
  }

  function addinApp() {
    const app = new Hono();
    // Mirrors routes/officeAddin/index.ts: the router registers '/from-email'
    // and '/:id/link-email' and is mounted under '/tickets'.
    app.route('/tickets', officeAddinTicketRoutes);
    return app;
  }

  function callAddin(body: Record<string, unknown>) {
    return addinApp().request('/tickets/from-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function callAddinLink(ticketId: string, body: Record<string, unknown>) {
    return addinApp().request(`/tickets/${ticketId}/link-email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function ticketsWithSubject(subject: string): Promise<number> {
    const rows = await admin()
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.partnerId, fx.partnerId), eq(tickets.subject, subject)));
    return rows.length;
  }

  it('rolls the losing add-in ticket back to the savepoint and returns the winner association', async () => {
    const { suffix, domain, senderEmail } = await seedTechAndSender();
    const messageId = `<addin-race-${suffix}@customer.test>`;
    const addinSubject = `Addin ${suffix}`;

    // The poller wins: it ingests and COMMITS the claim first.
    await withSystemDbAccessContext(() =>
      processInboundEmail(pollerEmail({ domain, senderEmail, messageId, suffix }))
    );
    const winnerLink = await withSystemDbAccessContext(() => findLinkByMessageId(fx.partnerId, messageId));
    expect(winnerLink).not.toBeNull();

    // Reproduce the interleave: the add-in's idempotency pre-check runs BEFORE
    // the poller's row is visible, so the route proceeds to create + claim.
    preCheckBlindOnce.armed = true;
    const res = await callAddin({
      orgId: fx.orgId,
      subject: addinSubject,
      description: 'Technician-composed body.',
      from: { email: senderEmail, name: 'Known Sender' },
      internetMessageId: messageId,
      requester: { kind: 'raw' },
    });
    expect(preCheckBlindOnce.armed).toBe(false); // the pre-check really was exercised

    // The route hands back the poller's ticket, not a second one.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadyExisted).toBe(true);
    expect(body.ticket.id).toBe(winnerLink!.ticketId);

    // ROLLBACK EVIDENCE: the ticket the handler created before losing the claim
    // does not exist. (Without the savepoint it would be committed by the
    // request transaction, since onConflictDoNothing raises no error.)
    expect(await ticketsWithSubject(addinSubject)).toBe(0);

    // Exactly one association, still the poller's.
    const links = await admin()
      .select()
      .from(ticketEmailLinks)
      .where(and(eq(ticketEmailLinks.partnerId, fx.partnerId), eq(ticketEmailLinks.messageId, messageId)));
    expect(links).toHaveLength(1);
    expect(links[0].ticketId).toBe(winnerLink!.ticketId);
    expect(links[0].origin).toBe('inbound');
  });

  /**
   * FINAL-REVIEW REGRESSION (finding 2). The add-in acts FIRST and commits its
   * claim; the 90s poller then ingests the very same message. A fresh email
   * carries no In-Reply-To/References and no [T-...] token, so nothing in the
   * thread matcher can connect it to the add-in's ticket — before the (2b)
   * ledger consult the pipeline fell through to createFromEmail and minted a
   * SECOND ticket whose losing claim was silently swallowed.
   */
  it('poller ingest of a message the add-in already claimed creates no second ticket or comment', async () => {
    const { suffix, domain, senderEmail } = await seedTechAndSender();
    const messageId = `<addin-first-${suffix}@customer.test>`;
    const addinSubject = `Addin ${suffix}`;

    // t=0 — the technician creates the ticket from the add-in.
    const res = await callAddin({
      orgId: fx.orgId,
      subject: addinSubject,
      description: 'Technician-composed body.',
      from: { email: senderEmail, name: 'Known Sender' },
      internetMessageId: messageId,
      requester: { kind: 'raw' },
    });
    expect(res.status).toBe(201);
    const addinTicketId = (await res.json()).ticket.id as string;

    const ticketsBefore = await admin()
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.partnerId, fx.partnerId));
    const commentsBefore = await admin()
      .select({ id: ticketComments.id })
      .from(ticketComments)
      .where(eq(ticketComments.ticketId, addinTicketId));

    // t=90s — the poller ingests the SAME message.
    await withSystemDbAccessContext(() =>
      processInboundEmail(pollerEmail({ domain, senderEmail, messageId, suffix }))
    );

    // No second ticket anywhere in the partner, and no new comment on the add-in's.
    const ticketsAfter = await admin()
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.partnerId, fx.partnerId));
    expect(ticketsAfter).toHaveLength(ticketsBefore.length);
    expect(await ticketsWithSubject(addinSubject)).toBe(1);

    const commentsAfter = await admin()
      .select({ id: ticketComments.id })
      .from(ticketComments)
      .where(eq(ticketComments.ticketId, addinTicketId));
    expect(commentsAfter).toHaveLength(commentsBefore.length);

    // Still exactly ONE association, still the add-in's.
    const links = await admin()
      .select()
      .from(ticketEmailLinks)
      .where(and(eq(ticketEmailLinks.partnerId, fx.partnerId), eq(ticketEmailLinks.messageId, messageId)));
    expect(links).toHaveLength(1);
    expect(links[0].origin).toBe('addin_create');
    expect(links[0].ticketId).toBe(addinTicketId);

    // The inbound audit row is terminal, non-'failed', and points at the add-in's ticket.
    const inbound = await admin().execute(
      sql`SELECT parse_status, ticket_id FROM ticket_email_inbound
          WHERE partner_id = ${fx.partnerId} AND message_id = ${messageId}`
    );
    const rows = Array.from(inbound as Iterable<{ parse_status: string; ticket_id: string | null }>);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.parse_status).toBe('matched');
    expect(rows[0]!.ticket_id).toBe(addinTicketId);
  });

  /**
   * REVIEW FINDING 1 (PR #3596). A public link-email whose sender has NO
   * portal_users row inserts an email-authored comment (user_id NULL,
   * portal_user_id NULL) under the technician's PARTNER scope. Before the
   * breeze_ticket_parent_email_insert policy
   * (2026-08-23-ticket-comments-email-authored-insert.sql) this raised 42501
   * out of the savepoint and the route 500'd.
   */
  it('public link-email from an unknown sender succeeds under partner scope (email-authored INSERT policy)', async () => {
    const { suffix } = await seedTechAndSender();
    const ticketId = await seedTicket('open');
    const messageId = `<link-unknown-${suffix}@customer.test>`;
    const strangerEmail = `stranger-${suffix}@unknown.test`; // deliberately NO portal_users row

    const res = await callAddinLink(ticketId, {
      visibility: 'public',
      from: { email: strangerEmail, name: 'Unknown Stranger' },
      internetMessageId: messageId,
      subject: `Link ${suffix}`,
      bodyText: 'Forwarded customer email body.',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.linked).toBe(true);
    expect(body.commentId).toBeTruthy();

    // The comment row really exists, email-authored and unattributed.
    const comments = await admin()
      .select({
        id: ticketComments.id,
        userId: ticketComments.userId,
        portalUserId: ticketComments.portalUserId,
        authorType: ticketComments.authorType,
        isPublic: ticketComments.isPublic,
      })
      .from(ticketComments)
      .where(eq(ticketComments.id, body.commentId));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      userId: null,
      portalUserId: null,
      authorType: 'email',
      isPublic: true,
    });

    // And the ledger row points at the comment.
    const link = await withSystemDbAccessContext(() => findLinkByMessageId(fx.partnerId, messageId));
    expect(link).not.toBeNull();
    expect(link!.ticketId).toBe(ticketId);
    expect(link!.origin).toBe('addin_link');
    expect(link!.commentId).toBe(body.commentId);
  });

  /**
   * REVIEW FINDING 2 (PR #3596). The unique index is (partner_id, message_id)
   * but RLS on ticket_email_links is ORG-scoped, so when the poller has
   * claimed the message for an org OUTSIDE a 'selected'-access technician's
   * grant: the pre-check sees nothing, the insert no-ops on the conflict, and
   * the scoped read-back also saw nothing — 500 instead of the designed 409.
   * claimMessageLink now re-reads the winner under a short system context.
   */
  it('cross-org blind claim answers 409 message_linked_elsewhere with ticket null (not 500)', async () => {
    const { suffix, senderEmail } = await seedTechAndSender();

    // A second org in the SAME partner, outside the technician's grant.
    const orgB = await createOrganization({ partnerId: fx.partnerId });
    seeded.orgIds.push(orgB.id);
    const orgBTicketId = await seedTicket('open', { orgId: orgB.id });

    const messageId = `<cross-org-${suffix}@customer.test>`;
    await withSystemDbAccessContext(() =>
      claimMessageLink({
        ticketId: orgBTicketId,
        orgId: orgB.id,
        partnerId: fx.partnerId,
        messageId,
        origin: 'inbound',
        visibility: 'public',
      })
    );

    const addinSubject = `Addin ${suffix}`;
    const res = await callAddin({
      orgId: fx.orgId,
      subject: addinSubject,
      description: 'Technician-composed body.',
      from: { email: senderEmail, name: 'Known Sender' },
      internetMessageId: messageId,
      requester: { kind: 'raw' },
    });

    // Designed conflict answer — the winner's ticket is NOT echoed (other-org).
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'message_linked_elsewhere', ticket: null });

    // The loser's ticket rolled back to the savepoint; the winner's link stands.
    expect(await ticketsWithSubject(addinSubject)).toBe(0);
    const links = await admin()
      .select()
      .from(ticketEmailLinks)
      .where(and(eq(ticketEmailLinks.partnerId, fx.partnerId), eq(ticketEmailLinks.messageId, messageId)));
    expect(links).toHaveLength(1);
    expect(links[0].ticketId).toBe(orgBTicketId);
    expect(links[0].origin).toBe('inbound');
  });

  it('concurrent add-in create and poller ingest of the same message yield exactly one association', async () => {
    const { suffix, domain, senderEmail } = await seedTechAndSender();
    const messageId = `<addin-concurrent-${suffix}@customer.test>`;
    const addinSubject = `Addin ${suffix}`;

    const [res] = await Promise.all([
      callAddin({
        orgId: fx.orgId,
        subject: addinSubject,
        description: 'Technician-composed body.',
        from: { email: senderEmail, name: 'Known Sender' },
        internetMessageId: messageId,
        requester: { kind: 'raw' },
      }),
      withSystemDbAccessContext(() =>
        processInboundEmail(pollerEmail({ domain, senderEmail, messageId, suffix }))
      ),
    ]);

    // ONE association for the message, whichever side won.
    const links = await admin()
      .select()
      .from(ticketEmailLinks)
      .where(and(eq(ticketEmailLinks.partnerId, fx.partnerId), eq(ticketEmailLinks.messageId, messageId)));
    expect(links).toHaveLength(1);

    // And the add-in's ticket exists if and only if the add-in won the claim.
    const addinTickets = await ticketsWithSubject(addinSubject);
    if (res.status === 201) {
      expect(addinTickets).toBe(1);
      expect(links[0].origin).toBe('addin_create');
      expect(links[0].ticketId).toBe((await res.json()).ticket.id);
    } else {
      expect([200, 409]).toContain(res.status);
      expect(addinTickets).toBe(0);
      expect(links[0].origin).toBe('inbound');
    }
  });
});
