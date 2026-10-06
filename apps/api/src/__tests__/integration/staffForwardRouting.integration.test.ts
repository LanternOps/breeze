/**
 * The per-partner staff-forward setting against real Postgres. The staff-forward
 * path re-routes a new ticket by the forwarded original sender ONLY when the
 * partner turned settings.ticketing.inbound.staffForwardRouting on and the outer
 * sender is ACTIVE, PARTNER-LEVEL staff (users.org_id IS NULL, with a
 * partner_users membership in this partner) whose org access covers the target
 * org. The unit suite's mocked select cannot evaluate those predicates, so this
 * file drives processInboundEmail with real users/partner_users rows. Every
 * negative sender below carries a partner-level 'all' membership unless the case
 * is about the membership, so each one fails on exactly one predicate.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { gmail_v1 } from '@googleapis/gmail';
import { withSystemDbAccessContext } from '../../db';
import {
  customerEmailDomains,
  partnerUsers,
  partners,
  ticketMailboxConnections,
  ticketEmailInbound,
  tickets,
} from '../../db/schema';
import { assignUserToPartner, createOrganization, createPartner, createRole, createUser } from './db-utils';
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

async function setStaffForwardRouting(partnerId: string, on: boolean) {
  const db = getTestDb() as any;
  await withSystemDbAccessContext(() => db.update(partners)
    .set({ settings: { ticketing: { inbound: { staffForwardRouting: on } } } })
    .where(eq(partners.id, partnerId)));
}

async function seed(suffix: string) {
  const db = getTestDb() as any;
  const staffDomain = `msp-${suffix}.test`;
  const clientDomain = `client-${suffix}.test`;
  const suspendedDomain = `suspended-${suffix}.test`;
  const mailbox = `help-${suffix}@example.test`;
  const fx = await withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const otherPartner = await createPartner();
    const mspOrg = await createOrganization({ partnerId: partner.id });
    const clientOrg = await createOrganization({ partnerId: partner.id });
    const suspendedOrg = await createOrganization({ partnerId: partner.id, status: 'suspended' });
    await db.insert(customerEmailDomains).values([
      { partnerId: partner.id, orgId: mspOrg.id, domain: staffDomain, autoCreateContact: false, isActive: true },
      { partnerId: partner.id, orgId: clientOrg.id, domain: clientDomain, autoCreateContact: false, isActive: true },
      // A suspended customer whose domain mapping is still active.
      { partnerId: partner.id, orgId: suspendedOrg.id, domain: suspendedDomain, autoCreateContact: false, isActive: true },
    ]);
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const otherRole = await createRole({ scope: 'partner', partnerId: otherPartner.id });
    const member = async (
      user: { id: string },
      access: 'all' | 'selected' | 'none' = 'all',
      orgIds: string[] | null = null,
      inPartner: { id: string } = partner,
    ) => {
      const a = await assignUserToPartner(user.id, inPartner.id, inPartner === partner ? role.id : otherRole.id, access);
      if (orgIds) await db.update(partnerUsers).set({ orgIds }).where(eq(partnerUsers.id, a.id));
    };
    // Positive control: active partner-level staff with access to every org.
    await member(await createUser({ partnerId: partner.id, email: `active@${staffDomain}`, status: 'active' }));
    // Partner-level staff whose selected orgs include the client org.
    await member(await createUser({ partnerId: partner.id, email: `scoped-in@${staffDomain}`, status: 'active' }), 'selected', [clientOrg.id]);
    // Same partner, status not active.
    await member(await createUser({ partnerId: partner.id, email: `disabled@${staffDomain}`, status: 'disabled' }));
    // Active, but of another partner.
    await member(await createUser({ partnerId: otherPartner.id, email: `elsewhere@${staffDomain}`, status: 'active' }), 'all', null, otherPartner);
    // Customer-org user (org_id set) on the staff domain. Given a partner 'all'
    // membership too, so only the org_id IS NULL predicate can reject it.
    await member(await createUser({ partnerId: partner.id, orgId: clientOrg.id, email: `customer@${staffDomain}`, status: 'active' }));
    // Partner-level staff limited to other orgs.
    await member(await createUser({ partnerId: partner.id, email: `scoped-out@${staffDomain}`, status: 'active' }), 'selected', [mspOrg.id]);
    // Partner-level user with no partner membership at all.
    await createUser({ partnerId: partner.id, email: `nomember@${staffDomain}`, status: 'active' });
    const [connection] = await db.insert(ticketMailboxConnections).values({
      partnerId: partner.id,
      provider: 'gmail',
      orgId: mspOrg.id,
      googleAccountSub: `sub-${suffix}`,
      mailboxAddress: mailbox,
      status: 'connected',
    }).returning({ id: ticketMailboxConnections.id, consentAttemptId: ticketMailboxConnections.consentAttemptId });
    return { partnerId: partner.id, mspOrgId: mspOrg.id, clientOrgId: clientOrg.id, staffDomain, clientDomain, suspendedDomain, mailbox, connection: connection! };
  });
  await setStaffForwardRouting(fx.partnerId, true);
  return fx;
}

async function ingestAndReadOrg(
  fx: Awaited<ReturnType<typeof seed>>, id: string, from: string, originalDomain: string = fx.clientDomain,
): Promise<string | null> {
  const db = getTestDb() as any;
  const normalized = normalizeGmailMessage(forwardMsg(id, from, fx.mailbox, `jane@${originalDomain}`), fx.partnerId, fx.mailbox, 'sub-x');
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

describe('staff-forward routing: partner setting and partner-level staff with org access (real DB)', () => {
  runDb('routes by the original sender only for active partner-level staff covering the target org', async () => {
    const suffix = `${Date.now()}-${Math.floor(performance.now())}`;
    const fx = await seed(suffix);
    const id = (name: string) => `sf-${name}-${suffix}`;

    // Positive controls: prove the forward, domains, setting and gate all line
    // up, so each negative case below fails for the predicate under test.
    expect(await ingestAndReadOrg(fx, id('active'), `Tech <active@${fx.staffDomain}>`)).toBe(fx.clientOrgId);
    expect(await ingestAndReadOrg(fx, id('scoped-in'), `Tech <scoped-in@${fx.staffDomain}>`)).toBe(fx.clientOrgId);
    // Each of these routes normally, by the outer sender's domain.
    expect(await ingestAndReadOrg(fx, id('disabled'), `Old Tech <disabled@${fx.staffDomain}>`)).toBe(fx.mspOrgId);
    expect(await ingestAndReadOrg(fx, id('elsewhere'), `Tech <elsewhere@${fx.staffDomain}>`)).toBe(fx.mspOrgId);
    expect(await ingestAndReadOrg(fx, id('customer'), `User <customer@${fx.staffDomain}>`)).toBe(fx.mspOrgId);
    expect(await ingestAndReadOrg(fx, id('scoped-out'), `Tech <scoped-out@${fx.staffDomain}>`)).toBe(fx.mspOrgId);
    expect(await ingestAndReadOrg(fx, id('nomember'), `Tech <nomember@${fx.staffDomain}>`)).toBe(fx.mspOrgId);
    // All-access staff, but the original sender's org is suspended: staff could
    // not open it, so the forward is not filed there.
    expect(await ingestAndReadOrg(fx, id('suspended'), `Tech <active@${fx.staffDomain}>`, fx.suspendedDomain)).toBe(fx.mspOrgId);

    // The partner setting off: even the positive-control sender routes normally.
    await setStaffForwardRouting(fx.partnerId, false);
    expect(await ingestAndReadOrg(fx, id('off'), `Tech <active@${fx.staffDomain}>`)).toBe(fx.mspOrgId);
  });
});
