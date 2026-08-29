/**
 * Ungrouped-alert delayed verdict job (Phase 2 wave P2-1 — alert verdicts,
 * task 13).
 *
 * Spec §4.1: an alert that stays open and UNCORRELATED for
 * `UNGROUPED_VERDICT_DELAY_MINUTES` also gets a verdict run, so every alert
 * eventually carries one — not just the two paths task 12's
 * `alertVerdictSubscriber.ts` already covers (folded into a correlation
 * group, or auto-resolved quickly).
 *
 * Triggered from the SAME durable subscriber id as task 12
 * (`ai-agent-alert-verdict`, `eventSubscribers.ts`) — its `eventTypes` is
 * extended with `alert.triggered`, routed to `handleAlertTriggeredEvent`
 * below (controller decision, task 13 brief: do NOT create a second
 * subscriber id).
 *
 * `scheduleUngroupedVerdict` enqueues a single delayed BullMQ job keyed by a
 * STABLE jobId (`alert-verdict-<alertId>`, hyphen-only — BullMQ reserves
 * `:` for the legacy repeatable-job id form, see patchJobExecutor.ts).
 * `queue.add()` with an already-present jobId is a silent BullMQ no-op —
 * that IS the idempotency mechanism here (deliberately simpler than
 * patchJobExecutor.ts's `resolveActiveQueueJob` stale-terminal-job removal
 * dance: `alert.triggered` fires at most once per alert under normal
 * operation, so the only realistic duplicate is a retried event delivery
 * racing an already-scheduled delayed job for the same alertId, which is
 * exactly the case this should no-op on).
 *
 * The processor (fires `UNGROUPED_VERDICT_DELAY_MINUTES` later) re-checks
 * three conditions before admitting a run — the alert may have moved on in
 * the interim:
 *   - still `status === 'active'` (task 12's auto-resolve path already
 *     handles a resolved alert);
 *   - no `alert_correlation_members` row (task 12's group_created path
 *     already handles a since-correlated alert);
 *   - no live verdict yet (`latestVerdictsForAlerts`) — belt-and-suspenders
 *     against a race with either of the other two admission paths.
 * All three are skip conditions, logged at debug and never thrown — a skip
 * is the expected, common outcome (most alerts get correlated or resolved
 * inside the delay window), not a failure. Only a genuine
 * `enqueueVerdictRunForAlert` rejection is allowed to propagate, so BullMQ's
 * job-level retry policy (`attempts: 3`, exponential backoff) applies to
 * real infra failures, not routine skips.
 *
 * Mirrors `jobs/aiUnattendedExposureRetention.ts`'s init/shutdown singleton
 * shape and `jobs/patchJobExecutor.ts`'s stable-jobId delayed `queue.add()`
 * pattern; connection via the shared `getBullMQConnection()` helper
 * (`services/redis.ts`), same as every sibling job.
 */
import { Job, Queue, Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import * as dbModule from '../db';
import { alerts, alertCorrelationMembers } from '../db/schema/alerts';
import { AI_AGENTS_ENABLED } from '../config/env';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';
import { latestVerdictsForAlerts } from '../services/aiAgents/alertVerdicts';
import { enqueueVerdictRunForAlert } from '../services/aiAgents/alertVerdictSubscriber';
import type { BreezeEvent } from '../services/eventBus';

// Minor 5 (P2-1 wave B task 16d): late-bound — `const { db } = dbModule` at
// module scope froze the binding at import time, before a test's
// `vi.mock('../db', ...)` factory could ever be observed (same trap
// `alertVerdictSubscriber.ts` avoids by reading `dbModule.db` inside each
// function instead).
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error(
      '[AlertVerdictScheduler] withSystemDbAccessContext is not available — DB module may not have loaded correctly',
    );
  }
  return dbModule.withSystemDbAccessContext(fn);
};

const QUEUE_NAME = 'ai-agent-verdict-delay';
const JOB_NAME = 'ungrouped-verdict';

/** Spec §4.1: how long an alert must stay open and uncorrelated before it
 *  gets its own (non-group) verdict run. */
export const UNGROUPED_VERDICT_DELAY_MINUTES = 10;

// NOTE: BullMQ rejects a jobId containing ':' — hyphen-only. alertId is
// UUID-shaped (no ':'), so this id stays stable and unique per alert.
function getUngroupedVerdictJobId(alertId: string): string {
  return `alert-verdict-${alertId}`;
}

export interface UngroupedVerdictJobData {
  orgId: string;
  alertId: string;
}

let ungroupedVerdictQueue: Queue<UngroupedVerdictJobData> | null = null;
let ungroupedVerdictWorker: Worker<UngroupedVerdictJobData> | null = null;

export function getUngroupedVerdictQueue(): Queue<UngroupedVerdictJobData> {
  if (!ungroupedVerdictQueue) {
    ungroupedVerdictQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return ungroupedVerdictQueue;
}

/**
 * Schedules the delayed ungrouped-verdict check for one alert. No-op when
 * `!AI_AGENTS_ENABLED` — the platform kill switch — so the delay queue never
 * fills on installs that have agents off (controller decision 4). Called
 * from `handleAlertTriggeredEvent` below.
 */
export async function scheduleUngroupedVerdict(orgId: string, alertId: string): Promise<void> {
  if (!AI_AGENTS_ENABLED) return;

  const queue = getUngroupedVerdictQueue();
  // A silent no-op when this jobId is already queued — see this module's
  // header for why that's the intended idempotency mechanism here.
  await queue.add(
    JOB_NAME,
    { orgId, alertId },
    {
      jobId: getUngroupedVerdictJobId(alertId),
      delay: UNGROUPED_VERDICT_DELAY_MINUTES * 60_000,
      removeOnComplete: true,
      removeOnFail: 50,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
    },
  );
}

/**
 * Registered handler for `alert.triggered` on the `ai-agent-alert-verdict`
 * subscriber (`eventSubscribers.ts`). Extracts `alertId`/`orgId` from the
 * event payload and schedules the delayed check. A malformed event (missing
 * alertId/orgId) is NOT retryable — logged and dropped, never thrown, since
 * redelivery of the same malformed payload would answer the same way (same
 * posture as `alertVerdictSubscriber.ts`'s own malformed-event handling).
 */
export async function handleAlertTriggeredEvent(event: BreezeEvent): Promise<void> {
  const orgId = event.orgId;
  const payload = event.payload as { alertId?: unknown } | null | undefined;
  const alertId = typeof payload?.alertId === 'string' ? payload.alertId : null;
  if (!alertId || !orgId) {
    console.error(
      '[AlertVerdictScheduler] malformed alert.triggered event — missing alertId/orgId, dropping',
      { eventId: event.id, orgId, payload: event.payload },
    );
    return;
  }
  await scheduleUngroupedVerdict(orgId, alertId);
}

interface UngroupedVerdictAlertRow {
  id: string;
  status: string;
}

async function loadAlertForUngroupedVerdict(
  alertId: string,
  orgId: string,
): Promise<UngroupedVerdictAlertRow | null> {
  const { db } = dbModule;
  const [row] = await db
    .select({ id: alerts.id, status: alerts.status })
    .from(alerts)
    .where(and(eq(alerts.id, alertId), eq(alerts.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

async function hasCorrelationMembership(alertId: string, orgId: string): Promise<boolean> {
  const { db } = dbModule;
  const [row] = await db
    .select({ id: alertCorrelationMembers.id })
    .from(alertCorrelationMembers)
    .where(and(eq(alertCorrelationMembers.orgId, orgId), eq(alertCorrelationMembers.alertId, alertId)))
    .limit(1);
  return !!row;
}

/**
 * Processor for a delayed `ungrouped-verdict` job — see this module's
 * header for the three re-check conditions and the retry/skip contract.
 * Runs its own reads under a system DB context (no ambient request context
 * in a background worker); `enqueueVerdictRunForAlert` is called with NO
 * system context active — see `alertVerdictSubscriber.ts`'s header (#1105
 * pool-hold seam) for why nesting there would silently defeat that
 * module's own protection.
 */
export async function processUngroupedVerdictJob(data: UngroupedVerdictJobData): Promise<void> {
  const { orgId, alertId } = data;

  const alert = await runWithSystemDbAccess(() => loadAlertForUngroupedVerdict(alertId, orgId));
  if (!alert) {
    console.debug('[AlertVerdictScheduler] skipping ungrouped verdict — alert not found (or not in org)', {
      alertId, orgId,
    });
    return;
  }
  if (alert.status !== 'active') {
    console.debug('[AlertVerdictScheduler] skipping ungrouped verdict — alert is no longer active', {
      alertId, orgId, status: alert.status,
    });
    return;
  }

  const hasMember = await runWithSystemDbAccess(() => hasCorrelationMembership(alertId, orgId));
  if (hasMember) {
    console.debug('[AlertVerdictScheduler] skipping ungrouped verdict — alert has a correlation-group membership', {
      alertId, orgId,
    });
    return;
  }

  const existingVerdicts = await runWithSystemDbAccess(() => latestVerdictsForAlerts(orgId, [alertId]));
  if (existingVerdicts.has(alertId)) {
    console.debug('[AlertVerdictScheduler] skipping ungrouped verdict — alert already carries a verdict', {
      alertId, orgId,
    });
    return;
  }

  // Called with NO system DB context active — see this function's header.
  await enqueueVerdictRunForAlert(orgId, alertId, 'ungrouped');
}

export function createUngroupedVerdictWorker(): Worker<UngroupedVerdictJobData> {
  return new Worker<UngroupedVerdictJobData>(
    QUEUE_NAME,
    async (job: Job<UngroupedVerdictJobData>) => processUngroupedVerdictJob(job.data),
    { connection: getBullMQConnection(), concurrency: 5 },
  );
}

/**
 * Registers the worker unconditionally — only the PRODUCER side
 * (`scheduleUngroupedVerdict`) is feature-gated (controller decision 4), so
 * flipping the kill switch back on drains any already-queued jobs without
 * needing a process restart, same posture as every other AI-agent worker in
 * the registry.
 */
export async function initializeAlertVerdictScheduler(): Promise<void> {
  ungroupedVerdictWorker = createUngroupedVerdictWorker();
  attachWorkerObservability(ungroupedVerdictWorker, 'alertVerdictScheduler');
  console.log('[AlertVerdictScheduler] Ungrouped-verdict delay worker initialized');
}

export async function shutdownAlertVerdictScheduler(): Promise<void> {
  if (ungroupedVerdictWorker) {
    await ungroupedVerdictWorker.close();
    ungroupedVerdictWorker = null;
  }
  if (ungroupedVerdictQueue) {
    await ungroupedVerdictQueue.close();
    ungroupedVerdictQueue = null;
  }
}
