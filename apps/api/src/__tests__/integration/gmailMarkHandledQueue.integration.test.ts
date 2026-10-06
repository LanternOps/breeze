/**
 * Gmail mark-handled runs on its own queue (#7949), against real Postgres and
 * Redis: the inbound-email job ingests the message, enqueues one mark job and
 * returns without touching Gmail; the dedicated worker (concurrency 1) applies
 * the label. Gmail HTTP is replaced by fakes; the pipeline, the queue and the
 * worker are real.
 */
import './setup';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { gmail_v1 } from '@googleapis/gmail';

const gm = vi.hoisted(() => ({
  markGmailHandled: vi.fn(async (..._a: unknown[]) => {}),
  identity: vi.fn(async () => ({ sub: 'goog-sub-q', email: 'x' })),
}));
vi.mock('../../services/ticketMailbox/googleMailboxClient', async (importActual) => {
  const actual = await importActual<typeof import('../../services/ticketMailbox/googleMailboxClient')>();
  return { ...actual, markGmailHandled: gm.markGmailHandled };
});
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../services/sentry', async (importActual) => {
  const actual = await importActual<typeof import('../../services/sentry')>();
  return { ...actual, captureException: sentry.captureException };
});
vi.mock('../../services/googleClient', async (importActual) => {
  const actual = await importActual<typeof import('../../services/googleClient')>();
  return {
    ...actual,
    getInboundModifyGmailClient: () => ({ gmail: { fake: true } as never, identity: gm.identity }),
  };
});

import { and, eq } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { googleWorkspaceConnections, ticketMailboxConnections, ticketEmailInbound, portalUsers } from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';
import { getTestDb } from './setup';
import { encryptSecret } from '../../services/secretCrypto';
import { normalizeGmailMessage } from '../../services/ticketMailbox/normalizeGmailMessage';
import { handleInboundEmail } from '../../jobs/inboundEmailWorker';
import { initializeGmailMarkHandledWorker, shutdownGmailMarkHandledWorker } from '../../jobs/gmailMarkHandledWorker';
import { enqueueGmailMarkHandled, getGmailMarkHandledQueue, gmailMarkHandledJobId } from '../../services/gmailMarkHandledQueue';
import { recordGmailHandledFailure } from '../../services/ticketMailbox/markIngestedGmailHandled';
import { listMailboxConnections } from '../../services/ticketMailbox/connectionService';
import type { MailboxGenerationContext } from '../../services/inboundEmailQueue';

const SUB = 'goog-sub-q';
let db: any;

function gmailMsg(id: string, from: string, mailbox: string): gmail_v1.Schema$Message {
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
        { name: 'Subject', value: `Printer down ${id}` },
        { name: 'Message-ID', value: `<${id}@known.test>` },
        { name: 'Authentication-Results', value: 'mx.google.com; spf=pass; dkim=pass; dmarc=pass' },
      ],
      body: { data: Buffer.from('printer down', 'utf8').toString('base64url') },
    },
  };
}

async function seed(opts: { label?: string | null } = {}) {
  const suffix = `${Date.now()}-${Math.floor(performance.now())}`;
  const customer = `cust-${suffix}@known.test`;
  const mailbox = `help-${suffix}@example.test`;
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await db.insert(portalUsers).values({ orgId: org.id, email: customer, name: 'Customer' });
    const saKey = JSON.stringify({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: 'k' });
    await db.insert(googleWorkspaceConnections).values({
      orgId: org.id, customerDomain: 'example.test', adminEmail: 'admin@example.test',
      serviceAccountEmail: 'sa@x.iam.gserviceaccount.com',
      serviceAccountKey: encryptSecret(saKey, { aad: 'google_workspace_connections.service_account_key' }),
      status: 'active',
    });
    const [conn] = await db.insert(ticketMailboxConnections).values({
      partnerId: partner.id, provider: 'gmail', orgId: org.id, googleAccountSub: SUB,
      mailboxAddress: mailbox, status: 'connected', historyId: 'H1',
      gmailHandledLabel: opts.label === undefined ? 'Handled' : opts.label, gmailArchiveOnHandle: true,
    }).returning({ id: ticketMailboxConnections.id, consentAttemptId: ticketMailboxConnections.consentAttemptId });
    const generation: MailboxGenerationContext = {
      provider: 'gmail', connectionId: conn!.id, partnerId: partner.id, tenantId: null, consentAttemptId: conn!.consentAttemptId,
    };
    const emailFor = (id: string, from = customer) => normalizeGmailMessage(gmailMsg(`${id}-${suffix}`, from, mailbox), partner.id, mailbox, SUB);
    return { partnerId: partner.id, connId: conn!.id, generation, emailFor };
  });
}

const readConn = (id: string) => withSystemDbAccessContext(async () => {
  const [row] = await db.select().from(ticketMailboxConnections).where(eq(ticketMailboxConnections.id, id));
  return row as { gmailHandledError: string | null; gmailHandledLabel: string | null };
});

const inboundStatus = (partnerId: string, providerMessageId: string) => withSystemDbAccessContext(async () => {
  const [row] = await db.select({ parseStatus: ticketEmailInbound.parseStatus, ticketId: ticketEmailInbound.ticketId })
    .from(ticketEmailInbound)
    .where(and(eq(ticketEmailInbound.partnerId, partnerId), eq(ticketEmailInbound.providerMessageId, providerMessageId)));
  return row as { parseStatus: string; ticketId: string | null } | undefined;
});

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() > until) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('Gmail mark-handled queue (real DB + Redis)', () => {
  beforeEach(async () => {
    db = getTestDb();
    gm.markGmailHandled.mockReset();
    gm.markGmailHandled.mockImplementation(async () => {});
    gm.identity.mockReset();
    gm.identity.mockImplementation(async () => ({ sub: SUB, email: 'x' }));
    sentry.captureException.mockClear();
    // The worker is started once per process (its readiness consumer attaches
    // once), so the intake test runs first, before it exists.
    await getGmailMarkHandledQueue().obliterate({ force: true });
  });

  afterAll(async () => {
    await shutdownGmailMarkHandledWorker();
    await getGmailMarkHandledQueue().obliterate({ force: true });
    await getGmailMarkHandledQueue().close();
  });

  it('intake creates the ticket and returns without waiting on Gmail, leaving one mark job queued', async () => {
    const { partnerId, generation, emailFor } = await seed();
    // Gmail never answers: any inline call would hang the intake job.
    gm.identity.mockImplementation(() => new Promise(() => {}));
    gm.markGmailHandled.mockImplementation(() => new Promise(() => {}));
    const email = emailFor('intake');

    const started = Date.now();
    await handleInboundEmail({ data: { email, mailboxGeneration: generation } } as never);
    expect(Date.now() - started).toBeLessThan(5_000);

    const row = await inboundStatus(partnerId, email.providerMessageId);
    expect(row?.parseStatus).toBe('created');
    expect(row?.ticketId).toBeTruthy();
    expect(gm.identity).not.toHaveBeenCalled();
    expect(gm.markGmailHandled).not.toHaveBeenCalled();

    const job = await getGmailMarkHandledQueue().getJob(gmailMarkHandledJobId(email.providerMessageId, generation));
    expect(job?.data).toEqual({ email: { provider: 'gmail', providerMessageId: email.providerMessageId }, generation });

    // A retried intake job does not queue a second mark for the same message.
    await handleInboundEmail({ data: { email, mailboxGeneration: generation } } as never);
    expect(await getGmailMarkHandledQueue().getWaitingCount()).toBe(1);
  }, 20_000);

  it('queues nothing for a mailbox without a handled label, or for mail that did not become a ticket', async () => {
    const off = await seed({ label: null });
    const offEmail = off.emailFor('off');
    await handleInboundEmail({ data: { email: offEmail, mailboxGeneration: off.generation } } as never);
    expect((await inboundStatus(off.partnerId, offEmail.providerMessageId))?.parseStatus).toBe('created');

    const on = await seed();
    const strangerEmail = on.emailFor('stranger', 'nobody@unknown.test');
    await handleInboundEmail({ data: { email: strangerEmail, mailboxGeneration: on.generation } } as never);
    expect((await inboundStatus(on.partnerId, strangerEmail.providerMessageId))?.parseStatus).not.toMatch(/^(created|matched)$/);

    expect(await getGmailMarkHandledQueue().count()).toBe(0);
  }, 20_000);

  it('skips a mark once the backlog is at the cap', async () => {
    const { generation } = await seed();
    expect(await enqueueGmailMarkHandled('gmail:goog-sub-q:cap-1', generation, { cap: 1 })).toBe('queued');
    expect(await enqueueGmailMarkHandled('gmail:goog-sub-q:cap-2', generation, { cap: 1 })).toBe('full');
    expect(await getGmailMarkHandledQueue().count()).toBe(1);
  });

  it('a mark that could not be queued shows on the mailbox card as not_queued, reported once', async () => {
    const { partnerId, connId, generation } = await seed();
    await recordGmailHandledFailure(generation, 'not_queued', new Error('redis down'));
    await recordGmailHandledFailure(generation, 'not_queued', new Error('redis down'));
    expect((await readConn(connId)).gmailHandledError).toBe('not_queued');
    const list = await withSystemDbAccessContext(() => listMailboxConnections(partnerId));
    expect(list.find((c) => c.id === connId)?.gmailHandling?.error).toBe('not_queued');
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('the worker marks the queued message, retrying a transient Gmail failure', async () => {
    const { generation, emailFor } = await seed();
    const email = emailFor('retry');
    gm.markGmailHandled.mockImplementationOnce(async () => { throw Object.assign(new Error('backend'), { code: 503 }); });
    await handleInboundEmail({ data: { email, mailboxGeneration: generation } } as never);

    await initializeGmailMarkHandledWorker();
    const jobId = gmailMarkHandledJobId(email.providerMessageId, generation);
    const job = await waitFor(
      () => getGmailMarkHandledQueue().getJob(jobId),
      (j) => j?.returnvalue !== undefined && j?.returnvalue !== null,
    );
    expect(job?.returnvalue).toBe('marked');
    expect(gm.markGmailHandled).toHaveBeenCalledTimes(2);
    expect(gm.markGmailHandled).toHaveBeenLastCalledWith(
      expect.anything(), expect.any(String), email.providerMessageId.split(':')[2],
      expect.objectContaining({ labelName: 'Handled', archive: true, accountSub: SUB }),
    );
  }, 30_000);

  it('a transient failure that outlasts the in-call retries is retried by the queue; Sentry hears of it once', async () => {
    const { partnerId, connId, generation, emailFor } = await seed({ label: null });
    const email = emailFor('queue-retry');
    await handleInboundEmail({ data: { email, mailboxGeneration: generation } } as never);
    await withSystemDbAccessContext(() => db.update(ticketMailboxConnections)
      .set({ gmailHandledLabel: 'Handled' }).where(eq(ticketMailboxConnections.id, connId)));
    expect((await inboundStatus(partnerId, email.providerMessageId))?.parseStatus).toBe('created');
    // The first job attempt fails all three in-call tries (503); the queue retries it.
    let calls = 0;
    gm.markGmailHandled.mockImplementation(async () => {
      calls += 1;
      if (calls <= 3) throw Object.assign(new Error('backend'), { code: 503 });
    });
    await initializeGmailMarkHandledWorker();
    expect(await enqueueGmailMarkHandled(email.providerMessageId, generation, { backoffMs: 50 })).toBe('queued');
    const job = await waitFor(
      () => getGmailMarkHandledQueue().getJob(gmailMarkHandledJobId(email.providerMessageId, generation)),
      (j) => j?.returnvalue === 'marked',
      20_000,
    );
    expect(job?.returnvalue).toBe('marked');
    expect(job?.attemptsMade).toBeGreaterThanOrEqual(1);
    expect(calls).toBe(4);
    // Recorded as unavailable by the first attempt, cleared by the success.
    expect((await readConn(connId)).gmailHandledError).toBeNull();
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('a permanent failure is recorded and not retried by the queue', async () => {
    const { connId, generation, emailFor } = await seed({ label: null });
    const email = emailFor('permanent');
    await handleInboundEmail({ data: { email, mailboxGeneration: generation } } as never);
    await withSystemDbAccessContext(() => db.update(ticketMailboxConnections)
      .set({ gmailHandledLabel: 'Handled' }).where(eq(ticketMailboxConnections.id, connId)));
    gm.markGmailHandled.mockRejectedValue(Object.assign(new Error('insufficient scope'), { status: 403 }));
    await initializeGmailMarkHandledWorker();
    expect(await enqueueGmailMarkHandled(email.providerMessageId, generation, { backoffMs: 50 })).toBe('queued');
    const job = await waitFor(
      () => getGmailMarkHandledQueue().getJob(gmailMarkHandledJobId(email.providerMessageId, generation)),
      (j) => j?.returnvalue === 'failed',
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(job?.returnvalue).toBe('failed');
    expect(gm.markGmailHandled).toHaveBeenCalledTimes(1);
    expect((await readConn(connId)).gmailHandledError).toBe('access_denied');
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('the worker runs one mark job at a time', async () => {
    const { generation, emailFor } = await seed();
    let inFlight = 0;
    let maxInFlight = 0;
    let completed = 0;
    gm.markGmailHandled.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 800));
      inFlight -= 1;
      completed += 1;
    });
    // The worker is already running. Each mark takes longer than an intake, so
    // later jobs are queued while the first is still in flight; a worker with
    // concurrency above 1 would pick them up in parallel.
    await initializeGmailMarkHandledWorker();
    for (const id of ['c1', 'c2', 'c3', 'c4']) {
      await handleInboundEmail({ data: { email: emailFor(id), mailboxGeneration: generation } } as never);
    }
    expect(await getGmailMarkHandledQueue().getWaitingCount()).toBeGreaterThanOrEqual(1);
    await waitFor(async () => completed, (n) => n >= 4);
    expect(completed).toBe(4);
    expect(maxInFlight).toBe(1);
  }, 30_000);
});
