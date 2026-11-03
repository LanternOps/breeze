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
 *      `event_dispatch_not_durable` (also once at worker start);
 *  (f) W06 (#5221) B4, Decision 7: the flow of a REVERTED legacy-Job
 *      conversion becomes `disabled` once the revert is older than
 *      LEGACY_DRAIN_MIN_MS and the flow has drained — no non-terminal run and
 *      no open intent. One statement; it cancels nothing (a revert closed the
 *      flow's admission at once; this only retires the drained flow).
 *
 * Each clause runs in its own try/catch, so one failing clause never starves
 * the rest; any clause, enqueue or pause failure then fails the pass as a
 * whole (FlowRunReconcileError), so the job is visibly red rather than a
 * silent partial success.
 *
 * Enqueues are idempotent: `enqueueFlowRunSlice` keys the job by
 * (run, resume_seq) and reuses a pending job, so a reconcile racing a real
 * wake collapses onto one slice.
 */
import { Job, Queue, Worker } from 'bullmq';
import { sql, type SQL } from 'drizzle-orm';
import { LEGACY_DRAIN_MIN_MS } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { isFlowEventDeliveryDurable } from '../services/flowValidator';
import { requestLikeFromSnapshot, writeAuditEvent } from '../services/auditEvents';
import { TERMINAL_FLOW_RUN_STATUSES } from '../services/flows/runStore';
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
  /** (f) reverted conversions' flows disabled after draining. */
  disabledRevertedFlows: number;
  enqueueFailures: number;
  pauseFailures: number;
}

/**
 * A pass that hit any failure. Every clause still ran; `summary` is what the
 * pass did get done and `errors` the clause failures (enqueue and pause
 * failures are counted in the summary and reported per row).
 */
export class FlowRunReconcileError extends AggregateError {
  readonly summary: FlowRunReconcileSummary;

  constructor(errors: unknown[], summary: FlowRunReconcileSummary) {
    super(
      errors,
      `${LOG} pass failed: ${errors.length} clause error(s), ${summary.enqueueFailures} enqueue failure(s), ${summary.pauseFailures} pause failure(s)`,
    );
    this.name = 'FlowRunReconcileError';
    this.summary = summary;
  }
}

interface ReconcileRow {
  id: string;
  org_id?: string | null;
  flow_id?: string | null;
  partner_id?: string | null;
}

/** Sentry tags with the absent ids left out. */
function flowTags(tags: Record<string, string | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) if (typeof v === 'string' && v) out[k] = v;
  return out;
}

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

function inFreshSystemTx<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

async function selectRows(query: SQL, label: string): Promise<ReconcileRow[]> {
  const rows = await inFreshSystemTx(() => db.execute(query), label);
  return rows as unknown as ReconcileRow[];
}

const LIMIT = sql.raw(String(FLOW_RUN_RECONCILE_LIMIT));

// The run clauses select org_id and flow_id beside the id only so a failed
// enqueue can be reported against its run; nothing acts on them.

/** (a) */
const queuedStale = (): SQL => sql`
  SELECT id, org_id, flow_id FROM flow_runs
  WHERE status = 'queued' AND updated_at < now() - interval '2 minutes'
  ORDER BY updated_at
  LIMIT ${LIMIT} FOR UPDATE SKIP LOCKED`;

/** (b) */
const awaitingWithTerminalIntent = (): SQL => sql`
  SELECT r.id, r.org_id, r.flow_id FROM flow_runs r
  JOIN flow_run_steps s ON s.run_id = r.id AND s.org_id = r.org_id
  JOIN action_intents i ON i.id = s.action_intent_id AND i.requesting_flow_run_id = r.id
  WHERE r.status = 'awaiting_approval'
    AND s.status = 'awaiting_approval'
    AND i.status IN ('completed', 'failed', 'rejected', 'expired', 'cancelled')
  LIMIT ${LIMIT} FOR UPDATE OF r SKIP LOCKED`;

/** (c) — a `running` run always holds a lease; a missing pair is treated as expired. */
const runningLeaseExpired = (): SQL => sql`
  SELECT id, org_id, flow_id FROM flow_runs
  WHERE status = 'running' AND (lease_expires_at < now() OR lease_token IS NULL)
  ORDER BY updated_at
  LIMIT ${LIMIT} FOR UPDATE SKIP LOCKED`;

/** (d) */
const waitingOverdue = (): SQL => sql`
  SELECT id, org_id, flow_id FROM flow_runs
  WHERE status = 'waiting' AND wake_at < now() - interval '2 minutes'
  ORDER BY wake_at
  LIMIT ${LIMIT} FOR UPDATE SKIP LOCKED`;

/** (e) */
const enabledEventFlows = (): SQL => sql`
  SELECT id, org_id, partner_id FROM flows
  WHERE status = 'enabled' AND definition->'trigger'->>'type' = 'event'
  LIMIT ${LIMIT} FOR UPDATE SKIP LOCKED`;

/** The intent statuses after which nothing more happens (clause b's list). */
const TERMINAL_INTENT_STATUSES = sql.raw(`'completed', 'failed', 'rejected', 'expired', 'cancelled'`);
const TERMINAL_RUN_STATUSES = sql.raw(TERMINAL_FLOW_RUN_STATUSES.map((st) => `'${st}'`).join(', '));
const DRAIN_INTERVAL = sql.raw(`interval '${LEGACY_DRAIN_MIN_MS} milliseconds'`);

/**
 * (f) One statement: pick (SKIP LOCKED) the live flows of reverted
 * generations older than LEGACY_DRAIN_MIN_MS with no non-terminal run and no
 * open intent, and disable them — `enabled_publication_seq` and the pause
 * reason cleared as disableFlow clears them, and NOTHING else written: no run,
 * step or intent is touched. Holding the flow row lock, no run can be
 * admitted in between (createFlowRun locks the flow FOR SHARE, and refuses a
 * reverted generation's flow anyway), so "drained" cannot go stale.
 */
const drainedRevertedFlows = (): SQL => sql`
  WITH drained AS (
    SELECT f.id, fac.id AS conversion_id FROM flows f
    JOIN flow_automation_conversions fac ON fac.flow_id = f.id
    WHERE fac.state = 'reverted'
      AND fac.revert_at < now() - ${DRAIN_INTERVAL}
      AND f.status IN ('enabled', 'paused')
      AND NOT EXISTS (SELECT 1 FROM flow_runs r WHERE r.flow_id = f.id AND r.status NOT IN (${TERMINAL_RUN_STATUSES}))
      AND NOT EXISTS (
        SELECT 1 FROM action_intents i JOIN flow_runs r ON r.id = i.requesting_flow_run_id
        WHERE r.flow_id = f.id AND i.status NOT IN (${TERMINAL_INTENT_STATUSES}))
    ORDER BY fac.revert_at
    LIMIT ${LIMIT} FOR UPDATE OF f SKIP LOCKED
  )
  UPDATE flows SET status = 'disabled', enabled_publication_seq = NULL, paused_reason = NULL, updated_at = now()
  FROM drained WHERE flows.id = drained.id
  RETURNING flows.id, flows.org_id, flows.partner_id, flows.name, drained.conversion_id`;

export interface DisabledRevertedFlow {
  id: string;
  org_id: string | null;
  partner_id: string | null;
  name: string;
  conversion_id: string;
}

/**
 * Clause (f) alone (exported for the integration suite). A failing statement
 * throws; the audit of each disabled flow is best effort.
 */
export async function disableDrainedRevertedFlows(): Promise<DisabledRevertedFlow[]> {
  const rows = (await inFreshSystemTx(() => db.execute(drainedRevertedFlows()), 'flowRunReconciler.revertedFlows')) as unknown as DisabledRevertedFlow[];
  for (const row of rows) {
    try {
      writeAuditEvent(requestLikeFromSnapshot({}), {
        orgId: row.org_id,
        ...(row.org_id ? {} : { partnerId: row.partner_id }),
        actorType: 'system',
        action: 'flow.disable',
        resourceType: 'flow',
        resourceId: row.id,
        resourceName: row.name,
        result: 'success',
        details: { reason: 'flow_conversion_reverted_drained', conversionId: row.conversion_id },
      });
    } catch (err) {
      console.error(`${LOG} audit of disabled reverted flow ${row.id} failed`, err);
    }
  }
  if (rows.length > 0) console.log(`${LOG} disabled ${rows.length} drained flow(s) of reverted conversions`);
  return rows;
}

async function enqueueAll(rows: ReconcileRow[], summary: FlowRunReconcileSummary): Promise<void> {
  for (const row of rows) {
    try {
      await enqueueFlowRunSlice(row.id);
    } catch (err) {
      summary.enqueueFailures += 1;
      console.error(`${LOG} enqueue failed (run=${row.id} flow=${row.flow_id ?? '?'} org=${row.org_id ?? '?'})`, err);
      // Fingerprinted: a Redis outage fails every row of every 60 s pass.
      captureException(
        asError(err),
        undefined,
        flowTags({ org_id: row.org_id, flow_id: row.flow_id, flow_run_id: row.id, flow_site: 'reconciler.enqueue' }),
        { fingerprint: ['flow', 'reconciler.enqueue'] },
      );
    }
  }
}

export interface PauseEventFlowsResult {
  paused: number;
  failures: number;
}

/**
 * Clause (e) alone; also run once at worker start. A failing SELECT throws; a
 * failing per-flow pause is reported and counted, and the others still pause.
 */
export async function pauseEventFlowsIfNotDurable(): Promise<PauseEventFlowsResult> {
  if (isFlowEventDeliveryDurable()) return { paused: 0, failures: 0 };
  // Select under SKIP LOCKED, then pause after that transaction ends:
  // pauseFlow opens its own and must not run while this one holds the rows.
  const flowRows = await selectRows(enabledEventFlows(), 'flowRunReconciler.eventFlows');
  let paused = 0;
  let failures = 0;
  for (const flow of flowRows) {
    try {
      await pauseFlow(flow.id, 'event_dispatch_not_durable');
      paused += 1;
    } catch (err) {
      failures += 1;
      console.error(`${LOG} pause failed (flow=${flow.id} org=${flow.org_id ?? '-'} partner=${flow.partner_id ?? '-'})`, err);
      // Fingerprinted: a flow that cannot be paused fails again every 60 s.
      captureException(
        asError(err),
        undefined,
        flowTags({ org_id: flow.org_id, partner_id: flow.partner_id, flow_id: flow.id, flow_site: 'reconciler.pause_event_flow' }),
        { fingerprint: ['flow', 'reconciler.pause_event_flow'] },
      );
    }
  }
  if (paused > 0) console.warn(`${LOG} paused ${paused} event flow(s): event delivery is not durable on this deployment`);
  return { paused, failures };
}

type RunClauseKey = 'queued' | 'awaitingApproval' | 'leaseExpired' | 'overdueWaits';

/** Each clause's Sentry `flow_site` (tag and fingerprint) is a fixed literal. */
const RUN_CLAUSES: ReadonlyArray<readonly [RunClauseKey, () => SQL, string]> = [
  ['queued', queuedStale, 'reconciler.queued'],
  ['awaitingApproval', awaitingWithTerminalIntent, 'reconciler.awaiting_approval'],
  ['leaseExpired', runningLeaseExpired, 'reconciler.lease_expired'],
  ['overdueWaits', waitingOverdue, 'reconciler.overdue_waits'],
];

export async function reconcileFlowRuns(): Promise<FlowRunReconcileSummary> {
  const summary: FlowRunReconcileSummary = {
    queued: 0, awaitingApproval: 0, leaseExpired: 0, overdueWaits: 0, pausedEventFlows: 0, disabledRevertedFlows: 0,
    enqueueFailures: 0, pauseFailures: 0,
  };
  const errors: unknown[] = [];
  const clauseFailed = (err: unknown, site: string): void => {
    errors.push(err);
    console.error(`${LOG} clause failed (${site})`, err);
    captureException(asError(err), undefined, { flow_site: site }, { fingerprint: ['flow', site] });
  };

  for (const [key, query, site] of RUN_CLAUSES) {
    try {
      const rows = await selectRows(query(), `flowRunReconciler.${key}`);
      summary[key] = rows.length;
      await enqueueAll(rows, summary);
    } catch (err) {
      clauseFailed(err, site);
    }
  }
  try {
    const { paused, failures } = await pauseEventFlowsIfNotDurable();
    summary.pausedEventFlows = paused;
    summary.pauseFailures = failures;
  } catch (err) {
    clauseFailed(err, 'reconciler.event_flows');
  }
  try {
    summary.disabledRevertedFlows = (await disableDrainedRevertedFlows()).length;
  } catch (err) {
    clauseFailed(err, 'reconciler.reverted_flows');
  }

  const failed = errors.length > 0 || summary.enqueueFailures > 0 || summary.pauseFailures > 0;
  const acted = summary.queued + summary.awaitingApproval + summary.leaseExpired + summary.overdueWaits + summary.pausedEventFlows
    + summary.disabledRevertedFlows;
  if (failed) {
    console.error(
      `${LOG} pass failed: ${errors.length} clause error(s), ${summary.enqueueFailures} enqueue failure(s) (retried next pass), ${summary.pauseFailures} pause failure(s)`,
      summary,
    );
    throw new FlowRunReconcileError(errors, summary);
  }
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
    captureException(asError(err), undefined, { flow_site: 'reconciler.startup_event_flows' }, {
      fingerprint: ['flow', 'reconciler.startup_event_flows'],
    });
  }
  console.log(`${LOG} initialized`);
}

export async function shutdownFlowRunReconciler(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (queue) { await queue.close(); queue = null; }
}

export const __testOnly = { QUEUE_NAME, JOB_NAME, REPEAT_JOB_ID, EVERY_MS };
