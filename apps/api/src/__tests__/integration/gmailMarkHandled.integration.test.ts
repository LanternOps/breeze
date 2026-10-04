/**
 * Opt-in Gmail mark-handled runs AFTER the inbound pipeline, against real
 * Postgres: only messages the pipeline logged as created/matched are labelled;
 * quarantined/ignored/failed mail stays untouched in the inbox. Gmail HTTP is
 * replaced by injected fakes.
 */
import './setup';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const gm = vi.hoisted(() => ({ markGmailHandled: vi.fn(async (..._a: unknown[]) => {}) }));
vi.mock('../../services/ticketMailbox/googleMailboxClient', async (importActual) => {
  const actual = await importActual<typeof import('../../services/ticketMailbox/googleMailboxClient')>();
  return { ...actual, markGmailHandled: gm.markGmailHandled };
});

import { db as appDb, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { ticketMailboxConnections, googleWorkspaceConnections, ticketEmailInbound } from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';
import { getTestDb } from './setup';
import { encryptSecret } from '../../services/secretCrypto';
import { eq } from 'drizzle-orm';
import { markIngestedGmailHandled, parseGmailProviderMessageId } from '../../services/ticketMailbox/markIngestedGmailHandled';
import type { NormalizedInboundEmail } from '../../services/inboundEmail/types';

let db: any;
const MAILBOX = 'help@client.example';
const SUB = 'goog-sub-1';

async function seed(parseStatus: string | null, credentialStatus = 'active') {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const saKey = JSON.stringify({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: 'k' });
    await db.insert(googleWorkspaceConnections).values({
      orgId: org.id, customerDomain: 'client.example', adminEmail: 'admin@client.example',
      serviceAccountEmail: 'sa@x.iam.gserviceaccount.com',
      serviceAccountKey: encryptSecret(saKey, { aad: 'google_workspace_connections.service_account_key' }),
      status: credentialStatus,
    });
    const [conn] = await db.insert(ticketMailboxConnections).values({
      partnerId: partner.id, provider: 'gmail', orgId: org.id, googleAccountSub: SUB,
      mailboxAddress: MAILBOX, status: 'connected', historyId: 'H1', eligibleAfter: new Date(Date.now() - 3_600_000),
    }).returning({ id: ticketMailboxConnections.id, consentAttemptId: ticketMailboxConnections.consentAttemptId });
    const providerMessageId = `gmail:${SUB}:msg-123`;
    if (parseStatus) {
      await db.insert(ticketEmailInbound).values({ partnerId: partner.id, provider: 'gmail', providerMessageId, parseStatus });
    }
    const email = { provider: 'gmail', providerMessageId } as unknown as NormalizedInboundEmail;
    const generation = { provider: 'gmail' as const, connectionId: conn!.id, partnerId: partner.id, tenantId: null, consentAttemptId: conn!.consentAttemptId };
    return { email, generation, connId: conn!.id, orgId: org.id };
  });
}

const FAKE_GMAIL = { fake: true } as never;
const sessionFor = (liveSub: string) => () => ({ gmail: FAKE_GMAIL, identity: async () => ({ sub: liveSub, email: MAILBOX }) });
const deps = { sleep: async () => {}, modifyClient: sessionFor(SUB) };

describe('markIngestedGmailHandled (post-ticket, real DB)', () => {
  beforeEach(() => {
    db = getTestDb();
    vi.clearAllMocks();
    process.env.GMAIL_HANDLED_LABEL = 'Handled';
  });
  afterEach(() => {
    delete process.env.GMAIL_HANDLED_LABEL;
    delete process.env.GMAIL_ARCHIVE_ON_HANDLE;
  });

  it('parses the account sub and Gmail id from the provider message id', () => {
    expect(parseGmailProviderMessageId('gmail:sub:abc')).toEqual({ sub: 'sub', gmailId: 'abc' });
    expect(parseGmailProviderMessageId('<x@y>')).toBeNull();
  });

  it('labels (and archives by default) a message that became a ticket', async () => {
    const { email, generation } = await seed('created');
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('marked');
    expect(gm.markGmailHandled).toHaveBeenCalledWith(FAKE_GMAIL, MAILBOX, 'msg-123', expect.objectContaining({ labelName: 'Handled', archive: true, accountSub: SUB }));
  });

  it('labels a reply threaded onto an existing ticket (matched)', async () => {
    const { email, generation } = await seed('matched');
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('marked');
  });

  it.each(['quarantined', 'ignored', 'failed', 'skipped'])('leaves %s mail untouched in the inbox', async (status) => {
    const { email, generation } = await seed(status);
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('not_ticketed');
    expect(gm.markGmailHandled).not.toHaveBeenCalled();
  });

  it.each([
    ['reconnected to a different Google account', { googleAccountSub: 'goog-sub-OTHER' }],
    ['consent generation rotated', { consentAttemptId: '99999999-9999-4999-8999-999999999999' }],
    ['connection disabled', { status: 'disabled' }],
  ])('never modifies mail when the mailbox was %s after ingestion', async (_label, patch) => {
    const { email, generation, connId } = await seed('created');
    await withSystemDbAccessContext(() => db.update(ticketMailboxConnections).set(patch as never).where(eq(ticketMailboxConnections.id, connId)));
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('not_ticketed');
    expect(gm.markGmailHandled).not.toHaveBeenCalled();
  });

  it.each(['reauth_required', 'error'])('still marks a ticketed message while the same generation is %s (as ingestion does)', async (status) => {
    const { email, generation, connId } = await seed('created');
    await withSystemDbAccessContext(() => db.update(ticketMailboxConnections).set({ status } as never).where(eq(ticketMailboxConnections.id, connId)));
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('marked');
  });

  it('never modifies when the org credential now resolves the mailbox to a different account', async () => {
    // Credential replaced in place (no generation rotation): the row still
    // matches, but the live identity behind the modify token is another account.
    const { email, generation } = await seed('created');
    expect(await markIngestedGmailHandled(email, generation, { ...deps, modifyClient: sessionFor('goog-sub-OTHER') })).toBe('not_ticketed');
    expect(gm.markGmailHandled).not.toHaveBeenCalled();
  });

  it('a reconnect that lands during the Gmail call waits until the call has finished', async () => {
    const { email, generation, connId } = await seed('created');
    let reconnect: Promise<unknown> | undefined;
    let reconnectDone = false;
    let doneDuringCall: boolean | undefined;
    gm.markGmailHandled.mockImplementationOnce(async () => {
      // A reconnect on its own connection, issued while the modify is in flight.
      reconnect = runOutsideDbContext(() => withSystemDbAccessContext(() => db.update(ticketMailboxConnections)
        .set({ consentAttemptId: '88888888-8888-4888-8888-888888888888' } as never)
        .where(eq(ticketMailboxConnections.id, connId))))
        .then(() => { reconnectDone = true; });
      await new Promise((r) => setTimeout(r, 300));
      doneDuringCall = reconnectDone;
    });
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('marked');
    expect(doneDuringCall).toBe(false);
    await reconnect;
    expect(reconnectDone).toBe(true);
    // A later message from the old generation is no longer modified.
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('not_ticketed');
    expect(gm.markGmailHandled).toHaveBeenCalledTimes(1);
  });

  it('a retry after a transient error re-checks the generation and stops if it rotated', async () => {
    const { email, generation, connId } = await seed('created');
    gm.markGmailHandled.mockImplementationOnce(async () => { throw Object.assign(new Error('backend'), { code: 503 }); });
    const retryDeps = {
      modifyClient: sessionFor(SUB),
      sleep: async () => {
        await withSystemDbAccessContext(() => db.update(ticketMailboxConnections)
          .set({ googleAccountSub: 'goog-sub-NEW' } as never)
          .where(eq(ticketMailboxConnections.id, connId)));
      },
    };
    expect(await markIngestedGmailHandled(email, generation, retryDeps)).toBe('not_ticketed');
    expect(gm.markGmailHandled).toHaveBeenCalledTimes(1);
  });

  it('uses the credential current at the call, and an in-place replacement during the call waits for it', async () => {
    const { email, generation, orgId } = await seed('created');
    const replacedKey = JSON.stringify({ client_email: 'sa2@y.iam.gserviceaccount.com', private_key: 'k2' });
    const seenKeys: string[] = [];
    let replace: Promise<unknown> | undefined;
    let replaceDone = false;
    let doneDuringCall: boolean | undefined;
    const trackingDeps = {
      sleep: async () => {},
      modifyClient: (saKey: string) => { seenKeys.push(saKey); return sessionFor(SUB)(); },
    };
    gm.markGmailHandled.mockImplementationOnce(async () => {
      replace = runOutsideDbContext(() => withSystemDbAccessContext(() => db.update(googleWorkspaceConnections)
        .set({ serviceAccountKey: encryptSecret(replacedKey, { aad: 'google_workspace_connections.service_account_key' }) } as never)
        .where(eq(googleWorkspaceConnections.orgId, orgId))))
        .then(() => { replaceDone = true; });
      await new Promise((r) => setTimeout(r, 300));
      doneDuringCall = replaceDone;
    });
    expect(await markIngestedGmailHandled(email, generation, trackingDeps)).toBe('marked');
    expect(doneDuringCall).toBe(false);
    await replace;
    expect(replaceDone).toBe(true);
    // The next mark builds its session from the replaced credential.
    expect(await markIngestedGmailHandled(email, generation, trackingDeps)).toBe('marked');
    expect(JSON.parse(seenKeys[0]!).client_email).toBe('sa@x.iam.gserviceaccount.com');
    expect(JSON.parse(seenKeys[1]!).client_email).toBe('sa2@y.iam.gserviceaccount.com');
  });

  it('stops retrying once the overall time budget is spent', async () => {
    const { email, generation } = await seed('created');
    let t = 0;
    gm.markGmailHandled.mockImplementation(async () => { t += 15_000; throw Object.assign(new Error('backend'), { code: 503 }); });
    try {
      expect(await markIngestedGmailHandled(email, generation, { ...deps, now: () => t })).toBe('failed');
      expect(gm.markGmailHandled).toHaveBeenCalledTimes(1);
    } finally {
      gm.markGmailHandled.mockReset();
      gm.markGmailHandled.mockImplementation(async (..._a: unknown[]) => {});
    }
  });

  it('aborts an in-flight Gmail call at the deadline and does not retry past it', async () => {
    const { email, generation } = await seed('created');
    let signal: AbortSignal | undefined;
    const started = Date.now();
    gm.markGmailHandled.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const result = await markIngestedGmailHandled(email, generation, {
      sleep: async () => {},
      budgetMs: 300,
      modifyClient: (_k: string, _m: string, s?: AbortSignal) => { signal = s; return sessionFor(SUB)(); },
    });
    expect(result).toBe('failed');
    expect(signal?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(gm.markGmailHandled).toHaveBeenCalledTimes(1);
  });

  it('a lock held by another transaction cannot hold the mark past its deadline', async () => {
    const { email, generation, connId } = await seed('created');
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => { locked = r; });
    // A reconnect-like writer holds the connection row (FOR UPDATE) for 3 s.
    const holder = runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      // appDb (not the test client) so the row lock lives in this transaction.
      await appDb.select({ id: ticketMailboxConnections.id }).from(ticketMailboxConnections)
        .where(eq(ticketMailboxConnections.id, connId)).for('update');
      locked();
      await Promise.race([held, new Promise((r) => setTimeout(r, 3_000))]);
    }));
    await lockTaken;
    const started = Date.now();
    const result = await markIngestedGmailHandled(email, generation, { ...deps, budgetMs: 400 });
    const elapsed = Date.now() - started;
    release();
    await holder;
    expect(result).toBe('failed');
    expect(elapsed).toBeLessThan(2_000);
    expect(gm.markGmailHandled).not.toHaveBeenCalled();
  });

  it('does nothing when the feature is off', async () => {
    delete process.env.GMAIL_HANDLED_LABEL;
    const { email, generation } = await seed('created');
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('skipped');
    expect(gm.markGmailHandled).not.toHaveBeenCalled();
  });

  it('does nothing when the Google credential is inactive', async () => {
    const { email, generation } = await seed('created', 'inactive');
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('not_ticketed');
  });

  it('retries a transient failure, and gives up (never throws) on a missing grant', async () => {
    const { email, generation } = await seed('created');
    gm.markGmailHandled.mockRejectedValueOnce(Object.assign(new Error('backend'), { status: 503 }));
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('marked');
    expect(gm.markGmailHandled).toHaveBeenCalledTimes(2);

    gm.markGmailHandled.mockReset();
    gm.markGmailHandled.mockRejectedValue(Object.assign(new Error('insufficient scope'), { status: 403 }));
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('failed');
    expect(gm.markGmailHandled).toHaveBeenCalledTimes(1);
  });
});
