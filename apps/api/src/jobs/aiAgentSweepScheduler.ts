/**
 * Fixed-tick sweeper for `ai_agent_schedules` (Phase 2 wave P2-2, task 9).
 *
 * Two job shapes on ONE queue (`ai-agent-sweep`):
 *
 *  - `tick` — a repeatable job every `SWEEP_TICK_INTERVAL_MS`. Scans every
 *    ENABLED partner baseline whose agent is enabled, asks
 *    `latestCronOccurrence` for the most recent minute that baseline's cron
 *    was due at, and enqueues ONE `occurrence` job per baseline that has a
 *    new occurrence. Deliberately NOT a per-schedule BullMQ repeatable: a
 *    partner can create, re-cron and delete schedules at will, and keeping a
 *    Redis repeatable in sync with a mutable config table is the class of
 *    problem that produces orphaned repeatables nobody can find. One fixed
 *    tick over the table is always consistent with the table.
 *
 *  - `occurrence` — the fan-out. Re-reads the baseline (it may have been
 *    disabled or deleted, or its agent soft-deleted, since the tick), merges
 *    each org's tighten-only override through `effectiveSchedule`, and admits
 *    one run per org through `createAndEnqueueAgentRun` — `profile: 'sweep'`
 *    for a `kind: 'sweep'` baseline, `profile: 'narrative'` for a
 *    `kind: 'narrative'` one (P2-3, the weekly org narrative). Everything
 *    else about the occurrence — the cadence, the CAS, the org enumeration,
 *    the cap, the skip tally, the aggregate-only `last_run_summary` — is
 *    identical for both kinds.
 *
 * ## Idempotency: jobId first, CAS second
 *
 * The tick's order is load-bearing and must not be "tidied" into a single
 * transaction:
 *
 *   1. compute the occurrence key;
 *   2. skip when it equals `last_occurrence_key` (this tick already ran it);
 *   3. `queue.add('occurrence', …, { jobId })` — `getSweepOccurrenceJobId` is
 *      a pure function of (scheduleId, key), and BullMQ SILENTLY NO-OPS an add
 *      whose jobId is already present;
 *   4. THEN `UPDATE … SET last_occurrence_key = $key WHERE id = $id AND
 *      last_occurrence_key IS NOT DISTINCT FROM $previous` — a compare-and-set
 *      so two replicas ticking together do not both claim the occurrence. Zero
 *      rows updated means the other replica won, which is fine: it added the
 *      same jobId.
 *
 * A crash between (3) and (4) leaves the key unstamped, so the next tick
 * recomputes the SAME key and re-adds the SAME jobId — BullMQ no-ops, the CAS
 * lands. The reverse order (stamp first, add second) would lose the occurrence
 * entirely on the same crash.
 *
 * **The jobId is a cheap first line of defence, NOT the exactly-once guard.**
 * BullMQ only rejects a duplicate id while a job with that id still exists in
 * Redis, so once the completed job ages out of `removeOnComplete` retention the
 * same id can be added again. The durable guarantee is one level down: every
 * run the fan-out admits carries `dedupeKey = sweep-<scheduleId>-<orgId>-<key>`
 * and `ai_agent_runs_org_dedupe_key_uq` is what actually makes a replayed
 * occurrence a no-op (proven against real Postgres in
 * `aiAgentSweepFanout.integration.test.ts`). Retention is nevertheless kept
 * well above one tick interval (`removeOnComplete: { count: 200 }`) so the id
 * survives the window in which a re-add is even plausible.
 *
 * ## Worker shape — one worker, not two (deviation, deliberate)
 *
 * The task brief called for two workers on this queue, "`tick` concurrency 1,
 * `occurrence` concurrency 2". BullMQ workers cannot filter by job NAME —
 * every worker on a queue receives every job on it — so two workers would
 * each have to handle both shapes, and the split would deliver neither a tick
 * singleton nor an occurrence budget: it would be total concurrency 3 under
 * two misleading names. One worker with the same total budget (3) and a
 * name dispatcher is the honest form of the same thing. The tick's
 * single-flight property comes from the repeatable `jobId` plus the CAS
 * above, never from worker concurrency.
 *
 * ## Gating
 *
 * The worker and the repeatable registration are unconditional (the
 * `alertVerdictScheduler.ts` convention): only the PRODUCER — the tick's
 * `queue.add` — is gated on `AI_AGENTS_ENABLED`, so flipping the platform
 * kill switch back on resumes sweeping without a process restart, and an
 * install with agents off never fills the queue. `createAndEnqueueAgentRun`
 * re-checks the same switch at call time, so the occurrence path is covered
 * even for a job that was enqueued before the switch was thrown.
 *
 * Registered in `services/workerRegistry.ts` as `global`. That is NOT an
 * assumption copied from a sibling: `workerEntrypointClosure.contract.test.ts`
 * (the mechanical authority) was run for BOTH values, and this module's
 * runtime import closure reaches neither `routes/agentWs.ts` nor
 * `services/agentCommandAwait.ts`. `alertVerdictScheduler` — same job shape,
 * `socket-owner` placement — reaches them only through
 * `alertVerdictSubscriber` -> `aiToolsOrgs` -> `tenantOffboarding` ->
 * `orgMerge` -> `routes/portal/helpers`, none of which this module imports.
 * The deepest AI dependency here is `createAndEnqueueAgentRun`, which inserts
 * a run row and enqueues; socket dispatch happens later, in `aiAgentRunner`.
 * Do not relitigate the value by reasoning about it — run the tool.
 */
import { Job, Queue, Worker } from 'bullmq';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import type { AiAgentScheduleKind, AiAgentScheduleRunSummary, AiSweepKind } from '@breeze/shared';

// Late-bound namespace import (NOT `const { db } = dbModule`): destructuring
// at module scope freezes the binding at import time, before a test's
// `vi.mock('../db')` factory can be observed. Same idiom as
// `alertVerdictScheduler.ts`.
import * as dbModule from '../db';
import { aiAgentSchedules, aiAgents, organizations } from '../db/schema';
import { envFlag } from '../config/env';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';
import { latestCronOccurrence } from '../services/aiAgents/sweepOccurrence';
import {
  effectiveSchedule,
  resolveEffectiveSchedulesForPartner,
  type ScheduleOverrideSummary,
} from '../services/aiAgents/scheduleService';
import { createAndEnqueueAgentRun } from '../services/aiAgents/runService';

export const AI_AGENT_SWEEP_QUEUE = 'ai-agent-sweep';

/** Fixed scan cadence. Sub-hourly, so it is deliberately OUTSIDE
 *  `scheduleRegistry.JOB_SCHEDULES` (an unused registry slot fails
 *  `scheduleRegistry.contract.test.ts`); the literal lives here so that
 *  suite's AST resolver can read the `repeat: { every: … }` statically. */
export const SWEEP_TICK_INTERVAL_MS = 5 * 60 * 1000;

const TICK_JOB = 'tick';
const OCCURRENCE_JOB = 'occurrence';
const TICK_JOB_ID = 'ai-agent-sweep-tick';

/** The tick lane's budget (1) plus the fan-out lane's (2) — see the header on
 *  why they are not two separate workers. */
const SWEEP_WORKER_CONCURRENCY = 3;

export interface SweepOccurrenceJobData {
  scheduleId: string;
  occurrenceKey: string;
}

type SweepJobData = SweepOccurrenceJobData | Record<string, never>;

/**
 * BullMQ rejects `:` in a jobId (it reserves it for the legacy repeatable-job
 * id form — see `alertVerdictScheduler.ts`), and an occurrence key carries
 * both `:` and `@`. Everything outside `[A-Za-z0-9]` is stripped rather than
 * escaped: the schedule id is already a UUID, so the pair stays unique per
 * (schedule, occurrence) — two DIFFERENT keys for the SAME schedule cannot
 * collide, because stripping only removes the fixed separators from a
 * fixed-width `YYYY-MM-DDTHH:mm@<tz>` shape.
 */
export function getSweepOccurrenceJobId(scheduleId: string, occurrenceKey: string): string {
  return `sweep-occ-${scheduleId}-${occurrenceKey.replace(/[^A-Za-z0-9]/g, '')}`;
}

let sweepQueue: Queue<SweepJobData> | null = null;
let sweepWorker: Worker<SweepJobData> | null = null;

export function getAiAgentSweepQueue(): Queue<SweepJobData> {
  if (!sweepQueue) {
    sweepQueue = new Queue<SweepJobData>(AI_AGENT_SWEEP_QUEUE, { connection: getBullMQConnection() });
  }
  return sweepQueue;
}

/** Late-bound system-context helper — see the `dbModule` note above. */
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error(
      '[AiAgentSweepScheduler] withSystemDbAccessContext is not available — DB module may not have loaded correctly',
    );
  }
  return dbModule.withSystemDbAccessContext(fn);
};

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

interface DueBaselineRow {
  id: string;
  agentId: string;
  partnerId: string | null;
  cron: string;
  timezone: string;
  sweepKinds: AiSweepKind[];
  lastOccurrenceKey: string | null;
}

/**
 * Every enabled PARTNER baseline (`org_id IS NULL`) whose agent is itself
 * enabled and not soft-deleted. Org overrides are deliberately absent: they
 * carry no cadence of their own (their cron/timezone are a copy of the
 * baseline's — see `scheduleService.updateSchedule`), so ticking them would
 * fan the same occurrence out twice.
 */
async function loadDueBaselines(): Promise<DueBaselineRow[]> {
  const { db } = dbModule;
  return db
    .select({
      id: aiAgentSchedules.id,
      agentId: aiAgentSchedules.agentId,
      partnerId: aiAgentSchedules.partnerId,
      cron: aiAgentSchedules.cron,
      timezone: aiAgentSchedules.timezone,
      sweepKinds: aiAgentSchedules.sweepKinds,
      lastOccurrenceKey: aiAgentSchedules.lastOccurrenceKey,
    })
    .from(aiAgentSchedules)
    .innerJoin(aiAgents, eq(aiAgents.id, aiAgentSchedules.agentId))
    .where(and(
      isNull(aiAgentSchedules.orgId),
      eq(aiAgentSchedules.enabled, true),
      eq(aiAgents.enabled, true),
      isNull(aiAgents.disabledAt),
    )) as Promise<DueBaselineRow[]>;
}

/**
 * Claim the occurrence for this schedule. Returns true when THIS replica won.
 *
 * `IS NOT DISTINCT FROM` (not `=`) because the previous key is NULL on a
 * schedule that has never fired, and `NULL = NULL` is NULL — an `=` form would
 * never match a first firing and the key would never be stamped.
 */
async function claimOccurrence(
  scheduleId: string,
  previousKey: string | null,
  nextKey: string,
): Promise<boolean> {
  const { db } = dbModule;
  const rows = await db
    .update(aiAgentSchedules)
    .set({ lastEnqueuedAt: new Date(), lastOccurrenceKey: nextKey, updatedAt: new Date() })
    .where(and(
      eq(aiAgentSchedules.id, scheduleId),
      sql`${aiAgentSchedules.lastOccurrenceKey} IS NOT DISTINCT FROM ${previousKey}::text`,
    ))
    .returning({ id: aiAgentSchedules.id });
  return rows.length > 0;
}

/**
 * One scan of every enabled partner baseline. See this module's header for
 * the add-then-CAS ordering, which is asserted in `aiAgentSweepScheduler.test.ts`.
 *
 * `now` is injectable for tests only; production always passes the real clock.
 */
export async function processSweepTick(now: Date = new Date()): Promise<{ scanned: number; enqueued: number }> {
  // Producer gate — the worker itself stays registered (see the header).
  //
  // Read through `envFlag` at CALL time, never a module-scope
  // `AI_AGENTS_ENABLED` const: the header's "resumes sweeping without a
  // process restart" is only true of a per-call read, and a frozen import
  // would have made that claim quietly false (review fix, #4189). Same
  // helper, same env var, as `runService.createAndEnqueueAgentRun`'s own
  // re-check — one switch, read the same way on both sides of the queue.
  if (!envFlag('BREEZE_AI_AGENTS_ENABLED', false)) return { scanned: 0, enqueued: 0 };

  const baselines = await runWithSystemDbAccess(loadDueBaselines);

  let enqueued = 0;
  for (const baseline of baselines) {
    // Per-baseline error boundary. One partner must never be able to stop the
    // scan for every other partner, and there are two realistic ways it could:
    // an invalid IANA `timezone` on the row makes `isCronDue`'s
    // `Intl.DateTimeFormat` throw `RangeError` on the FIRST candidate minute,
    // and a transient Redis blip fails `queue.add`. Both are per-schedule
    // faults; the tick is idempotent and re-runs in 5 minutes, so the right
    // response is to log this one loudly and keep scanning.
    try {
      const occurrence = latestCronOccurrence(baseline.cron, baseline.timezone, now);
      if (!occurrence) continue;
      if (occurrence.key === baseline.lastOccurrenceKey) continue;

      // Enqueue OUTSIDE any DB context: a BullMQ add is a Redis round trip, and
      // holding a pooled Postgres connection across it is what exhausted the
      // pool on 2026-05-21 (same note as runService.ts's step 10).
      await getAiAgentSweepQueue().add(
        OCCURRENCE_JOB,
        { scheduleId: baseline.id, occurrenceKey: occurrence.key },
        {
          jobId: getSweepOccurrenceJobId(baseline.id, occurrence.key),
          attempts: 3,
          backoff: { type: 'exponential', delay: 30_000 },
          // Retention, not `true`: the jobId must outlive at least one tick
          // interval to be worth anything as a duplicate guard — see the
          // header on why the run-level dedupe key is the real guarantee.
          removeOnComplete: { count: 200 },
          removeOnFail: 50,
        },
      );
      enqueued++;

      const claimed = await runWithSystemDbAccess(() => claimOccurrence(
        baseline.id,
        baseline.lastOccurrenceKey,
        occurrence.key,
      ));
      if (!claimed) {
        console.debug('[AiAgentSweepScheduler] occurrence already claimed by another replica', {
          scheduleId: baseline.id, occurrenceKey: occurrence.key,
        });
      }
    } catch (error) {
      console.error('[AiAgentSweepScheduler] tick failed for one schedule — continuing the scan', {
        scheduleId: baseline.id,
        cron: baseline.cron,
        timezone: baseline.timezone,
        error,
      });
    }
  }

  return { scanned: baselines.length, enqueued };
}

// ---------------------------------------------------------------------------
// Occurrence fan-out
// ---------------------------------------------------------------------------

interface OccurrenceBaselineRow {
  id: string;
  agentId: string;
  partnerId: string | null;
  /**
   * P2-3. What this occurrence PRODUCES: `sweep` fans out one sweep-profile
   * run per org (findings), `narrative` fans out one narrative-profile run
   * per org (that org's weekly report). Read from the eligibility row rather
   * than the resolver's copy because it is immutable — `updateAiAgentScheduleSchema`
   * never admits it — so the two can only ever agree.
   */
  kind: AiAgentScheduleKind;
  sweepKinds: AiSweepKind[];
  enabled: boolean;
}

/**
 * Re-read of the triggering baseline, with the SAME enabled/agent conditions
 * the tick applied. Between the tick and this job a partner may have disabled
 * the schedule, disabled the agent, or deleted either — a sweep must not fan
 * out on a configuration that no longer exists.
 */
async function loadOccurrenceBaseline(scheduleId: string): Promise<OccurrenceBaselineRow | null> {
  const { db } = dbModule;
  const rows = await db
    .select({
      id: aiAgentSchedules.id,
      agentId: aiAgentSchedules.agentId,
      partnerId: aiAgentSchedules.partnerId,
      kind: aiAgentSchedules.kind,
      sweepKinds: aiAgentSchedules.sweepKinds,
      enabled: aiAgentSchedules.enabled,
    })
    .from(aiAgentSchedules)
    .innerJoin(aiAgents, eq(aiAgents.id, aiAgentSchedules.agentId))
    .where(and(
      eq(aiAgentSchedules.id, scheduleId),
      isNull(aiAgentSchedules.orgId),
      eq(aiAgentSchedules.enabled, true),
      eq(aiAgents.enabled, true),
      isNull(aiAgents.disabledAt),
    ))
    .limit(1);
  return (rows[0] as OccurrenceBaselineRow | undefined) ?? null;
}

/**
 * Statuses a sweep may run against — the SAME live-org definition
 * `middleware/auth.ts`'s partner-scope org resolution uses. Everything else
 * (`suspended`, `churned`, `offboarding`, `merging`, `archived`, `purging`) is
 * a tenant in a terminal or frozen lifecycle state; `archived` is what an
 * archived_at org carries.
 */
const SWEEPABLE_ORG_STATUSES = ['active', 'trial'] as const;

/**
 * Hard admission ceiling per occurrence (review fix, #4189).
 *
 * One occurrence fans out one LLM-spending run PER LIVE ORG under the
 * partner, all enqueued in a single loop with no pacing. A partner with a few
 * thousand orgs is therefore an unbounded burst against the run queue, the
 * model provider's rate limits, and the billing meter — from ONE cron minute
 * nobody is watching. 500 is well above every real partner today and low
 * enough that the burst stays survivable.
 *
 * The overflow is COUNTED, not silently dropped: it lands in the summary as
 * `skipReasons.org_cap` (the same aggregate shape as every other skip) and is
 * logged once per occurrence with the partner id, so hitting the ceiling is
 * visible before it becomes a coverage gap nobody noticed.
 */
export const MAX_ORGS_PER_OCCURRENCE = 500;

/**
 * Every org a partner-wide schedule fans out to.
 *
 * Starts from `policyEvaluationService.policyDeviceScopeCondition`'s predicate
 * (`partner_id` + `type <> 'quick_support'` — quick_support is the partner's
 * hidden holder for ephemeral support enrolments, which no scheduled hygiene
 * sweep may touch) and narrows it to LIVE tenants: soft-deleted orgs and orgs
 * outside `SWEEPABLE_ORG_STATUSES` are excluded from the enumeration entirely,
 * so they are not merely skipped — they never appear in `orgsTotal` either.
 * A sweep is unattended, recurring, LLM-spending work; billing a churned or
 * mid-offboarding tenant for it, or raising findings a nobody will action, is
 * strictly worse than not running.
 */
async function loadPartnerOrgIds(partnerId: string): Promise<{ orgIds: string[]; capped: number }> {
  const { db } = dbModule;
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(
      eq(organizations.partnerId, partnerId),
      ne(organizations.type, 'quick_support'),
      isNull(organizations.deletedAt),
      inArray(organizations.status, [...SWEEPABLE_ORG_STATUSES]),
    ))
    // Deterministic: the cap below takes a PREFIX of this list, so without a
    // stable order a capped partner would sweep an arbitrary — and different
    // — 500 orgs on every occurrence, which is worse than sweeping a fixed
    // subset (nobody's coverage is reliable, and nothing is reproducible).
    .orderBy(asc(organizations.id));

  const all = rows.map((row) => row.id);
  const orgIds = all.slice(0, MAX_ORGS_PER_OCCURRENCE);
  return { orgIds, capped: all.length - orgIds.length };
}

async function writeRunSummary(scheduleId: string, summary: AiAgentScheduleRunSummary): Promise<void> {
  const { db } = dbModule;
  await db
    .update(aiAgentSchedules)
    .set({ lastRunSummary: summary, updatedAt: new Date() })
    .where(eq(aiAgentSchedules.id, scheduleId));
}

function emptySummary(occurrenceKey: string): AiAgentScheduleRunSummary {
  return {
    occurrenceKey,
    orgsTotal: 0,
    runsAdmitted: 0,
    runsSkipped: 0,
    skipReasons: {},
    enqueuedAt: new Date().toISOString(),
  };
}

/**
 * Best-effort `last_run_summary` write for an EARLY return (review fix,
 * #4189). Both bail-out paths below used to return without touching the
 * column, which left it showing the PREVIOUS occurrence's counters — so a
 * schedule that had been disabled, or whose agent was deleted, still read as
 * "fanned out to N orgs" on exactly the screen an operator consults to find
 * out why it stopped firing. Logged rather than thrown: failing to record
 * that nothing happened must not turn a legitimate no-op into a BullMQ
 * retry.
 */
async function writeEmptySummary(
  scheduleId: string,
  occurrenceKey: string,
): Promise<AiAgentScheduleRunSummary> {
  const summary = emptySummary(occurrenceKey);
  try {
    await runWithSystemDbAccess(() => writeRunSummary(scheduleId, summary));
  } catch (error) {
    console.error('[AiAgentSweepScheduler] failed to persist last_run_summary', {
      scheduleId, occurrenceKey, error,
    });
  }
  return summary;
}

/**
 * Fan ONE occurrence out across every org under the schedule's partner.
 *
 * The schedule's `kind` decides WHAT each org gets (one sweep-profile run, or
 * one narrative-profile run) and nothing else; the counters still reconcile
 * the same way for both — `orgsTotal === runsAdmitted + runsSkipped`.
 *
 * The returned (and stored) `last_run_summary` is AGGREGATE ONLY — counters
 * and a skip-reason histogram, never an org id or name. A partner baseline is
 * legible to each of its orgs through the effective resolver
 * (`scheduleService.listSchedules` strips the summary for them, but the
 * column is one migration away from being surfaced), so "org X was skipped
 * for budget" must not be recoverable from it. Asserted in the unit suite.
 */
export async function processSweepOccurrence(
  data: SweepOccurrenceJobData,
): Promise<AiAgentScheduleRunSummary> {
  const { scheduleId, occurrenceKey } = data;

  const baseline = await runWithSystemDbAccess(() => loadOccurrenceBaseline(scheduleId));
  if (!baseline || !baseline.partnerId) {
    // Not an error and never retried: the schedule or its agent was disabled
    // or deleted between the tick and this job, which is a legitimate outcome.
    console.info('[AiAgentSweepScheduler] sweep occurrence skipped — schedule or agent is no longer eligible', {
      scheduleId, occurrenceKey,
    });
    return writeEmptySummary(scheduleId, occurrenceKey);
  }

  // Called with NO ambient DB context — it opens its own system context (and
  // skips re-entering one when already inside).
  const resolved = await resolveEffectiveSchedulesForPartner(baseline.partnerId);
  const entry = resolved.find((candidate) => candidate.baseline.id === scheduleId);
  if (!entry) {
    console.warn('[AiAgentSweepScheduler] baseline vanished from the partner resolver between reads', {
      scheduleId, occurrenceKey,
    });
    return writeEmptySummary(scheduleId, occurrenceKey);
  }
  const overridesByOrg: Map<string, ScheduleOverrideSummary> = entry.overridesByOrg;

  // The resolver read happens AFTER the eligibility read above, so a partner
  // disabling the baseline in between lands here as `entry.baseline.enabled ===
  // false`. Reported as its own reason rather than folded into the per-org
  // merge: `effectiveSchedule` would return `enabled: false` for EVERY org and
  // the summary would read "every org opted out", which is a different — and
  // much more alarming — statement than "the schedule was turned off".
  const scheduleDisabled = !entry.baseline.enabled;

  const { orgIds, capped } = await runWithSystemDbAccess(
    () => loadPartnerOrgIds(baseline.partnerId as string),
  );

  const skipReasons: Record<string, number> = {};
  let runsAdmitted = 0;
  let runsSkipped = 0;
  const countSkip = (reason: string): void => {
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
    runsSkipped++;
  };

  if (capped > 0) {
    // Counted as a bulk skip, not one countSkip() per org: the histogram is
    // aggregate anyway, and iterating the overflow would only be a way to
    // spend time proportional to the thing being capped.
    skipReasons.org_cap = capped;
    runsSkipped += capped;
    // console.error, once: a partner outgrowing the ceiling is a coverage gap
    // for real tenants, not a routine skip. Partner id only — an org id here
    // would put tenant identifiers in a log line whose whole point is that
    // the summary column deliberately has none.
    console.error('[AiAgentSweepScheduler] partner exceeded the per-occurrence org cap — some orgs were not swept', {
      scheduleId,
      occurrenceKey,
      partnerId: baseline.partnerId,
      admitted: orgIds.length,
      skipped: capped,
      cap: MAX_ORGS_PER_OCCURRENCE,
    });
  }

  const buildSummary = (): AiAgentScheduleRunSummary => ({
    occurrenceKey,
    // The TRUE population, so the counters reconcile: orgsTotal ===
    // runsAdmitted + runsSkipped even when the cap fired.
    orgsTotal: orgIds.length + capped,
    runsAdmitted,
    runsSkipped,
    skipReasons,
    enqueuedAt: new Date().toISOString(),
  });

  // P2-3. Hoisted out of the loop: `kind` is immutable for the lifetime of a
  // schedule row, so this is a property of the OCCURRENCE, not of any one org.
  const isNarrative = baseline.kind === 'narrative';

  let summary: AiAgentScheduleRunSummary;
  try {
    for (const orgId of orgIds) {
      if (scheduleDisabled) {
        countSkip('schedule_disabled');
        continue;
      }

      // `enabled` comes from the ELIGIBILITY read (which gated `enabled =
      // true`), so this merge expresses only what the ORG's override does; the
      // baseline's own disable is handled above. `sweepKinds` comes from the
      // resolver, which is the fresher read of the kind set.
      const effective = effectiveSchedule(
        { enabled: baseline.enabled, sweepKinds: entry.baseline.sweepKinds },
        overridesByOrg.get(orgId) ?? null,
      );
      // An override that disables, or that intersects the baseline down to no
      // kinds at all, is the same outcome: this org has nothing to sweep.
      //
      // The kinds half of that is SWEEP-ONLY. A narrative schedule sweeps
      // nothing by definition (`ai_agent_schedules_kind_kinds_chk` forbids any
      // other shape), so applying the guard to it would skip every org on
      // every occurrence and the feature would never fire. An org override of
      // a narrative baseline therefore has exactly one lever — `enabled` —
      // and it still works.
      if (!effective.enabled || (!isNarrative && effective.sweepKinds.length === 0)) {
        countSkip('override_disabled');
        continue;
      }

      // Per-org error boundary. Admission touches Postgres, Redis and the
      // budget/billing lookups, so one org's transient failure (or one corrupt
      // policy row that fails schema parsing) must not cost every OTHER org
      // under the partner its sweep. Counted as its own `error` reason so a
      // partner-visible summary distinguishes "we chose not to run" from "we
      // tried and it broke".
      try {
        // No ambient DB context here — `createAndEnqueueAgentRun` manages its
        // own (see `alertVerdictSubscriber.ts`'s header on the #1105
        // pool-hold seam).
        //
        // The two arms differ ONLY in profile, triggerRef and dedupe key. The
        // dedupe key is namespaced by profile on purpose: `(org_id,
        // dedupe_key)` is a real unique index, so a shared `sweep-` prefix
        // would make a narrative and a sweep run for the same (schedule, org,
        // occurrence) collide and silently drop one of them.
        const result = isNarrative
          ? await createAndEnqueueAgentRun({
            orgId,
            kind: 'triage',
            triggerKind: 'schedule',
            deviceId: null,
            profile: 'narrative',
            scheduleId: baseline.id,
            triggerRef: { scheduleId: baseline.id, occurrenceKey, kind: 'narrative' },
            dedupeKey: `narrative-${baseline.id}-${orgId}-${occurrenceKey}`,
          })
          : await createAndEnqueueAgentRun({
            orgId,
            kind: 'triage',
            triggerKind: 'schedule',
            deviceId: null,
            profile: 'sweep',
            scheduleId: baseline.id,
            triggerRef: { scheduleId: baseline.id, occurrenceKey, sweepKinds: effective.sweepKinds },
            dedupeKey: `sweep-${baseline.id}-${orgId}-${occurrenceKey}`,
          });

        if (result.created) runsAdmitted++;
        else countSkip(result.skipped);
      } catch (error) {
        countSkip('error');
        console.error('[AiAgentSweepScheduler] sweep admission threw for one org — continuing the fan-out', {
          scheduleId, occurrenceKey, orgId, error,
        });
      }
    }
  } finally {
    // ALWAYS written, including on a partial failure: the summary is the only
    // durable record that this occurrence was attempted at all, and losing it
    // would leave `last_run_summary` showing the PREVIOUS occurrence's numbers
    // as if they were this one's. A write failure here is logged rather than
    // rethrown so it can never mask an in-flight error from the loop.
    summary = buildSummary();
    try {
      await runWithSystemDbAccess(() => writeRunSummary(scheduleId, summary));
    } catch (error) {
      console.error('[AiAgentSweepScheduler] failed to persist last_run_summary', {
        scheduleId, occurrenceKey, error,
      });
    }
  }

  console.info('[AiAgentSweepScheduler] schedule occurrence fanned out', {
    scheduleId, kind: baseline.kind, ...summary,
  });
  return summary;
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

export function createAiAgentSweepWorker(): Worker<SweepJobData> {
  return new Worker<SweepJobData>(
    AI_AGENT_SWEEP_QUEUE,
    async (job: Job<SweepJobData>) => {
      switch (job.name) {
        case TICK_JOB:
          return processSweepTick();
        case OCCURRENCE_JOB:
          return processSweepOccurrence(job.data as SweepOccurrenceJobData);
        default:
          // Loud, not silent: an unknown name means a producer added a job
          // this processor cannot honour, and dropping it would lose work.
          throw new Error(`[AiAgentSweepScheduler] unknown sweep job name: ${job.name}`);
      }
    },
    { connection: getBullMQConnection(), concurrency: SWEEP_WORKER_CONCURRENCY },
  );
}

/**
 * Boot reconcile, mirroring `metricAnomalies.scheduleMetricAnomaliesScan`:
 * remove any existing `tick` repeatable BEFORE adding, so changing
 * `SWEEP_TICK_INTERVAL_MS` does not leave the previous interval's repeatable
 * running alongside the new one forever.
 */
export async function initializeAiAgentSweepScheduler(): Promise<void> {
  sweepWorker = createAiAgentSweepWorker();
  attachWorkerObservability(sweepWorker, 'aiAgentSweepScheduler');
  sweepWorker.on('error', (error) => {
    console.error('[AiAgentSweepScheduler] Worker error:', error);
  });

  const queue = getAiAgentSweepQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === TICK_JOB) await queue.removeRepeatableByKey(job.key);
  }

  await queue.add(
    TICK_JOB,
    {},
    {
      jobId: TICK_JOB_ID,
      repeat: { every: SWEEP_TICK_INTERVAL_MS },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );

  console.log('[AiAgentSweepScheduler] Initialized');
}

export async function shutdownAiAgentSweepScheduler(): Promise<void> {
  if (sweepWorker) {
    await sweepWorker.close();
    sweepWorker = null;
  }
  if (sweepQueue) {
    await sweepQueue.close();
    sweepQueue = null;
  }
}
