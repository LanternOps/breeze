/**
 * LIVE worker end-to-end (gated on SA_KEY_PATH + E2E_MARKER). Proves the ASSEMBLED
 * path Codex required: a controlled help@ message flows through the REAL poll
 * worker -> BullMQ queue -> inbound consumer -> exactly ONE ticket, and stays
 * exactly one after a second sweep (cursor + dedup idempotency). No manual enqueue,
 * no direct consumer call. Seeds an encrypted DWD service-account credential row.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { and, eq, like } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import {
  googleWorkspaceConnections,
  ticketMailboxConnections,
  tickets,
  portalUsers,
} from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';
import { getTestDb } from './setup';
import { encryptSecret } from '../../services/secretCrypto';
import { runMailboxSweep } from '../../jobs/ticketMailboxPollWorker';
import { probeMailboxForConnect } from '../../services/ticketMailbox/googleMailboxClient';
import { initializeInboundEmailWorker, shutdownInboundEmailWorker } from '../../jobs/inboundEmailWorker';

const KEY = process.env.SA_KEY_PATH;
const MARKER = process.env.E2E_MARKER;
const SENDER = process.env.E2E_SENDER || 'sender@example.com';
const MAILBOX = process.env.E2E_MAILBOX || 'help@example.com';
const live = it.runIf(!!KEY && !!MARKER);

async function markerTickets(db: any, orgId: string): Promise<Array<{ id: string }>> {
  // Bind to the unique per-run marker carried in the sent message's subject, not
  // to every ticket in the org — otherwise an unrelated eligible message (or a
  // leftover ticket) would satisfy the assertion while the designated message was
  // actually lost. MARKER is non-null here (the suite only runs under runIf).
  return (await withSystemDbAccessContext(() =>
    db.select({ id: tickets.id }).from(tickets)
      .where(and(eq(tickets.orgId, orgId), like(tickets.subject, `%${MARKER}%`))),
  )) as Array<{ id: string }>;
}

describe('Gmail worker E2E (live, gated)', () => {
  live('one help@ message -> exactly one ticket via the real worker+queue+consumer, idempotent', async () => {
    const db = getTestDb() as any;
    const saKey = readFileSync(KEY!, 'utf8');
    // Seed the REAL immutable Google account sub of the live mailbox, read through
    // the same DWD probe the connect route uses. A fabricated sub would fail the
    // worker's per-sweep identity gate (googleAccountSub vs live UserInfo sub ->
    // reauth_required before any read), so the sweep would fetch nothing and this
    // test could never observe the marker ticket.
    const sub = (await probeMailboxForConnect(saKey, MAILBOX)).sub;

    const seeded = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      // Sender resolves to this org (the 'created' path).
      await db.insert(portalUsers).values({ orgId: org.id, email: SENDER, name: 'Sender' });
      await db.insert(googleWorkspaceConnections).values({
        orgId: org.id,
        customerDomain: process.env.E2E_CUSTOMER_DOMAIN || 'example.com',
        adminEmail: process.env.E2E_ADMIN_EMAIL || 'admin@example.com',
        serviceAccountEmail: JSON.parse(saKey).client_email,
        serviceAccountKey: encryptSecret(saKey, { aad: 'google_workspace_connections.service_account_key' }),
        status: 'active',
      });
      const [conn] = await db.insert(ticketMailboxConnections).values({
        partnerId: partner.id,
        provider: 'gmail',
        orgId: org.id,
        googleAccountSub: sub,
        mailboxAddress: MAILBOX,
        status: 'connected',
        // historyId '1' is too old -> forces the reconciliation path, which
        // enumerates INBOX since the floor and ingests (finds the just-sent marker).
        historyId: '1',
        eligibleAfter: new Date(Date.now() - 10 * 60 * 1000),
      }).returning({ id: ticketMailboxConnections.id });
      return { partnerId: partner.id, orgId: org.id, connId: conn!.id };
    });

    const readConn = async () => ((await withSystemDbAccessContext(() =>
      db.select({ historyId: ticketMailboxConnections.historyId, lastPolledAt: ticketMailboxConnections.lastPolledAt })
        .from(ticketMailboxConnections).where(eq(ticketMailboxConnections.id, seeded.connId)),
    )) as Array<{ historyId: string | null; lastPolledAt: Date | null }>)[0]!;

    await initializeInboundEmailWorker();
    try {
      // First sweep: reconcile -> fetch the marker message -> enqueue -> consumer -> ticket.
      await runMailboxSweep();

      // Poll for the ticket (consumer is async).
      let firstTickets: Array<{ id: string }> = [];
      for (let i = 0; i < 20; i++) {
        firstTickets = await markerTickets(db, seeded.orgId);
        if (firstTickets.length >= 1) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      expect(firstTickets).toHaveLength(1); // exactly one ticket for the uniquely-marked message
      const firstTicketId = firstTickets[0]!.id;

      // Force the SECOND sweep to actually re-process the same mailbox rather than
      // no-op. A bare re-run could skip the mailbox (cursor already advanced) and
      // still leave the count at 1 — a vacuous idempotency check. Reset the cursor
      // to the too-old value so the sweep re-reconciles: re-enumerate INBOX,
      // re-fetch the SAME marker message, re-enqueue it, and let dedup on
      // (partner_id, provider_message_id) drop it. Capture last_polled_at so we can
      // prove the sweep really ran the mailbox.
      const before = await readConn();
      await withSystemDbAccessContext(() =>
        db.update(ticketMailboxConnections)
          .set({ historyId: '1' })
          .where(eq(ticketMailboxConnections.id, seeded.connId)),
      );

      await runMailboxSweep();
      await new Promise((r) => setTimeout(r, 3000));

      // The mailbox was genuinely swept again (cursor re-advanced past the reset,
      // last_polled_at moved forward) — not silently skipped.
      const after = await readConn();
      expect(after.historyId).not.toBe('1');
      expect(after.lastPolledAt).not.toBeNull();
      if (before.lastPolledAt) {
        expect(after.lastPolledAt!.getTime()).toBeGreaterThan(before.lastPolledAt.getTime());
      }

      // And dedup kept exactly ONE ticket — the SAME one, not a recreated duplicate.
      const secondTickets = await markerTickets(db, seeded.orgId);
      expect(secondTickets).toHaveLength(1);
      expect(secondTickets[0]!.id).toBe(firstTicketId);
    } finally {
      await shutdownInboundEmailWorker();
    }
  }, 90000);
});
