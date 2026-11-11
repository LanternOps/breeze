/**
 * #10863, end to end: connecting a Microsoft 365 mailbox that already holds mail
 * imports none of it. Real Postgres and the real sweep, connection service and
 * normalizer; only the Graph calls and the queue producer are mocked, so a column
 * the sweep's listing fails to select, or a write the CHECK refuses, fails here.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const graph = vi.hoisted(() => ({ listInboxDelta: vi.fn(), markRead: vi.fn(async () => {}) }));
vi.mock('../../services/ticketMailbox/graphMailClient', async (importActual) => ({
  ...(await importActual<typeof import('../../services/ticketMailbox/graphMailClient')>()),
  listInboxDelta: graph.listInboxDelta,
  markRead: graph.markRead,
}));
vi.mock('../../services/ticketMailbox/mailboxToken', () => ({ getMailboxToken: vi.fn(async () => 'tok') }));
const enqueue = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock('../../services/inboundEmailQueue', () => ({ enqueueInboundEmail: enqueue }));

import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { ticketMailboxConnections, ticketMailboxTenantOwnerships } from '../../db/schema/ticketMailbox';
import { createPartner } from './db-utils';
import { runMailboxSweep } from '../../jobs/ticketMailboxPollWorker';
import {
  bindVerifiedTenant,
  createPendingConnection,
  listMailboxConnections,
} from '../../services/ticketMailbox/connectionService';

const message = (subject: string, receivedDateTime: string) => ({
  id: `graph-${subject}`,
  subject,
  receivedDateTime,
  from: { emailAddress: { address: 'customer@example.com' } },
  toRecipients: [{ emailAddress: { address: 'support@example.com' } }],
  body: { contentType: 'text', content: subject },
  internetMessageHeaders: [],
});
const backlog = (subject: string) => message(subject, '2020-01-01T00:00:00Z');
/** Well clear of the floor a test connects with: the floor is the current time. */
const afterConnect = (subject: string) => message(subject, new Date(Date.now() + 60_000).toISOString());

const enqueuedSubjects = () => enqueue.mock.calls.map(([email]) => (email as { subject: string }).subject);
const markedIds = () => (graph.markRead.mock.calls as unknown[][]).map((call) => call[2]);

/** A mailbox connected exactly as the consent callback does it. */
async function connect() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const pending = await createPendingConnection({
      partnerId: partner.id, mailboxAddress: `support-${randomUUID()}@example.com`, displayName: null, createdBy: null,
    });
    await bindVerifiedTenant(pending.id, partner.id, pending.consentAttemptId, randomUUID(), {
      microsoftOid: randomUUID(), breezeUserId: null,
    });
    return { id: pending.id, partnerId: partner.id };
  });
}

/** A mailbox already polling before the floor existed: a tenant, optionally a cursor, no floor. */
async function seedExisting(values: { deltaLink: string | null; lastPolledAt: Date | null }) {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const tenantId = randomUUID();
    await db.insert(ticketMailboxTenantOwnerships).values({
      tenantId, partnerId: partner.id, verifiedMicrosoftOid: randomUUID(),
    });
    const [row] = await db.insert(ticketMailboxConnections).values({
      partnerId: partner.id, tenantId, mailboxAddress: `support-${randomUUID()}@example.com`, status: 'connected', ...values,
    }).returning({ id: ticketMailboxConnections.id });
    return { id: row!.id, partnerId: partner.id };
  });
}

const readRow = async (id: string) => (await withSystemDbAccessContext(async () => db.select().from(ticketMailboxConnections)
  .where(eq(ticketMailboxConnections.id, id))))[0]!;

/** One sweep. Clears the short attempt claim, which would otherwise skip the mailbox on a back-to-back sweep. */
async function sweep(id: string) {
  await withSystemDbAccessContext(async () => db.update(ticketMailboxConnections)
    .set({ lastPollAttemptAt: null }).where(eq(ticketMailboxConnections.id, id)));
  await runMailboxSweep();
}

describe('Microsoft 365 connect baseline (#10863)', () => {
  beforeEach(() => {
    graph.listInboxDelta.mockReset();
    graph.markRead.mockClear();
    enqueue.mockClear();
  });

  it('a backlog across several sweeps imports nothing, and only later mail becomes tickets', async () => {
    const { id, partnerId } = await connect();

    // A first delta from no cursor, too large for one sweep.
    graph.listInboxDelta.mockResolvedValueOnce({
      messages: [backlog('old-1'), backlog('old-2')],
      deltaLink: null,
      resumeLink: 'https://graph.microsoft.com/next-2',
      resumeReason: 'page_cap',
    });
    await sweep(id);
    expect(graph.listInboxDelta.mock.calls[0]![2]).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
    expect(graph.markRead).not.toHaveBeenCalled();
    let row = await readRow(id);
    expect(row).toMatchObject({ deltaLink: 'https://graph.microsoft.com/next-2', baselineSkippedCount: 2, baselineCompletedAt: null });
    // Still running: the card gets no final number yet.
    let [listed] = await withSystemDbAccessContext(() => listMailboxConnections(partnerId));
    expect(listed!.connectBaseline).toEqual({ skippedCount: 2, completedAt: null });

    // Mail arriving during the walk shows up on a later page and is not swallowed.
    graph.listInboxDelta.mockResolvedValueOnce({
      messages: [backlog('old-3'), afterConnect('during-walk')],
      deltaLink: 'https://graph.microsoft.com/delta-1',
    });
    await sweep(id);
    expect(graph.listInboxDelta.mock.calls[1]![2]).toBe('https://graph.microsoft.com/next-2');
    expect(enqueuedSubjects()).toEqual(['during-walk']);
    expect(markedIds()).toEqual(['graph-during-walk']);
    row = await readRow(id);
    expect(row).toMatchObject({ deltaLink: 'https://graph.microsoft.com/delta-1', baselineSkippedCount: 3 });
    expect(row.baselineCompletedAt).toBeInstanceOf(Date);
    [listed] = await withSystemDbAccessContext(() => listMailboxConnections(partnerId));
    expect(listed!.connectBaseline).toEqual({ skippedCount: 3, completedAt: row.baselineCompletedAt });

    // Afterwards delta also reports old mail someone touched: still not a ticket,
    // and it no longer changes what the card says.
    enqueue.mockClear();
    graph.markRead.mockClear();
    graph.listInboxDelta.mockResolvedValueOnce({
      messages: [backlog('old-1'), afterConnect('new-1')],
      deltaLink: 'https://graph.microsoft.com/delta-2',
    });
    await sweep(id);
    expect(graph.listInboxDelta.mock.calls[2]![2]).toBe('https://graph.microsoft.com/delta-1');
    expect(enqueuedSubjects()).toEqual(['new-1']);
    expect(markedIds()).toEqual(['graph-new-1']);
    expect(await readRow(id)).toMatchObject({ deltaLink: 'https://graph.microsoft.com/delta-2', baselineSkippedCount: 3 });
  });

  it('a baseline that fails midway does not turn the next poll into a full import', async () => {
    const { id } = await connect();
    const floor = (await readRow(id)).eligibleAfter;

    const unavailable = Object.assign(new Error('Graph delta 503'), { status: 503 });
    graph.listInboxDelta.mockRejectedValueOnce(unavailable);
    await sweep(id);
    let row = await readRow(id);
    expect(row).toMatchObject({ deltaLink: null, status: 'connected', baselineCompletedAt: null, consecutiveTransientFailures: 1 });
    expect(row.eligibleAfter).toEqual(floor);

    graph.listInboxDelta.mockResolvedValueOnce({
      messages: [backlog('old-1'), backlog('old-2')],
      deltaLink: 'https://graph.microsoft.com/delta-1',
    });
    await sweep(id);
    expect(enqueue).not.toHaveBeenCalled();
    expect(graph.markRead).not.toHaveBeenCalled();
    row = await readRow(id);
    expect(row).toMatchObject({ deltaLink: 'https://graph.microsoft.com/delta-1', baselineSkippedCount: 2 });
  });

  it.each([
    ['410 Gone', { status: 410 }],
    ['syncStateNotFound', { status: 400, graphCode: 'syncStateNotFound' }],
  ])('an expired cursor (%s) re-baselines instead of re-importing the inbox', async (_label, failure) => {
    const { id } = await connect();
    graph.listInboxDelta.mockResolvedValueOnce({ messages: [backlog('old-1')], deltaLink: 'https://graph.microsoft.com/delta-1' });
    await sweep(id);
    const floor = (await readRow(id)).eligibleAfter;

    graph.listInboxDelta.mockRejectedValueOnce(Object.assign(new Error('expired'), failure));
    await sweep(id);
    expect(await readRow(id)).toMatchObject({ deltaLink: null, status: 'connected', baselineSkippedCount: 1 });

    // The whole inbox comes back from the fresh delta.
    graph.listInboxDelta.mockResolvedValueOnce({
      messages: [backlog('old-1'), backlog('old-2'), afterConnect('during-outage')],
      deltaLink: 'https://graph.microsoft.com/delta-2',
    });
    await sweep(id);

    expect(graph.listInboxDelta.mock.calls[2]![2]).toBeNull();
    expect(enqueuedSubjects()).toEqual(['during-outage']);
    const row = await readRow(id);
    expect(row).toMatchObject({ deltaLink: 'https://graph.microsoft.com/delta-2', baselineSkippedCount: 1 });
    expect(row.eligibleAfter).toEqual(floor);
  });

  it('an existing connection with a deltaLink is unaffected: no floor appears and its mail flows', async () => {
    const { id, partnerId } = await seedExisting({
      deltaLink: 'https://graph.microsoft.com/delta-old',
      lastPolledAt: new Date('2026-10-30T08:00:00.000Z'),
    });

    graph.listInboxDelta.mockResolvedValueOnce({
      messages: [backlog('old-looking')],
      deltaLink: 'https://graph.microsoft.com/delta-new',
    });
    await sweep(id);

    expect(graph.listInboxDelta.mock.calls[0]![2]).toBe('https://graph.microsoft.com/delta-old');
    expect(enqueuedSubjects()).toEqual(['old-looking']);
    expect(markedIds()).toEqual(['graph-old-looking']);
    expect(await readRow(id)).toMatchObject({
      deltaLink: 'https://graph.microsoft.com/delta-new', eligibleAfter: null, baselineSkippedCount: 0, baselineCompletedAt: null,
    });
    const [listed] = await withSystemDbAccessContext(() => listMailboxConnections(partnerId));
    expect(listed!.connectBaseline).toBeNull();
  });

  it('an existing connection that loses its cursor imports only what arrived since its last poll', async () => {
    const lastPolledAt = new Date('2026-10-30T08:00:00.000Z');
    const { id, partnerId } = await seedExisting({ deltaLink: 'https://graph.microsoft.com/delta-old', lastPolledAt });

    graph.listInboxDelta.mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 410 }));
    await sweep(id);
    expect(await readRow(id)).toMatchObject({ deltaLink: null, eligibleAfter: null });

    graph.listInboxDelta.mockResolvedValueOnce({
      messages: [
        message('imported-long-ago', '2026-10-30T07:50:00Z'),
        message('since-last-poll', '2026-10-30T08:01:00Z'),
      ],
      deltaLink: 'https://graph.microsoft.com/delta-new',
    });
    await sweep(id);

    expect(enqueuedSubjects()).toEqual(['since-last-poll']);
    const row = await readRow(id);
    expect(row.eligibleAfter!.getTime()).toBe(lastPolledAt.getTime() - 5 * 60_000);
    expect(row.deltaLink).toBe('https://graph.microsoft.com/delta-new');
    // This was not a connect, so the card says nothing about "already in this inbox".
    const [listed] = await withSystemDbAccessContext(() => listMailboxConnections(partnerId));
    expect(listed!.connectBaseline).toMatchObject({ skippedCount: 0 });
    expect(listed!.connectBaseline!.completedAt).toBeInstanceOf(Date);
  });
});
