/**
 * Tool catalog W04 (#5219), plan Task A8 — the flow run reconciler.
 *
 * Every wake in the flow runner is fire-and-forget (an enqueue after commit),
 * so each one has a sweep behind it. Every 60 s, at most
 * FLOW_RUN_RECONCILE_LIMIT rows per clause, each SELECT … FOR UPDATE SKIP
 * LOCKED in its own short system transaction, and the enqueues only after it
 * ends (never a queue round trip inside a transaction, #1105):
 *
 *  (a) `queued` runs untouched for 2 minutes — a lost creation enqueue;
 *  (b) `awaiting_approval` runs whose parked step's intent is terminal — a
 *      lost terminal-intent wake (services/flows/wake.ts);
 *  (c) `running` runs whose lease expired — a dead slice. The new slice
 *      takes the expired lease; the stalled-row rule decides retry vs
 *      `unknown_outcome`, and the dead slice's late checkpoint fails on the
 *      token;
 *  (d) `waiting` runs 2 minutes past `wake_at` — a lost timed wake;
 *  (e) when this deployment no longer delivers events durably (Decision 10),
 *      every enabled event-triggered flow is paused
 *      `event_dispatch_not_durable` (also once at worker start).
 *
 * Enqueues are idempotent: `enqueueFlowRunSlice` keys the job by
 * (run, resume_seq) and reuses a pending job, so a reconcile racing a real
 * wake collapses onto one slice.
 */
import { Job, Queue, Worker } from 'bullmq';
import { sql, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { isFlowEventDeliveryDurable } from '../services/flowValidator';
import { pauseFlow } from '../services/flows/versions';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { enqueueFlowRunSlice } from './flowRunQueue';
import { attachWorkerObservability } from './workerObservability';

const LOG = '[FlowRunReconciler]';
const QUEUE_NAME = 'flow-run-reconcile';
const JOB_NAME = 'flow-run-reconcile';
const REPEAT_JOB_ID = 'flow-run-reconcile';
const EVERY_MS = 60_000;

export const FLOW_RUN_RECONCILE_LIMIT = 500;

export interface FlowRunReconcileSummary {
  queued: number;
  awaitingApproval: number;
  leaseExpired: number;
  overdueWaits: number;
  pausedEventFlows: number;
  enqueueFailures: number;
}

function inFreshSystemTx<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

async function selectIds(query: SQL, label: string): Promise<string[]> {
  const rows = await inFreshSystemTx(() => db.execute(query), label);
  return (rows as unknown as Array<{ id: string }>).map((r) => r.id);
}

const LIMIT = sql.raw(String(FLOW_RUN_RECONCILE_LIMIT));

/** (a) */
const queuedStale = (): SQL => sql`
  SELECT id FROM flow_runs
  WHERE status = 'queued' AND updated_at < now() - interval '2 minutes'
  ORDER BY updated_at
  LIMIT ${LIMIT} FOR UPDATE SKIP LOCKED`;

/** (b) */
const awaitingWithTerminalIntent = (): SQL => sql`
  SELECT r.id FROM flow_runs r
  JOIN flow_run_steps s ON s.run_id = r.id AND s.org_id = r.org_id
  JOIN action_intents i ON i.id = s.action_intent_id AND i.requesting_flow_run_id = r.id
  WHERE r.status = 'awaiting_approval'
    AND s.status = 'awaiting_approval'
    AND i.status IN ('completed', 'failed', 'rejected', 'expired', 'cancelled')
  LIMIT ${LIMIT} FOR UPDATE OF r SKIP LOCKED`;

/** (c) — a `running` run always holds a lease; a missing pair is treated as expired. */
const runningLeaseExpired = (): SQL => sql`
  SELECT id FROM flow_runs
  WHERE status = 'running' AND (lease_expires_at < now() OR lease_token IS NULL)
  ORDER BY updated_at
  LIMIT ${LIMIT} FOR UPDATE SKIP LOCKED`;

/** (d) */
const waitingOverdue = (): SQL => sql`
  SELECT id FROM flow_runs
  WHERE status = 'waiting' AND wake_at < now() - interval '2 minutes'
  ORDER BY wake_at
  LIMIT ${LIMIT} FOR UPDATE SKIP LOCKED`;

/** (e) */
const enabledEventFlows = (): SQL => sql`
  SELECT id FROM flows
  WHERE status = 'enabled' AND definition->'trigger'->>'type' = 'event'
  LIMIT ${LIMIT} FOR UPDATE SKIP LOCKED`;

async function enqueueAll(ids: string[], summary: FlowRunReconcileSummary): Promise<void> {
  for (const runId of ids) {
    try {
      await enqueueFlowRunSlice(runId);
    } catch (err) {
      summary.enqueueFailures += 1;
      console.error(`${LOG} enqueue failed (run=${runId})`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

/** Clause (e) alone; also run once at worker start. Returns how many flows were paused. */
export async function pauseEventFlowsIfNotDurable(): Promise<number> {
  if (isFlowEventDeliveryDurable()) return 0;
  // Select under SKIP LOCKED, then pause after that transaction ends:
  // pauseFlow opens its own and must not run while this one holds the rows.
  const flowIds = await selectIds(enabledEventFlows(), 'flowRunReconciler.eventFlows');
  let paused = 0;
  for (const flowId of flowIds) {
    try {
      await pauseFlow(flowId, 'event_dispatch_not_durable');
      paused += 1;
    } catch (err) {
      console.error(`${LOG} pause failed (flow=${flowId})`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }
  if (paused > 0) console.warn(`${LOG} paused ${paused} event flow(s): event delivery is not durable on this deployment`);
  return paused;
}

export async function reconcileFlowRuns(): Promise<FlowRunReconcileSummary> {
  const summary: FlowRunReconcileSummary = {
    queued: 0, awaitingApproval: 0, leaseExpired: 0, overdueWaits: 0, pausedEventFlows: 0, enqueueFailures: 0,
  };
  const clauses: Array<[keyof Omit<FlowRunReconcileSummary, 'pausedEventFlows' | 'enqueueFailures'>, () => SQL]> = [
    ['queued', queuedStale],
    ['awaitingApproval', awaitingWithTerminalIntent],
    ['leaseExpired', runningLeaseExpired],
    ['overdueWaits', waitingOverdue],
  ];
  for (const [key, query] of clauses) {
    const ids = await selectIds(query(), `flowRunReconciler.${key}`);
    summary[key] = ids.length;
    await enqueueAll(ids, summary);
  }
  summary.pausedEventFlows = await pauseEventFlowsIfNotDurable();
  const acted = summary.queued + summary.awaitingApproval + summary.leaseExpired + summary.overdueWaits + summary.pausedEventFlows;
  if (acted > 0) console.log(`${LOG} pass`, summary);
  return summary;
}

// ── BullMQ wiring ───────────────────────────────────────────────────────────

let queue: Queue | null = null;
let worker: Worker | null = null;

function getQueue(): Queue {
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  return queue;
}

export async function initializeFlowRunReconciler(): Promise<void> {
  if (worker) return;
  worker = new Worker(
    QUEUE_NAME,
    // Not wrapped in a DB context: each clause opens its own short one.
    async (_job: Job) => reconcileFlowRuns(),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
  attachWorkerObservability(worker, 'flowRunReconciler');
  const q = getQueue();
  for (const job of await q.getRepeatableJobs()) await q.removeRepeatableByKey(job.key);
  await q.add(JOB_NAME, {}, {
    jobId: REPEAT_JOB_ID,
    repeat: { every: EVERY_MS },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 50 },
  });
  // Decision 10: re-check at start, not only on the first tick.
  try {
    await pauseEventFlowsIfNotDurable();
  } catch (err) {
    console.error(`${LOG} start-up event delivery check failed`, err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
  console.log(`${LOG} initialized`);
}

export async function shutdownFlowRunReconciler(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (queue) { await queue.close(); queue = null; }
}

export const __testOnly = { QUEUE_NAME, JOB_NAME, REPEAT_JOB_ID, EVERY_MS };
