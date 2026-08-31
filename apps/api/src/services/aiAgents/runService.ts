import { randomUUID } from 'node:crypto';
import { and, count, eq, gte, inArray, isNotNull, isNull, lt, or, sql, sum } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';
import type {
  AgentRunVerdict,
  AiAgentKind,
  AiAgentLimits,
  AiAgentPolicySnapshot,
  AiAgentRunProfile,
  AiAgentRunStatus,
  AiAgentTriggerKind,
  AiAgentTriggers,
} from '@breeze/shared';
import { envFlag } from '../../config/env';
import { PG_UUID_REGEX } from '../../utils/uuid';
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
import { deviceGroupMemberships, devices } from '../../db/schema/devices';
import { organizations } from '../../db/schema/orgs';
import { checkBudget } from '../aiCostTracker';
import { isDeviceInMaintenanceWindow } from '../deploymentEngine';
import { publishEvent } from '../eventBus';
import { getLlmBillingSourceForOrg } from '../llm/llmConfigResolver';
import { isCircuitOpen, isTerminalRunStatus, recordRunTerminal } from './agentCircuit';
import { AgentRunOwnershipError, assertRunOwnership } from './agentAuthContext';
import { resolveEffectiveAgentSystem } from './effectivePolicy';
import { closeAgentRunSession, reconcileHungExecutions } from './executionLedger';

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
 *  - maxActionsPerRun      — DEFERRED to Part B (#3826): the field ships in
 *                            wave 4a so partners can pre-configure it and
 *                            snapshots carry it; Part B's run loop is what
 *                            enforces it.
 *  - maxPolicyDecisionsPerDay — DEFERRED to wave 5 Part B (#3827): the field
 *                            ships in this PR (wave 5 Part A) so partners can
 *                            pre-configure it and every snapshot from now on
 *                            carries it; `resolvePolicyDecisionState` is a
 *                            stub that always returns `human_required`, so
 *                            nothing consumes the cap yet — Part B's
 *                            `attemptPolicyDecision` is the enforcer.
 *  - maxConsecutiveFailures — agentCircuit.ts via transitionRunStatus (wave 6
 *                            PR 2, #3828): the field ships in this task so
 *                            partners can pre-configure it and every
 *                            snapshot from now on carries it; the circuit
 *                            breaker itself (recordRunTerminal, the
 *                            terminalization chokepoint) is a later task in
 *                            this same PR.
 *  - maxVerdictRunsPerHour — HERE (admission rule 6b), verdict-profile runs
 *                            only — counted separately from maxRunsPerHour so
 *                            verdict volume can never starve full-profile runs.
 *  - maxConcurrentVerdictRuns — HERE (admission rule 6b), verdict-profile runs
 *                            only — counted separately from maxConcurrentRuns.
 *  - verdictBudgetCentsPerRun — run loop (verdictLimits(), verdictProfile.ts):
 *                            substitutes for maxBudgetCentsPerRun on a
 *                            verdict-profile run; not enforced here.
 *  - maxSweepRunsPerHour   — HERE (admission rule 6b, via profileCaps()),
 *                            sweep-profile runs only — counted separately
 *                            from maxRunsPerHour/maxVerdictRunsPerHour so
 *                            scheduled-sweep volume can never starve either.
 *  - maxConcurrentSweepRuns — HERE (admission rule 6b, via profileCaps()),
 *                            sweep-profile runs only — counted separately
 *                            from maxConcurrentRuns/maxConcurrentVerdictRuns.
 *  - sweepBudgetCentsPerRun — run loop (sweepLimits(), sweepProfile.ts):
 *                            substitutes for maxBudgetCentsPerRun on a
 *                            sweep-profile run; not enforced here.
 *  - sweepMaxTurns         — run loop (sweepLimits(), sweepProfile.ts):
 *                            substitutes for maxTurnsPerRun on a sweep-profile
 *                            run; not enforced here.
 *  - maxConcurrentNarrativeRuns — HERE (admission rule 6b, via profileCaps()),
 *                            narrative-profile runs only — counted separately
 *                            from maxConcurrentRuns/maxConcurrentVerdictRuns/
 *                            maxConcurrentSweepRuns (phase 2 P2-3).
 *  - maxNarrativeRunsPerHour — HERE (admission rule 6b, via profileCaps()),
 *                            narrative-profile runs only — counted separately
 *                            from every other per-hour cap, so the weekly
 *                            narrative can never starve sweeps or verdicts
 *                            (or be starved by them).
 *  - narrativeBudgetCentsPerRun — run loop (narrativeLimits(),
 *                            narrativeProfile.ts): substitutes for
 *                            maxBudgetCentsPerRun on a narrative-profile run;
 *                            not enforced here.
 *  - narrativeMaxTurns     — run loop (narrativeLimits(),
 *                            narrativeProfile.ts): substitutes for
 *                            maxTurnsPerRun on a narrative-profile run; not
 *                            enforced here.
 *  - maxConcurrentTriageRuns — HERE (admission rule 6b, via profileCaps()),
 *                            triage-profile runs only — counted separately
 *                            from every other per-run-shape concurrency cap
 *                            above (phase 2 P2-4).
 *  - maxTriageRunsPerHour  — HERE (admission rule 6b, via profileCaps()),
 *                            triage-profile runs only — counted separately
 *                            from every other per-hour cap, so ticket triage
 *                            can never starve, or be starved by, sweeps,
 *                            verdicts or narratives.
 *  - triageBudgetCentsPerRun — run loop (triageLimits(), triageProfile.ts):
 *                            substitutes for maxBudgetCentsPerRun on a
 *                            triage-profile run; not enforced here.
 *  - triageMaxTurns        — run loop (triageLimits(), triageProfile.ts):
 *                            substitutes for maxTurnsPerRun on a
 *                            triage-profile run; not enforced here.
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
  /**
   * The triggering ticket for `triggerKind: 'ticket'` runs (wave 6 PR 3,
   * #3828). Ticket runs carry no device — `deviceId` is always null for
   * them — so this is the run's only trigger-target identity.
   */
  ticketId?: string | null;
  /**
   * Wave 6 PR 3 review follow-up (#3828) — the triggering ticket's category/
   * priority, evaluated against `policy.triggers.ticketCategories`/
   * `ticketPriorities` (`evaluateTicketTriggerFilters` below), same shape as
   * `alertContext` above: the CALLER (`ticketHelpdeskSubscriber.ts`) loads
   * the ticket row and passes its narrowing-relevant fields in, rather than
   * this module re-reading the ticket itself.
   */
  ticketContext?: {
    category: string | null;
    categoryId: string | null;
    priority: 'low' | 'normal' | 'high' | 'urgent';
  };
  /**
   * The triggering canonical incident for `triggerKind: 'anomaly'` runs
   * (wave 6 PR 4, #3828 Task 3). Unlike ticket runs, anomaly runs ARE
   * device-bound — `deviceId` above is the incident's device, so the run
   * still passes device pinning / site-scope / maintenance-window checks.
   */
  anomalyIncidentId?: string | null;
  /**
   * Evaluated against `policy.triggers.anomalyTypes`/`metricNames`/
   * `minAnomalyScore` (`evaluateAnomalyTriggerFilters` below) plus the same
   * device-bound narrowing filters `evaluateAgentTriggerFilters` applies to
   * an alert trigger (siteIds/deviceGroupIds/deviceTags) — same shape as
   * `alertContext`/`ticketContext` above: the CALLER
   * (`metricAnomalySubscriber.ts`) loads the incident + device row and
   * passes the narrowing-relevant fields in, rather than this module
   * re-reading them itself.
   */
  anomalyContext?: {
    anomalyType: string;
    metricNames: string[];
    peakScore: number;
    siteId: string | null;
    deviceTags: string[];
  };
  /** e.g. `alert:${alertId}`, `manual:${randomUUID()}`. Unique per org. */
  dedupeKey: string;
  /**
   * Phase 2 wave P2-1 (alert verdicts). `'full'` (the default when omitted)
   * is the pre-existing run shape; `'verdict'` is a lighter-weight run scoped
   * to producing one `ai_alert_verdicts` row instead of a full triage/patch/
   * helpdesk turn. Admission counts a verdict run against its OWN
   * concurrency/rate caps (`maxConcurrentVerdictRuns`/`maxVerdictRunsPerHour`)
   * and skips the cooldown step entirely — see step 5/6b below.
   */
  profile?: AiAgentRunProfile;
  /**
   * Set only for a verdict run evaluating a correlation group rather than a
   * single alert. `null`/omitted for every other run.
   */
  correlationGroupId?: string | null;
  /**
   * Phase 2 wave P2-2 (scheduled sweeps). Set for a `profile: 'sweep'` run
   * triggered by `ai_agent_schedules`; `null`/omitted for every other run.
   * Written straight to `ai_agent_runs.schedule_id` (step 9 insert below) —
   * this module does not validate it against the schedule's own org/agent,
   * that is the caller's (scheduleService.ts / the sweep dispatcher's)
   * responsibility, same posture as `alertId`/`ticketId`/`anomalyIncidentId`.
   */
  scheduleId?: string | null;
}

export type AgentRunSkipReason =
  | 'kill_switch_off' | 'no_effective_agent' | 'agent_disabled' | 'mode_off'
  | 'circuit_open'
  | 'trigger_filter_mismatch' | 'maintenance_window' | 'cooldown'
  | 'max_concurrent_runs' | 'max_runs_per_hour' | 'org_budget_exceeded'
  | 'agent_daily_budget_exceeded' | 'duplicate' | 'ownership_mismatch'
  | 'device_not_in_org'
  // Phase 2 wave P2-1 (alert verdicts) — the verdict-profile equivalents of
  // max_concurrent_runs/max_runs_per_hour, counted against
  // maxConcurrentVerdictRuns/maxVerdictRunsPerHour instead (admission rule
  // 6b). Deliberately NOT added to PUBLISHED_SKIP_REASONS below: these are
  // volume guards on a high-frequency, cheap run shape, not a policy event
  // worth a bus publish.
  | 'max_concurrent_verdict_runs' | 'verdict_rate'
  // Phase 2 wave P2-2 (scheduled sweeps) — the sweep-profile equivalents,
  // counted against maxConcurrentSweepRuns/maxSweepRunsPerHour instead
  // (admission rule 6b, via profileCaps()). Same posture as the verdict pair
  // above: deliberately NOT added to PUBLISHED_SKIP_REASONS — volume guards,
  // not policy events.
  | 'max_concurrent_sweep_runs' | 'sweep_rate'
  // Phase 2 wave P2-3 (weekly org narrative) — the narrative-profile
  // equivalents, counted against
  // maxConcurrentNarrativeRuns/maxNarrativeRunsPerHour instead (admission
  // rule 6b, via profileCaps()). Same posture as the verdict and sweep pairs
  // above: deliberately NOT added to PUBLISHED_SKIP_REASONS — volume guards
  // on a scheduled, low-frequency run shape, not policy events.
  | 'max_concurrent_narrative_runs' | 'narrative_rate'
  // Phase 2 wave P2-4 (ticket triage) — the triage-profile equivalents,
  // counted against maxConcurrentTriageRuns/maxTriageRunsPerHour instead
  // (admission rule 6b, via profileCaps()). Same posture as the verdict,
  // sweep and narrative pairs above: deliberately NOT added to
  // PUBLISHED_SKIP_REASONS — volume guards, not policy events.
  | 'max_concurrent_triage_runs' | 'triage_rate';

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
 * `jobs/aiAgentEnqueuer.ts` exports `registerAiAgentEnqueuer()`, which calls
 * `registerAgentRunEnqueuer(enqueueAgentRunJob)`; every entrypoint (`index.ts`,
 * `worker.ts`) MUST call `registerAiAgentEnqueuer()` explicitly during boot, in
 * every role (wave 3.5d-b, #4086 — this used to be a module-scope side effect
 * of importing `jobs/aiAgentRunner`, which the lazy worker registry no longer
 * guarantees gets imported in an `api`-role process). With no enqueuer
 * registered a run is inserted and then immediately marked `failed` with
 * `errorCode: 'enqueue_failed'` — loud, never a silently stuck `queued`.
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
 * Org-pinned device-group membership lookup shared by every trigger-filter
 * evaluator below (`evaluateAgentTriggerFilters` today; the anomaly path,
 * Task 3, reuses it too). Mirrors `alertService.ts`'s
 * `getApplicableRules` group-membership query, with an explicit `org_id`
 * pin added: this runs inside a SYSTEM db context (see call sites), which
 * bypasses RLS, so the org scoping that RLS would otherwise provide has to
 * be asserted in the WHERE clause itself rather than assumed from context.
 *
 * Skipped entirely (no query) when `groupIds` is empty — the common case,
 * and consistent with every other narrowing filter's
 * undefined/empty-means-unrestricted convention costing nothing extra.
 */
async function deviceMatchesAnyGroup(
  deviceId: string,
  orgId: string,
  groupIds: readonly string[],
): Promise<boolean> {
  if (groupIds.length === 0) return true;
  const memberships = await inSystemDbContext(() => db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(and(
      eq(deviceGroupMemberships.deviceId, deviceId),
      eq(deviceGroupMemberships.orgId, orgId),
    )));
  return memberships.some((m) => groupIds.includes(m.groupId));
}

/**
 * Spec §5.3 trigger filters.
 *
 * Asymmetry is deliberate and load-bearing: `alertSeverities` is an explicit
 * opt-in list (empty matches NOTHING — an agent with no severities selected
 * must not fire on everything), while every other filter is a narrowing one
 * where empty/absent means "all".
 *
 * `deviceGroupIds` (wave 6 PR 4, #3828 Task 1 — previously "deliberately NOT
 * evaluated", see git history for the old docstring): resolves group
 * membership via an org-pinned `device_group_memberships` lookup
 * (`deviceMatchesAnyGroup` above), so this function is now ASYNC. Blast-
 * radius decision recorded here rather than threading `deviceGroupIds`
 * through every caller-supplied context: at the time of this change there
 * was exactly one production call site (`createAndEnqueueAgentRun` below)
 * and one context-building caller (`automationRuntime.ts`, which does not
 * need to change at all) — awaiting here is strictly smaller than adding a
 * membership query to every current AND future caller that builds an
 * `alertContext`, and centralizes the lookup for Task 3's anomaly path to
 * reuse via `deviceMatchesAnyGroup` rather than re-implementing it.
 *
 * A non-empty `deviceGroupIds` passes iff `deviceId` is a member of ANY
 * listed group; `deviceId === null` (no device to check) fails the filter
 * whenever the list is non-empty, same treatment as `ctx.siteId === null`
 * above it.
 */
export async function evaluateAgentTriggerFilters(
  triggers: AiAgentTriggers,
  ctx: NonNullable<CreateAgentRunInput['alertContext']>,
  deviceId: string | null,
  orgId: string,
): Promise<boolean> {
  const severities = triggers.alertSeverities ?? [];
  if (!severities.includes(ctx.severity)) return false;

  const ruleIds = triggers.alertRuleIds ?? [];
  if (ruleIds.length > 0 && (ctx.ruleId === null || !ruleIds.includes(ctx.ruleId))) return false;

  const siteIds = triggers.siteIds ?? [];
  if (siteIds.length > 0 && (ctx.siteId === null || !siteIds.includes(ctx.siteId))) return false;

  const deviceTags = triggers.deviceTags ?? [];
  if (deviceTags.length > 0 && !deviceTags.some((tag) => ctx.deviceTags.includes(tag))) return false;

  const groupIds = triggers.deviceGroupIds ?? [];
  if (groupIds.length > 0) {
    if (deviceId === null) return false;
    if (!(await deviceMatchesAnyGroup(deviceId, orgId, groupIds))) return false;
  }

  return true;
}

/**
 * Wave 6 PR 3 review follow-up (#3828) — ticket-trigger narrowing filters.
 * `ticketCategories`/`ticketPriorities` were validated and merged by
 * `effectivePolicy` since the original PR but never evaluated anywhere,
 * so a helpdesk agent fired on EVERY ticket created in the org regardless
 * of its configured filters. This mirrors `evaluateAgentTriggerFilters`
 * above: same narrowing (empty/absent = unrestricted) convention as
 * `siteIds`/`deviceTags`, NOT `alertSeverities`' opt-in-list asymmetry —
 * `AiAgentTriggers.ticketCategories`/`ticketPriorities` are both declared
 * `undefined`-means-unrestricted in the validator (`.min(1)`-or-undefined).
 *
 * `ticketCategories` id-vs-name semantics: the validator does NOT constrain
 * entries to guid format (`z.array(z.string().trim().min(1).max(100))`),
 * unlike `alertRuleIds`/`siteIds`/`deviceGroupIds` (all `.string().guid()`)
 * — a deliberate signal that this field holds the ticket's free-text
 * `category` NAME (`tickets.category`, varchar(100)), not its `categoryId`
 * FK. Matching is per-value rather than picking one column ahead of time: a
 * configured value that parses as a UUID (`PG_UUID_REGEX` — same "would this
 * cast cleanly" pattern the FK-typed columns use elsewhere) is matched
 * against `ctx.categoryId`; every other value is matched against
 * `ctx.category` by exact string equality. This lets an operator configure
 * the filter with either category names or ids (the categories admin UI
 * exposes both) without the filter silently going inert for one or the
 * other.
 */
export function evaluateTicketTriggerFilters(
  triggers: AiAgentTriggers,
  ctx: NonNullable<CreateAgentRunInput['ticketContext']>,
): boolean {
  const categories = triggers.ticketCategories ?? [];
  if (categories.length > 0) {
    const matchesCategory = categories.some((value) => (
      PG_UUID_REGEX.test(value)
        ? ctx.categoryId !== null && value.toLowerCase() === ctx.categoryId.toLowerCase()
        : ctx.category !== null && value === ctx.category
    ));
    if (!matchesCategory) return false;
  }

  const priorities = triggers.ticketPriorities ?? [];
  if (priorities.length > 0 && !priorities.includes(ctx.priority)) return false;

  return true;
}

/**
 * Wave 6 PR 4 (#3828 Task 3) — anomaly-trigger narrowing filters.
 *
 * `anomalyTypes`/`metricNames`/`minAnomalyScore` follow the same
 * narrowing (empty/absent = unrestricted) convention as every OTHER filter
 * here — NOT `alertSeverities`' opt-in-list asymmetry — matching the
 * validator's `.min(1)`-or-undefined declaration for these fields
 * (`packages/shared/src/validators/aiAgents.ts`). `minAnomalyScore` is a
 * floor: the incident's `peakScore` must be `>=` it.
 *
 * The device-bound filters (`siteIds`/`deviceTags`/`deviceGroupIds`) are
 * evaluated with the EXACT same semantics `evaluateAgentTriggerFilters`
 * uses for an alert trigger — anomaly runs are device-bound too (unlike
 * ticket runs), so `deviceGroupIds` reuses `deviceMatchesAnyGroup` directly
 * rather than re-implementing the membership lookup.
 */
export async function evaluateAnomalyTriggerFilters(
  triggers: AiAgentTriggers,
  ctx: NonNullable<CreateAgentRunInput['anomalyContext']>,
  deviceId: string | null,
  orgId: string,
): Promise<boolean> {
  const anomalyTypes = triggers.anomalyTypes ?? [];
  if (anomalyTypes.length > 0 && !anomalyTypes.includes(ctx.anomalyType)) return false;

  const metricNames = triggers.metricNames ?? [];
  if (metricNames.length > 0 && !metricNames.some((name) => ctx.metricNames.includes(name))) return false;

  if (triggers.minAnomalyScore !== undefined && ctx.peakScore < triggers.minAnomalyScore) return false;

  const siteIds = triggers.siteIds ?? [];
  if (siteIds.length > 0 && (ctx.siteId === null || !siteIds.includes(ctx.siteId))) return false;

  const deviceTags = triggers.deviceTags ?? [];
  if (deviceTags.length > 0 && !deviceTags.some((tag) => ctx.deviceTags.includes(tag))) return false;

  const groupIds = triggers.deviceGroupIds ?? [];
  if (groupIds.length > 0) {
    if (deviceId === null) return false;
    if (!(await deviceMatchesAnyGroup(deviceId, orgId, groupIds))) return false;
  }

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
 *
 * `max_concurrent_verdict_runs`/`verdict_rate` (phase 2 P2-1),
 * `max_concurrent_sweep_runs`/`sweep_rate` (phase 2 P2-2) and
 * `max_concurrent_narrative_runs`/`narrative_rate` (phase 2 P2-3) and
 * `max_concurrent_triage_runs`/`triage_rate` (phase 2 P2-4) are
 * deliberately absent: they are volume guards on a scheduled or
 * high-frequency, cheap run shape, not a policy event — see
 * `AgentRunSkipReason`'s docstring.
 */
const PUBLISHED_SKIP_REASONS: ReadonlySet<AgentRunSkipReason> = new Set([
  'circuit_open',
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
 * The freshness predicate shared by the candidate SELECT below and the CAS
 * that actually fails a candidate. Hoisted so the two can never drift apart
 * — the whole point is that both read the SAME cutoff condition.
 *
 * `started_at` is NULL for a run whose job never reached a worker at all
 * (Redis lost it after the enqueue returned), and that row wedges the
 * concurrency count identically — fall back to `queued_at`. Two typed column
 * comparisons rather than one `coalesce(...) < $n` fragment: a bare Date
 * interpolated into a raw `sql` template is handed to postgres.js unencoded
 * and throws ERR_INVALID_ARG_TYPE, because only a column reference carries
 * the timestamp mapper.
 */
function staleClause(cutoff: Date): SQL {
  return or(
    and(isNotNull(aiAgentRuns.startedAt), lt(aiAgentRuns.startedAt, cutoff)),
    and(isNull(aiAgentRuns.startedAt), lt(aiAgentRuns.queuedAt, cutoff)),
  ) as SQL;
}

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
 *
 * A reaped run predates the execution ledger (wave 4a): the SIGKILLed worker
 * that owned it died before `runLoop.ts`'s own cleanup could ever run, so
 * without repairing the ledger here too, a reaped run's `ai_sessions` row (if
 * it has one) is stuck 'active' and its `ai_tool_executions` rows stuck
 * 'executing' forever — nothing else in the codebase reaps them. Best-effort,
 * same as every other ledger write: never allowed to fail the reap itself.
 */
export async function reapStalledAgentRuns(scope: {
  agentId: string;
  orgId: string;
}): Promise<string[]> {
  const cutoff = new Date(Date.now() - STALLED_RUN_AFTER_SECONDS * 1000);
  const stale = staleClause(cutoff);
  // Candidate selection only — the actual terminal write for each candidate
  // routes through `transitionRunStatus` below (wave 6 PR 2, #3828: the
  // terminalization chokepoint), not a raw bulk UPDATE. The patch is
  // byte-identical to the old inline write (`status: 'failed', errorCode:
  // 'stalled', finishedAt`); the write PATH changed AND the atomicity is
  // restored below by passing `stale` back in as the CAS's guard clause —
  // see that call for why the id+status CAS alone is not enough here.
  const candidates = await inSystemDbContext(() => db
    .select({ id: aiAgentRuns.id, sessionId: aiAgentRuns.sessionId })
    .from(aiAgentRuns)
    .where(and(
      eq(aiAgentRuns.agentId, scope.agentId),
      eq(aiAgentRuns.orgId, scope.orgId),
      inArray(aiAgentRuns.status, ['queued', 'running']),
      stale,
    )));
  if (candidates.length === 0) return [];

  const reapedIds: string[] = [];
  for (const row of candidates) {
    // CAS through `transitionRunStatus`, guarded by the SAME `stale` clause
    // the candidate SELECT used — not just id+status. id+status alone is
    // TOCTOU: this loop is sequential (N round trips for N candidates, not
    // one atomic statement) and workers never take this reaper's advisory
    // lock, so a worker can legitimately claim a candidate (queued->running,
    // startedAt=now) between the SELECT above and this call. 'running' is
    // still a valid `from` status, so an id+status-only CAS would happily
    // fail that now-live run as 'stalled' out from under the worker. Passing
    // `stale` back in as the guard re-checks the cutoff atomically with the
    // write, so a row that stopped being stale between the two statements
    // loses the CAS and is silently skipped instead — exactly what the old
    // single bulk UPDATE's WHERE clause would also have excluded. Sequential
    // (not parallel) deliberately: there are at most a handful of stalled
    // rows for one (agent, org) pair.
    const moved = await transitionRunStatus(row.id, ['queued', 'running'], 'failed', {
      errorCode: 'stalled',
      finishedAt: new Date(),
    }, stale);
    if (moved) reapedIds.push(row.id);
  }
  if (reapedIds.length === 0) return [];

  console.warn('[aiAgentRunService] reaped stalled agent runs', {
    agentId: scope.agentId, orgId: scope.orgId, runIds: reapedIds,
  });
  const reapedIdSet = new Set(reapedIds);
  for (const row of candidates) {
    if (!reapedIdSet.has(row.id) || !row.sessionId) continue;
    const sessionId = row.sessionId;
    try {
      await reconcileHungExecutions(sessionId);
    } catch (error) {
      console.error(
        '[aiAgentRunService] failed to reconcile hung executions for a reaped run (non-fatal)',
        { agentId: scope.agentId, orgId: scope.orgId, runId: row.id, sessionId, error },
      );
    }
    try {
      await closeAgentRunSession(sessionId, 'failed');
    } catch (error) {
      console.error(
        '[aiAgentRunService] failed to close the execution-ledger session for a reaped run (non-fatal)',
        { agentId: scope.agentId, orgId: scope.orgId, runId: row.id, sessionId, error },
      );
    }
  }
  return reapedIds;
}

/**
 * Per-profile concurrency/rate caps for admission rule 6b — one exhaustive
 * `switch` replacing what used to be two separate `profile === 'verdict' ?
 * ... : ...` ternaries (phase 2 wave P2-1; P2-2 added a third arm, P2-3 a
 * fourth). Every profile gets its OWN (agent, org) counters and its own pair
 * of skip reasons, so no profile's volume can starve another's admission.
 * The `default: never` assertion is deliberate: a FUTURE profile added to
 * `AI_AGENT_RUN_PROFILES` without a matching arm here must fail to compile
 * rather than silently falling through to inherit `full`'s caps (which a
 * ternary chain would have done for any un-matched value).
 */
function profileCaps(
  profile: AiAgentRunProfile,
  limits: AiAgentLimits,
): { maxConcurrent: number; maxPerHour: number; concurrentSkip: AgentRunSkipReason; rateSkip: AgentRunSkipReason } {
  switch (profile) {
    case 'full':
      return {
        maxConcurrent: limits.maxConcurrentRuns,
        maxPerHour: limits.maxRunsPerHour,
        concurrentSkip: 'max_concurrent_runs',
        rateSkip: 'max_runs_per_hour',
      };
    case 'verdict':
      return {
        maxConcurrent: limits.maxConcurrentVerdictRuns ?? AI_AGENT_LIMIT_DEFAULTS.maxConcurrentVerdictRuns,
        maxPerHour: limits.maxVerdictRunsPerHour ?? AI_AGENT_LIMIT_DEFAULTS.maxVerdictRunsPerHour,
        concurrentSkip: 'max_concurrent_verdict_runs',
        rateSkip: 'verdict_rate',
      };
    case 'sweep':
      return {
        maxConcurrent: limits.maxConcurrentSweepRuns ?? AI_AGENT_LIMIT_DEFAULTS.maxConcurrentSweepRuns,
        maxPerHour: limits.maxSweepRunsPerHour ?? AI_AGENT_LIMIT_DEFAULTS.maxSweepRunsPerHour,
        concurrentSkip: 'max_concurrent_sweep_runs',
        rateSkip: 'sweep_rate',
      };
    case 'narrative':
      return {
        maxConcurrent:
          limits.maxConcurrentNarrativeRuns ?? AI_AGENT_LIMIT_DEFAULTS.maxConcurrentNarrativeRuns,
        maxPerHour: limits.maxNarrativeRunsPerHour ?? AI_AGENT_LIMIT_DEFAULTS.maxNarrativeRunsPerHour,
        concurrentSkip: 'max_concurrent_narrative_runs',
        rateSkip: 'narrative_rate',
      };
    // Phase 2 wave P2-4 (ticket triage), task A6 — same real cap-resolution
    // shape as the verdict/sweep/narrative arms above, counted against
    // maxConcurrentTriageRuns/maxTriageRunsPerHour so triage volume can
    // never starve, or be starved by, any other profile's admission. Task A9
    // is what wires the ticket-created subscriber to actually admit
    // `triage` runs; until then this arm is exercised only by direct/manual
    // callers, not left unenforced.
    case 'triage':
      return {
        maxConcurrent: limits.maxConcurrentTriageRuns ?? AI_AGENT_LIMIT_DEFAULTS.maxConcurrentTriageRuns,
        maxPerHour: limits.maxTriageRunsPerHour ?? AI_AGENT_LIMIT_DEFAULTS.maxTriageRunsPerHour,
        concurrentSkip: 'max_concurrent_triage_runs',
        rateSkip: 'triage_rate',
      };
    default: {
      const exhaustive: never = profile;
      throw new Error(`[profileCaps] Unknown run profile: ${String(exhaustive)}`);
    }
  }
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

  // Branch-review fix (wave 6 PR 3, #3828): `ticketId` must only ever
  // accompany `triggerKind: 'ticket'`. `runLoop.loadRunContext` loads
  // hostile ticket content into the prompt whenever `run.ticketId` is set
  // (runLoop.ts's ticket-context block), gated on ticketId ALONE — not on
  // triggerKind. If a caller ever set `ticketId` on a non-'ticket' trigger
  // (e.g. 'alert'), the forced-shadow override below would need to key on
  // the same condition as that context load, or an 'act'-mode agent could
  // receive hostile ticket content in a non-shadow run. No legitimate
  // caller sends this combination, so it is rejected outright rather than
  // silently admitted — a caller bug, not a skip, same posture as the
  // "org missing" 404 case below.
  if (input.ticketId && triggerKind !== 'ticket') {
    throw new Error(
      `createAndEnqueueAgentRun: ticketId is only valid with triggerKind 'ticket' (got '${triggerKind}')`,
    );
  }

  // Wave 6 PR 4 (#3828 Task 3) — same posture as the ticketId guard above,
  // for the same reason: `runLoop.loadRunContext`'s anomaly-context branch
  // (Task 4) is gated on `run.anomalyIncidentId` alone, and the forced-shadow
  // override two lines below is keyed on the same condition. A caller that
  // set `anomalyIncidentId` on a non-'anomaly' triggerKind would therefore
  // decouple "hostile anomaly evidence reaches the prompt" from "the run is
  // forced shadow" — a caller bug, rejected outright rather than silently
  // admitted.
  if (input.anomalyIncidentId && triggerKind !== 'anomaly') {
    throw new Error(
      `createAndEnqueueAgentRun: anomalyIncidentId is only valid with triggerKind 'anomaly' (got '${triggerKind}')`,
    );
  }

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
  // Wave 6 PR 3 (#3828) — design authority: a ticket-triggered run is ALWAYS
  // shadow, regardless of the agent's configured effective mode. This is a
  // downgrade only ('off' already skipped above at mode_off — a ticket
  // trigger can never turn a disabled agent on). Placed here (immediately
  // after the mode_off check, before the circuit breaker / trigger filter /
  // maintenance-window / admission-counter gates below) so every earlier and
  // later admission rule sees the SAME modeAtStart a real 'act'-mode agent
  // would have produced for any other trigger kind — forcing shadow changes
  // only what the run records and how the guardrail tool gate treats it
  // (aiGuardrails.ts's shadow branch + the device-less-mutation deny, since
  // ticket runs are also always device-less), never admission precedence.
  //
  // Keyed on the SAME condition as `runLoop.loadRunContext`'s ticket-context
  // load (`run.ticketId`, not `triggerKind`) — the guard above already makes
  // `input.ticketId` imply `triggerKind === 'ticket'`, but the OR keeps this
  // check structurally tied to the thing it protects (hostile ticket content
  // reaching an act-mode run) rather than to a value that would silently
  // stop matching if the guard above were ever loosened.
  //
  // Wave 6 PR 4 (#3828 Task 3) — anomaly runs are ALSO always forced shadow
  // (design authority: an unproven detector must never drive act mode).
  // Unlike ticket runs, anomaly runs ARE device-bound, so this downgrade is
  // narrower in effect: it changes only `modeAtStart` (and therefore the
  // guardrail tool gate's shadow branch) — device pinning, site scope, and
  // maintenance-window checks below still apply normally, exactly as they
  // would for any other device-bound trigger.
  //
  // P2-4 Task A6 (#4191) — the forced-shadow LIFT (spec §4.4 amendment).
  // A ticket-triggered run is admitted as `act` ONLY when BOTH gates are
  // open at once: the agent's effective mode is already `act` AND its
  // effective `triggers.ticketAutonomousWrites` is `true` — the SAME
  // org-row-only opt-in `effectivePolicy.ts`'s merge resolves onto
  // `effective` above (never the partner baseline alone; see
  // `AiAgentTriggers.ticketAutonomousWrites`'s docstring). Deliberately
  // narrower than "not forced shadow": the lift is keyed on the ticket
  // condition specifically, so it can never reach the anomaly force below —
  // an unproven detector has no lift at all, full stop.
  const ticketAutonomy = (triggerKind === 'ticket' || input.ticketId)
    && effective.mode === 'act' && effective.triggers.ticketAutonomousWrites === true;
  const modeAtStart = ((triggerKind === 'ticket' || input.ticketId) && !ticketAutonomy)
    || triggerKind === 'anomaly' || input.anomalyIncidentId ? 'shadow' : effective.mode;

  // 2b. Circuit breaker (wave 6 PR 2, #3828). Placed as early as possible
  // after the kill switch — this is the first point `resolved.agentId` is
  // known. Admission-only: an already-admitted, in-flight run is never
  // touched (`agentCircuit.ts`'s header) — this only refuses NEW admissions
  // for an (org, agent) pair a human has not yet reset with MFA.
  if (await isCircuitOpen(orgId, resolved.agentId)) return skip('circuit_open');

  // 2c. Anomaly opt-in gate (wave-6-4 follow-up, #3828) — conservative pilot
  // default: an org must never start receiving anomaly-triggered shadow runs
  // "for free" just because `ml.anomalies.enabled` is on and it happens to
  // have an enabled `triage` agent. Gated on `triggerKind` alone — NOT on
  // `input.anomalyContext` being supplied, unlike the narrowing filters in
  // step 3c below — so there is no path (context supplied or not) that
  // reaches admission for an anomaly trigger without this agent's effective
  // triggers explicitly carrying `anomalyEnabled: true`. See
  // `AiAgentTriggers.anomalyEnabled`'s docstring (packages/shared) for the
  // merge semantics: only the org's OWN trigger override can set this — a
  // partner-wide baseline can never silently opt an org in by itself.
  if (triggerKind === 'anomaly' && effective.triggers.anomalyEnabled !== true) {
    return skip('trigger_filter_mismatch');
  }

  // 3. Trigger filters. Only an event-shaped trigger carries a context; a human
  //    pressing "run now" has already made the selection the filters encode.
  if (input.alertContext
    && !(await evaluateAgentTriggerFilters(effective.triggers, input.alertContext, deviceId, orgId))) {
    return skip('trigger_filter_mismatch');
  }
  // 3b. Ticket trigger filters (wave 6 PR 3 review follow-up, #3828) — same
  // "only an event-shaped trigger carries a context" gating as alertContext
  // above. `ticketContext` is populated by `ticketHelpdeskSubscriber.ts`.
  if (input.ticketContext && !evaluateTicketTriggerFilters(effective.triggers, input.ticketContext)) {
    return skip('trigger_filter_mismatch');
  }
  // 3c. Anomaly trigger filters (wave 6 PR 4, #3828 Task 3) — same
  // "only an event-shaped trigger carries a context" gating as alertContext/
  // ticketContext above. `anomalyContext` is populated by
  // `metricAnomalySubscriber.ts`.
  if (input.anomalyContext
    && !(await evaluateAnomalyTriggerFilters(effective.triggers, input.anomalyContext, deviceId, orgId))) {
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
    // Ticket-triggered runs are always deviceId: null (no device axis for
    // tickets in v1 — wave 6 PR 3, #3828), so this already skips for them
    // with no ticket-specific branch needed: there is no device to be inside
    // a maintenance window of. Same reasoning covers siteIds — ticket runs
    // have no device to resolve a site from, so the siteIds trigger filter
    // (evaluated only when an alertContext is supplied, which ticket
    // admissions never are) is likewise inert for this trigger kind in v1.
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

    // Phase 2 wave P2-1 (alert verdicts). `profileScope` narrows the
    // concurrency/rate counts below (step 6b) to this run's OWN profile, so a
    // burst of cheap verdict-profile runs can never starve — or be starved
    // by — the full triage/patch/helpdesk budget. Ordered agentOrgScope,
    // profileScope, status/queuedAt to match
    // ai_agent_runs_agent_profile_queued_idx (agent_id, org_id, profile,
    // queued_at DESC), the index Task 1 added for exactly these counts.
    const profile: AiAgentRunProfile = input.profile ?? 'full';
    const profileScope = eq(aiAgentRuns.profile, profile);

    // 4c. Release runs a worker can no longer be executing before counting
    //     them, or one SIGKILLed replica wedges this (agent, org) forever.
    await reapStalledAgentRuns({ agentId: resolved.agentId, orgId });

    // 5. Cooldown for this exact target. EVERY non-full profile skips this
    //    entirely (the guard is `profile === 'full'`, not a list, so a new
    //    profile is opted out by default rather than silently inheriting a
    //    window sized for full runs): verdict runs dedupe on `dedupeKey`
    //    (`alert-verdict:<id>` / `group-verdict:<id>`), and sweep/narrative
    //    runs are schedule-driven and already rate-capped by their own
    //    per-profile counters at 6b. A cheap or scheduled run must never
    //    wait out a full-profile agent's cooldown window (or vice versa).
    if (profile === 'full' && effective.cooldownSeconds > 0) {
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

    // 6b. Concurrency and rate — counted PER PROFILE (phase 2 P2-1, P2-2,
    //    P2-3), against that profile's own cap (see `profileCaps` above:
    //    verdict's maxConcurrentVerdictRuns/maxVerdictRunsPerHour, sweep's
    //    maxConcurrentSweepRuns/maxSweepRunsPerHour, narrative's
    //    maxConcurrentNarrativeRuns/maxNarrativeRunsPerHour, full's unchanged
    //    maxConcurrentRuns/maxRunsPerHour). Plain counts are sufficient
    //    BECAUSE step 4b serialises every concurrent admission for this
    //    (agent, org) — they were not before, and the caps were bypassable by
    //    an unbounded factor. The v5/v6 limits fields (`?? AI_AGENT_LIMIT_
    //    DEFAULTS...`, inside profileCaps) may be absent on an older policy
    //    snapshot — same tolerant-read pattern the file uses elsewhere for a
    //    limits field added in a later schema version.
    const caps = profileCaps(profile, effective.limits);
    const [concurrent] = await db
      .select({ value: count() })
      .from(aiAgentRuns)
      .where(and(agentOrgScope, profileScope, inArray(aiAgentRuns.status, ['queued', 'running'])));
    if ((concurrent?.value ?? 0) >= caps.maxConcurrent) {
      return skip(caps.concurrentSkip);
    }

    const [lastHour] = await db
      .select({ value: count() })
      .from(aiAgentRuns)
      .where(and(agentOrgScope, profileScope, gte(aiAgentRuns.queuedAt, new Date(now - 3_600_000))));
    if ((lastHour?.value ?? 0) >= caps.maxPerHour) {
      return skip(caps.rateSkip);
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
        ticketId: input.ticketId ?? null,
        anomalyIncidentId: input.anomalyIncidentId ?? null,
        profile,
        correlationGroupId: input.correlationGroupId ?? null,
        // Phase 2 wave P2-2 (scheduled sweeps).
        scheduleId: input.scheduleId ?? null,
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
        ticketId: input.ticketId ?? null,
        anomalyIncidentId: input.anomalyIncidentId ?? null,
        profile,
        correlationGroupId: input.correlationGroupId ?? null,
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
        // #3828 branch-review blocker 3: wave 6 PR 4 is the first time two
        // trigger kinds can share (org_id, dedupe_key) — the anomaly path's
        // cross-dedupe deliberately collides onto `alert:<linkedAlertId>`.
        // Without this predicate, an enqueue_failed row from a DIFFERENT
        // trigger kind still matches the CAS above, and the SET list
        // (triggerKind/triggerRef/modeAtStart/policySnapshot — all columns
        // ai_agent_runs_immutable_guard() DISTINCT-FROM checks) then raises
        // 23000 the moment triggerKind actually changes. Scoping to the same
        // triggerKind makes a cross-kind collision match nothing here, so it
        // falls through to skip('duplicate') below instead of attempting (and
        // failing) the mutation.
        eq(aiAgentRuns.triggerKind, triggerKind),
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
    // Routed through `transitionRunStatus` (wave 6 PR 2, #3828: the
    // terminalization chokepoint) rather than a raw update. The patch is
    // byte-identical to the old inline write; the caller here still needs the
    // FULL row (its own caller reports `run.status`/`run.errorCode` back to
    // the HTTP client), which `transitionRunStatus`'s boolean return does not
    // carry — a follow-up read is cheap and this path is already an error case.
    const moved = await transitionRunStatus(runId, 'queued', 'failed', {
      errorCode: 'enqueue_failed',
      finishedAt: new Date(),
    });
    if (!moved) return null;
    return await inSystemDbContext(async () => {
      const [row] = await db.select().from(aiAgentRuns).where(eq(aiAgentRuns.id, runId)).limit(1);
      return row ?? null;
    });
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
 *
 * `guard`, when passed, is ANDed into the same WHERE as an extra CAS
 * condition beyond id+status — e.g. `reapStalledAgentRuns` passes back its
 * own staleness cutoff so a row that stopped being stale between its
 * candidate SELECT and this call loses the CAS instead of being wrongly
 * failed. Optional because most callers (runLoop.ts, the cancel route) have
 * no extra predicate — id+status is the whole story for them.
 */
export async function transitionRunStatus(
  runId: string,
  from: AiAgentRunStatus | AiAgentRunStatus[],
  to: AiAgentRunStatus,
  patch: AgentRunStatusPatch = {},
  guard?: SQL,
): Promise<boolean> {
  const fromStatuses = Array.isArray(from) ? from : [from];
  const moved = await inSystemDbContext(async () => {
    const rows = await db
      .update(aiAgentRuns)
      .set({ ...patch, status: to })
      .where(and(eq(aiAgentRuns.id, runId), inArray(aiAgentRuns.status, fromStatuses), guard))
      .returning({
        id: aiAgentRuns.id,
        orgId: aiAgentRuns.orgId,
        agentId: aiAgentRuns.agentId,
        errorCode: aiAgentRuns.errorCode,
        outcome: aiAgentRuns.outcome,
        profile: aiAgentRuns.profile,
      });
    return rows[0] ?? null;
  });
  if (!moved) return false;

  // Circuit-breaker bookkeeping (wave 6 PR 2, #3828). This is the ONE place a
  // run's status becomes terminal (`reapStalledAgentRuns` and
  // `failRunAfterEnqueueFailure` route through here too, see above), so this
  // is the ONE call site for `recordRunTerminal` — see the terminalization
  // contract test (`runService.terminalization.contract.test.ts`), which
  // asserts nothing else in the codebase writes a terminal status onto
  // `ai_agent_runs` directly.
  //
  // Deliberately OUTSIDE the `inSystemDbContext` block above, and wrapped in
  // its own try/catch: a circuit-accounting statement failure must never be
  // able to poison (and therefore roll back at COMMIT time) the run's own
  // terminal-status write — see `agentCircuit.ts`'s `recordRunTerminal`
  // docstring for the exact Postgres trap this avoids (the same one
  // `createAndEnqueueAgentRun`'s dedupe-key reclaim comment documents for a
  // caught 23505). In every call site that reaches an ambient context with no
  // system scope already active (runLoop.ts's every call; this function's own
  // `failRunAfterEnqueueFailure`), the update above has genuinely already
  // committed on its own connection by the time this runs. The one exception
  // — `reapStalledAgentRuns` called from inside admission's own already-open
  // system context — nests into that SAME uncommitted transaction instead,
  // but is safe by construction: its only errorCode ('stalled') always
  // classifies `neutral` (agentCircuit.ts), so `recordRunTerminal` returns
  // before issuing any SQL at all in that path.
  if (isTerminalRunStatus(to)) {
    try {
      const runVerdict: AgentRunVerdict | null =
        moved.outcome.runVerdict === 'needs_attention' ? 'needs_attention' : null;
      await recordRunTerminal(
        { id: moved.id, orgId: moved.orgId, agentId: moved.agentId, profile: moved.profile },
        to,
        moved.errorCode,
        runVerdict,
      );
    } catch (error) {
      console.error('[aiAgentRunService] circuit bookkeeping failed (non-fatal)', {
        runId, orgId: moved.orgId, agentId: moved.agentId, to, error,
      });
    }
  }
  return true;
}
