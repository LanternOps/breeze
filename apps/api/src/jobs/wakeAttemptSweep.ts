import { Queue, Worker } from 'bullmq';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices } from '../db/schema/devices';
import { deviceWakeAttempts, deviceWakeStatus, type WakeAttemptOutcome } from '../db/schema/deviceWake';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { WAKE_OUTCOME_WINDOW_MS } from '../services/wakeAttempts';
import { attachWorkerObservability } from './workerObservability';

export const WAKE_ATTEMPT_GRACE_MS = 2 * 60_000;
const QUEUE_NAME = 'wake-attempt-sweep';
const LOG_PREFIX = '[WakeAttemptSweep]';

type Attempt = Pick<typeof deviceWakeAttempts.$inferSelect, 'requestedAt' | 'deadlineAt' | 'outcome'>;

export function classifyWakeAttempt(
  attempt: Attempt,
  device: { lastSeenAt: Date | null },
  now: Date,
): WakeAttemptOutcome | null {
  if (attempt.outcome !== 'pending' && attempt.outcome !== 'sent') return null;
  const deadline = attempt.deadlineAt?.getTime() ?? attempt.requestedAt.getTime() + WAKE_OUTCOME_WINDOW_MS;
  const seen = device.lastSeenAt !== null && device.lastSeenAt >= attempt.requestedAt;
  if (seen) return now.getTime() > deadline + WAKE_ATTEMPT_GRACE_MS ? 'unknown' : 'came_online';
  if (now.getTime() < deadline) return null;
  return attempt.outcome === 'sent' ? 'timed_out' : 'send_failed';
}

function inFreshSystemContext<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

// Keep the literal predicate aligned with the partial deadline index.
const openOutcome = sql`${deviceWakeAttempts.outcome} IN ('pending', 'sent')`;

export async function resolveOpenWakeAttempts(clock: () => Date = () => new Date(), batchSize = 500): Promise<{ resolved: number }> {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('batchSize must be a positive integer');
  let resolved = 0;
  let afterId: string | undefined;
  // Keyset pagination visits every eligible row once, including when a row
  // fails to finalise. A failed row cannot starve later batches.
  for (;;) {
    const candidates = await inFreshSystemContext('wakeAttemptSweep.select', () => {
      const now = clock();
      const cursor = afterId ? gt(deviceWakeAttempts.id, afterId) : undefined;
      // Separate the deadline range from the heartbeat join so the due branch
      // can use device_wake_attempts_deadline_idx. UNION deduplicates attempts
      // that are both due and seen.
      const due = db.select({ id: deviceWakeAttempts.id }).from(deviceWakeAttempts)
        .where(and(openOutcome, cursor, lte(deviceWakeAttempts.deadlineAt, now)));
      const seen = db.select({ id: deviceWakeAttempts.id }).from(deviceWakeAttempts)
        .innerJoin(devices, and(eq(devices.id, deviceWakeAttempts.deviceId), eq(devices.orgId, deviceWakeAttempts.orgId)))
        .where(and(openOutcome, cursor, sql`${devices.lastSeenAt} >= ${deviceWakeAttempts.requestedAt}`));
      // Open rows normally carry a deadline. Preserve the canonical window
      // for a legacy/incomplete row instead of leaving it open forever.
      const missingDeadline = db.select({ id: deviceWakeAttempts.id }).from(deviceWakeAttempts)
        .where(and(openOutcome, cursor,
          sql`${deviceWakeAttempts.deadlineAt} IS NULL AND ${deviceWakeAttempts.requestedAt} <= ${new Date(now.getTime() - WAKE_OUTCOME_WINDOW_MS).toISOString()}::timestamptz`));
      return due.union(seen).union(missingDeadline).orderBy(sql`id`).limit(batchSize);
    });

    if (candidates.length === 0) break;
    for (const candidate of candidates) {
      try {
        const finalized = await inFreshSystemContext('wakeAttemptSweep.resolve', async () => {
          // Re-read after selection: a device move cascades org_id and a delete
          // cascades the attempt; neither should poison the rest of the batch.
          const [row] = await db.select({ attempt: deviceWakeAttempts, lastSeenAt: devices.lastSeenAt, uptimeSeconds: devices.uptimeSeconds })
            .from(deviceWakeAttempts)
            .innerJoin(devices, and(eq(devices.id, deviceWakeAttempts.deviceId), eq(devices.orgId, deviceWakeAttempts.orgId)))
            .where(and(eq(deviceWakeAttempts.id, candidate.id), openOutcome));
          if (!row) return false;
          const now = clock();
          const outcome = classifyWakeAttempt(row.attempt, row, now);
          if (!outcome) return false;
          const bootAfterSend = outcome === 'came_online' && row.lastSeenAt !== null && row.uptimeSeconds !== null
            && row.lastSeenAt.getTime() - row.uptimeSeconds * 1000 >= row.attempt.requestedAt.getTime();
          const [closed] = await db.update(deviceWakeAttempts).set({
            outcome, resolvedAt: now, ...(outcome === 'came_online' ? { bootAfterSend } : {}),
          }).where(and(eq(deviceWakeAttempts.id, candidate.id), eq(deviceWakeAttempts.orgId, row.attempt.orgId),
            // Match the observed open state too: a concurrent relay result from
            // pending to sent must be classified afresh on the next run.
            eq(deviceWakeAttempts.outcome, row.attempt.outcome), openOutcome))
            .returning({ deviceId: deviceWakeAttempts.deviceId, orgId: deviceWakeAttempts.orgId });
          if (!closed) return false;
          if (outcome === 'came_online') {
            await db.insert(deviceWakeStatus).values({ ...closed, lastCameOnlineAt: now, proofFingerprint: null, consecutiveTimeouts: 0, updatedAt: now })
              .onConflictDoUpdate({ target: deviceWakeStatus.deviceId, set: {
                lastCameOnlineAt: now, proofFingerprint: sql`${deviceWakeStatus.fingerprint}`, consecutiveTimeouts: 0, updatedAt: now,
              } });
          } else if (outcome === 'timed_out') {
            await db.insert(deviceWakeStatus).values({ ...closed, consecutiveTimeouts: 1, updatedAt: now })
              .onConflictDoUpdate({ target: deviceWakeStatus.deviceId, set: {
                consecutiveTimeouts: sql`${deviceWakeStatus.consecutiveTimeouts} + 1`, updatedAt: now,
              } });
          }
          return true;
        });
        if (finalized) resolved += 1;
      } catch (error) {
        console.error(`${LOG_PREFIX} Failed to resolve attempt ${candidate.id}:`, error);
        captureException(error);
      }
    }
    afterId = candidates[candidates.length - 1]!.id;
    if (candidates.length < batchSize) break;
  }
  return { resolved };
}

let sweepQueue: Queue | null = null;
let sweepWorker: Worker | null = null;
export function getWakeAttemptSweepQueue(): Queue {
  if (!sweepQueue) sweepQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  return sweepQueue;
}
export function createWakeAttemptSweepWorker(): Worker {
  // Each attempt owns its context; never wrap the whole run in one transaction.
  return new Worker(QUEUE_NAME, async () => resolveOpenWakeAttempts(), {
    connection: getBullMQConnection(), concurrency: 1,
  });
}
export async function initializeWakeAttemptSweep(): Promise<void> {
  try {
    sweepWorker = createWakeAttemptSweepWorker();
    attachWorkerObservability(sweepWorker, 'wakeAttemptSweep');
    sweepWorker.on('error', error => { console.error(`${LOG_PREFIX} Worker error:`, error); captureException(error); });
    sweepWorker.on('failed', (job, error) => { console.error(`${LOG_PREFIX} Job ${job?.id} failed:`, error); captureException(error); });
    await getWakeAttemptSweepQueue().upsertJobScheduler(QUEUE_NAME,
      { every: 60_000 },
      { name: 'sweep', data: {}, opts: { removeOnComplete: { count: 5 }, removeOnFail: { count: 10 } } });
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}
export async function shutdownWakeAttemptSweep(): Promise<void> {
  if (sweepWorker) { await sweepWorker.close(); sweepWorker = null; }
  if (sweepQueue) { await sweepQueue.close(); sweepQueue = null; }
}
