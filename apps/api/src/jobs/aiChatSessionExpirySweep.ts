/**
 * #11430 — 15-minute sweep that retires chat sessions nobody can send to again.
 *
 * Expiry is otherwise lazy: the send pre-flight stamps a session 'expired' only
 * when the next message arrives, and the in-memory eviction (2 h idle) only
 * sees sessions this process holds — an API restart forgets them, leaving rows
 * 'active' for days. A client then resumed one and its first send got a 410,
 * and a Wisp thread whose session never closed was never summarised.
 *
 * Each run stamps up to AI_CHAT_SESSION_EXPIRY_MAX_PER_RUN technician chat
 * sessions past the shared rule (services/aiSessionExpiry.ts: 24 h cap or 2 h
 * idle) 'expired' in system scope, then finalizes their Wisp thread summaries
 * exactly as the eviction path does, after the write has committed.
 *
 * Idempotent: the UPDATE re-applies the whole predicate, so an overlapping run,
 * a retry, or a turn admitted between the SELECT and the UPDATE sweeps nothing
 * twice and expires nothing live. Not gated on Wisp: chat sessions exist
 * without it.
 *
 * The finalize is awaited so a graceful worker close covers it. A summary can
 * include a model call (opt-in per grant), so a large first-run backlog may
 * hold the job past the interval; the next run just starts later.
 */
import { Job, Queue, Worker } from 'bullmq';
import { and, asc, eq, inArray, isNotNull, lt, or } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { aiSessions } from '../db/schema';
import { CHAT_SESSION_TYPES } from '../services/aiChatSessionTypes';
import { finalizeWispSummaries, noTurnInFlight, sessionExpiryCutoffs } from '../services/aiSessionExpiry';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'ai-chat-session-expiry-sweep';
const JOB_NAME = 'expire-idle-chat-sessions';
// Sub-hourly: `every:` per jobs/scheduleRegistry.ts, not a cron pattern.
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
export const AI_CHAT_SESSION_EXPIRY_MAX_PER_RUN = 200;

type SweepJobData = { type: 'expire-idle-chat-sessions'; queuedAt: string };

let sweepQueue: Queue<SweepJobData> | null = null;
let sweepWorker: Worker<SweepJobData> | null = null;

/**
 * One pass. `scanned` is how many stale rows the SELECT found, `expired` how
 * many the guarded UPDATE flipped (and finalized); `capped` means the batch was
 * full and more may be waiting for the next run.
 */
export async function sweepIdleChatSessions(now: Date = new Date()): Promise<{ scanned: number; expired: number; capped: boolean }> {
  const { createdBefore, idleBefore } = sessionExpiryCutoffs(now.getTime());
  // The SQL form of isExpirableChatSession + sessionExpiryReason: an active
  // technician chat session (Helper sessions have no user and their own rule)
  // past the 24 h cap or idle past the eviction window, with no turn running
  // (a turn admitted just inside the window is never cut off mid-answer).
  const stale = and(
    eq(aiSessions.status, 'active'),
    inArray(aiSessions.type, [...CHAT_SESSION_TYPES]),
    isNotNull(aiSessions.userId),
    or(lt(aiSessions.lastActivityAt, idleBefore), lt(aiSessions.createdAt, createdBefore)),
    noTurnInFlight(),
  );

  const { scanned, expiredIds } = await withSystemDbAccessContext(async () => {
    const candidates = await db
      .select({ id: aiSessions.id })
      .from(aiSessions)
      .where(stale)
      .orderBy(asc(aiSessions.lastActivityAt))
      .limit(AI_CHAT_SESSION_EXPIRY_MAX_PER_RUN);
    if (candidates.length === 0) return { scanned: 0, expiredIds: [] as string[] };
    const rows = await db
      .update(aiSessions)
      .set({ status: 'expired', updatedAt: now })
      .where(and(inArray(aiSessions.id, candidates.map((c) => c.id)), stale))
      .returning({ id: aiSessions.id });
    return { scanned: candidates.length, expiredIds: rows.map((r) => r.id) };
  }, 'aiChatSessionExpirySweep.expire');

  // After the system transaction committed, as the eviction path does. Awaited
  // so the job (and a graceful worker close) covers the summaries it started.
  await finalizeWispSummaries(expiredIds);

  const capped = scanned === AI_CHAT_SESSION_EXPIRY_MAX_PER_RUN;
  if (scanned > 0) {
    console.log(`[AiChatSessionExpirySweep] scanned=${scanned} expired=${expiredIds.length}`);
  }
  if (capped) {
    console.warn(`[AiChatSessionExpirySweep] hit the ${AI_CHAT_SESSION_EXPIRY_MAX_PER_RUN}-row cap; the rest wait for the next run`);
  }
  return { scanned, expired: expiredIds.length, capped };
}

function getQueue(): Queue<SweepJobData> {
  if (!sweepQueue) sweepQueue = new Queue<SweepJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  return sweepQueue;
}

async function scheduleSweepJobs(): Promise<void> {
  const queue = getQueue();
  for (const job of await queue.getRepeatableJobs()) {
    await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(
    JOB_NAME,
    { type: 'expire-idle-chat-sessions', queuedAt: new Date().toISOString() },
    {
      repeat: { every: SWEEP_INTERVAL_MS },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );
}

export async function initializeAiChatSessionExpirySweep(): Promise<void> {
  try {
    sweepWorker = new Worker<SweepJobData>(
      QUEUE_NAME,
      async (_job: Job<SweepJobData>) => sweepIdleChatSessions(),
      { connection: getBullMQConnection(), concurrency: 1 },
    );
    attachWorkerObservability(sweepWorker, 'aiChatSessionExpirySweep');
    sweepWorker.on('error', (error) => console.error('[AiChatSessionExpirySweep] Worker error:', error));
    sweepWorker.on('failed', (job, error) => console.error(`[AiChatSessionExpirySweep] Job ${job?.id} failed:`, error));
    await scheduleSweepJobs();
    console.log('[AiChatSessionExpirySweep] Worker initialized');
  } catch (error) {
    console.error('[AiChatSessionExpirySweep] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownAiChatSessionExpirySweep(): Promise<void> {
  if (sweepWorker) { await sweepWorker.close(); sweepWorker = null; }
  if (sweepQueue) { await sweepQueue.close(); sweepQueue = null; }
}
