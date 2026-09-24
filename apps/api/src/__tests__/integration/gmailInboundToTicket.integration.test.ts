/**
 * End-to-end (real DB): the Gmail inbound path. Proves against a live Postgres
 * that the migration applied, that the generalized generation lock ingests only
 * an exact gmail generation, and that the DB-level tenant-isolation invariants
 * (provider CHECK, connected-requires-sub+org, composite org/partner FK) hold.
 *
 * The poll worker (which mints a DWD token and calls Gmail) is NOT exercised here
 * — that is the live-mailbox proof. This test drives processInboundEmail directly
 * with a normalized Gmail message + generation, exactly as the sweep would.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { gmail_v1 } from '@googleapis/gmail';
import { withSystemDbAccessContext } from '../../db';
import {
  ticketMailboxConnections,
  ticketEmailInbound,
  tickets,
  portalUsers,
} from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';
import { getTestDb } from './setup';
import { normalizeGmailMessage } from '../../services/ticketMailbox/normalizeGmailMessage';
import { processInboundEmail } from '../../services/inboundEmail/inboundEmailService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function gmailMsg(id: string, from: string, mailbox: string, subject: string): gmail_v1.Schema$Message {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: String(Date.now()),
    labelIds: ['INBOX'],
    snippet: 'body',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: mailbox },
        { name: 'Subject', value: subject },
        { name: 'Message-ID', value: `<${id}@known.test>` },
        // Google-stamped, dmarc=pass → normalizer sets verified → clears the R4 gate.
        { name: 'Authentication-Results', value: 'mx.google.com; spf=pass; dkim=pass; dmarc=pass' },
      ],
      body: { data: b64url('printer down') },
    },
  };
}

async function seedGmailConnection(db: any, mailbox: string, customerEmail: string) {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await db.insert(portalUsers).values({ orgId: org.id, email: customerEmail, name: 'Customer' });
    const [connection] = await db.insert(ticketMailboxConnections).values({
      partnerId: partner.id,
      provider: 'gmail',
      orgId: org.id,
      googleAccountSub: `sub-${Date.now()}`,
      mailboxAddress: mailbox,
      status: 'connected',
    }).returning({
      id: ticketMailboxConnections.id,
      consentAttemptId: ticketMailboxConnections.consentAttemptId,
    });
    return { partnerId: partner.id, orgId: org.id, connection: connection! };
  });
}

describe('Gmail inbound → ticket (real DB)', () => {
  runDb('ingests a message under an exact connected gmail generation', async () => {
    const db = getTestDb() as any;
    const suffix = `${Date.now()}-${Math.floor(performance.now())}`;
    const customerEmail = `cust-${suffix}@known.test`;
    const mailbox = `help-${suffix}@bdunn.test`;
    const seeded = await seedGmailConnection(db, mailbox, customerEmail);

    const msg = gmailMsg(`g-${suffix}`, customerEmail, mailbox, `Gmail ingest ${suffix}`);
    const normalized = normalizeGmailMessage(msg, seeded.partnerId, mailbox, 'sub-x');
    expect(normalized.senderAuth?.verified).toBe(true);

    await withSystemDbAccessContext(() => processInboundEmail(normalized, {
      provider: 'gmail',
      connectionId: seeded.connection.id,
      partnerId: seeded.partnerId,
      tenantId: null,
      consentAttemptId: seeded.connection.consentAttemptId,
    }));

    const rows = await db.select().from(ticketEmailInbound).where(and(
      eq(ticketEmailInbound.partnerId, seeded.partnerId),
      eq(ticketEmailInbound.providerMessageId, normalized.providerMessageId),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.parseStatus).toBe('created');
  });

  runDb('drops a message whose generation was ROTATED, isolating the generation guard from status', async () => {
    // A reconnect/disable rotates consentAttemptId. A message carrying the OLD
    // generation is a retired binding and must be dropped. This ISOLATES the
    // generation guard from the status allowlist: the live row is left status
    // 'connected' (fully in the allowlist), so the ONLY reason to drop is the
    // consentAttemptId mismatch — proving the F1 allowlist change did not weaken it.
    const db = getTestDb() as any;
    const suffix = `${Date.now()}-${Math.floor(performance.now())}`;
    const customerEmail = `cust-rot-${suffix}@known.test`;
    const mailbox = `help-rot-${suffix}@bdunn.test`;
    const seeded = await seedGmailConnection(db, mailbox, customerEmail);
    const staleGeneration = seeded.connection.consentAttemptId;

    await withSystemDbAccessContext(() => db.update(ticketMailboxConnections)
      .set({ status: 'connected', consentAttemptId: crypto.randomUUID() })
      .where(eq(ticketMailboxConnections.id, seeded.connection.id)));

    const msg = gmailMsg(`gd-${suffix}`, customerEmail, mailbox, `rotated ${suffix}`);
    const normalized = normalizeGmailMessage(msg, seeded.partnerId, mailbox, 'sub-x');
    await withSystemDbAccessContext(() => processInboundEmail(normalized, {
      provider: 'gmail',
      connectionId: seeded.connection.id,
      partnerId: seeded.partnerId,
      tenantId: null,
      consentAttemptId: staleGeneration,
    }));

    const rows = await db.select().from(ticketEmailInbound).where(and(
      eq(ticketEmailInbound.partnerId, seeded.partnerId),
      eq(ticketEmailInbound.providerMessageId, normalized.providerMessageId),
    ));
    expect(rows).toHaveLength(0);
  });

  runDb('fails closed for a gmail message with NO generation', async () => {
    const db = getTestDb() as any;
    const suffix = `${Date.now()}-${Math.floor(performance.now())}`;
    const mailbox = `help-nogen-${suffix}@bdunn.test`;
    const seeded = await seedGmailConnection(db, mailbox, `c-${suffix}@known.test`);
    const msg = gmailMsg(`gn-${suffix}`, `c-${suffix}@known.test`, mailbox, 'no gen');
    const normalized = normalizeGmailMessage(msg, seeded.partnerId, mailbox, 'sub-x');

    await withSystemDbAccessContext(() => processInboundEmail(normalized)); // no generation

    const ticketRows = await withSystemDbAccessContext(() =>
      db.select().from(tickets).where(eq(tickets.orgId, seeded.orgId)),
    );
    expect(ticketRows).toHaveLength(0);
  });

  runDb('rejects a generation whose provider does not match the message provider', async () => {
    const db = getTestDb() as any;
    const suffix = `${Date.now()}-${Math.floor(performance.now())}`;
    const mailbox = `help-mism-${suffix}@bdunn.test`;
    const seeded = await seedGmailConnection(db, mailbox, `c-${suffix}@known.test`);
    const msg = gmailMsg(`gm-${suffix}`, `c-${suffix}@known.test`, mailbox, 'mismatch');
    const normalized = normalizeGmailMessage(msg, seeded.partnerId, mailbox, 'sub-x');

    // A gmail message paired with an m365 generation must NOT ingest.
    await withSystemDbAccessContext(() => processInboundEmail(normalized, {
      provider: 'm365',
      connectionId: seeded.connection.id,
      partnerId: seeded.partnerId,
      tenantId: null,
      consentAttemptId: seeded.connection.consentAttemptId,
    }));

    const rows = await db.select().from(ticketEmailInbound).where(and(
      eq(ticketEmailInbound.partnerId, seeded.partnerId),
      eq(ticketEmailInbound.providerMessageId, normalized.providerMessageId),
    ));
    expect(rows).toHaveLength(0);
  });

  runDb('DB CHECK: a connected gmail row requires google_account_sub AND org_id', async () => {
    const db = getTestDb() as any;
    await expect(withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      await db.insert(ticketMailboxConnections).values({
        partnerId: partner.id,
        provider: 'gmail',
        orgId: org.id,
        googleAccountSub: null, // missing → CHECK violation for a connected row
        mailboxAddress: `bad-${Date.now()}@bdunn.test`,
        status: 'connected',
      });
    })).rejects.toThrow();
  });

  runDb('DB FK: a gmail connection cannot reference an org owned by a DIFFERENT partner', async () => {
    const db = getTestDb() as any;
    await expect(withSystemDbAccessContext(async () => {
      const partnerA = await createPartner();
      const partnerB = await createPartner();
      const orgB = await createOrganization({ partnerId: partnerB.id });
      // partner A's connection pointing at partner B's org → composite FK violation.
      await db.insert(ticketMailboxConnections).values({
        partnerId: partnerA.id,
        provider: 'gmail',
        orgId: orgB.id,
        googleAccountSub: `sub-${Date.now()}`,
        mailboxAddress: `xtenant-${Date.now()}@bdunn.test`,
        status: 'connected',
      });
    })).rejects.toThrow();
  });
});
