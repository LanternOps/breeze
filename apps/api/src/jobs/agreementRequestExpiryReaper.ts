import { Job, Queue, Worker } from 'bullmq';
import { and, asc, inArray, lte } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import { agreementRequests } from '../db/schema/contractDocuments';
import { organizations } from '../db/schema/orgs';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { writeAuditEvent, requestLikeFromSnapshot } from '../services/auditEvents';
import { isAgreementRequestExpired } from '../services/agreementRequestService';
import { emitAgreementEvent } from '../services/agreementEvents';
import { bullmqJobId } from '../services/bullmqUtils';
import { attachWorkerObservability } from './workerObservability';

/**
 * Reaps `agreement_requests` rows whose `expires_at` has passed while still
 * `sent`/`viewed`, flipping them to `expired` (#9075 W3b, spec §3.5). Cloned
 * from quoteExpiryReaper. The read-time guard (`isAgreementRequestExpired` in
 * send / view / accept / decline / remind / copy-link) is the AUTHORITY — it
 * refuses a customer the instant the deadline passes; this sweep only makes the
 * status column, the lists and the `agreement_requests_open_expiry_idx` partial
 * index reflect it, and publishes `agreement.expired`.
 *
 * Unlike a quote's UTC calendar day, `expires_at` is a timestamptz INSTANT, so
 * the boundary is `now >= expires_at` — the SQL prefilter uses `<=` and every
 * candidate is re-checked through the shared helper so no two paths can
 * disagree about the edge.
 *
 * Runs every 15 minutes inside `withSystemDbAccessContext` (agreement_requests
 * is org-scoped; reaping is a system job). Bounded per run by MAX_REAP_PER_RUN.
 * No Redis jti revoke is needed: the token's own `exp` IS `expires_at`.
 */

const QUEUE_NAME = 'agreement-request-expiry-reaper';
const JOB_NAME = 'reap-expired-agreement-requests';
const REAP_INTERVAL_MS = 15 * 60 * 1000; // every 15 min
const MAX_REAP_PER_RUN = 500;
const OPEN_STATUSES: Array<'sent' | 'viewed'> = ['sent', 'viewed'];

type ReaperJobData = { type: typeof JOB_NAME; queuedAt: string };

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error(
      '[AgreementRequestExpiryReaper] withSystemDbAccessContext not available — reaper cannot run without system DB access',
    );
  }
  return withSystem(fn);
};

let reaperQueue: Queue<ReaperJobData> | null = null;
let reaperWorker: Worker<ReaperJobData> | null = null;

function getQueue(): Queue<ReaperJobData> {
  if (!reaperQueue) {
    reaperQueue = new Queue<ReaperJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return reaperQueue;
}

/**
 * Single pass: lock a bounded batch of overdue open requests (SKIP LOCKED, so a
 * concurrent send/void/answer is never waited on), flip them with a status-
 * guarded update, then audit + emit per transition. A request answered between
 * the read and the update simply no longer matches the guard and is left alone.
 * Returns the number of requests transitioned.
 */
export async function expireAgreementRequests(now: Date = new Date()): Promise<number> {
  const candidates = await db
    .select({ id: agreementRequests.id, expiresAt: agreementRequests.expiresAt })
    .from(agreementRequests)
    .where(and(inArray(agreementRequests.status, OPEN_STATUSES), lte(agreementRequests.expiresAt, now)))
    .orderBy(asc(agreementRequests.expiresAt))
    .limit(MAX_REAP_PER_RUN)
    .for('update', { skipLocked: true });

  const dueIds = candidates.filter((r) => isAgreementRequestExpired(r.expiresAt, now)).map((r) => r.id);
  if (dueIds.length === 0) return 0;

  const flipped = await db
    .update(agreementRequests)
    .set({ status: 'expired', expiredAt: now, updatedAt: now })
    .where(and(inArray(agreementRequests.id, dueIds), inArray(agreementRequests.status, OPEN_STATUSES)))
    .returning({
      id: agreementRequests.id,
      orgId: agreementRequests.orgId,
      label: agreementRequests.label,
      expiresAt: agreementRequests.expiresAt,
      reminderCount: agreementRequests.reminderCount,
    });
  if (flipped.length === 0) return 0;

  // Audit: one row per transition. Best-effort — never block a transition on
  // the audit write (nor one row's failure on the others).
  const requestLike = requestLikeFromSnapshot({});
  for (const row of flipped) {
    try {
      writeAuditEvent(requestLike, {
        orgId: row.orgId,
        action: 'billing.agreement.expired',
        resourceType: 'agreement_request',
        resourceId: row.id,
        resourceName: row.label,
        actorType: 'system',
        actorId: null,
        result: 'success',
        details: { expiresAt: row.expiresAt.toISOString(), reminderCount: row.reminderCount },
      });
    } catch (err) {
      console.error('[AgreementRequestExpiryReaper] Failed to write audit event:', err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // Bus events need the owning partner; one lookup for the batch's orgs.
  try {
    const events: Array<Parameters<typeof emitAgreementEvent>[0]> = [];
    const orgIds = [...new Set(flipped.map((r) => r.orgId))];
    const orgs = await db
      .select({ id: organizations.id, partnerId: organizations.partnerId })
      .from(organizations)
      .where(inArray(organizations.id, orgIds));
    const partnerByOrg = new Map(orgs.map((o) => [o.id, o.partnerId]));
    for (const row of flipped) {
      const partnerId = partnerByOrg.get(row.orgId);
      if (!partnerId) continue;
      events.push({ type: 'agreement.expired', requestId: row.id, orgId: row.orgId, partnerId });
    }
    // Only once the sweep's transaction (and its row locks) has COMMITTED: a
    // rolled-back flip must not announce, and a slow bus must not hold 500 locks.
    dbModule.runAfterDbContextCommit('agreement-request.expired.emit', () => Promise.all(events.map((e) => emitAgreementEvent(e))));
  } catch (err) {
    console.error('[AgreementRequestExpiryReaper] Failed to publish agreement.expired events:', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }

  if (flipped.length === MAX_REAP_PER_RUN) {
    console.warn(`[AgreementRequestExpiryReaper] Hit ${MAX_REAP_PER_RUN}-item cap — backlog may be growing`);
  }
  return flipped.length;
}

function createWorker(): Worker<ReaperJobData> {
  return new Worker<ReaperJobData>(
    QUEUE_NAME,
    async (_job: Job<ReaperJobData>) => {
      try {
        const reaped = await runWithSystemDbAccess(() => expireAgreementRequests());
        if (reaped > 0) {
          console.log(`[AgreementRequestExpiryReaper] Expired ${reaped} agreement request(s)`);
        }
        return { reaped };
      } catch (err) {
        console.error('[AgreementRequestExpiryReaper] Run failed:', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();
  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  await queue.add(
    JOB_NAME,
    { type: JOB_NAME, queuedAt: new Date().toISOString() },
    {
      jobId: bullmqJobId(QUEUE_NAME),
      repeat: { every: REAP_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeAgreementRequestExpiryReaper(): Promise<void> {
  if (reaperWorker) return;
  reaperWorker = createWorker();
  attachWorkerObservability(reaperWorker, 'agreementRequestExpiryReaper');
  reaperWorker.on('error', (error) => {
    console.error('[AgreementRequestExpiryReaper] Worker error:', error);
    captureException(error);
  });
  reaperWorker.on('failed', (job, error) => {
    console.error(`[AgreementRequestExpiryReaper] Job ${job?.id} failed:`, error);
    captureException(error);
  });
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await reaperWorker.close();
    reaperWorker = null;
    throw err;
  }
  console.log('[AgreementRequestExpiryReaper] Initialized');
}

export async function shutdownAgreementRequestExpiryReaper(): Promise<void> {
  const worker = reaperWorker;
  const queue = reaperQueue;
  reaperWorker = null;
  reaperQueue = null;
  if (worker) {
    try { await worker.close(); } catch (err) { console.error('[AgreementRequestExpiryReaper] Error closing worker:', err); }
  }
  if (queue) {
    try { await queue.close(); } catch (err) { console.error('[AgreementRequestExpiryReaper] Error closing queue:', err); }
  }
}
