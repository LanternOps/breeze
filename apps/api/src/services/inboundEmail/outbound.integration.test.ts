/**
 * End-to-end outbound integration test (real DB, captured email mock).
 *
 * Task 9 of docs/superpowers/plans/ticketing/2026-06-13-ticketing-phase4-outbound-backend.md
 *
 * Form: notify-worker-level integration test that seeds real DB rows
 * (real Postgres via withSystemDbAccessContext / createPartner / createOrganization)
 * and calls handleTicketEvent directly with a captured email mock. This proves the
 * wired path — DB reads, partner slug + settings, threading helpers, autoresponse
 * template composition — against a real schema, without hitting a live SMTP transport.
 *
 * What is mocked:
 *   - getEmailService / sendEmail  — captured to assert send args (no real mail)
 *   - getConfig (from validate.ts)  — returns TICKETS_INBOUND_DOMAIN so threading
 *     helpers produce deterministic Message-ID / In-Reply-To / anchors. validateConfig()
 *     is never called (it requires many unrelated env vars); the mock is the interface.
 *   - BullMQ / Redis / Sentry      — standard worker-test stubs (no queue needed)
 *
 * What uses the real DB:
 *   - Partner/org/portal-user/ticket/comment rows (seeded via admin pool)
 *   - handleTicketEvent's DB reads (withSystemDbAccessContext → real breeze_app pool)
 *   - Ticket anchor stamp (db.update(tickets).set({ emailThreadKey: ... }))
 *
 * Cleanup mirrors inboundEmail.integration.test.ts:
 *   - FK-safe teardown order: comments → tickets → portal_users → sequences →
 *     audit_logs (session_replication_role=replica DELETE) → orgs → partners.
 */
import '../../__tests__/integration/setup';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import {
  tickets,
  ticketComments,
  ticketEmailInbound,
  portalUsers,
  organizations,
  partners,
  partnerInboundDomains
} from '../../db/schema';
import { createOrganization, createPartner } from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import type { NormalizedInboundEmail } from './types';

// ---------------------------------------------------------------------------
// Module mocks — must appear before any import that resolves them.
// ---------------------------------------------------------------------------

const { sendEmailMock, getEmailServiceMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn().mockResolvedValue(undefined),
  getEmailServiceMock: vi.fn()
}));

vi.mock('../email', () => ({ getEmailService: getEmailServiceMock }));
vi.mock('bullmq', () => ({ Queue: vi.fn(() => ({ add: vi.fn() })), Worker: vi.fn() }));
vi.mock('../../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

// Provide TICKETS_INBOUND_DOMAIN so threading helpers produce deterministic IDs.
// The specifier from ticketNotifyWorker.ts (in jobs/) is '../config/validate';
// from outboundThreading.ts (in services/inboundEmail/) it resolves to
// '../../config/validate'. Both resolve to the same on-disk module, so a single
// vi.mock of the canonical specifier should catch both paths. We mock the
// services/ specifier since that is what outboundThreading.ts imports.
const INBOUND_DOMAIN = 'tickets.test.example.com';
vi.mock('../../config/validate', () => ({
  getConfig: () => ({ TICKETS_INBOUND_DOMAIN: INBOUND_DOMAIN })
}));
// Also mock the jobs/ path (relative from ticketNotifyWorker.ts) in case
// vitest module resolution treats them as distinct cache entries.
vi.mock('../config/validate', () => ({
  getConfig: () => ({ TICKETS_INBOUND_DOMAIN: INBOUND_DOMAIN })
}));

// Import AFTER mocks are registered.
import { handleTicketEvent } from '../../jobs/ticketNotifyWorker';
import { processInboundEmail } from './inboundEmailService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function admin() {
  return getTestDb() as any;
}

// Accumulated IDs for afterAll cleanup.
const seeded = {
  partnerIds: [] as string[],
  orgIds: [] as string[]
};

interface Fixture {
  partner: { id: string; slug: string };
  selfHostedPartner: { id: string; slug: string };
  org: { id: string };
  selfHostedOrg: { id: string };
  portalUserId: string;
  janeEmail: string;
}

let fx: Fixture;

// ---------------------------------------------------------------------------
// Seed fresh fixtures per test (setup.ts TRUNCATE CASCADE runs first)
// ---------------------------------------------------------------------------

beforeEach(async () => {
  vi.clearAllMocks();
  sendEmailMock.mockReset().mockResolvedValue(undefined);
  getEmailServiceMock.mockReturnValue({ sendEmail: sendEmailMock });

  const db = admin();
  const suffix = uniqueSuffix();

  // Default partner (derived Reply-To: slug@INBOUND_DOMAIN)
  const partner = await createPartner({ slug: `outbound-${suffix}` });
  const org = await createOrganization({ partnerId: partner.id });

  // Self-hosted partner (settings.ticketing.inbound.address override)
  const selfHostedPartner = await createPartner({ slug: `selfhosted-${suffix}` });
  const selfHostedOrg = await createOrganization({ partnerId: selfHostedPartner.id });

  // Set the self-hosted override on the partner settings
  await db
    .update(partners)
    .set({ settings: { ticketing: { inbound: { address: 'support@helpdesk.theirmsp.com' } } } })
    .where(eq(partners.id, selfHostedPartner.id));

  // Seed a partner inbound domain so resolvePartnerByRecipient can find them
  // (needed only if we call processInboundEmail; for this test we skip that).

  // Known portal user for the default partner's org.
  const janeEmail = `jane-${suffix}@known.test`;
  await db.insert(portalUsers).values({ orgId: org.id, email: janeEmail, name: 'Jane Known' });
  const puRows = await db.select({ id: portalUsers.id }).from(portalUsers)
    .where(eq(portalUsers.email, janeEmail)).limit(1);
  const portalUserId = puRows[0].id;

  seeded.partnerIds.push(partner.id, selfHostedPartner.id);
  seeded.orgIds.push(org.id, selfHostedOrg.id);

  fx = { partner, selfHostedPartner, org, selfHostedOrg, portalUserId, janeEmail };
});

// ---------------------------------------------------------------------------
// Cleanup (FK-safe, audit_logs append-only workaround)
// ---------------------------------------------------------------------------

afterAll(async () => {
  const db = admin();
  if (seeded.partnerIds.length === 0) return;
  const partnerList = sql.join(seeded.partnerIds.map((id) => sql`${id}`), sql`, `);
  const orgList = sql.join(seeded.orgIds.map((id) => sql`${id}`), sql`, `);

  await db.delete(ticketComments).where(
    sql`${ticketComments.ticketId} IN (SELECT id FROM tickets WHERE partner_id IN (${partnerList}))`
  );
  // The round-trip test drives processInboundEmail, which writes ticket_email_inbound
  // audit rows — clear them before the orgs/partners delete.
  await db.delete(ticketEmailInbound).where(sql`${ticketEmailInbound.partnerId} IN (${partnerList})`);
  await db.delete(tickets).where(sql`${tickets.partnerId} IN (${partnerList})`);
  await db.delete(portalUsers).where(sql`${portalUsers.orgId} IN (${orgList})`);
  await db.execute(sql`DELETE FROM partner_ticket_sequences WHERE partner_id IN (${partnerList})`);
  // audit_logs is append-only; bypass triggers via session_replication_role.
  await db.transaction(async (tx: any) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`DELETE FROM audit_logs WHERE org_id IN (${orgList})`);
  });
  await db.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  await db.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

// ---------------------------------------------------------------------------
// Helper: seed a source:email ticket directly (bypass processInboundEmail so
// we can unit-assert handleTicketEvent in isolation without hitting BullMQ / Redis)
// ---------------------------------------------------------------------------

async function seedEmailTicket(opts: {
  partnerId: string;
  orgId: string;
  submitterEmail: string;
  subject?: string;
}): Promise<{ id: string; internalNumber: string | null; subject: string; emailThreadKey: string | null }> {
  const db = admin();
  const suffix = uniqueSuffix();
  const [row] = await db
    .insert(tickets)
    .values({
      orgId: opts.orgId,
      partnerId: opts.partnerId,
      ticketNumber: `EMAIL-${suffix}`,
      internalNumber: `T-2026-${suffix.slice(-4)}`,
      subject: opts.subject ?? 'Printer is down',
      status: 'open',
      source: 'email',
      submitterEmail: opts.submitterEmail
    })
    .returning({
      id: tickets.id,
      internalNumber: tickets.internalNumber,
      subject: tickets.subject,
      emailThreadKey: tickets.emailThreadKey
    });
  return row;
}

async function ticketById(id: string) {
  const rows = await admin().select().from(tickets).where(eq(tickets.id, id)).limit(1);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('outbound threading + autoresponder + Reply-To + leak (real DB, captured email mock)', () => {
  it('autoresponse: sends Auto-Submitted + [T-…] subject + Reply-To = slug@domain + Message-ID = anchor', async () => {
    const ticket = await seedEmailTicket({
      partnerId: fx.partner.id,
      orgId: fx.org.id,
      submitterEmail: fx.janeEmail,
      subject: 'My laptop screen is flickering'
    });

    // Drive the autoresponse event directly (bypassing BullMQ).
    await withSystemDbAccessContext(() =>
      handleTicketEvent({
        type: 'ticket.autoresponse',
        ticketId: ticket.id,
        orgId: fx.org.id,
        partnerId: fx.partner.id,
        actorUserId: null,
        payload: {
          to: fx.janeEmail,
          internalNumber: ticket.internalNumber,
          subject: ticket.subject
        }
      } as never)
    );

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0]![0] as {
      to: string;
      subject: string;
      replyTo?: string;
      headers?: Record<string, string>;
    };

    // Recipient is the submitter.
    expect(arg.to).toBe(fx.janeEmail);

    // Subject carries the [T-…] token.
    expect(arg.subject).toMatch(/^\[T-/);
    expect(arg.subject).toContain(ticket.internalNumber ?? '');

    // Reply-To = derived slug address (no override configured).
    expect(arg.replyTo).toBe(`${fx.partner.slug}@${INBOUND_DOMAIN}`);

    // Auto-Submitted: auto-replied for loop hygiene.
    expect(arg.headers?.['Auto-Submitted']).toBe('auto-replied');

    // Message-ID = thread anchor = <ticket-{id}@INBOUND_DOMAIN>.
    const expectedAnchor = `<ticket-${ticket.id}@${INBOUND_DOMAIN}>`;
    expect(arg.headers?.['Message-ID']).toBe(expectedAnchor);
  });

  it('self-hosted Reply-To override: autoresponse uses settings.ticketing.inbound.address, not the derived default', async () => {
    const ticket = await seedEmailTicket({
      partnerId: fx.selfHostedPartner.id,
      orgId: fx.selfHostedOrg.id,
      submitterEmail: fx.janeEmail,
      subject: 'Help with my mouse'
    });

    await withSystemDbAccessContext(() =>
      handleTicketEvent({
        type: 'ticket.autoresponse',
        ticketId: ticket.id,
        orgId: fx.selfHostedOrg.id,
        partnerId: fx.selfHostedPartner.id,
        actorUserId: null,
        payload: {
          to: fx.janeEmail,
          internalNumber: ticket.internalNumber,
          subject: ticket.subject
        }
      } as never)
    );

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0]![0] as { replyTo?: string };
    // Override wins over the derived default.
    expect(arg.replyTo).toBe('support@helpdesk.theirmsp.com');
  });

  it('threaded reply: public technician comment carries Message-ID + In-Reply-To + References + Reply-To + stamps email_thread_key', async () => {
    const ticket = await seedEmailTicket({
      partnerId: fx.partner.id,
      orgId: fx.org.id,
      submitterEmail: fx.janeEmail,
      subject: 'Network outage'
    });

    // Seed a public technician comment row.
    const db = admin();
    const [comment] = await db.insert(ticketComments).values({
      ticketId: ticket.id,
      userId: null,
      portalUserId: null,
      authorName: 'Tech Alice',
      authorType: 'internal',
      commentType: 'comment',
      content: 'We are looking into this.',
      isPublic: true,
      oldValue: null,
      newValue: null
    }).returning({ id: ticketComments.id });

    // Drive the public comment notification.
    await withSystemDbAccessContext(() =>
      handleTicketEvent({
        type: 'ticket.commented',
        ticketId: ticket.id,
        orgId: fx.org.id,
        partnerId: fx.partner.id,
        actorUserId: null,
        payload: { commentId: comment.id, isPublic: true }
      } as never)
    );

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0]![0] as {
      to: string;
      subject: string;
      replyTo?: string;
      headers?: Record<string, string>;
    };

    // Sent to the requester.
    expect(arg.to).toBe(fx.janeEmail);

    // Subject includes the ticket's internal number token.
    expect(arg.subject).toContain(ticket.internalNumber ?? '');

    // Reply-To = derived slug address.
    expect(arg.replyTo).toBe(`${fx.partner.slug}@${INBOUND_DOMAIN}`);

    // Threading headers: anchor-based In-Reply-To/References + comment-specific Message-ID.
    const anchor = `<ticket-${ticket.id}@${INBOUND_DOMAIN}>`;
    const commentMid = `<ticket-${ticket.id}-${comment.id}@${INBOUND_DOMAIN}>`;
    expect(arg.headers?.['In-Reply-To']).toBe(anchor);
    expect(arg.headers?.['References']).toBe(anchor);
    expect(arg.headers?.['Message-ID']).toBe(commentMid);

    // The thread anchor was stamped onto the ticket (it was null before this reply).
    const after = await ticketById(ticket.id);
    expect(after.emailThreadKey).toBe(anchor);
  });

  it('inbound echo guard: an inbound:true public comment does NOT email the requester', async () => {
    const ticket = await seedEmailTicket({
      partnerId: fx.partner.id,
      orgId: fx.org.id,
      submitterEmail: fx.janeEmail
    });

    // Seed an inbound public comment (originated from the requester's email — would loop).
    const db = admin();
    const [comment] = await db.insert(ticketComments).values({
      ticketId: ticket.id,
      userId: null,
      portalUserId: fx.portalUserId,
      authorName: 'Jane Known',
      authorType: 'email',
      commentType: 'comment',
      content: 'Here is more detail.',
      isPublic: true,
      oldValue: null,
      newValue: null
    }).returning({ id: ticketComments.id });

    // Drive the inbound comment event (inbound:true = echo-guard fires).
    await withSystemDbAccessContext(() =>
      handleTicketEvent({
        type: 'ticket.commented',
        ticketId: ticket.id,
        orgId: fx.org.id,
        partnerId: fx.partner.id,
        actorUserId: null,
        payload: { commentId: comment.id, isPublic: true, inbound: true }
      } as never)
    );

    // Echo guard: no email sent to the requester.
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('leak guard (integration): a private comment emits no email and the requester is not contacted', async () => {
    const ticket = await seedEmailTicket({
      partnerId: fx.partner.id,
      orgId: fx.org.id,
      submitterEmail: fx.janeEmail
    });

    // Seed a PRIVATE comment (is_public=false, content = sensitive text).
    const SECRET = 'INTERNAL: customer flagged for payment issues — do not share';
    const db = admin();
    const [comment] = await db.insert(ticketComments).values({
      ticketId: ticket.id,
      userId: null,
      portalUserId: null,
      authorName: 'Tech Alice',
      authorType: 'internal',
      commentType: 'internal',
      content: SECRET,
      isPublic: false,
      oldValue: null,
      newValue: null
    }).returning({ id: ticketComments.id });

    // Drive the private comment event.
    await withSystemDbAccessContext(() =>
      handleTicketEvent({
        type: 'ticket.commented',
        ticketId: ticket.id,
        orgId: fx.org.id,
        partnerId: fx.partner.id,
        actorUserId: null,
        payload: { commentId: comment.id, isPublic: false }
      } as never)
    );

    // No email must be sent — the private comment must never trigger a notify.
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Threading round-trip (review finding): the deterministic anchor must unify
  // the created ticket's email_thread_key, the autoresponse's Message-ID, and the
  // inbound matcher — so a customer reply to the autoresponse threads via HEADER,
  // not just the [T-...] subject token.
  //
  // Before the fix, createFromEmail stamped email_thread_key = n.messageId (the
  // customer's own id) when present, while the autoresponse went out with
  // Message-ID = <ticket-{id}@domain>. A reply carrying In-Reply-To = that anchor
  // therefore could NOT match email_thread_key.
  // ---------------------------------------------------------------------------
  it('round-trip: email-created ticket stamps the anchor as email_thread_key, the anchor IS the autoresponse Message-ID, and a reply to that anchor matches the SAME ticket', async () => {
    const suffix = uniqueSuffix();
    const providerMessageId = `<orig-${suffix}@customer.test>`;
    // The customer's OWN Message-Id — the pre-fix code would have stamped THIS.
    const customerMessageId = `<real-${suffix}@customer.test>`;

    const buildInbound = (overrides: Partial<NormalizedInboundEmail>): NormalizedInboundEmail => ({
      provider: 'mailgun',
      providerMessageId,
      // Address the partner via its slug @ the (mocked) inbound domain so
      // resolvePartnerByRecipient resolves through the platform-slug branch.
      to: `${fx.partner.slug}@${INBOUND_DOMAIN}`,
      from: fx.janeEmail,
      fromName: 'Jane Known',
      subject: 'My printer is on fire',
      text: 'Smoke is coming out of it.',
      messageId: customerMessageId,
      attachments: [],
      raw: { recipient: `${fx.partner.slug}@${INBOUND_DOMAIN}` },
      senderAuth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', verified: true },
      ...overrides
    });

    // 1) Drive the inbound create (known portal-user sender → source:email ticket).
    await withSystemDbAccessContext(() => processInboundEmail(buildInbound({})));

    // The ticket was created and logged.
    const createdRows = await admin()
      .select()
      .from(tickets)
      .where(and(eq(tickets.partnerId, fx.partner.id), eq(tickets.source, 'email')));
    expect(createdRows).toHaveLength(1);
    const created = createdRows[0];

    // 2) email_thread_key = the DETERMINISTIC ANCHOR — NOT the customer's Message-Id.
    const anchor = `<ticket-${created.id}@${INBOUND_DOMAIN}>`;
    expect(created.emailThreadKey).toBe(anchor);
    expect(created.emailThreadKey).not.toBe(customerMessageId);

    // 3) The anchor IS the autoresponse Message-ID. Drive the autoresponse event
    //    (processInboundEmail enqueues it via BullMQ rather than sending inline) and
    //    capture the Message-ID off the send mock — it must equal email_thread_key.
    await withSystemDbAccessContext(() =>
      handleTicketEvent({
        type: 'ticket.autoresponse',
        ticketId: created.id,
        orgId: fx.org.id,
        partnerId: fx.partner.id,
        actorUserId: null,
        payload: {
          to: fx.janeEmail,
          internalNumber: created.internalNumber,
          subject: created.subject
        }
      } as never)
    );
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const autoArg = sendEmailMock.mock.calls[0]![0] as { headers?: Record<string, string> };
    expect(autoArg.headers?.['Message-ID']).toBe(anchor);
    expect(created.emailThreadKey).toBe(autoArg.headers?.['Message-ID']);

    // 4) A customer reply TO THE AUTORESPONSE carries In-Reply-To = the anchor.
    //    Route it through processInboundEmail — it must MATCH the SAME ticket (append
    //    a public comment, parse_status='matched'), NOT spawn a new ticket.
    const replyProviderMessageId = `<reply-${suffix}@customer.test>`;
    await withSystemDbAccessContext(() =>
      processInboundEmail(
        buildInbound({
          providerMessageId: replyProviderMessageId,
          messageId: `<reply-real-${suffix}@customer.test>`,
          subject: 'Re: My printer is on fire',
          inReplyTo: anchor,
          references: [anchor],
          text: 'It is still smoking.'
        })
      )
    );

    // Still exactly ONE source:email ticket for this partner (no fork).
    const afterReply = await admin()
      .select()
      .from(tickets)
      .where(and(eq(tickets.partnerId, fx.partner.id), eq(tickets.source, 'email')));
    expect(afterReply).toHaveLength(1);
    expect(afterReply[0].id).toBe(created.id);

    // The reply was logged 'matched' against the original ticket (header threading).
    const replyLog = await admin()
      .select()
      .from(ticketEmailInbound)
      .where(and(
        eq(ticketEmailInbound.partnerId, fx.partner.id),
        eq(ticketEmailInbound.providerMessageId, replyProviderMessageId)
      ));
    expect(replyLog).toHaveLength(1);
    expect(replyLog[0].parseStatus).toBe('matched');
    expect(replyLog[0].ticketId).toBe(created.id);

    // A public inbound comment landed on the original ticket.
    const comments = await admin()
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.ticketId, created.id));
    expect(comments.some((c: any) => c.content === 'It is still smoking.' && c.isPublic === true)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // FIX 2 (autoresponder-OFF self-reply): when a platform domain is configured,
  // email_thread_key = the generated anchor, but email_message_id = the customer's
  // OWN original Message-Id. A customer who replies to their OWN original (so
  // In-Reply-To = their original Message-Id, NOT the anchor — the autoresponder
  // never sent the anchor) must still thread onto the SAME ticket via the
  // email_message_id OR-branch — NOT fork a duplicate.
  // ---------------------------------------------------------------------------
  it('round-trip: a customer reply to their OWN original Message-Id (In-Reply-To != anchor) threads via email_message_id, no fork', async () => {
    const suffix = uniqueSuffix();
    const providerMessageId = `<self-orig-${suffix}@customer.test>`;
    // The customer's OWN Message-Id on the original — what their reply's In-Reply-To
    // will point at (they replied to their own sent mail, not to our autoresponse).
    const customerMessageId = `<self-real-${suffix}@customer.test>`;

    const buildInbound = (overrides: Partial<NormalizedInboundEmail>): NormalizedInboundEmail => ({
      provider: 'mailgun',
      providerMessageId,
      to: `${fx.partner.slug}@${INBOUND_DOMAIN}`,
      from: fx.janeEmail,
      fromName: 'Jane Known',
      subject: 'My screen is cracked',
      text: 'It happened when it fell.',
      messageId: customerMessageId,
      attachments: [],
      raw: { recipient: `${fx.partner.slug}@${INBOUND_DOMAIN}` },
      senderAuth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', verified: true },
      ...overrides
    });

    // 1) Drive the inbound create (known portal-user sender → source:email ticket).
    await withSystemDbAccessContext(() => processInboundEmail(buildInbound({})));

    const createdRows = await admin()
      .select()
      .from(tickets)
      .where(and(eq(tickets.partnerId, fx.partner.id), eq(tickets.source, 'email')));
    expect(createdRows).toHaveLength(1);
    const created = createdRows[0];

    // email_thread_key = the anchor; email_message_id = the customer's own Message-Id.
    const anchor = `<ticket-${created.id}@${INBOUND_DOMAIN}>`;
    expect(created.emailThreadKey).toBe(anchor);
    expect(created.emailMessageId).toBe(customerMessageId);

    // 2) Customer replies to their OWN original: In-Reply-To = customerMessageId (NOT anchor).
    const replyProviderMessageId = `<self-reply-${suffix}@customer.test>`;
    await withSystemDbAccessContext(() =>
      processInboundEmail(
        buildInbound({
          providerMessageId: replyProviderMessageId,
          messageId: `<self-reply-real-${suffix}@customer.test>`,
          subject: 'Re: My screen is cracked',
          inReplyTo: customerMessageId, // their OWN original id, NOT the anchor
          references: [customerMessageId],
          text: 'Any update on this?'
        })
      )
    );

    // Still exactly ONE source:email ticket for this partner (no fork).
    const afterReply = await admin()
      .select()
      .from(tickets)
      .where(and(eq(tickets.partnerId, fx.partner.id), eq(tickets.source, 'email')));
    expect(afterReply).toHaveLength(1);
    expect(afterReply[0].id).toBe(created.id);

    // The reply was logged 'matched' against the original ticket (via email_message_id).
    const replyLog = await admin()
      .select()
      .from(ticketEmailInbound)
      .where(and(
        eq(ticketEmailInbound.partnerId, fx.partner.id),
        eq(ticketEmailInbound.providerMessageId, replyProviderMessageId)
      ));
    expect(replyLog).toHaveLength(1);
    expect(replyLog[0].parseStatus).toBe('matched');
    expect(replyLog[0].ticketId).toBe(created.id);

    // A public inbound comment landed on the original ticket.
    const comments = await admin()
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.ticketId, created.id));
    expect(comments.some((c: any) => c.content === 'Any update on this?' && c.isPublic === true)).toBe(true);
  });
});
