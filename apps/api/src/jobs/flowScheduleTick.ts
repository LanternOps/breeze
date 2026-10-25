/**
 * Tool catalog W04 (#5219), plan Task A9 — the schedule trigger.
 *
 * One global repeatable (`flow-schedule-tick`, every 60 s) scans the enabled
 * schedule flows — the aiAgentSweepScheduler.ts shape: a fixed tick over the
 * table, never a per-flow Redis repeatable to keep in sync.
 *
 * Per flow (its LIVE publication's cron + timezone):
 *  1. `latestCronOccurrence` within 24 h — missed fires are not back-filled;
 *     only the latest occurrence ever fires;
 *  2. skip when that key equals `schedule_last_occurrence_key` (already
 *     fired; also how a DST fall-back hour fires once — the key is the LOCAL
 *     wall clock) or the occurrence is before `enabled_at` (enable stamps the
 *     current occurrence too);
 *  3. target orgs: the flow's org, or for a partner-wide flow every live org
 *     of the partner (`loadPartnerOrgIds`: active/trial, not quick_support,
 *     not the holding org, not deleted, capped at 500);
 *  4. `createFlowRun` per org with dedupe `schedule:<key>` — the dedupe
 *     constraint makes a re-fire of the same occurrence a per-org no-op;
 *  5. ONLY when every org returned created / duplicate / flow_queue_full,
 *     CAS `schedule_last_occurrence_key = key WHERE … IS NOT DISTINCT FROM
 *     <the key read>`. Any other failure leaves the key unadvanced, so the
 *     next tick retries the same occurrence and fills only the orgs that
 *     missed (quorum Q3: the sweeper's catch-and-continue would silently drop
 *     that org's fire). `flow_queue_full` is handled, not retried: logged and
 *     counted (`flow_schedule_admission_refused_total`).
 * Inserts first, CAS second (the sweeper's jobId-then-claim order): a crash
 * between them re-fires the same occurrence next tick, which dedupe absorbs.
 *
 * Flag off ⇒ the tick does nothing (the worker still runs, so flipping
 * FLOWS_ENABLED back on resumes without a restart).
 */
import { Job, Queue, Worker } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { flowsEnabled } from '../config/env';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { flowVersions } from '../db/schema/flowRuns';
import { flows } from '../db/schema/flows';
import { latestCronOccurrence } from '../services/aiAgents/sweepOccurrence';
import { recordFlowScheduleAdmissionRefused } from '../services/flows/flowTriggerMetrics';
import { nullFlowInputs } from '../services/flows/inputDefaults';
import { createFlowRun } from '../services/flows/runService';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { loadPartnerOrgIds } from './aiAgentSweepScheduler';
import { attachWorkerObservability } from './workerObservability';

const LOG = '[FlowScheduleTick]';
const QUEUE_NAME = 'flow-schedule-tick';
const JOB_NAME = 'flow-schedule-tick';
const REPEAT_JOB_ID = 'flow-schedule-tick';
const EVERY_MS = 60_000;

export interface FlowScheduleTickResult {
  /** Runs created this tick. */
  fired: number;
  /** Flows with nothing to fire (no occurrence in 24 h, already fired, before enable, malformed trigger). */
  skipped: number;
}

interface ScheduleFlowRow {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  enabledAt: Date | null;
  scheduleLastOccurrenceKey: string | null;
  trigger: unknown;
  inputs: unknown;
}

function system<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

function loadScheduleFlows(): Promise<ScheduleFlowRow[]> {
  return system(
    async () => db
      .select({
        id: flows.id,
        orgId: flows.orgId,
        partnerId: flows.partnerId,
        enabledAt: flows.enabledAt,
        scheduleLastOccurrenceKey: flows.scheduleLastOccurrenceKey,
        trigger: sql<unknown>`${flowVersions.definition}->'trigger'`,
        inputs: sql<unknown>`${flowVersions.definition}->'inputs'`,
      })
      .from(flows)
      .innerJoin(flowVersions, and(eq(flowVersions.flowId, flows.id), eq(flowVersions.publicationSeq, flows.enabledPublicationSeq)))
      .where(and(eq(flows.status, 'enabled'), sql`${flowVersions.definition}->'trigger'->>'type' = 'schedule'`)),
    'flowScheduleTick.flows',
  );
}

function scheduleOf(trigger: unknown): { cron: string; timezone: string } | null {
  if (!trigger || typeof trigger !== 'object') return null;
  const t = trigger as { type?: unknown; cron?: unknown; timezone?: unknown };
  if (t.type !== 'schedule' || typeof t.cron !== 'string' || typeof t.timezone !== 'string') return null;
  return { cron: t.cron, timezone: t.timezone };
}

async function targetOrgs(flow: ScheduleFlowRow): Promise<string[]> {
  if (flow.orgId) return [flow.orgId];
  if (!flow.partnerId) return [];
  const partnerId = flow.partnerId;
  const { orgIds, capped } = await system(() => loadPartnerOrgIds(partnerId), 'flowScheduleTick.partnerOrgs');
  if (capped > 0) {
    console.error(`${LOG} partner-wide flow ${flow.id}: partner ${partnerId} has ${capped} live org(s) past the fan-out cap; they are not scheduled`);
  }
  return orgIds;
}

/** Fire one flow's latest occurrence across its orgs. Returns runs created and whether the key was advanced. */
async function fireFlow(flow: ScheduleFlowRow, occurrence: { at: Date; key: string }): Promise<number> {
  const orgIds = await targetOrgs(flow);
  const inputs = nullFlowInputs(flow.inputs);
  let created = 0;
  let allHandled = true;
  for (const orgId of orgIds) {
    try {
      const result = await createFlowRun({
        triggerKind: 'schedule',
        flowId: flow.id,
        orgId,
        scope: { firedAt: occurrence.at.toISOString() },
        inputs,
        dedupeKey: `schedule:${occurrence.key}`,
      });
      if (result.created) {
        created += 1;
      } else if (result.reason === 'flow_queue_full') {
        console.warn(`${LOG} active-run cap reached: flow ${flow.id} occurrence ${occurrence.key} not started in org ${orgId}`);
        recordFlowScheduleAdmissionRefused();
      } else if (result.reason === 'not_enabled') {
        // Disabled or paused mid-tick: nothing more to fire, and no stamp.
        return created;
      }
    } catch (err) {
      allHandled = false;
      console.error(`${LOG} run creation failed (flow=${flow.id}, org=${orgId}, occurrence=${occurrence.key}); retried next tick`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }
  if (!allHandled) return created;

  const previous = flow.scheduleLastOccurrenceKey;
  await system(
    async () => db
      .update(flows)
      .set({ scheduleLastOccurrenceKey: occurrence.key })
      .where(and(eq(flows.id, flow.id), sql`${flows.scheduleLastOccurrenceKey} IS NOT DISTINCT FROM ${previous}`)),
    'flowScheduleTick.stamp',
  );
  return created;
}

export async function processFlowScheduleTick(now: Date = new Date()): Promise<FlowScheduleTickResult> {
  const result: FlowScheduleTickResult = { fired: 0, skipped: 0 };
  if (!flowsEnabled()) return result;

  for (const flow of await loadScheduleFlows()) {
    const schedule = scheduleOf(flow.trigger);
    let occurrence: { at: Date; key: string } | null = null;
    try {
      occurrence = schedule ? latestCronOccurrence(schedule.cron, schedule.timezone, now) : null;
    } catch (err) {
      console.error(`${LOG} flow ${flow.id}: schedule could not be evaluated`, err);
    }
    if (
      !occurrence
      || occurrence.key === flow.scheduleLastOccurrenceKey
      || (flow.enabledAt && occurrence.at.getTime() < new Date(flow.enabledAt).getTime())
    ) {
      result.skipped += 1;
      continue;
    }
    try {
      result.fired += await fireFlow(flow, occurrence);
    } catch (err) {
      // One flow's org enumeration or stamp failing never starves the others.
      console.error(`${LOG} flow ${flow.id} occurrence ${occurrence.key} failed; retried next tick`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }
  if (result.fired > 0) console.log(`${LOG} tick`, result);
  return result;
}

// ── BullMQ wiring ───────────────────────────────────────────────────────────

let queue: Queue | null = null;
let worker: Worker | null = null;

function getQueue(): Queue {
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  return queue;
}

export async function initializeFlowScheduleTick(): Promise<void> {
  if (worker) return;
  worker = new Worker(
    QUEUE_NAME,
    // Not wrapped in a DB context: every read and write opens its own short one.
    async (_job: Job) => processFlowScheduleTick(),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
  attachWorkerObservability(worker, 'flowScheduleTick');
  const q = getQueue();
  for (const job of await q.getRepeatableJobs()) await q.removeRepeatableByKey(job.key);
  await q.add(JOB_NAME, {}, {
    jobId: REPEAT_JOB_ID,
    repeat: { every: EVERY_MS },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 50 },
  });
  console.log(`${LOG} initialized`);
}

export async function shutdownFlowScheduleTick(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (queue) { await queue.close(); queue = null; }
}

export const __testOnly = { QUEUE_NAME, JOB_NAME, REPEAT_JOB_ID, EVERY_MS };
