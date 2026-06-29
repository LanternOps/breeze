import { Job, Queue, Worker } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { captureException } from '../services/sentry';
import {
  listConnectedMailboxes,
  updateDeltaCursor,
  resetDeltaCursor,
  setConnectionStatus,
} from '../services/ticketMailbox/connectionService';
import { getMailboxToken } from '../services/ticketMailbox/mailboxToken';
import { listInboxDelta, markRead } from '../services/ticketMailbox/graphMailClient';
import { normalizeGraphMessage } from '../services/ticketMailbox/normalizeGraphMessage';
import { enqueueInboundEmail } from '../services/inboundEmailQueue';

const QUEUE_NAME = 'ticket-mailbox-poll';
const SWEEP_INTERVAL_MS = 90 * 1000;
const SWEEP_JOB_ID = 'ticket-mailbox-poll-sweep';

type SweepJobData = { type: 'sweep' };

/** Process one mailbox end-to-end. Graph I/O runs outside any DB context. */
async function sweepOne(c: Awaited<ReturnType<typeof listConnectedMailboxes>>[number]): Promise<void> {
  if (!c.tenantId) return;

  let page: Awaited<ReturnType<typeof listInboxDelta>>;
  try {
    const token = await getMailboxToken(c.tenantId);
    page = await listInboxDelta(token, c.mailboxAddress, c.deltaLink);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 410) {
      await resetDeltaCursor(c.id);
      console.warn('[mailboxPoll] delta token gone (410); cursor reset', { id: c.id });
      return;
    }

    const next = status === 401 || status === 403 ? 'reauth_required' : 'error';
    // setConnectionStatus is shared with the request path (bare db); the worker has
    // no request DB context, so wrap in system context or the FORCE-RLS UPDATE
    // matches zero rows and the status never surfaces.
    await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      setConnectionStatus(c.id, c.partnerId, next, err instanceof Error ? err.message : 'poll failed')));
    return;
  }

  let lastMessageAt: Date | null = null;
  try {
    const token = await getMailboxToken(c.tenantId);
    for (const msg of page.messages) {
      const normalized = normalizeGraphMessage(msg, c.partnerId, c.mailboxAddress);
      await enqueueInboundEmail(normalized);
      await markRead(token, c.mailboxAddress, msg.id).catch((e) => {
        console.warn('[mailboxPoll] mark-read failed', { id: msg.id, err: e instanceof Error ? e.message : e });
      });
      if (msg.receivedDateTime) lastMessageAt = new Date(msg.receivedDateTime);
    }
  } catch (err) {
    console.error('[mailboxPoll] enqueue failed; cursor not advanced', {
      id: c.id,
      err: err instanceof Error ? err.message : err,
    });
    return;
  }

  if (page.deltaLink) {
    const polledAt = new Date();
    await updateDeltaCursor(c.id, page.deltaLink, polledAt, lastMessageAt ?? polledAt);
  }
}

/** Exported for tests. Reads connections in system context, processes each independently. */
export async function runMailboxSweep(): Promise<void> {
  const connections = await listConnectedMailboxes();
  for (const c of connections) {
    try {
      await sweepOne(c);
    } catch (err) {
      captureException(err instanceof Error ? err : new Error(String(err)));
      console.error('[mailboxPoll] sweepOne crashed', { id: c.id });
    }
  }
}

let queue: Queue<SweepJobData> | null = null;
let worker: Worker<SweepJobData> | null = null;

export async function initializeTicketMailboxPollWorker(): Promise<void> {
  if (worker) return;

  queue = new Queue<SweepJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  await queue.add(
    'sweep',
    { type: 'sweep' },
    {
      jobId: SWEEP_JOB_ID,
      repeat: { every: SWEEP_INTERVAL_MS },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  );

  worker = new Worker<SweepJobData>(
    QUEUE_NAME,
    async (_job: Job<SweepJobData>) => {
      await runMailboxSweep();
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    console.error('[mailboxPoll] sweep job failed', { id: job?.id, err: err?.message });
  });
  console.log('[mailboxPoll] worker initialized');
}
