/**
 * fix-outcome sweeper (AI Suggested Fixes W1). Every 5 minutes:
 *   1. advance every active fix_outcomes row (authoritative path — event
 *      delivery defaults to in-process best-effort, EVENT_DISPATCH_MODE=off);
 *   2. recompute aggregates whose attempts were re-voted or terminalised by the
 *      inline script hook (scriptTerminalHook.ts sets recount_requested_at);
 *   3. mark owner drift (script re-scoped) stale;
 *   4. rebuild stale partners and partners with a pending org-erasure rebuild
 *      request (fix_memory.rebuild_pending_org_ids). This is the RETRY for a
 *      tenant-erasure rebuild that failed or never ran. The request is cleared
 *      only by a rebuild that saw the erased org's organizations row already
 *      gone, so a rebuild that races the cascade cannot satisfy it.
 * Each outcome advances in its OWN system transaction, so one bad row cannot
 * poison the batch. Sub-hourly repeat: no scheduleRegistry slot needed.
 */
import { Queue, Worker, type Job } from 'bullmq';
import { asc, inArray } from 'drizzle-orm';
import { FIX_OUTCOME_ACTIVE_STATES } from '@breeze/shared';
import { db } from '../db';
import { fixOutcomes } from '../db/schema';
import { inSystemDbContext } from '../services/outcomeProbes';
import { advanceOutcome } from '../services/fixMemory/outcomeWatcher';
import {
  markOwnerDriftStale, rebuildFixMemory, recomputeForOutcome, recountRequestedOutcomeIds, stalePartnerIds,
} from '../services/fixMemory/store';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'fix-outcome-sweep';
const JOB_NAME = 'sweep-fix-outcomes';
const INTERVAL_MS = 5 * 60_000;
const MAX_OUTCOMES_PER_RUN = 500;
const MAX_RECOUNTS_PER_RUN = 200;
const MAX_REBUILDS_PER_RUN = 20;

type SweepJobData = { type: typeof JOB_NAME; queuedAt: string };

export interface FixOutcomeSweepStats { scanned: number; errors: number; recounted: number; drifted: number; rebuilt: number }

let sweepQueue: Queue<SweepJobData> | null = null;
let sweepWorker: Worker<SweepJobData> | null = null;

function report(scope: string, id: string, err: unknown): void {
  console.error(`[FixOutcomeSweep] ${scope} failed for ${id}:`, err);
  captureException(err instanceof Error ? err : new Error(String(err)));
}

export async function runFixOutcomeSweep(now: Date = new Date()): Promise<FixOutcomeSweepStats> {
  const ids = await inSystemDbContext(async () => {
    const found = await db.select({ id: fixOutcomes.id }).from(fixOutcomes)
      .where(inArray(fixOutcomes.state, [...FIX_OUTCOME_ACTIVE_STATES]))
      .orderBy(asc(fixOutcomes.deadlineAt))
      .limit(MAX_OUTCOMES_PER_RUN);
    return found.map((r) => r.id);
  }, 'fixOutcomeSweep.select');

  let errors = 0;
  for (const id of ids) {
    try { await advanceOutcome(id, { now }); } catch (err) { errors += 1; report('advance', id, err); }
  }

  let recounted = 0;
  const recountIds = await inSystemDbContext(() => recountRequestedOutcomeIds(MAX_RECOUNTS_PER_RUN), 'fixOutcomeSweep.recountSelect');
  for (const id of recountIds) {
    try { await inSystemDbContext(() => recomputeForOutcome(id, now), 'fixOutcomeSweep.recount'); recounted += 1; } catch (err) { report('recount', id, err); }
  }

  const drifted = await inSystemDbContext(() => markOwnerDriftStale(now), 'fixOutcomeSweep.drift');

  let rebuilt = 0;
  const partners = await inSystemDbContext(() => stalePartnerIds(MAX_REBUILDS_PER_RUN), 'fixOutcomeSweep.staleSelect');
  for (const partnerId of partners) {
    try { await inSystemDbContext(() => rebuildFixMemory({ partnerId }, now), 'fixOutcomeSweep.rebuild'); rebuilt += 1; } catch (err) { report('rebuild', partnerId, err); }
  }

  if (ids.length === MAX_OUTCOMES_PER_RUN) console.warn(`[FixOutcomeSweep] hit the ${MAX_OUTCOMES_PER_RUN}-row cap — backlog may be growing`);
  return { scanned: ids.length, errors, recounted, drifted, rebuilt };
}

function getQueue(): Queue<SweepJobData> {
  if (!sweepQueue) sweepQueue = new Queue<SweepJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  return sweepQueue;
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();
  for (const job of await queue.getRepeatableJobs()) {
    if (job.name === JOB_NAME) await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(JOB_NAME, { type: JOB_NAME, queuedAt: new Date().toISOString() }, {
    jobId: QUEUE_NAME, repeat: { every: INTERVAL_MS },
    removeOnComplete: { count: 20 }, removeOnFail: { count: 200 },
  });
}

export async function initializeFixOutcomeWorker(): Promise<void> {
  if (sweepWorker) return;
  sweepWorker = new Worker<SweepJobData>(QUEUE_NAME, async (_job: Job<SweepJobData>) => runFixOutcomeSweep(), {
    connection: getBullMQConnection(), concurrency: 1,
  });
  attachWorkerObservability(sweepWorker, 'fixOutcomeWorker');
  sweepWorker.on('error', (error) => { console.error('[FixOutcomeSweep] Worker error:', error); captureException(error); });
  sweepWorker.on('failed', (job, error) => { console.error(`[FixOutcomeSweep] Job ${job?.id} failed:`, error); captureException(error); });
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await sweepWorker.close();
    sweepWorker = null;
    throw err;
  }
  console.log(`[FixOutcomeSweep] Initialized (every ${INTERVAL_MS / 60_000}m)`);
}

export async function shutdownFixOutcomeWorker(): Promise<void> {
  const worker = sweepWorker;
  const queue = sweepQueue;
  sweepWorker = null;
  sweepQueue = null;
  if (worker) { try { await worker.close(); } catch (err) { console.error('[FixOutcomeSweep] Error closing worker:', err); } }
  if (queue) { try { await queue.close(); } catch (err) { console.error('[FixOutcomeSweep] Error closing queue:', err); } }
}
