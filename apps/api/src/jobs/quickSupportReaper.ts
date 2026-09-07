import { Job, Queue, Worker } from 'bullmq';
import { and, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices, supportSessions } from '../db/schema';
import { deleteDeviceCascade, type DeviceDeletionTx } from '../services/deviceDeletion';
import { endSupportSession } from '../services/quickSupportEnd';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';

/**
 * Quick Support reaper — the safety net for ad-hoc support sessions.
 *
 * Every cooperative teardown path (tech clicks End, client sends its own stop,
 * client's dead-man timer fires) can fail: a browser tab closes mid-request, a
 * client process is SIGKILLed, a websocket dies before `support_end` lands.
 * Nothing in this feature may rely on the happy path, because a leaked session
 * leaves an ephemeral, fully-enrolled agent alive on an end user's machine.
 * This job is what guarantees that never happens, no matter what failed.
 *
 * Runs every 5 minutes under the system DB context: `support_sessions` and
 * `devices` are org-scoped RLS but reaping is cross-tenant system work.
 */

const QUEUE_NAME = 'quick-support-reaper';
const JOB_NAME = 'reap';
const REAP_INTERVAL_MS = 5 * 60 * 1000;

/** Client crashed between redeeming the code and finishing enrollment. */
const CLAIMED_LIMBO_MS = 20 * 60 * 1000;
/** Agent heartbeat gap that counts as "the end user closed the client". */
const END_USER_STOP_MS = 5 * 60 * 1000;
/** Grace period before the ephemeral device row itself is destroyed. */
const PURGE_AFTER_ENDED_MS = 6 * 60 * 60 * 1000;

/**
 * Per-pass cap. A single run must stay bounded: passes c/d/e each do several
 * queries per session, so an unnoticed backlog would otherwise turn one tick
 * into an unbounded run that holds a connection and overlaps the next tick.
 * Leftovers are simply picked up 5 minutes later.
 */
const MAX_PER_PASS = 500;

let reaperQueue: Queue | null = null;
let reaperWorker: Worker | null = null;

interface ReaperJobData {
  type: 'reap';
  queuedAt: string;
}

/**
 * One reaper pass. Exported and free of BullMQ so it can be driven directly
 * from tests and from an operator console.
 *
 * A throw from any one session is logged and swallowed: a reaper that dies on
 * a single corrupt row stops protecting every other tenant, which is strictly
 * worse than the bad row itself.
 */
export async function reapOnce(): Promise<void> {
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const now = new Date();

    // (a) EXPIRED CODES — the technician generated a code that nobody ever
    // used. No device exists yet, so there is nothing to tear down; a bulk
    // UPDATE is enough. Safety net for: codes accumulating as usable
    // credentials long after the tech forgot about them.
    await db
      .update(supportSessions)
      .set({ status: 'expired', endedAt: now, endedReason: 'expired' })
      .where(and(
        eq(supportSessions.status, 'pending'),
        lt(supportSessions.codeExpiresAt, now),
      ));

    // (b) CLAIMED LIMBO — the code was redeemed but enrollment never completed,
    // so no device row was ever created. Safety net for: a client that crashed
    // (or was killed by AV) between redeem and enroll, which otherwise leaves
    // the technician's panel stuck on "Client connecting…" for the full 8h
    // hard cap. No device means no teardown, so a bulk UPDATE again.
    await db
      .update(supportSessions)
      .set({ status: 'expired', endedAt: now, endedReason: 'error' })
      .where(and(
        eq(supportSessions.status, 'claimed'),
        isNull(supportSessions.deviceId),
        lt(supportSessions.claimedAt, new Date(now.getTime() - CLAIMED_LIMBO_MS)),
      ));

    // (c) HARD CAP — the absolute ceiling on how long an ad-hoc agent may live.
    // Safety net for: every failure mode not covered by a more specific pass,
    // including a session that stays healthy and connected forever because
    // nobody remembered to end it. Goes through endSupportSession so tokens are
    // revoked and the client is told to self-destruct — never a bare UPDATE.
    const overdue = await db
      .select({ id: supportSessions.id })
      .from(supportSessions)
      .where(and(
        inArray(supportSessions.status, ['claimed', 'ready']),
        lt(supportSessions.hardExpiresAt, now),
      ))
      .limit(MAX_PER_PASS);

    for (const session of overdue) {
      try {
        await endSupportSession(session.id, 'expired');
      } catch (err) {
        console.error(`[QuickSupportReaper] Hard-cap end failed for session ${session.id}:`, err);
      }
    }

    // (d) END-USER STOP — v1 has no explicit stop API, so "the user closed the
    // client" is inferred from the agent going offline and staying offline.
    // Safety net for: an end user who quits the client (or unplugs) while the
    // technician's panel still shows a live session and the credentials remain
    // valid. The 5-minute quiet period keeps a brief network blip from killing
    // a session the user is still in.
    const abandoned = await db
      .select({ id: supportSessions.id })
      .from(supportSessions)
      .innerJoin(devices, eq(devices.id, supportSessions.deviceId))
      .where(and(
        eq(supportSessions.status, 'ready'),
        eq(devices.status, 'offline'),
        lt(devices.lastSeenAt, new Date(now.getTime() - END_USER_STOP_MS)),
      ))
      .limit(MAX_PER_PASS);

    for (const session of abandoned) {
      try {
        await endSupportSession(session.id, 'end_user');
      } catch (err) {
        console.error(`[QuickSupportReaper] End-user stop failed for session ${session.id}:`, err);
      }
    }

    // (e) PURGE — destroy the ephemeral device row once the session has been
    // over long enough to have been reviewed. Safety net for: ephemeral devices
    // outliving their session and polluting the hidden quick-support org (and
    // every device count / license tally derived from it). support_sessions
    // .device_id is ON DELETE SET NULL, so the session row survives as the
    // audit trail after its device is gone.
    const purgeable = await db
      .select({ id: supportSessions.id, deviceId: supportSessions.deviceId })
      .from(supportSessions)
      .where(and(
        inArray(supportSessions.status, ['ended', 'expired']),
        isNotNull(supportSessions.deviceId),
        lt(supportSessions.endedAt, new Date(now.getTime() - PURGE_AFTER_ENDED_MS)),
      ))
      .limit(MAX_PER_PASS);

    for (const session of purgeable) {
      if (!session.deviceId) continue;
      try {
        // SAFETY GUARD: re-read the device and delete ONLY if it is ephemeral.
        // The join above proves the session points at this device; it does NOT
        // prove the device is disposable. A corrupted, mis-linked, or
        // maliciously-crafted session row must never be able to turn this
        // reaper into a delete primitive for a real customer device — a device
        // delete is unrecoverable and cascades across every history table.
        const [device] = await db
          .select({ id: devices.id, isEphemeral: devices.isEphemeral })
          .from(devices)
          .where(eq(devices.id, session.deviceId))
          .limit(1);

        if (!device) continue; // already purged; nothing to do

        if (device.isEphemeral !== true) {
          console.error(
            `[QuickSupportReaper] REFUSING to purge non-ephemeral device ${session.deviceId} ` +
            `referenced by support session ${session.id} — investigate this row`,
          );
          continue;
        }

        // Shared cascade, wrapped in a transaction so a device is never left
        // half-deleted with orphaned children behind an FK.
        await db.transaction(async (tx) => {
          await deleteDeviceCascade(tx as unknown as DeviceDeletionTx, session.deviceId!);
        });
      } catch (err) {
        console.error(`[QuickSupportReaper] Purge failed for session ${session.id}:`, err);
      }
    }
  }));
}

export function getQuickSupportReaperQueue(): Queue {
  if (!reaperQueue) {
    reaperQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return reaperQueue;
}

function createQuickSupportReaperWorker(): Worker<ReaperJobData> {
  return new Worker<ReaperJobData>(
    QUEUE_NAME,
    async (_job: Job<ReaperJobData>) => {
      await reapOnce();
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    },
  );
}

async function scheduleQuickSupportReaperJobs(): Promise<void> {
  const queue = getQuickSupportReaperQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(
    JOB_NAME,
    { type: 'reap', queuedAt: new Date().toISOString() },
    {
      repeat: { every: REAP_INTERVAL_MS },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );
  console.log('[QuickSupportReaper] Scheduled 5-minute Quick Support reaper job');
}

export async function initializeQuickSupportReaper(): Promise<void> {
  try {
    reaperWorker = createQuickSupportReaperWorker();
  attachWorkerObservability(reaperWorker, 'quickSupportReaper');
    reaperWorker.on('error', (error) => console.error('[QuickSupportReaper] Worker error:', error));
    reaperWorker.on('failed', (job, error) => console.error(`[QuickSupportReaper] Job ${job?.id} failed:`, error));
    await scheduleQuickSupportReaperJobs();
    console.log('[QuickSupportReaper] Worker initialized');
  } catch (error) {
    console.error('[QuickSupportReaper] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownQuickSupportReaper(): Promise<void> {
  if (reaperWorker) { await reaperWorker.close(); reaperWorker = null; }
  if (reaperQueue) { await reaperQueue.close(); reaperQueue = null; }
  console.log('[QuickSupportReaper] Worker shut down');
}
