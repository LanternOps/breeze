/**
 * End-to-end (real DB): M365 messages fail closed without generation proof,
 * ingest through the existing pipeline with an exact active generation, and
 * are discarded after disable rotates a generation that was already queued.
 *
 * Org resolution still resolves the customer ORG after the mailbox row proves
 * the partner. An unknown sender would quarantine (step 8), so we
 * seed a portal user for the sender (findPortalUserInPartner → step 5) to
 * exercise the 'created' path. The sender-auth gate (R4) requires DMARC pass,
 * so the Graph message carries Authentication-Results: dmarc=pass.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import {
  ticketComments,
  ticketEmailInbound,
  ticketMailboxConnections,
  ticketMailboxTenantOwnerships,
  tickets,
  portalUsers,
} from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';
import { getTestDb } from './setup';
import { normalizeGraphMessage } from '../../services/ticketMailbox/normalizeGraphMessage';
import { processInboundEmail } from '../../services/inboundEmail/inboundEmailService';
import { disableConnection } from '../../services/ticketMailbox/connectionService';
import type { GraphMessage } from '../../services/ticketMailbox/graphMailClient';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('M365 inbound → ticket (real DB)', () => {
  runDb('fails closed for a pre-resolved Graph message without a mailbox generation', async () => {
    const db = getTestDb() as any;
    const suffix = `${Date.now()}-${Math.floor(performance.now())}`;
    const custEmail = `cust-${suffix}@known.test`;

    const { partnerId, orgId } = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      // Known portal user → findPortalUserInPartner resolves the org (the 'created' path).
      await db.insert(portalUsers).values({ orgId: org.id, email: custEmail, name: 'Cust' });
      return { partnerId: partner.id, orgId: org.id };
    });

    const msg: GraphMessage = {
      id: `graph-${suffix}`,
      internetMessageId: `<${suffix}@known.test>`,
      subject: 'Cannot print',
      from: { emailAddress: { address: custEmail, name: 'Cust' } },
      toRecipients: [{ emailAddress: { address: 'support@a.com' } }],
      body: { contentType: 'html', content: '<p>printer down</p>' },
      bodyPreview: 'printer down',
      hasAttachments: false,
      internetMessageHeaders: [
        // authserv-id 'a.com' matches the support mailbox domain → trusted (clears R4).
        { name: 'Authentication-Results', value: 'a.com; spf=pass; dkim=pass; dmarc=pass' },
      ],
    };
    const normalized = normalizeGraphMessage(msg, partnerId, 'support@a.com');
    // Pre-resolved partner + verified sender → bypasses recipient resolution, clears R4.
    expect(normalized.resolvedPartnerId).toBe(partnerId);
    expect(normalized.senderAuth?.verified).toBe(true);

    await withSystemDbAccessContext(() => processInboundEmail(normalized));

    const rows = await db
      .select()
      .from(ticketEmailInbound)
      .where(and(
        eq(ticketEmailInbound.partnerId, partnerId),
        eq(ticketEmailInbound.providerMessageId, msg.id),
      ));

    expect(rows).toHaveLength(0);
    const ticketRows = await withSystemDbAccessContext(() =>
      db.select().from(tickets).where(eq(tickets.orgId, orgId)),
    );
    expect(ticketRows).toHaveLength(0);
  });

  runDb('ingests only the exact connected mailbox generation', async () => {
    const db = getTestDb() as any;
    const suffix = `${Date.now()}-${Math.floor(performance.now())}`;
    const tenantId = randomUUID();
    const microsoftOid = randomUUID();
    const customerEmail = `active-${suffix}@known.test`;
    const mailboxAddress = `support-${suffix}@example.com`;

    const seeded = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      await db.insert(portalUsers).values({ orgId: org.id, email: customerEmail, name: 'Customer' });
      await db.insert(ticketMailboxTenantOwnerships).values({
        tenantId,
        partnerId: partner.id,
        verifiedMicrosoftOid: microsoftOid,
      });
      const [connection] = await db.insert(ticketMailboxConnections).values({
        partnerId: partner.id,
        tenantId,
        mailboxAddress,
        status: 'connected',
      }).returning({
        id: ticketMailboxConnections.id,
        consentAttemptId: ticketMailboxConnections.consentAttemptId,
      });
      return { partnerId: partner.id, connection: connection! };
    });

    const msg: GraphMessage = {
      id: `active-${suffix}`,
      internetMessageId: `<active-${suffix}@known.test>`,
      subject: `Active generation ${suffix}`,
      from: { emailAddress: { address: customerEmail, name: 'Customer' } },
      toRecipients: [{ emailAddress: { address: mailboxAddress } }],
      body: { contentType: 'text', content: 'active generation' },
      bodyPreview: 'active generation',
      hasAttachments: false,
      internetMessageHeaders: [
        { name: 'Authentication-Results', value: 'example.com; spf=pass; dkim=pass; dmarc=pass' },
      ],
    };
    const normalized = normalizeGraphMessage(msg, seeded.partnerId, mailboxAddress);

    await withSystemDbAccessContext(() => processInboundEmail(normalized, {
      connectionId: seeded.connection.id,
      partnerId: seeded.partnerId,
      tenantId,
      consentAttemptId: seeded.connection.consentAttemptId,
    }));

    const rows = await db.select().from(ticketEmailInbound).where(and(
      eq(ticketEmailInbound.partnerId, seeded.partnerId),
      eq(ticketEmailInbound.providerMessageId, msg.id),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.parseStatus).toBe('created');
  });

  runDb('discards a queued generation after disable rotates it without ticket or comment writes', async () => {
    const db = getTestDb() as any;
    const suffix = `${Date.now()}-${Math.floor(performance.now())}`;
    const tenantId = randomUUID();
    const microsoftOid = randomUUID();
    const mailboxAddress = `support-stale-${suffix}@example.com`;
    const customerEmail = `stale-${suffix}@known.test`;

    const seeded = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      await db.insert(portalUsers).values({ orgId: org.id, email: customerEmail, name: 'Customer' });
      await db.insert(ticketMailboxTenantOwnerships).values({
        tenantId,
        partnerId: partner.id,
        verifiedMicrosoftOid: microsoftOid,
      });
      const [connection] = await db.insert(ticketMailboxConnections).values({
        partnerId: partner.id,
        tenantId,
        mailboxAddress,
        status: 'connected',
      }).returning({
        id: ticketMailboxConnections.id,
        consentAttemptId: ticketMailboxConnections.consentAttemptId,
      });
      return { partnerId: partner.id, connection: connection! };
    });

    const queuedGeneration = {
      connectionId: seeded.connection.id,
      partnerId: seeded.partnerId,
      tenantId,
      consentAttemptId: seeded.connection.consentAttemptId,
    };
    const msg: GraphMessage = {
      id: `stale-${suffix}`,
      internetMessageId: `<stale-${suffix}@known.test>`,
      subject: `Stale generation ${suffix}`,
      from: { emailAddress: { address: customerEmail, name: 'Customer' } },
      toRecipients: [{ emailAddress: { address: mailboxAddress } }],
      body: { contentType: 'text', content: 'must not ingest' },
      bodyPreview: 'must not ingest',
      hasAttachments: true,
      internetMessageHeaders: [
        { name: 'Authentication-Results', value: 'example.com; spf=pass; dkim=pass; dmarc=pass' },
      ],
    };
    const normalized = normalizeGraphMessage(msg, seeded.partnerId, mailboxAddress);
    const commentsBefore = await db.select({ id: ticketComments.id }).from(ticketComments);

    // The poll snapshot has already been queued. Disable commits first and rotates
    // consentAttemptId; consuming the old job must fail the transaction-scoped lock.
    await withSystemDbAccessContext(() => disableConnection(seeded.connection.id, seeded.partnerId));
    await withSystemDbAccessContext(() => processInboundEmail(normalized, queuedGeneration));

    const inboundRows = await db.select().from(ticketEmailInbound).where(eq(
      ticketEmailInbound.providerMessageId,
      msg.id,
    ));
    const ticketRows = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.subject, msg.subject ?? ''));
    const commentsAfter = await db.select({ id: ticketComments.id }).from(ticketComments);
    expect(inboundRows).toHaveLength(0);
    expect(ticketRows).toHaveLength(0);
    expect(commentsAfter).toHaveLength(commentsBefore.length);
  });
});
