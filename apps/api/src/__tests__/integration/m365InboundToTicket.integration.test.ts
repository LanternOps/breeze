/**
 * End-to-end (real DB): a Graph message, normalized via the M365 path with a
 * PRE-RESOLVED partner, flows through the existing processInboundEmail pipeline
 * and creates a ticket — proving the Plan 2 ingest reuses all of the inbound
 * threading/dedup/ticket logic.
 *
 * Org resolution: processInboundEmail still resolves the ORG even when the
 * partner is pre-resolved. An unknown sender would quarantine (step 8), so we
 * seed a portal user for the sender (findPortalUserInPartner → step 5) to
 * exercise the 'created' path. The sender-auth gate (R4) requires DMARC pass,
 * so the Graph message carries Authentication-Results: dmarc=pass.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { ticketEmailInbound, portalUsers } from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';
import { getTestDb } from './setup';
import { normalizeGraphMessage } from '../../services/ticketMailbox/normalizeGraphMessage';
import { processInboundEmail } from '../../services/inboundEmail/inboundEmailService';
import type { GraphMessage } from '../../services/ticketMailbox/graphMailClient';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('M365 inbound → ticket (real DB)', () => {
  runDb('creates a ticket from a normalized Graph message via the pre-resolved partner', async () => {
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
        { name: 'Authentication-Results', value: 'spf=pass; dkim=pass; dmarc=pass' },
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

    expect(rows.length).toBe(1);
    expect(rows[0].provider).toBe('m365');
    expect(rows[0].parseStatus).toBe('created');
    expect(rows[0].ticketId).toBeTruthy();

    // The created ticket lives in the portal user's org under the resolved partner.
    const ticketRows = await withSystemDbAccessContext(async () => {
      const { tickets } = await import('../../db/schema');
      return db.select().from(tickets).where(eq(tickets.id, rows[0].ticketId!)).limit(1);
    });
    expect(ticketRows[0]?.orgId).toBe(orgId);
    expect(ticketRows[0]?.partnerId).toBe(partnerId);
  });
});
