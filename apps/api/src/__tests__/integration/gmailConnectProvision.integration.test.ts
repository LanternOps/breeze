/**
 * #6593: production Gmail connect/provisioning path. createGmailConnection
 * verifies the org's Google Workspace credential can actually read the mailbox
 * (domain-wide delegation), then persists a CONNECTED gmail row. Real Postgres
 * exercises the provider CHECK constraints; only the external Gmail read is mocked.
 */
import './setup';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const gmailMock = vi.hoisted(() => ({ probeMailboxForConnect: vi.fn() }));
vi.mock('../../services/ticketMailbox/googleMailboxClient', async (importActual) => {
  const actual = await importActual<typeof import('../../services/ticketMailbox/googleMailboxClient')>();
  return { ...actual, probeMailboxForConnect: gmailMock.probeMailboxForConnect }; // keep MailboxProbeError real
});

import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { withSystemDbAccessContext } from '../../db';
import { ticketMailboxConnections, googleWorkspaceConnections, organizations } from '../../db/schema';
import { createPartner, createOrganization, createUser } from './db-utils';
import { getTestDb } from './setup';
import { encryptSecret } from '../../services/secretCrypto';
import { createGmailConnection } from '../../services/ticketMailbox/connectionService';
import { MailboxProbeError } from '../../services/ticketMailbox/googleMailboxClient';
import { executeOrgMerge } from '../../services/orgMerge';

let db: any;

async function seedOrg(withCredential: boolean) {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    if (withCredential) {
      const saKey = JSON.stringify({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: 'k' });
      await db.insert(googleWorkspaceConnections).values({
        orgId: org.id,
        customerDomain: 'client.example',
        adminEmail: 'admin@client.example',
        serviceAccountEmail: 'sa@x.iam.gserviceaccount.com',
        serviceAccountKey: encryptSecret(saKey, { aad: 'google_workspace_connections.service_account_key' }),
        status: 'active',
      });
    }
    return { partnerId: partner.id, orgId: org.id };
  });
}

describe('createGmailConnection (#6593 production connect path)', () => {
  beforeEach(() => {
    db = getTestDb();
    vi.clearAllMocks();
    gmailMock.probeMailboxForConnect.mockResolvedValue({ historyId: '12345', sub: 'goog-sub-default', email: 'help@client.example' });
  });

  it('provisions a connected Gmail row after verifying the mailbox is readable', async () => {
    const { partnerId, orgId } = await seedOrg(true);
    const res = await createGmailConnection({
      partnerId, orgId, mailboxAddress: 'Help@Client.Example', displayName: 'Support', createdBy: null,
    });
    expect(res.ok).toBe(true);
    expect(gmailMock.probeMailboxForConnect).toHaveBeenCalledWith(expect.any(String), 'help@client.example');

    const rows = (await withSystemDbAccessContext(() =>
      db.select().from(ticketMailboxConnections).where(eq(ticketMailboxConnections.orgId, orgId)),
    )) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.provider).toBe('gmail');
    expect(row.status).toBe('connected');
    expect(row.mailboxAddress).toBe('help@client.example');
    expect(row.googleAccountSub).toBe('goog-sub-default'); // the immutable Google sub, not the address
    expect(row.tenantId).toBeNull();                       // gmail row carries no Microsoft tenant
    expect(row.historyId).toBe('12345');
    expect(row.eligibleAfter).not.toBeNull();
  });

  it('fails cleanly (account_id_unavailable) when the immutable account id cannot be read', async () => {
    const { partnerId, orgId } = await seedOrg(true);
    gmailMock.probeMailboxForConnect.mockRejectedValue(new MailboxProbeError('identity', 'missing openid scope'));
    const res = await createGmailConnection({ partnerId, orgId, mailboxAddress: 'help@client.example', createdBy: null });
    expect(res).toMatchObject({ ok: false, code: 'account_id_unavailable' });
    // Nothing persisted without a verified account identity.
    const rows = (await withSystemDbAccessContext(() =>
      db.select().from(ticketMailboxConnections).where(eq(ticketMailboxConnections.orgId, orgId)),
    )) as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('fails cleanly when the org has no active Google Workspace credential', async () => {
    const { partnerId, orgId } = await seedOrg(false);
    const res = await createGmailConnection({ partnerId, orgId, mailboxAddress: 'help@client.example', createdBy: null });
    expect(res).toMatchObject({ ok: false, code: 'no_google_connection' });
    expect(gmailMock.probeMailboxForConnect).not.toHaveBeenCalled();
  });

  it('fails cleanly when domain-wide delegation cannot read the mailbox', async () => {
    const { partnerId, orgId } = await seedOrg(true);
    gmailMock.probeMailboxForConnect.mockRejectedValue(new MailboxProbeError('read', '403'));
    const res = await createGmailConnection({ partnerId, orgId, mailboxAddress: 'help@client.example', createdBy: null });
    expect(res).toMatchObject({ ok: false, code: 'mailbox_unreadable' });
    // Nothing persisted on a failed verification.
    const rows = (await withSystemDbAccessContext(() =>
      db.select().from(ticketMailboxConnections).where(eq(ticketMailboxConnections.orgId, orgId)),
    )) as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('rejects an org that does not belong to the caller partner', async () => {
    const { orgId } = await seedOrg(true);
    const other = await withSystemDbAccessContext(() => createPartner());
    const res = await createGmailConnection({ partnerId: other.id, orgId, mailboxAddress: 'help@client.example', createdBy: null });
    expect(res).toMatchObject({ ok: false, code: 'org_not_in_partner' });
  });

  it('connect-vs-merge race: the FOR UPDATE lock SERIALIZES against a concurrent merge fence, then refuses org_unavailable', async () => {
    // The real interleaving (not a pre-fenced org): a second connection holds the
    // org row lock and fences it to status='merging' UNCOMMITTED, exactly as a merge
    // Phase A in flight. createGmailConnection passes its (lock-free) validation +
    // probe, then BLOCKS on its own FOR UPDATE of the org row inside the upsert
    // transaction. Only after the fence commits does connect acquire the lock, see
    // 'merging', and refuse. This proves the lock is load-bearing: without
    // `.for('update')` connect would not block and could orphan a row under the
    // merged-away org.
    const { partnerId, orgId } = await seedOrg(true);
    gmailMock.probeMailboxForConnect.mockResolvedValue({ historyId: '12345', sub: 'goog-sub-default', email: 'help@client.example' });

    const holder = postgres(process.env.DATABASE_URL as string, { max: 1 });
    const reserved = await holder.reserve();
    let blockedSeen = false;
    try {
      await reserved`BEGIN`;
      await reserved`SELECT set_config('breeze.scope','system',true)`;
      await reserved`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`;
      await reserved`UPDATE organizations SET status = 'merging' WHERE id = ${orgId}`;

      // Start connect WITHOUT awaiting — it will block on the org FOR UPDATE we hold.
      const connectP = createGmailConnection({ partnerId, orgId, mailboxAddress: 'help@client.example', createdBy: null });

      // Deterministically wait until connect's backend is actually blocked on a lock.
      for (let i = 0; i < 100 && !blockedSeen; i++) {
        const r = (await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`)) as unknown as Array<{ n: number }>;
        if ((r[0]?.n ?? 0) >= 1) { blockedSeen = true; break; }
        await new Promise((res) => setTimeout(res, 50));
      }

      await reserved`COMMIT`; // release the lock and publish the fence
      const res = await connectP;
      expect(res).toMatchObject({ ok: false, code: 'org_unavailable' });
    } finally {
      await reserved.release();
      await holder.end();
    }

    expect(blockedSeen).toBe(true); // connect really did block on the lock (serialization proven)
    const rows = (await withSystemDbAccessContext(() =>
      db.select().from(ticketMailboxConnections).where(eq(ticketMailboxConnections.orgId, orgId)),
    )) as unknown[];
    expect(rows).toHaveLength(0); // no orphaned connection under the merged-away org
  });

  it('refuses (org_unavailable) when the org has been soft-deleted (merge terminal shell)', async () => {
    const { partnerId, orgId } = await seedOrg(true);
    await withSystemDbAccessContext(() =>
      db.update(organizations).set({ deletedAt: new Date() }).where(eq(organizations.id, orgId)),
    );
    const res = await createGmailConnection({ partnerId, orgId, mailboxAddress: 'help@client.example', createdBy: null });
    expect(res).toMatchObject({ ok: false, code: 'org_unavailable' });
  });

  it('same-account reconnect PRESERVES the durable cursor + eligibility floor AND keeps the generation (does not skip outage-window mail or drop queued work)', async () => {
    const { partnerId, orgId } = await seedOrg(true);
    // A mailbox that was connected, went reauth_required during an outage, and
    // still holds its last durable cursor H1, its connect-time floor, and its
    // stored account sub.
    const priorFloor = new Date(Date.now() - 60 * 60 * 1000);
    const [prior] = (await withSystemDbAccessContext(() =>
      db.insert(ticketMailboxConnections).values({
        partnerId,
        provider: 'gmail',
        orgId,
        googleAccountSub: 'goog-sub-1',
        mailboxAddress: 'help@client.example',
        status: 'reauth_required',
        historyId: 'H1',
        eligibleAfter: priorFloor,
      }).returning({ id: ticketMailboxConnections.id, consentAttemptId: ticketMailboxConnections.consentAttemptId }),
    )) as Array<{ id: string; consentAttemptId: string }>;

    // The verification probe returns a NEWER cursor H2, and the live identity is the
    // SAME account sub as stored -> same-account, so H1 must be preserved (a naive
    // upsert would overwrite H1 -> H2 and skip the H1..H2 outage window).
    gmailMock.probeMailboxForConnect.mockResolvedValue({ historyId: 'H2', sub: 'goog-sub-1', email: 'help@client.example' });
    const res = await createGmailConnection({ partnerId, orgId, mailboxAddress: 'help@client.example', createdBy: null });
    expect(res.ok).toBe(true);

    const rows = (await withSystemDbAccessContext(() =>
      db.select().from(ticketMailboxConnections).where(eq(ticketMailboxConnections.orgId, orgId)),
    )) as Array<Record<string, any>>;
    expect(rows).toHaveLength(1); // upsert, not a duplicate
    const row = rows[0]!;
    expect(row.id).toBe(prior!.id);
    expect(row.status).toBe('connected');
    // Cursor and floor are PRESERVED so the next sweep still reaches the outage window.
    expect(row.historyId).toBe('H1');
    expect(new Date(row.eligibleAfter).getTime()).toBe(priorFloor.getTime());
    // Generation is KEPT on a same-binding reconnect: already-queued valid jobs for
    // this same mailbox must still complete (rotating would drop mail the cursor
    // already advanced past).
    expect(row.consentAttemptId).toBe(prior!.consentAttemptId);
  });

  it('refuses (connection_changed) a stale reconnect whose generation was rotated by a disconnect during the probe', async () => {
    const { partnerId, orgId } = await seedOrg(true);
    const [prior] = (await withSystemDbAccessContext(() =>
      db.insert(ticketMailboxConnections).values({
        partnerId,
        provider: 'gmail',
        orgId,
        googleAccountSub: 'goog-sub-1',
        mailboxAddress: 'help@client.example',
        status: 'connected',
        historyId: 'H1',
        eligibleAfter: new Date(Date.now() - 60 * 60 * 1000),
      }).returning({ id: ticketMailboxConnections.id, consentAttemptId: ticketMailboxConnections.consentAttemptId }),
    )) as Array<{ id: string; consentAttemptId: string }>;

    // Simulate a DISCONNECT committing DURING the Google probe: it disables the row
    // and rotates the generation, exactly as DELETE /connections/:id does. connect
    // read the pre-probe generation first, so its CAS upsert must now match 0 rows.
    gmailMock.probeMailboxForConnect.mockImplementation(async () => {
      await withSystemDbAccessContext(() =>
        db.update(ticketMailboxConnections)
          .set({ status: 'disabled', consentAttemptId: sql`gen_random_uuid()` })
          .where(eq(ticketMailboxConnections.id, prior!.id)),
      );
      return { historyId: 'H2', sub: 'goog-sub-1', email: 'help@client.example' };
    });

    const res = await createGmailConnection({ partnerId, orgId, mailboxAddress: 'help@client.example', createdBy: null });
    expect(res).toMatchObject({ ok: false, code: 'connection_changed' });

    // The later disconnect stands — the stale reconnect did NOT resurrect the row.
    const rows = (await withSystemDbAccessContext(() =>
      db.select().from(ticketMailboxConnections).where(eq(ticketMailboxConnections.id, prior!.id)),
    )) as Array<Record<string, any>>;
    expect(rows[0]!.status).toBe('disabled');
  });

  it('reconnect resolving to a DIFFERENT account sub RESETS the cursor + floor and rotates the generation (no foreign-mailbox history)', async () => {
    // The address was connected under one Google account (sub OLD, cursor H1). The
    // address is later reconnected but the live identity resolves to a DIFFERENT
    // account (sub NEW) -- e.g. the address was reassigned. The OLD cursor/floor
    // belong to a foreign mailbox and must NOT be preserved; preserving them could
    // import that account's history and cross-tenant-contaminate tickets.
    const { partnerId, orgId } = await seedOrg(true);
    const oldFloor = new Date(Date.now() - 90 * 60 * 1000);
    const [prior] = (await withSystemDbAccessContext(() =>
      db.insert(ticketMailboxConnections).values({
        partnerId,
        provider: 'gmail',
        orgId,
        googleAccountSub: 'goog-sub-OLD',
        mailboxAddress: 'help@client.example',
        status: 'connected',
        historyId: 'H1',
        eligibleAfter: oldFloor,
      }).returning({ consentAttemptId: ticketMailboxConnections.consentAttemptId }),
    )) as Array<{ consentAttemptId: string }>;

    gmailMock.probeMailboxForConnect.mockResolvedValue({ historyId: 'H2', sub: 'goog-sub-NEW', email: 'help@client.example' });
    const before = Date.now();
    const res = await createGmailConnection({ partnerId, orgId, mailboxAddress: 'help@client.example', createdBy: null });
    expect(res.ok).toBe(true);

    const rows = (await withSystemDbAccessContext(() =>
      db.select().from(ticketMailboxConnections).where(eq(ticketMailboxConnections.mailboxAddress, 'help@client.example')),
    )) as Array<Record<string, any>>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.googleAccountSub).toBe('goog-sub-NEW'); // rebound to the new account
    // Foreign cursor/floor discarded; freshly probed baseline + a now-floor instead.
    expect(row.historyId).toBe('H2');
    expect(new Date(row.eligibleAfter).getTime()).toBeGreaterThanOrEqual(before);
    // Different account -> generation ROTATED so old-account queued work stops being authorized.
    expect(row.consentAttemptId).not.toBe(prior!.consentAttemptId);
  });

  it('converting an m365 row (no Gmail cursor) SEEDS the freshly-probed cursor and floor', async () => {
    const { partnerId, orgId } = await seedOrg(true);
    // A Microsoft row for the same address: org_id NULL, history_id/eligible_after
    // NULL. Kept pending_consent with tenant_id NULL so it needs no tenant-ownership
    // row — all we need is an existing row whose Gmail cursor is absent.
    await withSystemDbAccessContext(() =>
      db.insert(ticketMailboxConnections).values({
        partnerId,
        provider: 'm365',
        mailboxAddress: 'help@client.example',
        status: 'pending_consent',
      }),
    );
    gmailMock.probeMailboxForConnect.mockResolvedValue({ historyId: '55555', sub: 'goog-sub-default', email: 'help@client.example' });
    const res = await createGmailConnection({ partnerId, orgId, mailboxAddress: 'help@client.example', createdBy: null });
    expect(res.ok).toBe(true);

    const rows = (await withSystemDbAccessContext(() =>
      db.select().from(ticketMailboxConnections).where(eq(ticketMailboxConnections.mailboxAddress, 'help@client.example')),
    )) as Array<Record<string, any>>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.provider).toBe('gmail');
    expect(row.orgId).toBe(orgId);
    expect(row.tenantId).toBeNull();
    // Nothing to preserve, so the probed baseline seeds the cursor + floor.
    expect(row.historyId).toBe('55555');
    expect(row.googleAccountSub).toBe('goog-sub-default');
    expect(row.eligibleAfter).not.toBeNull();
  });

  it('merge then reconnect under the survivor RESUMES from the preserved cursor (no mail lost across a merge)', async () => {
    // A same-Workspace merge is a plain repoint: after merge the row stays
    // connected under the survivor with its cursor and account sub preserved. Even
    // if an admin then re-runs connect under the survivor, that is same-binding
    // (same account sub), so it RESUMES from the preserved cursor rather than
    // reseeding to "now" — no mail from before the merge is skipped.
    const seeded = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const loser = await createOrganization({ partnerId: partner.id });
      const survivor = await createOrganization({ partnerId: partner.id });
      const actor = await createUser({ partnerId: partner.id });
      const saKey = JSON.stringify({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: 'k' });
      for (const o of [loser, survivor]) {
        await db.insert(googleWorkspaceConnections).values({
          orgId: o.id,
          customerDomain: 'client.example',
          adminEmail: 'admin@client.example',
          serviceAccountEmail: 'sa@x.iam.gserviceaccount.com',
          serviceAccountKey: encryptSecret(saKey, { aad: 'google_workspace_connections.service_account_key' }),
          status: 'active',
        });
      }
      const [conn] = await db.insert(ticketMailboxConnections).values({
        partnerId: partner.id,
        provider: 'gmail',
        orgId: loser.id,
        googleAccountSub: 'goog-sub-merge',
        mailboxAddress: 'help@client.example',
        status: 'connected',
        historyId: 'H_PREMERGE',
        eligibleAfter: new Date(Date.now() - 30 * 60 * 1000),
      }).returning({ id: ticketMailboxConnections.id });
      return { partnerId: partner.id, loserId: loser.id, survivorId: survivor.id, actorId: actor.id, connId: conn!.id };
    });

    await executeOrgMerge({
      loserOrgId: seeded.loserId,
      survivorOrgId: seeded.survivorId,
      partnerId: seeded.partnerId,
      performedBy: seeded.actorId,
    });

    // Re-run connect under the survivor. The probe returns a NEWER baseline, but the
    // live identity resolves to the SAME account sub carried across the merge, so the
    // preserved cursor wins (resume, not reseed).
    gmailMock.probeMailboxForConnect.mockResolvedValue({ historyId: 'H_NEW_BASELINE', sub: 'goog-sub-merge', email: 'help@client.example' });
    const res = await createGmailConnection({ partnerId: seeded.partnerId, orgId: seeded.survivorId, mailboxAddress: 'help@client.example', createdBy: null });
    expect(res.ok).toBe(true);

    const rows = (await withSystemDbAccessContext(() =>
      db.select().from(ticketMailboxConnections).where(eq(ticketMailboxConnections.id, seeded.connId)),
    )) as Array<Record<string, any>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orgId).toBe(seeded.survivorId);
    expect(rows[0]!.status).toBe('connected');
    // Resumed from the preserved cursor, not reseeded to the fresh probe.
    expect(rows[0]!.historyId).toBe('H_PREMERGE');
  }, 120000);

});
