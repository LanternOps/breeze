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
import { getBullMQConnection, getRedis } from '../services/redis';
import { captureException } from '../services/sentry';
import {
  INBOUND_EMAIL_QUEUE,
  type InboundEmailJobData,
  type InboundEmailQueueJob,
} from '../services/inboundEmailQueue';
import { processInboundEmail } from '../services/inboundEmail/inboundEmailService';
import { resolvePartnerByRecipient } from '../services/inboundEmail/resolvePartner';
import { loadPartnerInboundPolicy } from '../services/inboundEmail/resolveOrg';
import {
  evaluateInboundThrottle,
  resolveInboundCapLimits,
  type InboundThrottleVerdict,
} from '../services/inboundEmail/inboundRateLimit';
import { inboundQueueMaxPerSec } from '../config/env';
import { attachWorkerObservability } from './workerObservability';

let worker: Worker<InboundEmailQueueJob> | null = null;

function unwrapJob(data: InboundEmailQueueJob): InboundEmailJobData {
  return 'email' in data ? data : { email: data };
}

/**
 * Evaluate the inbound flood cap for this job, BEFORE the processing
 * transaction opens. The Redis sliding-window check cannot run inside the held
 * DB context (#1105), so it lives here: a SHORT own DB context resolves the
 * partner and reads its cap overrides and closes, then the Redis check runs
 * with NO context held. Returns undefined when the partner can't be resolved
 * (an unhosted recipient) — processInboundEmail will log that as 'ignored'.
 *
 * Only the job's FIRST attempt is counted: a BullMQ retry must not record a
 * second hit in the window (which would let transient failures inflate the
 * count) or be wrongly quarantined for a burst it already survived.
 */
async function evaluateThrottleForJob(
  job: Job<InboundEmailQueueJob>,
): Promise<InboundThrottleVerdict | undefined> {
  if ((job.attemptsMade ?? 0) !== 0) return undefined;
  const { email, mailboxGeneration } = unwrapJob(job.data);

  const resolved = await dbModule.runOutsideDbContext(() =>
    dbModule.withSystemDbAccessContext(async () => {
      const partnerId =
        mailboxGeneration?.partnerId ?? email.resolvedPartnerId ?? (await resolvePartnerByRecipient(email.to));
      if (!partnerId) return null;
      const policy = await loadPartnerInboundPolicy(partnerId);
      return {
        partnerId,
        overrides: {
          maxTicketsPerSenderPerHour: policy.maxTicketsPerSenderPerHour,
          maxTicketsPerDomainPerHour: policy.maxTicketsPerDomainPerHour,
          maxTicketsPerPartnerPerHour: policy.maxTicketsPerPartnerPerHour,
        },
      };
    }),
  );
  if (!resolved) return undefined;

  // Redis-only, NO DB context held here.
  return evaluateInboundThrottle({
    redis: getRedis(),
    from: email.from,
    partnerId: resolved.partnerId,
    limits: resolveInboundCapLimits(resolved.overrides),
  });
}

export async function handleInboundEmail(job: Job<InboundEmailQueueJob>): Promise<void> {
  const { email, mailboxGeneration } = unwrapJob(job.data);

  // Flood cap FIRST, outside any DB context (its Redis round-trip must not pin a
  // pooled connection idle-in-transaction, #1105). The verdict is threaded into
  // the pipeline, which quarantines over-cap mail for review rather than minting
  // a ticket. A throttle-evaluation failure must never lose the email: on error
  // we proceed unthrottled (fail-open here) — the pipeline's own quarantine and
  // the global queue limiter remain as backstops.
  let throttle: InboundThrottleVerdict | undefined;
  try {
    throttle = await evaluateThrottleForJob(job);
  } catch (err) {
    console.error('[InboundEmail] throttle evaluation failed; proceeding unthrottled:', err);
  }

  // runOutsideDbContext is a synchronous wrapper that asserts no open DB context
  // exists on the current async-context stack and then runs fn() in a clean scope.
  // We need to bridge it to our async work by returning the Promise it produces.
  return dbModule.runOutsideDbContext(() =>
    dbModule.withSystemDbAccessContext(() =>
      processInboundEmail(email, mailboxGeneration, throttle ? { throttle } : {}),
    ),
  );
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
