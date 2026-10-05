/**
 * Opt-in Gmail mark-handled runs AFTER the inbound pipeline, against real
 * Postgres: only messages the pipeline logged as created/matched are labelled;
 * quarantined/ignored/failed mail stays untouched in the inbox. The setting is
 * per mailbox connection (gmail_handled_label / gmail_archive_on_handle). No DB
 * transaction or row lock is held while Gmail is called, and failures are
 * recorded on the connection. Gmail HTTP is replaced by injected fakes.
 */
import './setup';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const gm = vi.hoisted(() => ({ markGmailHandled: vi.fn(async (..._a: unknown[]) => {}) }));
vi.mock('../../services/ticketMailbox/googleMailboxClient', async (importActual) => {
  const actual = await importActual<typeof import('../../services/ticketMailbox/googleMailboxClient')>();
  return { ...actual, markGmailHandled: gm.markGmailHandled };
});
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../services/sentry', async (importActual) => {
  const actual = await importActual<typeof import('../../services/sentry')>();
  return { ...actual, captureException: sentry.captureException };
});

import { db as appDb, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { ticketMailboxConnections, googleWorkspaceConnections, ticketEmailInbound } from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';
import { getTestDb } from './setup';
import { encryptSecret } from '../../services/secretCrypto';
import { eq, sql } from 'drizzle-orm';
import { markIngestedGmailHandled, parseGmailProviderMessageId } from '../../services/ticketMailbox/markIngestedGmailHandled';
import { listMailboxConnections, updateGmailHandling } from '../../services/ticketMailbox/connectionService';
import type { NormalizedInboundEmail } from '../../services/inboundEmail/types';

let db: any;
const MAILBOX = 'help@client.example';
const SUB = 'goog-sub-1';

async function seed(parseStatus: string | null, opts: { credentialStatus?: string; label?: string | null; archive?: boolean } = {}) {
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
      partnerId: partner.id, provider: 'gmail', orgId: org.id, googleAccountSub: SUB,
      mailboxAddress: MAILBOX, status: 'connected', historyId: 'H1', eligibleAfter: new Date(Date.now() - 3_600_000),
      gmailHandledLabel: opts.label === undefined ? 'Handled' : opts.label,
      gmailArchiveOnHandle: opts.archive ?? true,
    }).returning({ id: ticketMailboxConnections.id, consentAttemptId: ticketMailboxConnections.consentAttemptId });
    const providerMessageId = `gmail:${SUB}:msg-123`;
    if (parseStatus) {
      await db.insert(ticketEmailInbound).values({ partnerId: partner.id, provider: 'gmail', providerMessageId, parseStatus });
    }
    const email = { provider: 'gmail', providerMessageId } as unknown as NormalizedInboundEmail;
    const generation = { provider: 'gmail' as const, connectionId: conn!.id, partnerId: partner.id, tenantId: null, consentAttemptId: conn!.consentAttemptId };
    return { email, generation, connId: conn!.id, orgId: org.id, partnerId: partner.id };
  });
}

const readConn = (id: string) => withSystemDbAccessContext(() =>
  db.select().from(ticketMailboxConnections).where(eq(ticketMailboxConnections.id, id)),
).then((r) => (r as any[])[0]);

const FAKE_GMAIL = { fake: true } as never;
const sessionFor = (liveSub: string) => () => ({ gmail: FAKE_GMAIL, identity: async () => ({ sub: liveSub, email: MAILBOX }) });
const deps = { sleep: async () => {}, modifyClient: sessionFor(SUB) };

/** Row locks on both rows the mark reads, taken with NOWAIT in a separate
 *  transaction: succeeds only if nobody (the mark included) holds one. */
const lockBothRowsNowait = (connId: string, orgId: string) =>
  runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await appDb.execute(sql`SELECT id FROM ticket_mailbox_connections WHERE id = ${connId} FOR UPDATE NOWAIT`);
    await appDb.execute(sql`SELECT org_id FROM google_workspace_connections WHERE org_id = ${orgId} FOR UPDATE NOWAIT`);
  }));

describe('markIngestedGmailHandled (post-ticket, real DB)', () => {
  beforeEach(() => {
    db = getTestDb();
    vi.clearAllMocks();
    gm.markGmailHandled.mockReset();
    gm.markGmailHandled.mockImplementation(async (..._a: unknown[]) => {});
  });

  it('parses the account sub and Gmail id from the provider message id', () => {
    expect(parseGmailProviderMessageId('gmail:sub:abc')).toEqual({ sub: 'sub', gmailId: 'abc' });
    expect(parseGmailProviderMessageId('<x@y>')).toBeNull();
  });

  it('labels and archives a message that became a ticket, using the mailbox setting', async () => {
    const { email, generation } = await seed('created');
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('marked');
    expect(gm.markGmailHandled).toHaveBeenCalledWith(FAKE_GMAIL, MAILBOX, 'msg-123', expect.objectContaining({ labelName: 'Handled', archive: true, accountSub: SUB }));
  });

  it('label-only when the mailbox has archive off', async () => {
    const { email, generation } = await seed('created', { label: 'Breeze/Ticketed', archive: false });
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('marked');
    expect(gm.markGmailHandled).toHaveBeenCalledWith(FAKE_GMAIL, MAILBOX, 'msg-123', expect.objectContaining({ labelName: 'Breeze/Ticketed', archive: false }));
  });

  it('labels a reply threaded onto an existing ticket (matched)', async () => {
    const { email, generation } = await seed('matched');
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('marked');
  });

  it('does nothing for a mailbox without a handled label (the default)', async () => {
    const { email, generation } = await seed('created', { label: null });
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('skipped');
    expect(gm.markGmailHandled).not.toHaveBeenCalled();
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
  ])('reports stale and never modifies mail when the mailbox was %s after ingestion', async (_label, patch) => {
    const { email, generation, connId } = await seed('created');
    await withSystemDbAccessContext(() => db.update(ticketMailboxConnections).set(patch as never).where(eq(ticketMailboxConnections.id, connId)));
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('stale');
    expect(gm.markGmailHandled).not.toHaveBeenCalled();
  });

  it.each(['reauth_required', 'error'])('still marks a ticketed message while the same generation is %s (as ingestion does)', async (status) => {
    const { email, generation, connId } = await seed('created');
    await withSystemDbAccessContext(() => db.update(ticketMailboxConnections).set({ status } as never).where(eq(ticketMailboxConnections.id, connId)));
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('marked');
  });

  it('reports stale and never modifies when the credential now resolves the mailbox to a different account', async () => {
    const { email, generation } = await seed('created');
    expect(await markIngestedGmailHandled(email, generation, { ...deps, modifyClient: sessionFor('goog-sub-OTHER') })).toBe('stale');
    expect(gm.markGmailHandled).not.toHaveBeenCalled();
  });

  it('reports no_credential when the Google credential is inactive, and records it on the connection', async () => {
    const { email, generation, connId } = await seed('created', { credentialStatus: 'inactive' });
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('no_credential');
    expect(gm.markGmailHandled).not.toHaveBeenCalled();
    expect((await readConn(connId)).gmailHandledError).toBe('no_credential');
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('holds no row lock and no open transaction while Gmail is called', async () => {
    const { email, generation, connId, orgId } = await seed('created');
    let lockOutcome: 'ok' | string | undefined;
    let idleInTx: number | undefined;
    gm.markGmailHandled.mockImplementationOnce(async () => {
      lockOutcome = await lockBothRowsNowait(connId, orgId).then(() => 'ok', (e: unknown) => String((e as { code?: string })?.code ?? e));
      const rows = await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()`);
      idleInTx = (rows.rows ?? rows)[0].n;
    });
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('marked');
    expect(lockOutcome).toBe('ok');
    expect(idleInTx).toBe(0);
  });

  it('a reconnect issued during the Gmail call is not blocked by it, and later old-generation mail is not modified', async () => {
    const { email, generation, connId } = await seed('created');
    let reconnectDoneDuringCall: boolean | undefined;
    gm.markGmailHandled.mockImplementationOnce(async () => {
      let done = false;
      const reconnect = runOutsideDbContext(() => withSystemDbAccessContext(async () => {
        await appDb.execute(sql`SET LOCAL lock_timeout = '1s'`);
        await appDb.update(ticketMailboxConnections)
          .set({ consentAttemptId: '88888888-8888-4888-8888-888888888888' } as never)
          .where(eq(ticketMailboxConnections.id, connId));
      })).then(() => { done = true; });
      await Promise.race([reconnect, new Promise((r) => setTimeout(r, 1_500))]);
      reconnectDoneDuringCall = done;
    });
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('marked');
    expect(reconnectDoneDuringCall).toBe(true);
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('stale');
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
    expect(await markIngestedGmailHandled(email, generation, retryDeps)).toBe('stale');
    expect(gm.markGmailHandled).toHaveBeenCalledTimes(1);
  });

  it('a credential replaced during the Gmail call is not blocked, and the next mark uses the new key', async () => {
    const { email, generation, orgId } = await seed('created');
    const replacedKey = JSON.stringify({ client_email: 'sa2@y.iam.gserviceaccount.com', private_key: 'k2' });
    const seenKeys: string[] = [];
    let replaceDoneDuringCall: boolean | undefined;
    const trackingDeps = {
      sleep: async () => {},
      modifyClient: (saKey: string) => { seenKeys.push(saKey); return sessionFor(SUB)(); },
    };
    gm.markGmailHandled.mockImplementationOnce(async () => {
      let done = false;
      const replace = runOutsideDbContext(() => withSystemDbAccessContext(async () => {
        await appDb.execute(sql`SET LOCAL lock_timeout = '1s'`);
        await appDb.update(googleWorkspaceConnections)
          .set({ serviceAccountKey: encryptSecret(replacedKey, { aad: 'google_workspace_connections.service_account_key' }) } as never)
          .where(eq(googleWorkspaceConnections.orgId, orgId));
      })).then(() => { done = true; });
      await Promise.race([replace, new Promise((r) => setTimeout(r, 1_500))]);
      replaceDoneDuringCall = done;
    });
    expect(await markIngestedGmailHandled(email, generation, trackingDeps)).toBe('marked');
    expect(replaceDoneDuringCall).toBe(true);
    expect(await markIngestedGmailHandled(email, generation, trackingDeps)).toBe('marked');
    expect(JSON.parse(seenKeys[0]!).client_email).toBe('sa@x.iam.gserviceaccount.com');
    expect(JSON.parse(seenKeys[1]!).client_email).toBe('sa2@y.iam.gserviceaccount.com');
  });

  it('a row lock held by another transaction does not delay marking', async () => {
    const { email, generation, connId } = await seed('created');
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => { locked = r; });
    const holder = runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      await appDb.select({ id: ticketMailboxConnections.id }).from(ticketMailboxConnections)
        .where(eq(ticketMailboxConnections.id, connId)).for('update');
      locked();
      await Promise.race([held, new Promise((r) => setTimeout(r, 3_000))]);
    }));
    await lockTaken;
    const started = Date.now();
    const result = await markIngestedGmailHandled(email, generation, deps);
    const elapsed = Date.now() - started;
    release();
    await holder;
    expect(result).toBe('marked');
    expect(elapsed).toBeLessThan(2_000);
  });

  it('records a failure on the connection, reports it once per code change, and clears it on the next success', async () => {
    const { email, generation, connId } = await seed('created');
    gm.markGmailHandled.mockRejectedValue(Object.assign(new Error('insufficient scope'), { status: 403 }));
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('failed');
    const first = await readConn(connId);
    expect(first.gmailHandledError).toBe('access_denied');
    expect(first.gmailHandledErrorAt).toBeInstanceOf(Date);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException.mock.calls[0]![2]).toEqual({ component: 'gmailHandled', code: 'access_denied' });

    // The same failure again: no new Sentry event and no per-message row write.
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('failed');
    const second = await readConn(connId);
    expect(second.gmailHandledError).toBe('access_denied');
    expect(second.gmailHandledErrorAt.getTime()).toBe(first.gmailHandledErrorAt.getTime());
    expect(sentry.captureException).toHaveBeenCalledTimes(1);

    // A different failure is a change: recorded and reported.
    gm.markGmailHandled.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('failed');
    expect((await readConn(connId)).gmailHandledError).toBe('failed');
    expect(sentry.captureException).toHaveBeenCalledTimes(2);

    gm.markGmailHandled.mockReset();
    gm.markGmailHandled.mockImplementation(async (..._a: unknown[]) => {});
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('marked');
    const cleared = await readConn(connId);
    expect(cleared.gmailHandledError).toBeNull();
    expect(cleared.gmailHandledErrorAt).toBeNull();
  });

  it('never records a failure onto a connection that was reconnected during the call', async () => {
    const { email, generation, connId } = await seed('created');
    gm.markGmailHandled.mockImplementationOnce(async () => {
      await withSystemDbAccessContext(() => db.update(ticketMailboxConnections)
        .set({ consentAttemptId: '77777777-7777-4777-8777-777777777777' } as never)
        .where(eq(ticketMailboxConnections.id, connId)));
      throw Object.assign(new Error('forbidden'), { status: 403 });
    });
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('failed');
    expect((await readConn(connId)).gmailHandledError).toBeNull();
  });

  it('records label_invalid without calling Gmail when the stored label is a system label', async () => {
    const { email, generation, connId } = await seed('created', { label: 'INBOX' });
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('failed');
    expect(gm.markGmailHandled).not.toHaveBeenCalled();
    expect((await readConn(connId)).gmailHandledError).toBe('label_invalid');
  });

  it('stops retrying once the overall time budget is spent, and records it', async () => {
    const { email, generation, connId } = await seed('created');
    let t = 0;
    gm.markGmailHandled.mockImplementation(async () => { t += 15_000; throw Object.assign(new Error('backend'), { code: 503 }); });
    expect(await markIngestedGmailHandled(email, generation, { ...deps, now: () => t })).toBe('failed');
    expect(gm.markGmailHandled).toHaveBeenCalledTimes(1);
    expect((await readConn(connId)).gmailHandledError).toBe('unavailable');
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

describe('Gmail handling setting on the mailbox connection', () => {
  beforeEach(() => {
    db = getTestDb();
  });

  it('updateGmailHandling sets the label and archive flag, clears a recorded failure, and the list shows it', async () => {
    const { connId, partnerId } = await seed(null, { label: null });
    await withSystemDbAccessContext(() => db.update(ticketMailboxConnections)
      .set({ gmailHandledError: 'access_denied', gmailHandledErrorAt: new Date() })
      .where(eq(ticketMailboxConnections.id, connId)));
    const updated = await withSystemDbAccessContext(() => updateGmailHandling(connId, partnerId, { label: 'Breeze/Ticketed', archive: false }));
    expect(updated?.id).toBe(connId);
    const list = await withSystemDbAccessContext(() => listMailboxConnections(partnerId));
    expect(list.find((c) => c.id === connId)?.gmailHandling).toEqual({
      label: 'Breeze/Ticketed', archive: false, error: null, errorAt: null,
    });
  });

  it('never updates another partner\'s mailbox or a disabled one', async () => {
    const { connId } = await seed(null, { label: null });
    const other = await withSystemDbAccessContext(() => createPartner());
    expect(await withSystemDbAccessContext(() => updateGmailHandling(connId, other.id, { label: 'X', archive: true }))).toBeNull();
    const own = await seed(null, { label: null });
    await withSystemDbAccessContext(() => db.update(ticketMailboxConnections).set({ status: 'disabled' } as never).where(eq(ticketMailboxConnections.id, own.connId)));
    expect(await withSystemDbAccessContext(() => updateGmailHandling(own.connId, own.partnerId, { label: 'X', archive: true }))).toBeNull();
    expect((await readConn(connId)).gmailHandledLabel).toBeNull();
  });

  it('the database refuses an over-long label and an unknown failure code', async () => {
    const { connId } = await seed(null, { label: null });
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; cause?: { code?: string } }) => e.cause?.code ?? e.code);
    expect(await code(withSystemDbAccessContext(() => db.update(ticketMailboxConnections)
      .set({ gmailHandledError: 'something_else' } as never).where(eq(ticketMailboxConnections.id, connId))))).toBe('23514');
    expect(await code(withSystemDbAccessContext(() => db.update(ticketMailboxConnections)
      .set({ gmailHandledLabel: 'x'.repeat(101) } as never).where(eq(ticketMailboxConnections.id, connId))))).toBe('23514');
  });
});
