/**
 * Hourly trust-page refresh: re-derives every published page's snapshot
 * (hash-deduped, revision-checked in refreshPublishedPage), rebuilds the Redis
 * serving set from the DB so it self-heals, and prunes non-current snapshots
 * older than 90 days.
 */
import { Queue, Worker } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { extractRowCount } from '../db/rowCount';
import { trustPages, partners } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { refreshPublishedPage } from '../services/trustPage/publication';
import { rebuildServingSetFromDb } from '../services/trustPage/servingSet';
import { livePublicationPredicate } from '../services/trustPage/predicate';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';

const LOG_PREFIX = '[TrustPageSnapshot]';
const QUEUE_NAME = 'trust-page-snapshot';
const PRUNE_AFTER_DAYS = 90;

let queue: Queue | null = null;
let worker: Worker | null = null;

export interface TrustPageSweepSummary {
  pages: number;
  rebuilt: number;
  failed: number;
  pruned: number;
  servingMembers: number;
  durationMs: number;
}

export async function runTrustPageSnapshotSweepOnce(now: Date = new Date()): Promise<TrustPageSweepSummary> {
  const startedAt = Date.now();
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({ pageId: trustPages.id })
      .from(trustPages)
      .innerJoin(partners, eq(partners.id, trustPages.partnerId))
      .where(livePublicationPredicate()),
  )) as Array<{ pageId: string }>;

  const summary: TrustPageSweepSummary = { pages: rows.length, rebuilt: 0, failed: 0, pruned: 0, servingMembers: 0, durationMs: 0 };
  for (const r of rows) {
    try {
      if ((await refreshPublishedPage(r.pageId)).rebuilt) summary.rebuilt += 1;
    } catch (err) {
      // One page's failure must not stop the sweep.
      summary.failed += 1;
      console.error(`${LOG_PREFIX} refresh failed for page ${r.pageId}:`, err);
      captureException(err);
    }
  }

  // Self-heal the serving set from the DB (one query, atomic swap).
  try {
    summary.servingMembers = await rebuildServingSetFromDb();
  } catch (err) {
    console.error(`${LOG_PREFIX} serving-set rebuild failed:`, err);
    captureException(err);
  }

  try {
    const res = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db.execute(sql`DELETE FROM trust_page_snapshots WHERE NOT is_current AND generated_at < ${now.toISOString()}::timestamptz - make_interval(days => ${PRUNE_AFTER_DAYS})`)));
    summary.pruned = extractRowCount(res);
  } catch (err) {
    console.error(`${LOG_PREFIX} prune failed:`, err);
    captureException(err);
  }

  summary.durationMs = Date.now() - startedAt;
  if (summary.pages > 0 || summary.pruned > 0) {
    console.log(`${LOG_PREFIX} refreshed ${summary.pages} pages (rebuilt=${summary.rebuilt}, failed=${summary.failed}), serving=${summary.servingMembers}, pruned ${summary.pruned} snapshots in ${summary.durationMs}ms`);
  }
  return summary;
}

export function getTrustPageSnapshotQueue(): Queue {
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  return queue;
}

export async function initializeTrustPageSnapshotWorker(): Promise<void> {
  worker = new Worker(QUEUE_NAME, () => runTrustPageSnapshotSweepOnce(), {
    connection: getBullMQConnection(),
    concurrency: 1,
    lockDuration: 600_000,
  });
  attachWorkerObservability(worker, 'trustPageSnapshotWorker');
  worker.on('error', (error) => {
    console.error(`${LOG_PREFIX} Worker error:`, error);
    captureException(error);
  });

  // Until the serving set exists every card request answers 503, so build it at
  // boot rather than waiting for the first scheduled sweep. Must not fail init.
  try {
    await rebuildServingSetFromDb();
  } catch (err) {
    console.error(`${LOG_PREFIX} initial serving-set build failed:`, err);
    captureException(err);
  }

  const q = getTrustPageSnapshotQueue();
  for (const job of await q.getRepeatableJobs()) await q.removeRepeatableByKey(job.key);
  await q.add('sweep', {}, {
    repeat: { pattern: jobSchedule('trust-page-snapshot') },
    removeOnComplete: { count: 5 },
    removeOnFail: { count: 10 },
  });
  console.log(`${LOG_PREFIX} worker initialized`);
}

export async function shutdownTrustPageSnapshotWorker(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (queue) { await queue.close(); queue = null; }
}
