import { randomUUID } from 'node:crypto';
import { and, count, eq, gte, inArray, isNull, sum } from 'drizzle-orm';
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
  | 'agent_daily_budget_exceeded' | 'duplicate' | 'ownership_mismatch';

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

/** postgres.js surfaces the SQLSTATE on the error, Drizzle wraps it in `cause`. */
function sqlStateOf(error: unknown): string | undefined {
  const direct = (error as { code?: unknown } | null)?.code;
  if (typeof direct === 'string') return direct;
  const wrapped = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof wrapped === 'string' ? wrapped : undefined;
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
]);

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

    const now = Date.now();

    // Scoping note for 5/6/7: every count is pinned to (agentId, orgId), not
    // agentId alone. A partner-wide agent legitimately runs against many orgs,
    // and org A's traffic must not consume org B's caps or cooldown.
    const agentOrgScope = and(eq(aiAgentRuns.agentId, resolved.agentId), eq(aiAgentRuns.orgId, orgId));

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

    // 6. Concurrency and rate. Count queries, not a distributed lock: for caps
    //    of 1/20 a race overshoots by at most the worker concurrency, and the
    //    run-side wall-clock and per-run budget guards still bound the cost.
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

    // 9. Insert the ledger row.
    let run: AiAgentRunRow;
    try {
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
        .returning();
      if (!inserted) throw new Error('agent run insert returned no row');
      run = inserted;
    } catch (error) {
      // ai_agent_runs_org_dedupe_key_uq — the same trigger fired twice.
      if (sqlStateOf(error) === '23505') return skip('duplicate');
      throw error;
    }

    return { created: true, run };
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
