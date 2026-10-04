/**
 * STAFF_FORWARD_DOMAINS against real Postgres. The staff-forward path re-routes
 * a new ticket by the forwarded original sender ONLY when the outer sender is an
 * ACTIVE user of the partner whose mailbox received the mail. The unit suite's
 * mocked select cannot evaluate those predicates, so this file drives
 * processInboundEmail with a real users table: an active user of the partner
 * (positive control), a disabled user of the partner, and an active user of
 * another partner on the same staff domain. Only the first may re-route.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { gmail_v1 } from '@googleapis/gmail';
import { withSystemDbAccessContext } from '../../db';
import {
  customerEmailDomains,
  ticketMailboxConnections,
  ticketEmailInbound,
  tickets,
} from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';
import { normalizeGmailMessage } from '../../services/ticketMailbox/normalizeGmailMessage';
import { processInboundEmail } from '../../services/inboundEmail/inboundEmailService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function forwardMsg(id: string, from: string, mailbox: string, originalSender: string): gmail_v1.Schema$Message {
  const body = [
    'Can you take this one?',
    '',
    '---------- Forwarded message ---------',
    `From: Jane Client <${originalSender}>`,
    'Date: Sun, Sep 20, 2026 at 1:00 PM',
    'Subject: Printer down',
    '',
    'Our printer stopped working.',
  ].join('\n');
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: String(Date.now()),
    labelIds: ['INBOX'],
    snippet: 'forward',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: mailbox },
        { name: 'Subject', value: 'Fwd: Printer down' },
        { name: 'Message-ID', value: `<${id}@staff.test>` },
        { name: 'Authentication-Results', value: 'mx.google.com; spf=pass; dkim=pass; dmarc=pass' },
      ],
      body: { data: b64url(body) },
    },
  };
}

async function seed(suffix: string) {
  const db = getTestDb() as any;
  const staffDomain = `msp-${suffix}.test`;
  const clientDomain = `client-${suffix}.test`;
  const mailbox = `help-${suffix}@example.test`;
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const otherPartner = await createPartner();
    const mspOrg = await createOrganization({ partnerId: partner.id });
    const clientOrg = await createOrganization({ partnerId: partner.id });
    await db.insert(customerEmailDomains).values([
      { partnerId: partner.id, orgId: mspOrg.id, domain: staffDomain, autoCreateContact: false, isActive: true },
      { partnerId: partner.id, orgId: clientOrg.id, domain: clientDomain, autoCreateContact: false, isActive: true },
    ]);
    await createUser({ partnerId: partner.id, email: `active@${staffDomain}`, status: 'active' });
    await createUser({ partnerId: partner.id, email: `disabled@${staffDomain}`, status: 'disabled' });
    await createUser({ partnerId: otherPartner.id, email: `elsewhere@${staffDomain}`, status: 'active' });
    const [connection] = await db.insert(ticketMailboxConnections).values({
      partnerId: partner.id,
      provider: 'gmail',
      orgId: mspOrg.id,
      googleAccountSub: `sub-${suffix}`,
      mailboxAddress: mailbox,
      status: 'connected',
    }).returning({ id: ticketMailboxConnections.id, consentAttemptId: ticketMailboxConnections.consentAttemptId });
    return { partnerId: partner.id, mspOrgId: mspOrg.id, clientOrgId: clientOrg.id, staffDomain, clientDomain, mailbox, connection: connection! };
  });
}

async function ingestAndReadOrg(fx: Awaited<ReturnType<typeof seed>>, id: string, from: string): Promise<string | null> {
  const db = getTestDb() as any;
  const normalized = normalizeGmailMessage(forwardMsg(id, from, fx.mailbox, `jane@${fx.clientDomain}`), fx.partnerId, fx.mailbox, 'sub-x');
  expect(normalized.senderAuth?.verified).toBe(true);
  expect(normalized.forwardScanText).toContain('Forwarded message');
  await withSystemDbAccessContext(() => processInboundEmail(normalized, {
    provider: 'gmail',
    connectionId: fx.connection.id,
    partnerId: fx.partnerId,
    tenantId: null,
    consentAttemptId: fx.connection.consentAttemptId,
  }));
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select({ orgId: tickets.orgId })
      .from(ticketEmailInbound)
      .innerJoin(tickets, eq(tickets.id, ticketEmailInbound.ticketId))
      .where(and(eq(ticketEmailInbound.partnerId, fx.partnerId), eq(ticketEmailInbound.providerMessageId, normalized.providerMessageId)));
    return row?.orgId ?? null;
  });
}

describe('staff-forward routing: outer sender must be an active user of the partner (real DB)', () => {
  afterEach(() => {
    delete process.env.STAFF_FORWARD_DOMAINS;
  });

  runDb('routes by the original sender only for an active user of the partner', async () => {
    const suffix = `${Date.now()}-${Math.floor(performance.now())}`;
    const fx = await seed(suffix);
    process.env.STAFF_FORWARD_DOMAINS = fx.staffDomain;

    // Positive control: proves the forward, domains and gate all line up, so the
    // two negative cases below fail for the predicate under test, not the fixture.
    expect(await ingestAndReadOrg(fx, `sf-active-${suffix}`, `Tech <active@${fx.staffDomain}>`)).toBe(fx.clientOrgId);
    // Same partner, status not active: routed normally by the outer sender's domain.
    expect(await ingestAndReadOrg(fx, `sf-disabled-${suffix}`, `Old Tech <disabled@${fx.staffDomain}>`)).toBe(fx.mspOrgId);
    // Active user, but of another partner: no authority in this partner's mailbox.
    expect(await ingestAndReadOrg(fx, `sf-other-${suffix}`, `Tech <elsewhere@${fx.staffDomain}>`)).toBe(fx.mspOrgId);
  });
});
