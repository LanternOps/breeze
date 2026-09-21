/**
 * Inbound Email Worker
 *
 * Consumes the `inbound-email` BullMQ queue and processes each normalized
 * inbound email through processInboundEmail, which:
 *   1. Resolves partner by recipient address
 *   2. Deduplicates by provider message id
 *   3. Finds or creates the ticket (with reopen logic)
 *   4. Appends the public comment
 *   5. Emits ticket.commented with inbound:true (suppresses echo in ticketNotifyWorker)
 *
 * DB work runs inside runOutsideDbContext → withSystemDbAccessContext to avoid
 * idle-in-transaction pool poison (#1105): the provider HTTP callback is not
 * active at this point, so withSystemDbAccessContext is safe to call directly,
 * but we wrap in runOutsideDbContext as belt-and-suspenders in case the worker
 * is started in a context that already holds a DB context open.
 */

import { Worker, type Job } from 'bullmq';
import * as dbModule from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import {
  INBOUND_EMAIL_QUEUE,
  type InboundEmailJobData,
  type InboundEmailQueueJob,
} from '../services/inboundEmailQueue';
import {
  processInboundEmail,
  resolveInboundThrottleChecks,
} from '../services/inboundEmail/inboundEmailService';
import { peekInboundThrottle, chargeInboundTickets } from '../services/inboundEmail/inboundRateLimit';
import type { InboundCapCheck } from '../services/inboundEmail/inboundRateLimit';
import { getRedis } from '../services/redis';
import { inboundQueueMaxPerSec } from '../config/env';
import { attachWorkerObservability } from './workerObservability';

let worker: Worker<InboundEmailQueueJob> | null = null;

function unwrapJob(data: InboundEmailQueueJob): InboundEmailJobData {
  return 'email' in data ? data : { email: data };
}

export async function handleInboundEmail(job: Job<InboundEmailQueueJob>): Promise<void> {
  const { email, mailboxGeneration } = unwrapJob(job.data);

  // FLOOD CAP — the flood cap's OWN Redis runs entirely OUTSIDE the pipeline's held
  // transaction (#1105). (The autoresponder still makes its own per-sender Redis
  // call from inside the pipeline; that is a separate, pre-existing accepted
  // warn-only #1105 tolerance this code does not change.) A Redis round-trip made
  // while withSystemDbAccessContext is held would pin the pooled Postgres
  // connection idle-in-transaction, so the flood-cap flow is:
  //
  //   1. Resolve the cap windows for this message in a SHORT DB context (reads
  //      only), which is CLOSED before any Redis touches the wire.
  //   2. PEEK those windows read-only (ZCOUNT), entirely outside any DB context — a
  //      best-effort pre-gate. A peek never mutates, so a peeked message that
  //      creates no ticket charges nothing.
  //   3. Run the pipeline in its own held transaction; it consults the peeked
  //      verdict only at its create paths (a reply that appends to an existing
  //      ticket is never throttled) and makes no flood-cap Redis call. On a real
  //      creation it hands back, via onTicketCreated, the windows computed from the
  //      partner + policy it AUTHORITATIVELY resolved in-transaction.
  //   4. AFTER the transaction commits, charge exactly those authoritative windows.
  //      Charging the pipeline's windows (not the phase-1 snapshot) keeps the charge
  //      correct even if partner routing or cap settings changed between the peek
  //      and the creation; the peek can then be at most one message stale, which is
  //      the same accepted, self-healing class as the documented overshoot.
  const plan = await dbModule.runOutsideDbContext(() =>
    dbModule.withSystemDbAccessContext(() => resolveInboundThrottleChecks(email, mailboxGeneration)),
  );
  const throttle = await peekInboundThrottle(getRedis(), plan.checks);

  let chargeChecks: InboundCapCheck[] = [];
  await dbModule.runOutsideDbContext(() =>
    dbModule.withSystemDbAccessContext(() =>
      // Pass the plan's partnerId so the pipeline only ENFORCES the verdict when it
      // matches the partner it authoritatively resolves (a routing change between
      // the peek and now must not quarantine under the wrong tenant).
      processInboundEmail(email, mailboxGeneration, {
        onTicketCreated: (checks) => {
          chargeChecks = checks;
        },
      }, throttle, plan.partnerId),
    ),
  );

  // Reaching here means the pipeline transaction committed (processInboundEmail
  // swallows its own errors; a commit failure would have thrown and skipped this).
  // A non-empty chargeChecks means a ticket was created; charge its authoritative windows.
  if (chargeChecks.length > 0) {
    await chargeInboundTickets(getRedis(), chargeChecks, email.providerMessageId);
  }
}

export function initializeInboundEmailWorker(): Promise<void> {
  if (worker) return Promise.resolve();

  worker = new Worker<InboundEmailQueueJob>(
    INBOUND_EMAIL_QUEUE,
    (job: Job<InboundEmailQueueJob>) => handleInboundEmail(job),
    {
      connection: getBullMQConnection(),
      concurrency: 5,
      // Global backpressure: cap how many inbound jobs process per second across
      // ALL senders (INBOUND_QUEUE_MAX_PER_SEC). This is the sender-independent
      // floor under the per-sender/domain/partner caps — a distributed burst that
      // spreads across many senders (so no single window trips) is still bounded
      // here. BullMQ delays over-rate jobs rather than dropping them, so nothing
      // is lost; the mail just drains at a controlled rate.
      limiter: { max: inboundQueueMaxPerSec(), duration: 1000 },
    }
  );
  attachWorkerObservability(worker, 'inboundEmailWorker');

  worker.on('error', (error) => {
    console.error('[InboundEmail] Worker error:', error);
  });

  worker.on('failed', (job, error) => {
    const msgId = job ? unwrapJob(job.data).email.providerMessageId : undefined;
    const attempts = job?.attemptsMade;
    console.error(`[InboundEmail] Job ${job?.id} failed (providerMessageId=${msgId}, attempts=${attempts}):`, error);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      captureException(error instanceof Error ? error : new Error(String(error)));
    }
  });

  console.log('[InboundEmail] Worker initialized');
  return Promise.resolve();
}

export async function shutdownInboundEmailWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
