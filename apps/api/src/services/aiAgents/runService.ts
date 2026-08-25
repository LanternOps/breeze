import { randomUUID } from 'node:crypto';
import { and, count, eq, gte, inArray, isNotNull, isNull, lt, or, sql, sum } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type {
  AiAgentKind,
  AiAgentPolicySnapshot,
  AiAgentRunStatus,
  AiAgentTriggerKind,
  AiAgentTriggers,
} from '@breeze/shared';
import { envFlag } from '../../config/env';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
// Direct module imports, NOT the ../../db/schema barrel: this module is the
// admission gate every trigger path calls, and pulling the barrel would force
// every partial-mock unit test of those paths to stub the whole schema surface.
import { aiAgents, aiAgentRuns, type AiAgentRunRow } from '../../db/schema/aiAgents';
import { devices } from '../../db/schema/devices';
import { organizations } from '../../db/schema/orgs';
import { checkBudget } from '../aiCostTracker';
import { isDeviceInMaintenanceWindow } from '../deploymentEngine';
import { publishEvent } from '../eventBus';
import { getLlmBillingSourceForOrg } from '../llm/llmConfigResolver';
import { AgentRunOwnershipError, assertRunOwnership } from './agentAuthContext';
import { resolveEffectiveAgentSystem } from './effectivePolicy';

/**
 * Which `AiAgentLimits` field is enforced where. Every field must appear in
 * this list — an unenforced cap is an unbounded agent (self-review item 3).
 *
 *  - maxConcurrentRuns     — HERE (admission rule 6)
 *  - maxRunsPerHour        — HERE (admission rule 6)
 *  - maxBudgetCentsPerDay  — HERE (admission rule 7), per agent per org
 *  - cooldownSeconds       — HERE (admission rule 5), policy root not `limits`
 *  - maxTurnsPerRun        — run loop (`aiAgentRunner`, Task 4)
 *  - maxBudgetCentsPerRun  — run loop (SDK `maxBudgetUsd`)
 *  - wallClockSeconds      — run loop (abort controller)
 *  - maxDevicesPerRun      — DEFERRED: wave 3 creates single-device runs only
 *                            (`CreateAgentRunInput.deviceId` is one id, not a
 *                            list), so there is nothing to cap yet. Enforce it
 *                            when fleet-wide runs land.
 *  - maxFleetPercentPerDay — DEFERRED to wave 5 (fleet remediation): needs a
 *                            per-day distinct-device count against org fleet
 *                            size, which only means something once an agent can
 *                            touch more than one device.
 */

export interface CreateAgentRunInput {
  orgId: string;
  kind: AiAgentKind;
  triggerKind: AiAgentTriggerKind;
  deviceId: string | null;
  alertId?: string | null;
  triggerEventId?: string | null;
  triggerRef?: Record<string, unknown>;
  /** Present for alert triggers; evaluated against policy.triggers. */
  alertContext?: {
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    ruleId: string | null;
    siteId: string | null;
    deviceTags: string[];
  };
  /** e.g. `alert:${alertId}`, `manual:${randomUUID()}`. Unique per org. */
  dedupeKey: string;
}

export type AgentRunSkipReason =
  | 'kill_switch_off' | 'no_effective_agent' | 'agent_disabled' | 'mode_off'
  | 'trigger_filter_mismatch' | 'maintenance_window' | 'cooldown'
  | 'max_concurrent_runs' | 'max_runs_per_hour' | 'org_budget_exceeded'
  | 'agent_daily_budget_exceeded' | 'duplicate' | 'ownership_mismatch'
  | 'device_not_in_org';

export type CreateAgentRunResult =
  | { created: true; run: AiAgentRunRow }
  | { created: false; skipped: AgentRunSkipReason };

/**
 * Enqueue seam. `jobs/aiAgentRunner` owns the BullMQ queue AND imports
 * `transitionRunStatus` from this module, so a static import here would close a
 * cycle between a service and a job module. Registering the enqueuer instead
 * keeps the cycle open, and keeps BullMQ/Redis out of the unit-test module
 * graph of the most heavily tested function in this wave.
 *
 * `jobs/aiAgentRunner` MUST call `registerAgentRunEnqueuer(enqueueAgentRunJob)`
 * at module scope, and `index.ts` MUST import that module at boot. With no
 * enqueuer registered a run is inserted and then immediately marked `failed`
 * with `errorCode: 'enqueue_failed'` — loud, never a silently stuck `queued`.
 */
export type AgentRunEnqueuer = (runId: string) => Promise<{ enqueued: boolean; jobId?: string }>;

let agentRunEnqueuer: AgentRunEnqueuer | null = null;

export function registerAgentRunEnqueuer(enqueuer: AgentRunEnqueuer | null): void {
  agentRunEnqueuer = enqueuer;
}

/**
 * Same skip-if-already-system shape as `resolveEffectiveAgentSystem`: a bare
 * system wrapper is a no-op inside an ambient request context (so exit first),
 * and re-entering from an already-system worker context would take a SECOND
 * pooled connection while the first is still held, for no visibility gain.
 */
function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * Spec §5.3 trigger filters.
 *
 * Asymmetry is deliberate and load-bearing: `alertSeverities` is an explicit
 * opt-in list (empty matches NOTHING — an agent with no severities selected
 * must not fire on everything), while every other filter is a narrowing one
 * where empty/absent means "all".
 *
 * `deviceGroupIds` is deliberately NOT evaluated here: resolving group
 * membership costs a query per trigger, and the caller has no group ids on the
 * alert context. Deferred to wave 6 — until then a group filter is inert and
 * WIDER than the operator asked for, which is why it is called out in the PR
 * body rather than silently ignored.
 */
export function evaluateAgentTriggerFilters(
  triggers: AiAgentTriggers,
  ctx: NonNullable<CreateAgentRunInput['alertContext']>,
): boolean {
  const severities = triggers.alertSeverities ?? [];
  if (!severities.includes(ctx.severity)) return false;

  const ruleIds = triggers.alertRuleIds ?? [];
  if (ruleIds.length > 0 && (ctx.ruleId === null || !ruleIds.includes(ctx.ruleId))) return false;

  const siteIds = triggers.siteIds ?? [];
  if (siteIds.length > 0 && (ctx.siteId === null || !siteIds.includes(ctx.siteId))) return false;

  const deviceTags = triggers.deviceTags ?? [];
  if (deviceTags.length > 0 && !deviceTags.some((tag) => ctx.deviceTags.includes(tag))) return false;

  return true;
}

/**
 * Skips that are worth an event on the bus vs. skips that are merely logged.
 *
 * Everything before the agent is resolved-and-enabled fires on EVERY trigger in
 * EVERY org the moment the kill switch is off or the agent is unconfigured —
 * publishing there would put one Redis stream write on the hot alert path for a
 * non-event. Once a live agent has genuinely declined a trigger, the skip IS
 * the news, so it goes on the bus.
 */
const PUBLISHED_SKIP_REASONS: ReadonlySet<AgentRunSkipReason> = new Set([
  'trigger_filter_mismatch', 'maintenance_window', 'cooldown',
  'max_concurrent_runs', 'max_runs_per_hour', 'org_budget_exceeded',
  'agent_daily_budget_exceeded', 'duplicate', 'ownership_mismatch',
  'device_not_in_org',
]);

/**
 * Advisory-lock namespace for agent-run admission. `pg_advisory_xact_lock` is
 * a GLOBAL keyspace shared by every lock taker in the database, so the first
 * (int4, int4) argument namespaces this feature's locks away from anyone
 * else's. Arbitrary but must never change: a different value would stop
 * serialising against in-flight admissions during a rolling deploy.
 */
const AGENT_RUN_ADMISSION_LOCK_NAMESPACE = 3824;

/**
 * How long a run may sit in `queued`/`running` before a later admission
 * declares it dead.
 *
 * 1800s is the maximum `wallClockSeconds` the validator accepts, so this
 * threshold is safe for EVERY policy rather than only the default one; the
 * extra 900s covers the BullMQ lock (720s), teardown, and clock skew. Too
 * generous only delays recovery — too aggressive would fail a run that is
 * still thinking, which is unrecoverable.
 */
const STALLED_RUN_AFTER_SECONDS = 1800 + 900;

/**
 * Fail runs the worker can no longer be executing, scoped to one (agent, org).
 *
 * Why this exists: BullMQ's stalled checker re-delivers a job whose worker was
 * SIGKILLed (deploy, OOM, `docker stop` past the grace period), and the
 * redelivered job's `transitionRunStatus(runId, 'queued', 'running')` CAS FAILS
 * against a row already sitting in `running` — `executeAgentRun` logs
 * "duplicate delivery ignored" and returns, BullMQ marks the job complete, and
 * the row stays `running` forever. With `maxConcurrentRuns` defaulting to 1 and
 * the concurrency count covering `('queued','running')`, ONE such crash
 * permanently refuses every future run for that (agent, org) with
 * `max_concurrent_runs` — the manual trigger included, which 409s. Recovery
 * used to require hand-written SQL.
 *
 * Reaping HERE rather than on a timer is deliberate: admission is the only
 * place the wedge can actually be observed, it already holds the (agent, org)
 * advisory lock and a system context, and it runs exactly when someone is
 * trying to get past the jam. The transition is a CAS, so a run that IS still
 * alive and finishes normally between the two statements is not clobbered.
 */
export async function reapStalledAgentRuns(scope: {
  agentId: string;
  orgId: string;
}): Promise<string[]> {
  const cutoff = new Date(Date.now() - STALLED_RUN_AFTER_SECONDS * 1000);
  return inSystemDbContext(async () => {
    const rows = await db
      .update(aiAgentRuns)
      .set({ status: 'failed', errorCode: 'stalled', finishedAt: new Date() })
      .where(and(
        eq(aiAgentRuns.agentId, scope.agentId),
        eq(aiAgentRuns.orgId, scope.orgId),
        inArray(aiAgentRuns.status, ['queued', 'running']),
        // `started_at` is NULL for a run whose job never reached a worker at
        // all (Redis lost it after the enqueue returned), and that row wedges
        // the concurrency count identically — fall back to `queued_at`. Two
        // typed column comparisons rather than one `coalesce(...) < $n`
        // fragment: a bare Date interpolated into a raw `sql` template is
        // handed to postgres.js unencoded and throws ERR_INVALID_ARG_TYPE,
        // because only a column reference carries the timestamp mapper.
        or(
          and(isNotNull(aiAgentRuns.startedAt), lt(aiAgentRuns.startedAt, cutoff)),
          and(isNull(aiAgentRuns.startedAt), lt(aiAgentRuns.queuedAt, cutoff)),
        ),
      ))
      .returning({ id: aiAgentRuns.id });
    if (rows.length > 0) {
      console.warn('[aiAgentRunService] reaped stalled agent runs', {
        agentId: scope.agentId, orgId: scope.orgId, runIds: rows.map((r) => r.id),
      });
    }
    return rows.map((r) => r.id);
  });
}

/**
 * The single admission gate for agent runs (spec §7): resolve the effective
 * policy, apply trigger filters and every per-agent cap, establish the
 * cross-table ownership invariant, insert the ledger row, enqueue.
 *
 * It NEVER runs the agent inline. The only side effects are one insert, one
 * event and one BullMQ enqueue.
 */
export async function createAndEnqueueAgentRun(
  input: CreateAgentRunInput,
): Promise<CreateAgentRunResult> {
  const { orgId, kind, triggerKind, deviceId, dedupeKey } = input;

  let snapshot: AiAgentPolicySnapshot | null = null;
  const skip = (reason: AgentRunSkipReason): CreateAgentRunResult => {
    // A dropped trigger must never be invisible (spec §7's silent-drop finding).
    console.info('[aiAgentRunService] run skipped', {
      reason, orgId, kind, triggerKind, deviceId,
      alertId: input.alertId ?? null,
      agentId: snapshot?.agentId ?? null,
      dedupeKey,
    });
    if (snapshot && PUBLISHED_SKIP_REASONS.has(reason)) {
      void publishEvent(
        'ai.agent.run.skipped',
        orgId,
        {
          reason, agentId: snapshot.agentId, deviceId, triggerKind, dedupeKey,
          alertId: input.alertId ?? null,
        },
        'ai-agent-runner',
      ).catch((error: unknown) => {
        // Observability must never turn a skip into a throw.
        console.error('[aiAgentRunService] failed to publish skip event', { orgId, reason, error });
      });
    }
    return { created: false, skipped: reason };
  };

  // 1. Kill switch. Checked before anything reads the DB — with the flag off,
  //    every guardrail check would deny anyway (spec §10).
  if (!envFlag('BREEZE_AI_AGENTS_ENABLED', false)) return skip('kill_switch_off');

  // 2. Effective policy. Throws 404 when the org itself is missing — that is a
  //    caller bug, not a skip, and is deliberately allowed to propagate.
  const resolved = await resolveEffectiveAgentSystem(orgId, kind);
  if (!resolved) return skip('no_effective_agent');
  snapshot = resolved;
  const effective = resolved.effective;
  if (!effective.enabled) return skip('agent_disabled');
  if (effective.mode === 'off') return skip('mode_off');
  const modeAtStart = effective.mode;

  // 3. Trigger filters. Only an event-shaped trigger carries a context; a human
  //    pressing "run now" has already made the selection the filters encode.
  if (input.alertContext && !evaluateAgentTriggerFilters(effective.triggers, input.alertContext)) {
    return skip('trigger_filter_mismatch');
  }

  // 4. Maintenance windows. Reads partner-wide (org_id NULL) windows, so it has
  //    to run inside the system context below — an org-scoped RLS context sees
  //    none of them (#1105).
  //
  // Everything from here to the insert runs in ONE system context, i.e. one
  // pooled Postgres connection. The announce/enqueue in step 10 deliberately
  // does NOT: a BullMQ enqueue is a Redis roundtrip, and holding a Postgres
  // connection `idle in transaction` across Redis is what exhausted the pool on
  // 2026-05-21 (see the same note on eventBus.publish).
  const admission: CreateAgentRunResult = await inSystemDbContext(async () => {
    if (effective.triggers.respectMaintenanceWindows && deviceId) {
      if (await isDeviceInMaintenanceWindow(deviceId)) return skip('maintenance_window');
    }

    // 4b. Serialize the whole check-then-insert for this (agent, org).
    //
    // Every gate below is a plain SELECT taken before a non-atomic insert, and
    // the manual route mints `manual:${randomUUID()}` per call, so the
    // (org_id, dedupe_key) unique index cannot collapse concurrent requests
    // either. Without this lock, N simultaneous POSTs each read zero committed
    // runs and each insert: 100 concurrent triggers admitted 100 runs against
    // `maxConcurrentRuns: 1`, `maxRunsPerHour: 20` and a 900s cooldown, at up
    // to `maxBudgetCentsPerRun` each. The overshoot was bounded by REQUEST
    // concurrency, not by worker concurrency as the old comment here claimed.
    //
    // `pg_advisory_xact_lock` (not the session variant) releases on commit or
    // rollback of the transaction `inSystemDbContext` already opened, so no
    // path can leak it; the lock is keyed on the same (agent, org) pair every
    // counter below is scoped to, so two different orgs never queue behind each
    // other. `hashtext` is stable within a major version, and a hash collision
    // between two unrelated pairs would only serialise them — never admit.
    await db.execute(sql`select pg_advisory_xact_lock(
      ${AGENT_RUN_ADMISSION_LOCK_NAMESPACE}::int4,
      hashtext(${`${resolved.agentId}:${orgId}`})
    )`);

    const now = Date.now();

    // Scoping note for 5/6/7: every count is pinned to (agentId, orgId), not
    // agentId alone. A partner-wide agent legitimately runs against many orgs,
    // and org A's traffic must not consume org B's caps or cooldown.
    const agentOrgScope = and(eq(aiAgentRuns.agentId, resolved.agentId), eq(aiAgentRuns.orgId, orgId));

    // 4c. Release runs a worker can no longer be executing before counting
    //     them, or one SIGKILLed replica wedges this (agent, org) forever.
    await reapStalledAgentRuns({ agentId: resolved.agentId, orgId });

    // 5. Cooldown for this exact target.
    if (effective.cooldownSeconds > 0) {
      const deviceScope: SQL | undefined = deviceId
        ? eq(aiAgentRuns.deviceId, deviceId)
        : isNull(aiAgentRuns.deviceId);
      const [recent] = await db
        .select({ id: aiAgentRuns.id })
        .from(aiAgentRuns)
        .where(and(
          agentOrgScope,
          deviceScope,
          gte(aiAgentRuns.queuedAt, new Date(now - effective.cooldownSeconds * 1000)),
        ))
        .limit(1);
      if (recent) return skip('cooldown');
    }

    // 6. Concurrency and rate. Plain counts are sufficient BECAUSE step 4b
    //    serialises every concurrent admission for this (agent, org) — they
    //    were not before, and the caps were bypassable by an unbounded factor.
    const [concurrent] = await db
      .select({ value: count() })
      .from(aiAgentRuns)
      .where(and(agentOrgScope, inArray(aiAgentRuns.status, ['queued', 'running'])));
    if ((concurrent?.value ?? 0) >= effective.limits.maxConcurrentRuns) {
      return skip('max_concurrent_runs');
    }

    const [lastHour] = await db
      .select({ value: count() })
      .from(aiAgentRuns)
      .where(and(agentOrgScope, gte(aiAgentRuns.queuedAt, new Date(now - 3_600_000))));
    if ((lastHour?.value ?? 0) >= effective.limits.maxRunsPerHour) {
      return skip('max_runs_per_hour');
    }

    // 7. Budgets: the org's AI budget first, then the agent's own daily cap
    //    (spec §4.3 — "per org, on top of ai_budgets").
    const billingSource = await getLlmBillingSourceForOrg(orgId);
    if (await checkBudget(orgId, billingSource)) return skip('org_budget_exceeded');

    const startOfUtcDay = new Date();
    startOfUtcDay.setUTCHours(0, 0, 0, 0);
    const [spend] = await db
      .select({ totalCostCents: sum(aiAgentRuns.costCents) })
      .from(aiAgentRuns)
      .where(and(agentOrgScope, gte(aiAgentRuns.queuedAt, startOfUtcDay)));
    // `sum` is numeric: postgres.js hands it back as a string, and NULL on an
    // empty set.
    const spentCents = Number(spend?.totalCostCents ?? 0) || 0;
    if (spentCents >= effective.limits.maxBudgetCentsPerDay) {
      return skip('agent_daily_budget_exceeded');
    }

    // 8. Ownership (spec §4.2). THIS is the single place the cross-table
    //    invariant `run.org_id ∈ owner(agent)` is established, and it is why
    //    the owner columns are re-read here rather than trusted from the
    //    snapshot: a composite FK cannot express it, because a partner-wide
    //    agent legitimately runs against many orgs (3a handoff decision 2).
    const [org] = await db
      .select({ id: organizations.id, partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    const [agentRow] = await db
      .select({
        id: aiAgents.id,
        orgId: aiAgents.orgId,
        partnerId: aiAgents.partnerId,
        name: aiAgents.name,
        kind: aiAgents.kind,
      })
      .from(aiAgents)
      .where(eq(aiAgents.id, resolved.agentId))
      .limit(1);
    if (!org?.partnerId || !agentRow) return skip('ownership_mismatch');
    try {
      assertRunOwnership(
        agentRow,
        { id: '(pre-insert)', orgId, deviceId },
        { id: orgId, partnerId: org.partnerId },
      );
    } catch (error) {
      if (error instanceof AgentRunOwnershipError) return skip('ownership_mismatch');
      throw error;
    }

    // 8b. device ∈ org. `assertRunOwnership` covers agent<->org only; the
    //     (orgId, deviceId) pair arrives from the caller and was inserted
    //     verbatim. The manual route resolves the org FROM the device, but an
    //     authorized cross-org move can commit between that read and this
    //     insert — moveOrg's device-detach pass only NULLs `device_id` on runs
    //     that already exist, so a later insert would keep a now-foreign
    //     device on an org-A run. Re-read it here, inside the same transaction
    //     that inserts (and behind the advisory lock), so the pair is checked
    //     against committed state rather than the caller's snapshot.
    if (deviceId) {
      const [deviceRow] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
        .limit(1);
      if (!deviceRow) return skip('device_not_in_org');
    }

    // 9. Insert the ledger row. `DO NOTHING` targeted at
    //    ai_agent_runs_org_dedupe_key_uq, NOT a try/catch around a plain
    //    insert: a 23505 CAUGHT inside the SAME transaction that raised it is
    //    a documented trap in this repo (quoteOrderService.ts,
    //    partnerStripe.ts) — postgres.js latches the failed statement on the
    //    transaction and rethrows it after the callback returns, so the skip
    //    this function carefully computed never reaches the caller and every
    //    duplicate trigger surfaces as a 500 instead. `DO NOTHING` never
    //    raises: an empty `returning()` IS the duplicate.
    const [inserted] = await db
      .insert(aiAgentRuns)
      .values({
        agentId: resolved.agentId,
        orgId,
        deviceId,
        alertId: input.alertId ?? null,
        triggerKind,
        triggerEventId: input.triggerEventId ?? null,
        triggerRef: input.triggerRef ?? {},
        dedupeKey,
        modeAtStart,
        policySnapshot: resolved,
        status: 'queued',
        correlationId: randomUUID(),
      })
      .onConflictDoNothing({ target: [aiAgentRuns.orgId, aiAgentRuns.dedupeKey] })
      .returning();
    if (inserted) return { created: true, run: inserted };

    // The key is taken. Usually that IS the same trigger fired twice — but it
    // is also how a run whose enqueue never landed blocks its own retry: step
    // 10 below marks such a row `failed`/`enqueue_failed`, and it then holds
    // (org_id, dedupe_key) forever, so every redelivery of that alert answers
    // `duplicate` and the alert is never triaged. Reclaim it as a compare-and-
    // set on that terminal state, inside the same transaction and advisory lock
    // as every counter above: a row a worker could still be holding (`queued` /
    // `running`) or one that genuinely ran is left alone and still reports
    // `duplicate`. Re-stamping queuedAt is deliberate — the retry is a new
    // attempt for cooldown and rate purposes, and reusing the row keeps the
    // hourly count honest rather than adding a second row for one alert.
    // Scope note: step 5's cooldown probe counts a failed row as a recent
    // attempt (it filters on queuedAt, not status), so with a cooldown
    // configured the retry reaches this reclaim only once that window has
    // passed. That block is transient and intended; the PERMANENT one — the
    // dedupe key held forever — is what this removes.
    const [reclaimed] = await db
      .update(aiAgentRuns)
      .set({
        agentId: resolved.agentId,
        deviceId,
        alertId: input.alertId ?? null,
        triggerKind,
        triggerEventId: input.triggerEventId ?? null,
        triggerRef: input.triggerRef ?? {},
        modeAtStart,
        policySnapshot: resolved,
        status: 'queued',
        errorCode: null,
        startedAt: null,
        finishedAt: null,
        queuedAt: new Date(),
        correlationId: randomUUID(),
      })
      .where(and(
        eq(aiAgentRuns.orgId, orgId),
        eq(aiAgentRuns.dedupeKey, dedupeKey),
        eq(aiAgentRuns.status, 'failed'),
        eq(aiAgentRuns.errorCode, 'enqueue_failed'),
      ))
      .returning();
    if (reclaimed) {
      console.info('[aiAgentRunService] reclaimed an enqueue_failed run', {
        runId: reclaimed.id, orgId, dedupeKey,
      });
      return { created: true, run: reclaimed };
    }

    // The same trigger fired twice for this org.
    return skip('duplicate');
  });

  if (!admission.created) return admission;
  const run = admission.run;

  // 10. Announce, then enqueue — outside the DB context (see above). A failure
  //     in either leaves a row no worker will ever pick up, so it is failed
  //     here rather than left to sit in `queued` forever.
  try {
    await publishEvent(
      'ai.agent.run.queued',
      orgId,
      { runId: run.id, agentId: run.agentId, deviceId, alertId: input.alertId ?? null, triggerKind },
      'ai-agent-runner',
    );
    if (!agentRunEnqueuer) {
      throw new Error('no agent run enqueuer registered (jobs/aiAgentRunner not loaded)');
    }
    const enqueued = await agentRunEnqueuer(run.id);
    if (!enqueued.enqueued) throw new Error('agent run enqueue refused');
    return { created: true, run };
  } catch (error) {
    console.error('[aiAgentRunService] run enqueue failed', { runId: run.id, orgId, error });
    const failed = await failRunAfterEnqueueFailure(run.id);
    return { created: true, run: failed ?? { ...run, status: 'failed', errorCode: 'enqueue_failed' } };
  }
}

async function failRunAfterEnqueueFailure(runId: string): Promise<AiAgentRunRow | null> {
  try {
    const [row] = await inSystemDbContext(() => db
      .update(aiAgentRuns)
      .set({ status: 'failed', errorCode: 'enqueue_failed', finishedAt: new Date() })
      .where(and(eq(aiAgentRuns.id, runId), eq(aiAgentRuns.status, 'queued')))
      .returning());
    return row ?? null;
  } catch (error) {
    console.error('[aiAgentRunService] could not mark run failed after enqueue failure', {
      runId, error,
    });
    return null;
  }
}

export type AgentRunStatusPatch = Partial<Pick<typeof aiAgentRuns.$inferInsert,
  'summary' | 'outcome' | 'intentIds' | 'turnCount' | 'costCents' | 'errorCode'
  | 'startedAt' | 'finishedAt'>>;

/**
 * Compare-and-set status transition. Returns false when the row was not in one
 * of the `from` statuses — the caller lost a race (a stalled BullMQ job being
 * retried, a cancel landing mid-run) and must not keep writing to the run.
 */
export async function transitionRunStatus(
  runId: string,
  from: AiAgentRunStatus | AiAgentRunStatus[],
  to: AiAgentRunStatus,
  patch: AgentRunStatusPatch = {},
): Promise<boolean> {
  const fromStatuses = Array.isArray(from) ? from : [from];
  return inSystemDbContext(async () => {
    const rows = await db
      .update(aiAgentRuns)
      .set({ ...patch, status: to })
      .where(and(eq(aiAgentRuns.id, runId), inArray(aiAgentRuns.status, fromStatuses)))
      .returning({ id: aiAgentRuns.id });
    return rows.length > 0;
  });
}
