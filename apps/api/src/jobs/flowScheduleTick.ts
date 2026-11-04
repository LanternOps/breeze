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
 *  3. target orgs: the flow's org when it is live (`liveOrgCondition`:
 *     active/trial, not deleted — a suspended or deleted org's own flows stop
 *     firing; its occurrence is consumed, not retried), or for a partner-wide
 *     flow every live org of the partner (`loadPartnerOrgIds`: also not
 *     quick_support, not the holding org; capped at 500);
 *  4. `createFlowRun` per org with dedupe `schedule:<key>` — the dedupe
 *     constraint makes a re-fire of the same occurrence a per-org no-op;
 *  5. ONLY when every org returned created / duplicate / flow_queue_full,
 *     CAS `schedule_last_occurrence_key = key WHERE … IS NOT DISTINCT FROM
 *     <the key read>`. Any other failure leaves the key unadvanced, so the
 *     next tick retries the same occurrence and fills only the orgs that
 *     missed (quorum Q3: the sweeper's catch-and-continue would silently drop
 *     that org's fire). `flow_queue_full` is handled, not retried: logged
 *     (warn, flow + org) and counted (`flow_schedule_admission_refused_total`).
 *     `not_enabled` (disabled / re-published mid-fan-out) ends the flow's
 *     fan-out unstamped and is logged at error with a capture.
 * A schedule that cannot be evaluated (malformed trigger, unknown timezone) is
 * skipped and logged at error every tick; it is captured once per process.
 * Inserts first, CAS second (the sweeper's jobId-then-claim order): a crash
 * between them re-fires the same occurrence next tick, which dedupe absorbs.
 *
 * Flag off ⇒ the tick does nothing (the worker still runs, so flipping
 * FLOWS_ENABLED back on resumes without a restart).
 *
 * Converted-flow mode (#5221 B5, plan Decision 6) — ONLY for a flow converted
 * from a legacy Job (it has a `flow_automation_conversions` row); every other
 * flow is exactly the W04 tick above:
 *  - a generation that is not `switched` (reverted; shadow cannot be enabled)
 *    admits nothing new: it never evaluates its cron, claims or reports —
 *    legacy owns its occurrences again (Decision 7). The one exception is
 *    execution of what it already admitted: the newest occurrence it
 *    parent-claimed while switched, not yet stamped, keeps W04's retry of
 *    unfinished orgs until stamped (`finishRevertedOccurrence`); createFlowRun
 *    lets exactly those children through by reading the claim itself;
 *  - the occurrence key is the UTC minute (`occurrenceKey.schedule` without
 *    its prefix, e.g. `2027-01-09T03:00Z`), as legacy keys it, so a DST
 *    repeated hour fires twice like the legacy Job did. The cursor holds that
 *    key and children dedupe on `schedule:<key>` (the W04 namespace; it is the
 *    claim key verbatim). Enable stamps a LOCAL key, which never equals a UTC
 *    one, so the stamp can never consume an occurrence here; the `enabled_at`
 *    skip covers what it was for;
 *  - an occurrence legacy prefers (`legacyPrefers`: before `switch_at`) is
 *    left alone — not claimed, not run, not stamped — so the engines are
 *    complementary on the same instant by construction;
 *  - otherwise the tick claims the PARENT occurrence (`claimOccurrence`,
 *    engine `flow`, no flow run, the automation's owner axis) before any
 *    child. A conflict with anything but its own parent claim (legacy won, or
 *    pre-claim legacy history) consumes the occurrence without a run: the key
 *    is stamped. Its own parent claim (engine `flow`, `flow_run_id` and
 *    `legacy_run_id` NULL — the only claim with no run; children never claim)
 *    is a retried tick: the fan-out continues and W04's dedupe fills only the
 *    orgs that missed;
 *  - a revert landing mid-fan-out does not stop it: the remaining children
 *    still run (their parent claim holds), and the parent claim keeps legacy
 *    off that occurrence. A child refused `flow_conversion_reverted` anyway
 *    (claim not visible) is an error, retried next tick, unstamped.
 */
import { Job, Queue, Worker } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { flowsEnabled } from '../config/env';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { flowAutomationConversions } from '../db/schema/flowConversions';
import { flowVersions } from '../db/schema/flowRuns';
import { flows } from '../db/schema/flows';
import { organizations } from '../db/schema/orgs';
import { SWEEP_OCCURRENCE_LOOKBACK_MINUTES, latestCronOccurrence } from '../services/aiAgents/sweepOccurrence';
import { isFlowAdmissionRefusal, occurrenceKey, type FlowConversionState } from '@breeze/shared';
import { claimOccurrence, legacyPrefers, newestParentScheduleClaim } from '../services/flows/conversion/claims';
import { recordFlowScheduleAdmissionRefused } from '../services/flows/flowTriggerMetrics';
import { nullFlowInputs } from '../services/flows/inputDefaults';
import { createFlowRun } from '../services/flows/runService';
import { liveOrgCondition } from '../services/partnerFanoutOrgs';
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
  /** #5221 B5: the flow's conversion (one per flow, `flow_automation_conversions_flow_uq`); all null for a plain flow. */
  conversionId: string | null;
  conversionState: FlowConversionState | null;
  conversionSwitchAt: Date | null;
  conversionAutomationId: string | null;
  conversionOrgId: string | null;
  conversionPartnerId: string | null;
}

/** The generation a converted flow came from: what the parent claim and the switch_at gate need. */
interface FlowConversion {
  id: string;
  state: FlowConversionState;
  switchAt: Date | null;
  automationId: string;
  orgId: string | null;
  partnerId: string | null;
}

function conversionOf(flow: ScheduleFlowRow): FlowConversion | null {
  if (!flow.conversionId || !flow.conversionState || !flow.conversionAutomationId) return null;
  return {
    id: flow.conversionId,
    state: flow.conversionState,
    switchAt: flow.conversionSwitchAt ? new Date(flow.conversionSwitchAt) : null,
    automationId: flow.conversionAutomationId,
    orgId: flow.conversionOrgId ?? null,
    partnerId: flow.conversionPartnerId ?? null,
  };
}

const CLAIM_KEY_PREFIX = 'schedule:';

/** A converted flow's occurrence key: the UTC minute (`2027-01-09T03:00Z`); `schedule:<key>` is its claim key. */
function utcOccurrenceKey(at: Date): string {
  return occurrenceKey.schedule(at).slice(CLAIM_KEY_PREFIX.length);
}

function system<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

/** Sentry with the flow tags the scrubber keeps and a bounded fingerprint (a literal site). */
function report(err: unknown, site: string, flow: { id: string; orgId: string | null }, orgId?: string): void {
  const tags: Record<string, string> = { flow_id: flow.id, flow_site: site };
  const org = orgId ?? flow.orgId;
  if (org) tags.org_id = org;
  captureException(err instanceof Error ? err : new Error(String(err)), undefined, tags, { fingerprint: ['flow', site] });
}

/** Unevaluable schedules already captured by this process (flow + cron + tz): logged every tick, captured once. */
const reportedUnevaluable = new Set<string>();

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
        conversionId: flowAutomationConversions.id,
        conversionState: flowAutomationConversions.state,
        conversionSwitchAt: flowAutomationConversions.switchAt,
        conversionAutomationId: flowAutomationConversions.automationId,
        conversionOrgId: flowAutomationConversions.orgId,
        conversionPartnerId: flowAutomationConversions.partnerId,
      })
      .from(flows)
      .innerJoin(flowVersions, and(eq(flowVersions.flowId, flows.id), eq(flowVersions.publicationSeq, flows.enabledPublicationSeq)))
      .leftJoin(flowAutomationConversions, eq(flowAutomationConversions.flowId, flows.id))
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
  if (flow.orgId) {
    const orgId = flow.orgId;
    const live = await system(
      async () => db
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(eq(organizations.id, orgId), liveOrgCondition()))
        .limit(1),
      'flowScheduleTick.orgLiveness',
    );
    if (live.length === 0) {
      console.log(`${LOG} flow ${flow.id}: org ${orgId} is not live (suspended, churned or deleted); the occurrence is skipped`);
      return [];
    }
    return [orgId];
  }
  if (!flow.partnerId) return [];
  const partnerId = flow.partnerId;
  const { orgIds, capped } = await system(() => loadPartnerOrgIds(partnerId), 'flowScheduleTick.partnerOrgs');
  if (capped > 0) {
    console.error(`${LOG} partner-wide flow ${flow.id}: partner ${partnerId} has ${capped} live org(s) past the fan-out cap; they are not scheduled`);
  }
  return orgIds;
}

/**
 * #5221 B5 — the parent claim of a converted flow's occurrence, before any
 * child. True when the flow owns it (just claimed, or its own parent claim
 * from an earlier, unfinished tick); false when another admission won.
 */
async function claimParentOccurrence(flow: ScheduleFlowRow, conversion: FlowConversion, occurrence: { at: Date; key: string }): Promise<boolean> {
  const claim = await system(
    () => claimOccurrence(db, {
      automationId: conversion.automationId,
      owner: { orgId: conversion.orgId, partnerId: conversion.partnerId },
      keys: [occurrenceKey.schedule(occurrence.at)],
      engine: 'flow',
      conversionId: conversion.id,
      occurrenceAt: occurrence.at,
    }),
    'flowScheduleTick.parentClaim',
  );
  if (claim.ok) return true;
  const { engine, flowRunId, legacyRunId } = claim.existing;
  // Only this tick writes a flow claim without a run (children never claim).
  if (engine === 'flow' && flowRunId === null && legacyRunId === null) return true;
  console.log(
    `${LOG} converted flow ${flow.id}: occurrence ${occurrence.key} was already admitted by the ${engine} engine `
    + `(legacy run ${legacyRunId ?? '-'}, flow run ${flowRunId ?? '-'}); consumed without a run`,
  );
  return false;
}

/** CAS the cursor from the key that was read (`IS NOT DISTINCT FROM`): a concurrent stamp wins. */
async function stampOccurrence(flow: ScheduleFlowRow, key: string): Promise<void> {
  const previous = flow.scheduleLastOccurrenceKey;
  await system(
    async () => db
      .update(flows)
      .set({ scheduleLastOccurrenceKey: key })
      .where(and(eq(flows.id, flow.id), sql`${flows.scheduleLastOccurrenceKey} IS NOT DISTINCT FROM ${previous}`)),
    'flowScheduleTick.stamp',
  );
}

/**
 * Fire one flow's latest occurrence across its orgs. Returns runs created and whether the key was advanced.
 * `parentHeld`: the occurrence's parent claim is already this generation's
 * (a reverted flow finishing what it admitted) — never claim again.
 */
async function fireFlow(
  flow: ScheduleFlowRow,
  occurrence: { at: Date; key: string },
  conversion: FlowConversion | null,
  opts: { parentHeld?: boolean } = {},
): Promise<number> {
  if (conversion && !opts.parentHeld && !(await claimParentOccurrence(flow, conversion, occurrence))) {
    await stampOccurrence(flow, occurrence.key);
    return 0;
  }
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
      } else if (isFlowAdmissionRefusal(result.reason)) {
        // Active-run cap or a monthly cap (W5): handled, the key still advances
        // (a capped occurrence is not retried; the flow is not paused).
        console.warn(`${LOG} admission refused (${result.reason}): flow ${flow.id} occurrence ${occurrence.key} not started in org ${orgId}`);
        recordFlowScheduleAdmissionRefused(result.reason);
      } else if (result.reason === 'not_enabled') {
        // Disabled, paused or re-published mid-tick: nothing more to fire, and
        // no stamp. Loud, because it also ends the fan-out for every org after
        // this one.
        const remaining = orgIds.length - orgIds.indexOf(orgId) - 1;
        console.error(
          `${LOG} flow ${flow.id} is no longer enabled at org ${orgId} (occurrence ${occurrence.key}); `
          + `fan-out stopped with ${remaining} org(s) not attempted, key not advanced`,
        );
        report(new Error('flow schedule fan-out stopped: flow not enabled'), 'schedule_tick.not_enabled_mid_fanout', flow, orgId);
        return created;
      } else if (result.reason === 'flow_conversion_reverted') {
        // #5221 B5: a child of a parent-claimed occurrence runs even after a
        // revert (createFlowRun reads the claim). A refusal means the claim
        // was not visible: an error, retried next tick like a failed insert.
        allHandled = false;
        console.error(
          `${LOG} converted flow ${flow.id}: child run refused flow_conversion_reverted at org ${orgId} `
          + `(occurrence ${occurrence.key}) although the tick holds its parent claim; retried next tick`,
        );
        report(new Error('flow schedule child refused: conversion reverted without a visible parent claim'),
          'schedule_tick.child_refused_reverted', flow, orgId);
      }
    } catch (err) {
      allHandled = false;
      console.error(`${LOG} run creation failed (flow=${flow.id}, org=${orgId}, occurrence=${occurrence.key}); retried next tick`, err);
      report(err, 'schedule_tick.create_run', flow, orgId);
    }
  }
  if (!allHandled) return created;

  await stampOccurrence(flow, occurrence.key);
  return created;
}

/**
 * #5221 B5 (Decision 7) — a reverted generation's flow claims nothing new,
 * but an occurrence it parent-claimed while switched was ADMITTED: its per-org
 * children are execution and still run. The newest such claim (within the
 * W04 24 h lookback) that the cursor has not stamped gets W04's retry of the
 * unfinished orgs until it is stamped. Returns runs created; counts a skip
 * when there is nothing to finish.
 */
async function finishRevertedOccurrence(
  flow: ScheduleFlowRow,
  conversion: FlowConversion,
  now: Date,
  result: FlowScheduleTickResult,
): Promise<number> {
  if (conversion.state !== 'reverted') {
    result.skipped += 1;
    return 0;
  }
  const since = new Date(now.getTime() - SWEEP_OCCURRENCE_LOOKBACK_MINUTES * 60_000);
  const held = await system(
    () => newestParentScheduleClaim(db, { id: conversion.id, automationId: conversion.automationId }, since),
    'flowScheduleTick.revertedParentClaim',
  );
  const key = held ? held.key.slice(CLAIM_KEY_PREFIX.length) : null;
  if (!held || !key || key === flow.scheduleLastOccurrenceKey) {
    result.skipped += 1;
    return 0;
  }
  return fireFlow(flow, { at: held.at, key }, conversion, { parentHeld: true });
}

export async function processFlowScheduleTick(now: Date = new Date()): Promise<FlowScheduleTickResult> {
  const result: FlowScheduleTickResult = { fired: 0, skipped: 0 };
  if (!flowsEnabled()) return result;

  for (const flow of await loadScheduleFlows()) {
    const conversion = conversionOf(flow);
    if (conversion && conversion.state !== 'switched') {
      // #5221 B5: a reverted generation's flow attempts nothing new — it only
      // finishes an occurrence it parent-claimed before the revert.
      try {
        result.fired += await finishRevertedOccurrence(flow, conversion, now, result);
      } catch (err) {
        console.error(`${LOG} reverted converted flow ${flow.id}: finishing its admitted occurrence failed; retried next tick`, err);
        report(err, 'schedule_tick.fire_flow', flow);
      }
      continue;
    }
    const schedule = scheduleOf(flow.trigger);
    let occurrence: { at: Date; key: string } | null = null;
    let unevaluable: unknown = schedule ? null : new Error('malformed schedule trigger');
    if (schedule) {
      try {
        occurrence = latestCronOccurrence(schedule.cron, schedule.timezone, now);
      } catch (err) {
        unevaluable = err;
      }
    }
    if (unevaluable) {
      // Never fires until the flow is fixed: loud every tick, captured once.
      console.error(
        `${LOG} flow ${flow.id} (org=${flow.orgId ?? 'partner-wide'}, partner=${flow.partnerId ?? '-'}): schedule could not be evaluated; it does not fire`,
        unevaluable,
      );
      const memo = `${flow.id}|${schedule?.cron ?? ''}|${schedule?.timezone ?? ''}`;
      if (!reportedUnevaluable.has(memo)) {
        reportedUnevaluable.add(memo);
        report(unevaluable, 'schedule_tick.cron_unevaluable', flow);
      }
    }
    // #5221 B5: a converted flow keys the UTC minute.
    if (occurrence && conversion) occurrence = { at: occurrence.at, key: utcOccurrenceKey(occurrence.at) };
    if (
      !occurrence
      || occurrence.key === flow.scheduleLastOccurrenceKey
      || (flow.enabledAt && occurrence.at.getTime() < new Date(flow.enabledAt).getTime())
      // #5221 B5: an occurrence legacy prefers (before switch_at) is legacy's
      // alone — not claimed, not run, not stamped.
      || (conversion && legacyPrefers(conversion, occurrence.at, false))
    ) {
      result.skipped += 1;
      continue;
    }
    try {
      result.fired += await fireFlow(flow, occurrence, conversion);
    } catch (err) {
      // One flow's org enumeration or stamp failing never starves the others.
      console.error(`${LOG} flow ${flow.id} occurrence ${occurrence.key} failed; retried next tick`, err);
      report(err, 'schedule_tick.fire_flow', flow);
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
