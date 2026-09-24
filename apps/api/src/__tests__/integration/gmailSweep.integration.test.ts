/**
 * CI-runnable coverage for the Gmail sweep (sweepOneGmail via runMailboxSweep).
 * Real Postgres exercises the generation rechecks, cursor CAS, status transitions,
 * and expiry reconciliation; ONLY the external Gmail HTTP calls are mocked (the
 * error class + classifier stay real via importActual). The enqueue is mocked so
 * this needs no Redis. This replaces the gap where the only end-to-end sweep test
 * was the live-gated gmailWorkerE2e suite, so normal CI never ran sweepOneGmail.
 */
import './setup';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const gmail = vi.hoisted(() => ({
  getStartHistoryId: vi.fn(),
  listInboxChanges: vi.fn(),
  getFullMessage: vi.fn(),
  forEachInboxPageSince: vi.fn(),
}));
vi.mock('../../services/ticketMailbox/googleMailboxClient', async (importActual) => {
  const actual = await importActual<typeof import('../../services/ticketMailbox/googleMailboxClient')>();
  return {
    ...actual, // keep GmailHistoryExpiredError + classifyGmailError real
    getStartHistoryId: gmail.getStartHistoryId,
    listInboxChanges: gmail.listInboxChanges,
    getFullMessage: gmail.getFullMessage,
    forEachInboxPageSince: gmail.forEachInboxPageSince,
  };
});
const enqueue = vi.hoisted(() => ({ fn: vi.fn(async () => {}) }));
vi.mock('../../services/inboundEmailQueue', () => ({ enqueueInboundEmail: enqueue.fn }));

// The sweep builds ONE inbound session and verifies the mailbox's live account sub
// through it before ingesting. Mock the session so identity() returns a
// configurable sub (default: matches the seeded connection).
const idMock = vi.hoisted(() => ({ identity: vi.fn() }));
vi.mock('../../services/googleClient', async (importActual) => {
  const actual = await importActual<typeof import('../../services/googleClient')>();
  return {
    ...actual,
    getInboundMailboxSession: vi.fn(() => ({ gmail: {} as never, identity: idMock.identity })),
  };
});

// Everything in connectionService stays real EXCEPT listConnectedGmailMailboxes,
// which one test overrides to hand the worker a snapshot whose org_id is stale
// (as it would be if an org merge repointed the row after enumeration).
const connSvc = vi.hoisted(() => ({ listOverride: null as null | (() => Promise<unknown[]>) }));
vi.mock('../../services/ticketMailbox/connectionService', async (importActual) => {
  const actual = await importActual<typeof import('../../services/ticketMailbox/connectionService')>();
  return {
    ...actual,
    listConnectedGmailMailboxes: vi.fn(() =>
      connSvc.listOverride ? connSvc.listOverride() : actual.listConnectedGmailMailboxes()),
  };
});

const gErr = (status: number) => ({ status });

import { eq } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { ticketMailboxConnections, googleWorkspaceConnections } from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';
import { getTestDb } from './setup';
import { encryptSecret } from '../../services/secretCrypto';
import { GmailHistoryExpiredError } from '../../services/ticketMailbox/googleMailboxClient';
import { runMailboxSweep } from '../../jobs/ticketMailboxPollWorker';

let db: any;
const SUB = 'goog-sub-acct-1'; // the mailbox's stored immutable account sub

const MAILBOX = 'help@client.example';

function gmailMessage(id: string, deliveredTo: string = MAILBOX) {
  return {
    id, threadId: `t-${id}`, internalDate: String(Date.now()), labelIds: ['INBOX'],
    snippet: 'hi', payload: {
      mimeType: 'text/plain',
      // A Gmail-stamped `Delivered-To` addressed to the support mailbox so the
      // recipient-scope filter (decision A, MTA-stamped headers only) admits it;
      // filter tests pass a different deliveredTo.
      headers: [
        { name: 'From', value: 'cust@x.com' },
        { name: 'To', value: MAILBOX },
        { name: 'Delivered-To', value: deliveredTo },
        { name: 'Subject', value: `subject ${id}` },
      ],
      body: { data: Buffer.from(`body ${id}`, 'utf8').toString('base64url') },
    },
  };
}

async function seedConnection(opts: { historyId: string | null; credentialStatus?: string; eligibleAfter?: Date }) {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const saKey = JSON.stringify({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: 'k' });
    await db.insert(googleWorkspaceConnections).values({
      orgId: org.id, customerDomain: 'client.example', adminEmail: 'admin@client.example',
      serviceAccountEmail: 'sa@x.iam.gserviceaccount.com',
      serviceAccountKey: encryptSecret(saKey, { aad: 'google_workspace_connections.service_account_key' }),
      status: opts.credentialStatus ?? 'active',
    });
    const [conn] = await db.insert(ticketMailboxConnections).values({
      partnerId: partner.id, provider: 'gmail', orgId: org.id,
      googleAccountSub: SUB, mailboxAddress: 'help@client.example',
      status: 'connected', historyId: opts.historyId,
      eligibleAfter: opts.eligibleAfter ?? new Date(Date.now() - 60 * 60 * 1000),
    }).returning({ id: ticketMailboxConnections.id });
    return { connId: conn!.id, partnerId: partner.id, orgId: org.id };
  });
}

const readConn = (id: string) => withSystemDbAccessContext(() =>
  db.select().from(ticketMailboxConnections).where(eq(ticketMailboxConnections.id, id)),
).then((r) => (r as any[])[0]);

describe('Gmail sweep (sweepOneGmail via runMailboxSweep)', () => {
  beforeEach(() => {
    db = getTestDb();
    vi.clearAllMocks();
    connSvc.listOverride = null;
    // Default: the live account matches the stored sub (same-account, keep polling).
    idMock.identity.mockResolvedValue({ sub: SUB, email: 'help@client.example' });
  });

  it('with no cursor: seeds the baseline history id and enqueues nothing ("new mail from now")', async () => {
    const { connId } = await seedConnection({ historyId: null });
    gmail.getStartHistoryId.mockResolvedValue('SEED1');

    await runMailboxSweep();

    expect(enqueue.fn).not.toHaveBeenCalled();
    expect((await readConn(connId)).historyId).toBe('SEED1');
  });

  it('incremental: fetches + enqueues each changed message under the gmail generation and advances the cursor (CAS)', async () => {
    const { connId, partnerId } = await seedConnection({ historyId: 'H0' });
    gmail.listInboxChanges.mockResolvedValue({ messageIds: ['m1'], newHistoryId: 'H9' });
    gmail.getFullMessage.mockResolvedValue(gmailMessage('m1'));

    await runMailboxSweep();

    expect(gmail.listInboxChanges).toHaveBeenCalledWith(expect.anything(), 'H0');
    expect(enqueue.fn).toHaveBeenCalledTimes(1);
    expect(enqueue.fn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gmail' }),
      expect.objectContaining({ provider: 'gmail', connectionId: connId, partnerId, tenantId: null }),
    );
    expect((await readConn(connId)).historyId).toBe('H9'); // advanced from H0
  });

  it('recipient scope (decision A): ingests ONLY mail addressed to the support mailbox, skips the rest, advances the cursor', async () => {
    const { connId } = await seedConnection({ historyId: 'H0' });
    gmail.listInboxChanges.mockResolvedValue({ messageIds: ['mine', 'other'], newHistoryId: 'H9' });
    gmail.getFullMessage.mockImplementation(async (_g: unknown, id: string) =>
      // 'other' is in the same INBOX (e.g. the account owner's personal mail) but
      // is NOT addressed to help@client.example — it must not become a ticket.
      id === 'mine' ? gmailMessage('mine') : gmailMessage('other', 'someone-else@personal.example'));

    await runMailboxSweep();

    expect(enqueue.fn).toHaveBeenCalledTimes(1); // only 'mine'
    expect((await readConn(connId)).historyId).toBe('H9'); // cursor still advances past both
  });

  it('recipient scope: trusts only MTA-stamped Delivered-To (incl. plus-addressed), and REJECTS a forged To when delivery went to the account owner', async () => {
    const { connId } = await seedConnection({ historyId: 'H0' });
    gmail.listInboxChanges.mockResolvedValue({ messageIds: ['deliv', 'plus', 'forged'], newHistoryId: 'H9' });
    gmail.getFullMessage.mockImplementation(async (_g: unknown, id: string) => {
      if (id === 'deliv') return gmailMessage('deliv', MAILBOX); // Delivered-To == mailbox
      if (id === 'plus') return gmailMessage('plus', 'help+urgent@client.example'); // plus-addressed Delivered-To
      // 'forged': delivered to the account owner, but a forged To claims the mailbox.
      const m = gmailMessage('forged', 'owner@client.example');
      m.payload.headers = m.payload.headers.filter((h) => h.name !== 'To');
      m.payload.headers.push({ name: 'To', value: MAILBOX });
      return m;
    });

    await runMailboxSweep();

    expect(enqueue.fn).toHaveBeenCalledTimes(2); // deliv + plus; forged is rejected
    expect((await readConn(connId)).historyId).toBe('H9');
  });

  it('records the NEWEST message timestamp, not the last enumerated (order-independent)', async () => {
    const { connId } = await seedConnection({ historyId: 'H0' });
    const newer = Date.now();
    const older = newer - 5 * 60 * 1000;
    gmail.listInboxChanges.mockResolvedValue({ messageIds: ['m_new', 'm_old'], newHistoryId: 'H9' });
    gmail.getFullMessage.mockImplementation(async (_g: unknown, id: string) => ({
      ...gmailMessage(id),
      internalDate: String(id === 'm_new' ? newer : older), // newest is NOT last in the list
    }));

    await runMailboxSweep();

    // last_message_at is the max, so the older trailing message does not move it back.
    expect(new Date((await readConn(connId)).lastMessageAt).getTime()).toBe(newer);
  });

  it('does not move last_message_at BACKWARD across sweeps (SQL GREATEST, not just per-batch max)', async () => {
    const { connId } = await seedConnection({ historyId: 'H0' });
    const newer = Date.now();
    const older = newer - 24 * 60 * 60 * 1000; // a day earlier
    gmail.getFullMessage.mockImplementation(async (_g: unknown, id: string) => ({
      ...gmailMessage(id),
      internalDate: String(id === 'm_new' ? newer : older),
    }));

    // Sweep 1: a newly delivered message -> last_message_at = newer.
    gmail.listInboxChanges.mockResolvedValueOnce({ messageIds: ['m_new'], newHistoryId: 'H9' });
    await runMailboxSweep();
    expect(new Date((await readConn(connId)).lastMessageAt).getTime()).toBe(newer);

    // Sweep 2 (from H9): an OLDER message surfaces (e.g. labelAdded(INBOX) on old
    // mail). Its per-batch max is older, but the stored value must NOT regress.
    gmail.listInboxChanges.mockResolvedValueOnce({ messageIds: ['m_old'], newHistoryId: 'H10' });
    await runMailboxSweep();
    expect(new Date((await readConn(connId)).lastMessageAt).getTime()).toBe(newer);
  });

  it('expiry: on GmailHistoryExpiredError it reconciles from the floor and commits the fresh baseline', async () => {
    const { connId } = await seedConnection({ historyId: 'OLD' });
    gmail.listInboxChanges.mockRejectedValue(new GmailHistoryExpiredError());
    gmail.getStartHistoryId.mockResolvedValue('BASE');
    gmail.forEachInboxPageSince.mockImplementation(
      async (_g: unknown, _floor: number, onPage: (ids: string[]) => Promise<boolean>) => { await onPage(['m2']); },
    );
    gmail.getFullMessage.mockResolvedValue(gmailMessage('m2'));

    await runMailboxSweep();

    expect(gmail.forEachInboxPageSince).toHaveBeenCalled();
    expect(enqueue.fn).toHaveBeenCalledTimes(1);
    expect((await readConn(connId)).historyId).toBe('BASE');
  });

  it('inactive Google credential: marks the mailbox reauth_required and enqueues nothing', async () => {
    const { connId } = await seedConnection({ historyId: 'H0', credentialStatus: 'revoked' });

    await runMailboxSweep();

    expect(enqueue.fn).not.toHaveBeenCalled();
    expect((await readConn(connId)).status).toBe('reauth_required');
  });

  it('DIFFERENT account (live sub != stored sub): marks reauth_required and ingests nothing (merge/reassignment safety)', async () => {
    // This is the safety gate that lets an org merge be a plain repoint: if the
    // repointed/reassigned credential resolves to a DIFFERENT Google account, the
    // sweep must stop before reading any mail.
    const { connId } = await seedConnection({ historyId: 'H0' });
    idMock.identity.mockResolvedValue({ sub: 'goog-sub-DIFFERENT', email: 'help@client.example' });

    await runMailboxSweep();

    expect(gmail.listInboxChanges).not.toHaveBeenCalled(); // stopped before any read
    expect(enqueue.fn).not.toHaveBeenCalled();
    expect((await readConn(connId)).status).toBe('reauth_required');
  });

  it('same account (live sub == stored sub): keeps polling and ingests (the merge keep-going case)', async () => {
    // The property that makes a same-Workspace merge a safe plain repoint: when the
    // live account matches the stored sub, the sweep continues and mail is ingested.
    const { connId } = await seedConnection({ historyId: 'H0' });
    idMock.identity.mockResolvedValue({ sub: SUB, email: 'help@client.example' });
    gmail.listInboxChanges.mockResolvedValue({ messageIds: ['m1'], newHistoryId: 'H9' });
    gmail.getFullMessage.mockResolvedValue(gmailMessage('m1'));

    await runMailboxSweep();

    expect(enqueue.fn).toHaveBeenCalledTimes(1);
    const row = await readConn(connId);
    expect(row.status).toBe('connected');
    expect(row.historyId).toBe('H9');
  });

  it('org-merge race: credential missing for the STALE enumerated org but the row was repointed to a survivor -> skips, does NOT falsely mark reauth', async () => {
    // The real merge race (finding 1). A merge repoints the row org_id and drops the
    // loser credential AFTER the sweep enumerated the row under the loser org. The
    // worker loads the loser credential (gone) but must NOT mark the healthy,
    // repointed row reauth_required. Simulated by handing the worker a snapshot with
    // the pre-merge (loser) org while the real row sits under a survivor.
    const { connId, partnerId } = await seedConnection({ historyId: 'H0' }); // survivor org has an active credential
    const loser = await withSystemDbAccessContext(() => createOrganization({ partnerId })); // no Google credential
    const row = await readConn(connId);
    connSvc.listOverride = async () => [{
      id: connId,
      partnerId,
      consentAttemptId: row.consentAttemptId,
      orgId: loser.id, // STALE: enumerated under the pre-merge org
      mailboxAddress: 'help@client.example',
      googleAccountSub: SUB,
      historyId: 'H0',
      eligibleAfter: new Date(Date.now() - 60 * 60 * 1000),
    }];

    await runMailboxSweep();

    expect(gmail.listInboxChanges).not.toHaveBeenCalled();
    expect(enqueue.fn).not.toHaveBeenCalled();
    expect((await readConn(connId)).status).toBe('connected'); // NOT reauth_required
  });

  it('no-loss: ANY message fetch error (even a non-retryable 400) aborts the page and does NOT advance the cursor', async () => {
    // A message must never be silently dropped: the cursor stays put so the next
    // sweep re-lists and retries (durable dedup absorbs the re-enqueued prefix).
    const { connId } = await seedConnection({ historyId: 'H0' });
    gmail.listInboxChanges.mockResolvedValue({ messageIds: ['m1', 'm2', 'm3'], newHistoryId: 'H9' });
    gmail.getFullMessage.mockImplementation(async (_g: unknown, id: string) => {
      if (id === 'm2') throw gErr(400); // would-be "poison" — still must NOT advance past it
      return gmailMessage(id);
    });

    await runMailboxSweep();

    expect((await readConn(connId)).historyId).toBe('H0'); // cursor unchanged; m2 not lost
  });

  it('a 404 on fetch (message deleted between listing and fetch) is skipped as a normal race and the page still advances', async () => {
    const { connId } = await seedConnection({ historyId: 'H0' });
    gmail.listInboxChanges.mockResolvedValue({ messageIds: ['m1', 'gone', 'm3'], newHistoryId: 'H9' });
    gmail.getFullMessage.mockImplementation(async (_g: unknown, id: string) =>
      id === 'gone' ? null : gmailMessage(id)); // getFullMessage returns null on 404

    await runMailboxSweep();

    expect(enqueue.fn).toHaveBeenCalledTimes(2); // m1 + m3; the deleted one is a benign skip
    expect((await readConn(connId)).historyId).toBe('H9');
  });

  it('expiry recovery drops a message that predates the eligibility floor (no pre-connection mail ticketed)', async () => {
    // The recovery query is widened by 1s, so a message just before the floor can be
    // returned; ingest must drop it by exact-millisecond internalDate.
    const floor = new Date();
    const { connId } = await seedConnection({ historyId: 'OLD', eligibleAfter: floor });
    gmail.listInboxChanges.mockRejectedValue(new GmailHistoryExpiredError());
    gmail.getStartHistoryId.mockResolvedValue('BASE');
    gmail.forEachInboxPageSince.mockImplementation(
      async (_g: unknown, _floor: number, onPage: (ids: string[]) => Promise<boolean>) => { await onPage(['old', 'new']); },
    );
    gmail.getFullMessage.mockImplementation(async (_g: unknown, id: string) => ({
      ...gmailMessage(id),
      internalDate: id === 'old'
        ? String(floor.getTime() - 2000) // 2s before the floor -> dropped
        : String(floor.getTime() + 2000), // after the floor -> ingested
    }));

    await runMailboxSweep();

    expect(enqueue.fn).toHaveBeenCalledTimes(1); // only 'new'
    expect((await readConn(connId)).historyId).toBe('BASE');
  });
});
