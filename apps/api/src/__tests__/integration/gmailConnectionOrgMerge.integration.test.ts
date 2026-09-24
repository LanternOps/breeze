/**
 * #6592: a Gmail inbound mailbox connection carries org_id. Before the fix it was
 * exempt from the org cascade, so merging its credential-owning org into another
 * cascade-DELETED the connection with the loser org. It is now in the cascade
 * order with a plain `repoint` merge policy: the connection is simply re-tenanted
 * to the survivor org, keeping its status, lifecycle generation and Gmail cursor.
 *
 * The merge does NOT force a reconnect. Safety is enforced at POLL time instead:
 * every sweep verifies the mailbox's live Google account (OpenID `sub`) against the
 * stored one before ingesting (see gmailSweep.integration.test.ts). Same account ->
 * keeps polling with no interruption, so an in-flight message is never dropped
 * during the common same-Workspace merge. Different account (a genuine
 * reassignment) -> the sweep marks it reauth_required before reading any mail.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { ticketMailboxConnections, googleWorkspaceConnections } from '../../db/schema';
import { createPartner, createOrganization, createUser } from './db-utils';
import { getTestDb } from './setup';
import { encryptSecret } from '../../services/secretCrypto';
import { executeOrgMerge } from '../../services/orgMerge';

describe('Gmail connection through an org merge (#6592)', () => {
  it('re-tenants the Gmail mailbox connection to the survivor as a plain repoint (never cascade-deletes it, never forces reauth)', async () => {
    const db = getTestDb() as any;

    const seeded = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const loser = await createOrganization({ partnerId: partner.id });
      const survivor = await createOrganization({ partnerId: partner.id });
      const actor = await createUser({ partnerId: partner.id });
      const saKey = JSON.stringify({ client_email: 'sa@example.iam.gserviceaccount.com', private_key: 'x' });
      await db.insert(googleWorkspaceConnections).values({
        orgId: loser.id,
        customerDomain: 'client.example',
        adminEmail: 'admin@client.example',
        serviceAccountEmail: 'sa@example.iam.gserviceaccount.com',
        serviceAccountKey: encryptSecret(saKey, { aad: 'google_workspace_connections.service_account_key' }),
        status: 'active',
      });
      const [conn] = await db.insert(ticketMailboxConnections).values({
        partnerId: partner.id,
        provider: 'gmail',
        orgId: loser.id,
        googleAccountSub: 'sub-6592',
        mailboxAddress: 'help@client.example',
        status: 'connected',
        historyId: '42',
        eligibleAfter: new Date(),
      }).returning({ id: ticketMailboxConnections.id, consentAttemptId: ticketMailboxConnections.consentAttemptId });
      return {
        partnerId: partner.id, loserId: loser.id, survivorId: survivor.id, actorId: actor.id,
        connId: conn!.id, priorConsentAttemptId: conn!.consentAttemptId,
      };
    });

    await executeOrgMerge({
      loserOrgId: seeded.loserId,
      survivorOrgId: seeded.survivorId,
      partnerId: seeded.partnerId,
      performedBy: seeded.actorId,
    });

    const rows = (await withSystemDbAccessContext(() =>
      db.select().from(ticketMailboxConnections).where(eq(ticketMailboxConnections.id, seeded.connId)),
    )) as Array<{ orgId: string | null; status: string; consentAttemptId: string; googleAccountSub: string | null; historyId: string | null; eligibleAfter: Date | null }>;
    // The connection still exists and now belongs to the survivor org.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orgId).toBe(seeded.survivorId);
    // Plain repoint: status, lifecycle generation, immutable account sub and Gmail
    // cursor are all untouched. The next sweep verifies the live account and either
    // keeps polling (same account) or forces reauth (different account) — see
    // gmailSweep.integration.test.ts. Nothing is dropped here.
    expect(rows[0]!.status).toBe('connected');
    expect(rows[0]!.consentAttemptId).toBe(seeded.priorConsentAttemptId);
    expect(rows[0]!.googleAccountSub).toBe('sub-6592');
    expect(rows[0]!.historyId).toBe('42');
    expect(rows[0]!.eligibleAfter).not.toBeNull();
    // No row was left stranded under the (now-erased) loser org.
    const strays = (await withSystemDbAccessContext(() =>
      db.select().from(ticketMailboxConnections).where(
        and(eq(ticketMailboxConnections.provider, 'gmail'), eq(ticketMailboxConnections.orgId, seeded.loserId)),
      ),
    )) as unknown[];
    expect(strays).toHaveLength(0);
  }, 120000);
});
