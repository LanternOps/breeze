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

import { randomUUID } from 'node:crypto';
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
import { admitInboundTicket, releaseInboundCharges } from '../services/inboundEmail/inboundRateLimit';
import { getRedis } from '../services/redis';
import { inboundQueueMaxPerSec } from '../config/env';
import { attachWorkerObservability } from './workerObservability';

let worker: Worker<InboundEmailQueueJob> | null = null;

function unwrapJob(data: InboundEmailQueueJob): InboundEmailJobData {
  return 'email' in data ? data : { email: data };
}

export async function handleInboundEmail(job: Job<InboundEmailQueueJob>): Promise<void> {
  const { email, mailboxGeneration } = unwrapJob(job.data);

  // FLOOD CAP — all Redis happens OUTSIDE the pipeline's held transaction (#1105).
  // A Redis round-trip made while withSystemDbAccessContext is held would pin the
  // pooled Postgres connection idle-in-transaction, so the flow is admit/settle:
  //
  //   1. Resolve the cap windows for this message in a SHORT DB context (reads
  //      only), which is CLOSED before any Redis touches the wire.
  //   2. ADMIT: atomically charge-and-check the windows (ZADD+ZCARD MULTI, outside
  //      any DB context) under a reservation token UNIQUE to this delivery attempt,
  //      so the limit holds exactly under concurrency AND a later refund can only
  //      remove this attempt's own slot (never a prior accepted delivery's).
  //   3. Run the pipeline in its own held transaction; it consults the admission
  //      verdict only at its create paths (a reply that appends to an existing
  //      ticket is never throttled) and touches no Redis.
  //   4. SETTLE: keep the reservation ONLY when a ticket was actually created AND
  //      its transaction committed; otherwise (throttled, reply-append, drop,
  //      dedup, quarantine, or a rolled-back/failed transaction) refund it — so
  //      each window counts real, committed creations only. The refund is in a
  //      `finally` so a commit failure cannot leave a phantom charge.
  const reservationMember = randomUUID();
  const checks = await dbModule.runOutsideDbContext(() =>
    dbModule.withSystemDbAccessContext(() => resolveInboundThrottleChecks(email, mailboxGeneration)),
  );
  const { verdict, chargedKeys } = await admitInboundTicket(getRedis(), checks, reservationMember);

  // `created` is set inside the transaction (after logCreated); `committed` flips
  // true only once withSystemDbAccessContext resolves, i.e. the transaction
  // actually committed. A create path whose commit then fails leaves created=true
  // but committed=false, so the reservation is refunded (the ticket rolled back).
  let created = false;
  let committed = false;
  try {
    await dbModule.runOutsideDbContext(() =>
      dbModule.withSystemDbAccessContext(() =>
        processInboundEmail(email, mailboxGeneration, {
          onTicketCreated: () => {
            created = true;
          },
        }, verdict),
      ),
    );
    committed = true;
  } finally {
    if (!(committed && created)) {
      await releaseInboundCharges(getRedis(), chargedKeys, reservationMember);
    }
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
