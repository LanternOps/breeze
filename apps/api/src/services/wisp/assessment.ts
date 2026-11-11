/**
 * Wisp W05b Task 7 (#9917) — the assessment engine's admission, run context
 * and deterministic partner picture (Wisp design §7.1–7.3, §9; w00 "Triage
 * engine (W05)", A33, A34).
 *
 *   enqueueAssessment      flag → entitlement → ceiling → org in ceiling →
 *                          budget → no-changes gate → createAndEnqueueAgentRun({
 *                          grant, profile: 'assessment' }). An exhausted budget
 *                          never pauses the grant: the grantor is told once per
 *                          UTC day and the deterministic digest path records the
 *                          event as a low concern instead (no model call). A
 *                          tick or watch with nothing new since the last clean
 *                          assessment is recorded as a `skipped / no_changes`
 *                          run, also without a model call (#11423).
 *   loadAssessmentContext  the run's bounded context: thread seed, the org's
 *                          live concerns with this grant's recipient state, a
 *                          bounded digest since the watermark (each read
 *                          pinned to the run's org, gated on the grantor's
 *                          permission for it, ≤ 25 rows, sanitised; on a
 *                          first look the alerts are the org's open ones,
 *                          #10389; metric anomalies are the open ones plus
 *                          the reason's trigger, #11425), the reason's watch,
 *                          the org's readiness inventory, and the grantor's
 *                          nudge feedback. null = the grant is no
 *                          longer usable (the run finishes without a model call).
 *   rollupPartnerPicture   deterministic text of every live concern under the
 *                          ceiling → updateThreadPicture.
 *
 * DB access: every read here runs in a FRESH system context
 * (`runOutsideDbContext(withSystemDbAccessContext)`) — callers are the wake
 * worker and the run loop, which already hold the pinned grant id. Admission
 * (`createAndEnqueueAgentRun`) is always called OUTSIDE any DB context, because
 * it announces and enqueues after its own transaction commits (#1105; the same
 * seam as metricAnomalySubscriber.ts).
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  WISP_CHECK_IN_TRIGGER_EVENTS,
  type Concern,
  type ConcernSeverity,
  type ConcernSubject,
  type ConcernSubjectKind,
  type WatchKind,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { alerts } from '../../db/schema/alerts';
import { connectionHealthIncidents } from '../../db/schema/connectionHealth';
import { devices } from '../../db/schema/devices';
import { metricAnomalyEpisodes } from '../../db/schema/metricAnomalyEpisodes';
import { metricAnomalyIncidents } from '../../db/schema/metricAnomalyIncidents';
import { organizations } from '../../db/schema/orgs';
import { tickets } from '../../db/schema/portal';
import { wispGrants } from '../../db/schema/wisp';
import { wispConcerns } from '../../db/schema/wispConcerns';
import { wispEnabled } from '../../config/env';
import { ASSESSMENT_BUDGET_CENTS_PER_RUN } from '../aiAgents/assessmentProfile';
import {
  createAndEnqueueAgentRun,
  transitionRunStatus,
  type AgentRunSkipReason,
  type CreateAgentRunInput,
  type CreateAgentRunResult,
} from '../aiAgents/runService';
import { sanitizeSweepText } from '../aiAgents/runnerPrompt';
import { hasEntitlement } from '../entitlements';
import { captureException } from '../sentry';
import { chargeableUnderGrant, notifyBudgetExhaustedOnce, utcDayWindow } from './budget';
import { CHECK_IN_EVIDENCE_OUTPUT_MAX, type CheckInEvidence } from './checkInTriggers';
import { ConcernSubjectHeldError, listConcernsForCeiling, resolveConcernBySignature, upsertConcern } from './concerns';
import { deliverInApp } from './deliver';
import {
  CeilingViolationError,
  GrantInactiveError,
  assertWithinCeiling,
  resolveGrantCeiling,
  type GrantCeiling,
} from './grantAuthority';
import { recallForGrant } from './memoryBroker';
import { assessableOrgIds } from './assessableOrgs';
import { readinessInventory } from './readiness';
import { getOrCreateThread, seedContextForSession, updateThreadPicture } from './threads';
import { listWatches } from './watches';
import { parseWatchHitSummary } from './watchHits';
import { incWispAssessment } from '../wispMetrics';
import type {
  AssessmentDigest,
  AssessmentReason,
  AssessmentRunContext,
  OrgReadiness,
  WispAssessmentTriggerRef,
} from './assessmentTypes';

export type { AssessmentReason, AssessmentRunContext, AssessmentDigest, WispAssessmentTriggerRef } from './assessmentTypes';
export { assessableOrgIds } from './assessableOrgs';

/**
 * W07 (#11496): every caller-supplied dedupe key starts with this, so it can
 * never collide with a derived `wisp-assess-` key or another trigger's key.
 * `checkInRunDedupeKey` (wisp/checkInRuns.ts) builds it.
 */
export const CHECK_IN_RUN_DEDUPE_PREFIX = 'wisp-check-in-';

/** Rows per digest table (w00: bounded, newest first). */
const DIGEST_ROW_LIMIT = 25;
/** Digest window when the (grant, org) pair has no watermark yet (see lastAssessmentWatermark). */
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** w00 A34: the grantor's last 20 nudge-feedback preference blocks. */
const NUDGE_FEEDBACK_LIMIT = 20;
const NUDGE_FEEDBACK_PREFIX = 'nudge_feedback:';

/** updateThreadPicture's ceiling (it truncates at the same length). */
const PICTURE_MAX_CHARS = 4000;
const PICTURE_SUMMARIES_PER_ORG = 3;
/** sanitizeSweepText appends one '…' past `max`, so 79 keeps each summary ≤ 80. */
const PICTURE_SUMMARY_MAX = 79;
const PICTURE_ORG_NAME_MAX = 80;
/**
 * The orgId of the pseudo-org line that carries partner-level (org_id NULL)
 * concerns in a partner-wide ceiling's picture. Never a uuid, so it cannot
 * collide with a real org; excluded from the header's org counts.
 */
export const PARTNER_WIDE_PICTURE_ORG_ID = 'partner-wide';
const PARTNER_WIDE_PICTURE_NAME = 'Partner-wide';

const SEVERITY_RANK: Readonly<Record<ConcernSeverity, number>> = { high: 3, medium: 2, low: 1, info: 0 };

/**
 * Event reasons the budget-exhausted path records, and the subject kind the
 * concern is keyed on. Anything else records nothing (the floor tick and the
 * next funded assessment cover it).
 */
const DIGEST_EVENT_SUBJECT_KIND: Readonly<Record<string, ConcernSubjectKind>> = {
  'alert.triggered': 'alert',
  'integration.health_opened': 'integration',
  'ticket.stale': 'ticket',
  'ai.operator.task.finished': 'task',
};
/** Recorded only when the task failed (w00: "with a failed outcome"). */
const DIGEST_EVENTS_REQUIRING_FAILURE = new Set(['ai.operator.task.finished']);

function sys<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' && v !== '') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function toIso(v: unknown): string {
  return toDate(v)?.toISOString() ?? '';
}

async function loadGrantPin(grantId: string): Promise<{ partnerId: string; currentRevisionId: string | null } | null> {
  const [row] = await sys(() => db
    .select({ id: wispGrants.id, partnerId: wispGrants.partnerId, currentRevisionId: wispGrants.currentRevisionId })
    .from(wispGrants)
    .where(eq(wispGrants.id, grantId))
    .limit(1), 'wisp.assessment.grantPin');
  return row ? { partnerId: row.partnerId, currentRevisionId: row.currentRevisionId ?? null } : null;
}

/** The grant's live ceiling at its CURRENT revision; null when the grant cannot be used. */
async function currentCeiling(grantId: string): Promise<GrantCeiling | null> {
  const grant = await loadGrantPin(grantId);
  if (!grant?.currentRevisionId) return null;
  try {
    return await resolveGrantCeiling(grantId, grant.currentRevisionId);
  } catch (err) {
    if (err instanceof GrantInactiveError) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

/**
 * What the budget-exhausted path records for an `event` reason. The bus event
 * id alone does not name the subject (events live in Redis streams, not a
 * table), so the wake handler (Task 9), which holds the event payload, passes
 * it here: `alertId` → `{ kind: 'alert' }`, `integration.health_opened`'s
 * incident id → `{ kind: 'integration' }`, `ticketId` → `{ kind: 'ticket' }`,
 * `taskId` → `{ kind: 'task' }` with `failed: state === 'failed'`.
 */
export type DeterministicDigestHint = {
  subject?: ConcernSubject;
  /** `ai.operator.task.finished` only: the task ended in failure. */
  failed?: boolean;
};

function skipAssessment(
  skipped: string,
  outcome: 'skipped_budget' | 'skipped_grant' | 'skipped_admission',
): { skipped: string } {
  incWispAssessment(outcome);
  return { skipped };
}

/**
 * Admit one assessment run for (grant, org). `subject` / `failed` are used
 * only on the budget-exhausted path (see DeterministicDigestHint). Never call
 * this from inside a DB transaction you still hold open: admission enqueues.
 */
export async function enqueueAssessment(
  input: {
    grantId: string;
    orgId: string;
    reason: AssessmentReason;
    /**
     * The queue job's identity (`<jobId>@<job.timestamp>`). When set the
     * dedupe key is derived from it, so a BullMQ retry of the SAME job
     * occurrence lands on the same `(org_id, dedupe_key)` and admission
     * returns `duplicate` instead of a second assessment (W05 carry-over,
     * fixed in W07). Unset → a time-based key (direct callers).
     */
    occurrenceKey?: string;
    /**
     * W07 (#11496): the run's dedupe key, verbatim, in place of the derived
     * one. Only a run-mode check-in sets it (`checkInRunDedupeKey`), so it
     * must start with CHECK_IN_RUN_DEDUPE_PREFIX: one check-in admits at most
     * one run, whichever path fires it and however often it retries.
     */
    dedupeKey?: string;
    /**
     * W07: admit only while this is still the grant's current revision (a
     * run-mode check-in's scheduling revision). Anything else skips as
     * `grant_revision_changed` before the ceiling is resolved or any budget
     * is charged, so a revised grant, wider or narrower, never runs it.
     */
    requireRevisionId?: string;
  } & DeterministicDigestHint,
): Promise<{ runId: string } | { skipped: string }> {
  if (input.dedupeKey !== undefined && !input.dedupeKey.startsWith(CHECK_IN_RUN_DEDUPE_PREFIX)) {
    throw new Error(`enqueueAssessment: a dedupeKey must start with ${CHECK_IN_RUN_DEDUPE_PREFIX}`);
  }
  if (!wispEnabled()) return skipAssessment('wisp_disabled', 'skipped_admission');
  const { grantId, orgId, reason } = input;

  const grant = await loadGrantPin(grantId);
  if (!grant?.currentRevisionId) return skipAssessment('grant_inactive', 'skipped_grant');
  if (input.requireRevisionId !== undefined && grant.currentRevisionId !== input.requireRevisionId) {
    return skipAssessment('grant_revision_changed', 'skipped_grant');
  }
  // Spec §10 claim-time re-check: a partner that lost the entitlement admits nothing.
  if (!(await hasEntitlement(grant.partnerId, 'wisp'))) return skipAssessment('not_entitled', 'skipped_admission');

  let ceiling: GrantCeiling;
  try {
    ceiling = await resolveGrantCeiling(grantId, grant.currentRevisionId);
  } catch (err) {
    if (err instanceof GrantInactiveError) return skipAssessment('grant_inactive', 'skipped_grant');
    throw err;
  }
  // Same spelling as W02's admission skip (step 1d), which re-checks it.
  if (!ceiling.orgIds.has(orgId)) return skipAssessment('grant_org_out_of_ceiling', 'skipped_grant');
  if (!assessableOrgIds(ceiling).has(orgId)) return skipAssessment('grant_org_site_restricted', 'skipped_grant');

  const budget = await chargeableUnderGrant(grantId, ASSESSMENT_BUDGET_CENTS_PER_RUN);
  if (!budget.ok) {
    // The model stops; the bookkeeping does not. Both steps are attempted even
    // if one fails, then the first failure surfaces. pauseGrant is never called.
    const failures: unknown[] = [];
    await notifyBudgetExhaustedOnce(grantId).catch((err: unknown) => { failures.push(err); });
    await recordDeterministicDigest(grantId, orgId, reason, { subject: input.subject, failed: input.failed, ceiling })
      .catch((err: unknown) => { failures.push(err); });
    if (failures.length > 0) throw failures[0];
    return skipAssessment('budget_exhausted', 'skipped_budget');
  }

  const watermark = await lastAssessmentWatermark(grantId, orgId);
  const triggerRef: WispAssessmentTriggerRef = {
    grantId,
    grantRevisionId: ceiling.revisionId,
    // #10389: a floor tick for an org this grant has never assessed (orgs past
    // onboarding's first 10 reach Wisp this way) is that org's first look, so
    // it runs as onboarding: first-look framing and the readiness note. Event
    // and watch reasons keep their reason; loadAssessmentContext still gives
    // them the first-look digest.
    reason: watermark === null && reason.kind === 'tick' ? { kind: 'onboarding' } : reason,
    watermark: watermark?.toISOString() ?? null,
  };
  const admission: CreateAgentRunInput = {
    orgId,
    kind: 'triage',
    triggerKind: 'schedule',
    deviceId: null,
    profile: 'assessment',
    dedupeKey: input.dedupeKey ?? (input.occurrenceKey
      ? `wisp-assess-${grantId}-${orgId}-o${createHash('sha256').update(input.occurrenceKey).digest('hex').slice(0, 24)}`
      : `wisp-assess-${grantId}-${orgId}-${Date.now()}`),
    triggerRef: { wisp: triggerRef },
    grant: { grantId, grantRevisionId: ceiling.revisionId },
  };

  // #11423: a tick (or alert_pattern watch) for an org where nothing changed
  // since its last clean assessment makes no model call. The model was the
  // gate before: a Sonnet call to answer "Nothing changed" (issue #11423).
  if (await nothingChangedSinceLastLook(ceiling, triggerRef.reason, watermark, orgId)) {
    return recordNoChangesSkip(admission, grantId, ceiling.partnerId, orgId);
  }

  // #1105: admission opens its own context and enqueues after commit, so it
  // must not run inside a caller's (request or system) context.
  const result = await runOutsideDbContext(() => createAndEnqueueAgentRun(admission));
  return settleAdmission(result, grantId, ceiling.partnerId, orgId);
}

/** The admission result → enqueueAssessment's result, with the no-agent readiness bookkeeping. */
async function settleAdmission(
  result: CreateAgentRunResult,
  grantId: string,
  partnerId: string,
  orgId: string,
): Promise<{ runId: string } | { skipped: string }> {
  if (result.created) {
    incWispAssessment('admitted');
    await clearNoAgentReadiness(partnerId, orgId);
    return { runId: result.run.id };
  }
  // An enabled Triage agent resolved (the skip is something else), so a stale "no agent" concern is false: close it.
  if (NO_ENABLED_TRIAGE_AGENT_SKIPS.has(result.skipped)) await raiseNoAgentReadiness(grantId, partnerId, orgId);
  else await clearNoAgentReadiness(partnerId, orgId);
  return skipAssessment(result.skipped, 'skipped_admission');
}

// ---------------------------------------------------------------------------
// No-changes gate (#11423)
// ---------------------------------------------------------------------------

/** `ai_agent_runs.error_code` of an assessment skipped because nothing changed. */
export const NO_CHANGES_ERROR_CODE = 'no_changes';
const NO_CHANGES_SUMMARY = 'Nothing changed since the last assessment, so Wisp made no model call.';

/**
 * Watch kinds whose hits are rows the probe reads, so "no change" means "no
 * new or cleared hit": an alert_pattern watch's hits are alerts. Every other
 * kind always runs:
 *   ticket_waiting       fires BECAUSE a ticket did not change;
 *   backup_health, patch_compliance, security_findings, custom_query
 *                        are judged through tools, on state the digest does
 *                        not read;
 *   ticket_cluster       has its own deterministic poller.
 * #11424 makes watches stateful (a stored hit-set), which supersedes this.
 */
const DIGEST_EVALUATED_WATCH_KINDS: ReadonlySet<WatchKind> = new Set<WatchKind>(['alert_pattern']);

/**
 * Pure. True when this request may be skipped because nothing changed. It
 * needs an earlier clean assessment to compare against (a watermark; `reason`
 * as recorded, so a first-look tick is already `onboarding`), and a tick, or
 * a watch of a DIGEST_EVALUATED_WATCH_KINDS kind. An `event` names something
 * to look at and `onboarding` is a first look: both always run, as does a
 * watch whose kind is unknown (`watchKind` null: the watch is gone).
 */
export function noChangesGateApplies(reason: AssessmentReason, watermark: Date | null, watchKind: WatchKind | null = null): boolean {
  if (watermark === null) return false;
  if (reason.kind === 'tick') return true;
  return reason.kind === 'watch' && watchKind !== null && DIGEST_EVALUATED_WATCH_KINDS.has(watchKind);
}

/**
 * The gate's reads. Fails open: the gate only saves money, so if any read
 * throws, the assessment runs as it did before the gate, and the error is
 * reported rather than blocking every tick and watch until it is fixed.
 */
async function nothingChangedSinceLastLook(
  ceiling: GrantCeiling,
  reason: AssessmentReason,
  watermark: Date | null,
  orgId: string,
): Promise<boolean> {
  if (watermark === null || (reason.kind !== 'tick' && reason.kind !== 'watch')) return false;
  try {
    const watchKind = reason.kind === 'watch'
      ? (await listWatches(ceiling)).find((w) => w.id === reason.watchId)?.kind ?? null
      : null;
    if (!noChangesGateApplies(reason, watermark, watchKind)) return false;
    const since = await lastCleanAssessmentFinish(ceiling.grantId, orgId);
    return since !== null && (await firstChangedDigestSource(ceiling, ceiling.grantId, orgId, since)) === null;
  } catch (err) {
    console.error('[wisp.assessment] no-changes probe failed; running the assessment', {
      grantId: ceiling.grantId, orgId, reason: reason.kind, error: err instanceof Error ? err.message : String(err),
    });
    captureException(err, undefined, { component: 'wisp', op: 'wisp.assessment.noChangesProbe', grantId: ceiling.grantId, orgId });
    return false;
  }
}

/** What the gate probes, in probe order. */
export type DigestChangeSource = 'alerts' | 'tickets' | 'incidents' | 'runs' | 'intents' | 'anomalies' | 'concerns';

/**
 * `finished_at` of the latest assessment of (grant, org) that finished
 * cleanly: the same runs lastAssessmentWatermark reads, so it is the end of
 * the run the next digest window starts at. null when there is none (or it
 * has no finish time), and then the gate does not apply.
 */
async function lastCleanAssessmentFinish(grantId: string, orgId: string): Promise<Date | null> {
  const [row] = await sys(() => db
    .select({ at: sql<Date | string | null>`max(${aiAgentRuns.finishedAt})` })
    .from(aiAgentRuns)
    .where(and(
      eq(aiAgentRuns.grantId, grantId),
      eq(aiAgentRuns.orgId, orgId),
      eq(aiAgentRuns.profile, 'assessment'),
      inArray(aiAgentRuns.status, [...WATERMARK_RUN_STATUSES]),
      or(isNull(aiAgentRuns.errorCode), ne(aiAgentRuns.errorCode, PARTIALLY_APPLIED_ERROR_CODE)),
      notCheckInRun(),
    )), 'wisp.assessment.noChangesAnchor');
  return toDate(row?.at);
}

/**
 * W07 (#11496): not a run check-in's assessment. That run answers one
 * follow-up the person asked for, so it never moves the org's digest
 * watermark or the no-changes anchor: the next tick still sees every change
 * since the last full look. Null-safe: a row with no reason kind is kept.
 */
function notCheckInRun(): SQL {
  return sql`coalesce(${aiAgentRuns.triggerRef} -> 'wisp' -> 'reason' ->> 'kind', '') <> ${'check_in'}`;
}

/** Not a row the no-changes gate wrote (null-safe: a null error_code is kept). */
function notNoChangesSkip(): SQL {
  return or(
    ne(aiAgentRuns.status, 'skipped'),
    isNull(aiAgentRuns.errorCode),
    ne(aiAgentRuns.errorCode, NO_CHANGES_ERROR_CODE),
  ) as SQL;
}

/**
 * The first digest source with a change since `since` (the last clean
 * assessment's FINISH), or null when there is none. Each probe starts from
 * the digest's predicate for its table (loadDigest), widened where the digest
 * would miss a change of state, and is gated on the same grantor permission,
 * so a section that would render empty is not probed:
 *
 *   alerts     triggered, acknowledged, dismissed or resolved since (an
 *              acknowledgement clears an "unacknowledged alert" watch hit)
 *   tickets    updated since
 *   incidents  opened since, with a view permission inside the ceiling
 *   runs       queued or finished since — not a no_changes skip, not another
 *              grant's assessment, not a specialist (depth > 0). Wisp's own
 *              bookkeeping is not news: counting another grant's runs would
 *              have two grants on one org wake each other for ever, and a
 *              specialist's finish (or failure) is its own
 *              `ai.agent.run.completed` / `.failed` event, which always runs.
 *   intents    created, or changed status, since
 *   anomalies  (#11425) the open set the digest shows changed since: an
 *              incident announced since (anomalyIncidentAnnounced) whose
 *              episode is still open joined it, or the episode of an
 *              announced incident closed since and took it off. A close is
 *              `resolved_at` since, or, for a `resolved` episode, `updated_at`
 *              since: the automatic close (metricAnomalyEpisodes.ts) backdates
 *              `resolved_at` to the end of the anomalous data, which can
 *              precede `since`, but stamps `updated_at` with the close, and a
 *              resolved episode is never live again, so that stamp stays. A
 *              `dismissed` episode is read by `resolved_at` only (the
 *              dismissal stamps it): a snoozed one stays live and keeps
 *              refreshing `updated_at`, which would wake every tick. An open
 *              incident's later detector updates do not count: they do not
 *              change which anomalies are open. An incident with no episode
 *              row is never listed as open, so the join is INNER.
 *   concerns   (no permission: the run always reads them) updated since,
 *              unless the last write was an assessment finalizer's — its
 *              `last_assessed_run_id` names a run that finished at or after
 *              the write. That covers the touch loop (assessmentFinalizer
 *              stamps every open concern the run read, before finishRun sets
 *              finished_at) and the run's other concern writes. Writes by
 *              people, chat or the budget-exhausted path still count.
 *
 * Measuring from the FINISH, not the watermark (the start), keeps the last
 * run's own writes out. The cost: a change that landed while that run was in
 * flight, after it read its digest, waits for the next change or event; the
 * next model run still reads it, because a skip never moves the watermark.
 */
async function firstChangedDigestSource(
  ceiling: GrantCeiling,
  grantId: string,
  orgId: string,
  since: Date,
): Promise<DigestChangeSource | null> {
  const may = (section: keyof typeof DIGEST_SECTION_PERMISSION) =>
    ceilingAllows(ceiling, orgId, DIGEST_SECTION_PERMISSION[section]);
  const any = async (rows: Promise<unknown[]>) => (await rows).length > 0;
  return sys(async () => {
    if (may('alerts') && await any(db.select({ id: alerts.id }).from(alerts)
      .where(and(eq(alerts.orgId, orgId), or(
        gte(alerts.triggeredAt, since), gte(alerts.acknowledgedAt, since), gte(alerts.dismissedAt, since), gte(alerts.resolvedAt, since),
      )))
      .limit(1))) return 'alerts';
    if (may('tickets') && await any(db.select({ id: tickets.id }).from(tickets)
      .where(and(eq(tickets.orgId, orgId), gte(tickets.updatedAt, since)))
      .limit(1))) return 'tickets';
    if (may('incidents')) {
      const present = await db
        .selectDistinct({ viewPermission: connectionHealthIncidents.viewPermission })
        .from(connectionHealthIncidents)
        .where(and(eq(connectionHealthIncidents.orgId, orgId), gte(connectionHealthIncidents.openedAt, since)));
      if (present.some((p) => ceilingAllows(ceiling, orgId, p.viewPermission))) return 'incidents';
    }
    if (may('runs') && await any(db.select({ id: aiAgentRuns.id }).from(aiAgentRuns)
      .where(and(
        eq(aiAgentRuns.orgId, orgId),
        or(gte(aiAgentRuns.queuedAt, since), gt(aiAgentRuns.finishedAt, since)),
        eq(aiAgentRuns.depth, 0),
        or(ne(aiAgentRuns.profile, 'assessment'), and(eq(aiAgentRuns.grantId, grantId), notNoChangesSkip())),
      ))
      .limit(1))) return 'runs';
    if (may('intents') && await any(db.select({ id: actionIntents.id }).from(actionIntents)
      .where(and(
        eq(actionIntents.orgId, orgId),
        or(gte(actionIntents.createdAt, since), gt(actionIntents.statusChangedAt, since)),
      ))
      .limit(1))) return 'intents';
    if (may('anomalies') && await any(db.select({ id: metricAnomalyIncidents.id }).from(metricAnomalyIncidents)
      .innerJoin(metricAnomalyEpisodes, and(
        eq(metricAnomalyEpisodes.id, metricAnomalyIncidents.episodeId),
        eq(metricAnomalyEpisodes.orgId, metricAnomalyIncidents.orgId),
      ))
      .where(and(
        eq(metricAnomalyIncidents.orgId, orgId),
        anomalyIncidentAnnounced(),
        or(
          and(eq(metricAnomalyEpisodes.status, 'open'), gte(metricAnomalyIncidents.dispatchedAt, since)),
          and(ne(metricAnomalyEpisodes.status, 'open'), or(
            gte(metricAnomalyEpisodes.resolvedAt, since),
            and(eq(metricAnomalyEpisodes.status, 'resolved'), gte(metricAnomalyEpisodes.updatedAt, since)),
          )),
        ),
      ))
      .limit(1))) return 'anomalies';
    if (await any(db.select({ id: wispConcerns.id }).from(wispConcerns)
      .where(and(
        eq(wispConcerns.orgId, orgId),
        gte(wispConcerns.updatedAt, since),
        sql`NOT EXISTS (SELECT 1 FROM ai_agent_runs r
                         WHERE r.id = ${wispConcerns.lastAssessedRunId}
                           AND r.profile = 'assessment'
                           AND r.finished_at >= ${wispConcerns.updatedAt})`,
      ))
      .limit(1))) return 'concerns';
    return null;
  }, 'wisp.assessment.noChangesProbe');
}

/**
 * Record the skip as an `ai_agent_runs` row — `skipped`, `no_changes`, zero
 * cost, never started — so the brief can count what was saved (#11428) and
 * the round-robin (wake.ts loadLastAssessedByOrg) moves on to the next org.
 *
 * The row goes through admission like any run (agent, policy snapshot, caps,
 * dedupe, the no-agent readiness concern), with the enqueue deferred and
 * never called; the queued → skipped transition is the one terminal write
 * path (runService.terminalization contract). If that transition fails the
 * admitted run is enqueued after all: an extra model call, never a row left
 * `queued` with no job holding the org's concurrency slot.
 */
async function recordNoChangesSkip(
  admission: CreateAgentRunInput,
  grantId: string,
  partnerId: string,
  orgId: string,
): Promise<{ runId: string } | { skipped: string }> {
  const result = await runOutsideDbContext(() => createAndEnqueueAgentRun(admission, { deferEnqueue: true }));
  if (!result.created) return settleAdmission(result, grantId, partnerId, orgId);
  const runId = result.run.id;
  let recorded = false;
  try {
    recorded = await runOutsideDbContext(() => transitionRunStatus(runId, 'queued', 'skipped', {
      errorCode: NO_CHANGES_ERROR_CODE,
      summary: NO_CHANGES_SUMMARY,
      finishedAt: new Date(),
    }));
    if (!recorded) console.warn('[wisp.assessment] no_changes skip lost its queued → skipped CAS; enqueueing the run', { runId, grantId, orgId });
  } catch (err) {
    console.error('[wisp.assessment] could not record a no_changes skip; enqueueing the run', {
      runId, grantId, orgId, error: err instanceof Error ? err.message : String(err),
    });
    captureException(err, undefined, { component: 'wisp', op: 'wisp.assessment.noChangesSkip', runId, orgId });
  }
  if (recorded) {
    incWispAssessment('skipped_no_changes');
    await clearNoAgentReadiness(partnerId, orgId);
    return { skipped: NO_CHANGES_ERROR_CODE };
  }
  if (!result.enqueue) throw new Error(`createAndEnqueueAgentRun returned no deferred enqueue for run ${runId}`);
  const enqueue = result.enqueue;
  return settleAdmission(await runOutsideDbContext(() => enqueue()), grantId, partnerId, orgId);
}

/**
 * #10143: Wisp looks idle, not blocked, when an org has no effective AI agent.
 * #10292: an assessment is a `triage` run, so readiness is "an ENABLED Triage
 * agent resolves" by the same partner-baseline → org-override merge admission
 * uses (resolveEffectiveAgentSystem, then `effective.enabled` / `mode`). An
 * agent of another kind never satisfies it, and one that resolves but is
 * turned off blocks Wisp just the same — the copy names the kind for both.
 */
const NO_ENABLED_TRIAGE_AGENT_SKIPS: ReadonlySet<string> = new Set<AgentRunSkipReason>(['no_effective_agent', 'agent_disabled', 'mode_off']);
const noAgentSignature = (orgId: string): string => `wisp-readiness:no-effective-agent:${orgId}`;
const NO_AGENT_SUMMARY =
  "Wisp can't check this organization yet — its checks run as your Triage agent, and no Triage agent is set up "
  + 'and switched on here (other agent kinds don\'t count). Create one, or check its status and mode, under Settings → AI Agents.';
const NO_AGENT_HREF = '/settings/ai-agents';

/**
 * Upsert (keyed by signature, so once per org however many ticks skip). Best
 * effort: never changes the skip. Subject `readiness`, not `org` (#10386).
 * The slot can only be held by the onboarding readiness note (system-only
 * kind); with no agent that inventory is moot, so it yields once.
 */
async function raiseNoAgentReadiness(grantId: string, partnerId: string, orgId: string): Promise<void> {
  const raise = () => upsertConcern({
    partnerId,
    orgId,
    subject: { kind: 'readiness', id: orgId },
    summary: NO_AGENT_SUMMARY,
    severity: 'info',
    evidence: { href: NO_AGENT_HREF, reason: 'no_effective_agent' },
    signature: noAgentSignature(orgId),
    raisedByGrantId: grantId,
  });
  try {
    try {
      await raise();
    } catch (err) {
      if (!(err instanceof ConcernSubjectHeldError)) throw err;
      // Retry only when the onboarding note (`readiness:<org>`, written by
      // assessmentFinalizer.applyReadiness) was the holder and is now closed.
      const { resolved } = await resolveConcernBySignature(partnerId, `readiness:${orgId}`, 'superseded_no_effective_agent');
      if (!resolved) throw err;
      await raise();
    }
  } catch (err) {
    captureException(err, undefined, { wisp_op: 'raise_no_agent_readiness' }, { fingerprint: ['wisp-readiness', 'raise'] });
  }
}

/** An assessment was admitted, so an agent exists: close the readiness concern. Best effort. */
async function clearNoAgentReadiness(partnerId: string, orgId: string): Promise<void> {
  try {
    await resolveConcernBySignature(partnerId, noAgentSignature(orgId), 'ai_agent_configured');
  } catch (err) {
    captureException(err, undefined, { wisp_op: 'clear_no_agent_readiness' }, { fingerprint: ['wisp-readiness', 'clear'] });
  }
}

/** Run statuses that finished an assessment cleanly enough to advance the watermark. */
const WATERMARK_RUN_STATUSES = ['completed', 'awaiting_approval'] as const;
/** The finalizer's error code for dropped work (aiAgents/assessmentFinalizer.ts). */
const PARTIALLY_APPLIED_ERROR_CODE = 'assessment_partially_applied';

/**
 * Where the next assessment's digest window starts for (grant, org): the
 * START (`started_at`, else `queued_at`) of the latest assessment run that
 * finished cleanly; null when there is none (the caller falls back to 24 h).
 * Deliberate departure from the plan's MAX(finished_at) of completed runs:
 *   - `awaiting_approval` counts: a run whose propose_action left a pending
 *     intent did its job; excluding it would re-read the same window and
 *     could propose the same action again.
 *   - the START, not the finish: an event that lands while run A is running
 *     (after A loaded its digest, before A finished) is in neither A's window
 *     nor — with MAX(finished_at) — the next run's. The overlap this leaves is
 *     harmless: concerns upsert idempotently.
 *   - a run whose finalizer returned `assessment_partially_applied` (stored in
 *     `error_code`) does not advance it, so the dropped work is re-assessed.
 */
export async function lastAssessmentWatermark(grantId: string, orgId: string): Promise<Date | null> {
  const [row] = await sys(() => db
    .select({ at: sql<Date | string | null>`max(coalesce(${aiAgentRuns.startedAt}, ${aiAgentRuns.queuedAt}))` })
    .from(aiAgentRuns)
    .where(and(
      eq(aiAgentRuns.grantId, grantId),
      eq(aiAgentRuns.orgId, orgId),
      eq(aiAgentRuns.profile, 'assessment'),
      inArray(aiAgentRuns.status, [...WATERMARK_RUN_STATUSES]),
      or(isNull(aiAgentRuns.errorCode), ne(aiAgentRuns.errorCode, PARTIALLY_APPLIED_ERROR_CODE)),
      notCheckInRun(),
    )), 'wisp.assessment.watermark');
  return toDate(row?.at);
}

/**
 * The budget-exhausted deterministic path (spec §9): for an event reason in
 * DIGEST_EVENT_SUBJECT_KIND whose subject the caller named, upsert a `low`
 * concern on that subject, then deliver the day's single digest notice
 * (dedupe key per grant and UTC day; later events the same day add concerns
 * only — the concerns list is the digest). Tick, watch and onboarding reasons
 * record nothing. `ceiling` lets enqueueAssessment reuse the one it resolved.
 */
export async function recordDeterministicDigest(
  grantId: string,
  orgId: string,
  reason: AssessmentReason,
  opts: DeterministicDigestHint & { ceiling?: GrantCeiling; now?: Date } = {},
): Promise<{ recorded: false } | { recorded: true; concernId: string; created: boolean }> {
  if (reason.kind !== 'event') return { recorded: false };
  const expectedKind = DIGEST_EVENT_SUBJECT_KIND[reason.eventType];
  if (!expectedKind) return { recorded: false };
  if (DIGEST_EVENTS_REQUIRING_FAILURE.has(reason.eventType) && opts.failed !== true) return { recorded: false };
  if (!opts.subject || opts.subject.kind !== expectedKind || opts.subject.id === '') {
    console.warn('[wisp.assessment] budget-exhausted event without a matching subject; nothing recorded', {
      grantId, orgId, eventType: reason.eventType, eventId: reason.eventId, subjectKind: opts.subject?.kind ?? null,
    });
    return { recorded: false };
  }
  if (opts.ceiling && opts.ceiling.grantId !== grantId) {
    throw new Error(`recordDeterministicDigest: ceiling of grant ${opts.ceiling.grantId} passed for grant ${grantId}`);
  }
  const ceiling = opts.ceiling ?? await currentCeiling(grantId);
  if (!ceiling || !ceiling.orgIds.has(orgId)) return { recorded: false };

  const { id: concernId, created } = await upsertConcern({
    partnerId: ceiling.partnerId,
    orgId,
    subject: opts.subject,
    summary: `${reason.eventType} (recorded while Wisp's budget was exhausted)`,
    severity: 'low',
    evidence: { eventId: reason.eventId, recordedWithoutModel: true },
    raisedByGrantId: grantId,
  });

  const thread = await getOrCreateThread(grantId);
  const link = `/ai/wisp/thread/${thread.id}`;
  await deliverInApp({
    userId: ceiling.grantorUserId,
    orgId,
    title: 'Wisp is noting events without review today',
    body: "Today's budget is spent, so Wisp records new events as concerns without looking into them. They are listed in the thread.",
    link,
    dedupeKey: `wisp-digest-${grantId}-${utcDayWindow(opts.now ?? new Date()).key}`,
    threadId: thread.id,
    grantId,
    deepLink: link,
  });
  return { recorded: true, concernId, created };
}

// ---------------------------------------------------------------------------
// Run context
// ---------------------------------------------------------------------------

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

function parseReason(v: unknown): AssessmentReason | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  switch (r.kind) {
    case 'event':
      // #10388: the subject ids are rendered into the prompt, so anything but
      // a uuid is dropped rather than carried.
      return isNonEmptyString(r.eventType) && isNonEmptyString(r.eventId)
        ? {
          kind: 'event',
          eventType: r.eventType,
          eventId: r.eventId,
          ...(isUuid(r.alertId) ? { alertId: r.alertId } : {}),
          ...(isUuid(r.deviceId) ? { deviceId: r.deviceId } : {}),
          ...(isUuid(r.anomalyIncidentId) ? { anomalyIncidentId: r.anomalyIncidentId } : {}),
        }
        : null;
    case 'tick':
      return { kind: 'tick' };
    case 'watch': {
      if (!isNonEmptyString(r.watchId)) return null;
      // #11424: the scheduler's hit summary; a malformed one is dropped, not the reason.
      const hits = parseWatchHitSummary(r.hits);
      return hits ? { kind: 'watch', watchId: r.watchId, hits } : { kind: 'watch', watchId: r.watchId };
    }
    case 'onboarding':
      return { kind: 'onboarding' };
    case 'on_demand':
      return isNonEmptyString(r.requestId) ? { kind: 'on_demand', requestId: r.requestId } : null;
    case 'check_in':
      // W07: the instruction is rendered into the prompt (single-lined there);
      // malformed evidence is dropped, never the reason.
      return isUuid(r.checkInId) && isNonEmptyString(r.instruction)
        ? { kind: 'check_in', checkInId: r.checkInId, instruction: r.instruction, evidence: parseCheckInEvidence(r.evidence) }
        : null;
    default:
      return null;
  }
}

const TRIGGER_EVENTS: ReadonlySet<string> = new Set(WISP_CHECK_IN_TRIGGER_EVENTS);
const EVIDENCE_STATUS_MAX = 64;

/** A check_in reason's evidence as stored; null when absent or not the shape triggerConditionOf writes. */
function parseCheckInEvidence(v: unknown): CheckInEvidence | null {
  if (typeof v !== 'object' || v === null) return null;
  const e = v as Record<string, unknown>;
  if (typeof e.kind !== 'string' || !TRIGGER_EVENTS.has(e.kind)) return null;
  if (!isNonEmptyString(e.status) || e.status.length > EVIDENCE_STATUS_MAX) return null;
  const at = typeof e.at === 'string' ? toDate(e.at) : null;
  if (!at) return null;
  const out: CheckInEvidence = { kind: e.kind as CheckInEvidence['kind'], status: e.status, at: at.toISOString() };
  if (e.exitCode === null || (typeof e.exitCode === 'number' && Number.isInteger(e.exitCode))) out.exitCode = e.exitCode as number | null;
  if (typeof e.outputHead === 'string' && e.outputHead !== '') out.outputHead = Array.from(e.outputHead).slice(0, CHECK_IN_EVIDENCE_OUTPUT_MAX).join('');
  if (e.lastSeenAt === null) out.lastSeenAt = null;
  else if (typeof e.lastSeenAt === 'string') {
    const seen = toDate(e.lastSeenAt);
    if (seen) out.lastSeenAt = seen.toISOString();
  }
  return out;
}

/** `ai_agent_runs.trigger_ref.wisp` → WispAssessmentTriggerRef; null when absent or malformed. */
export function parseWispTriggerRef(triggerRef: Record<string, unknown> | null | undefined): WispAssessmentTriggerRef | null {
  const raw = triggerRef?.wisp;
  if (typeof raw !== 'object' || raw === null) return null;
  const w = raw as Record<string, unknown>;
  if (!isNonEmptyString(w.grantId) || !isNonEmptyString(w.grantRevisionId)) return null;
  const reason = parseReason(w.reason);
  if (!reason) return null;
  let watermark: string | null = null;
  if (w.watermark !== null && w.watermark !== undefined) {
    const d = typeof w.watermark === 'string' ? toDate(w.watermark) : null;
    if (!d) return null;
    watermark = d.toISOString();
  }
  return { grantId: w.grantId, grantRevisionId: w.grantRevisionId, reason, watermark };
}

/**
 * The human permission each digest section needs — what a person holding the
 * grantor's delegated authority would need to read the same rows:
 *   alerts     alerts:read (PERMISSIONS.ALERTS_READ)
 *   tickets    tickets:read (PERMISSIONS.TICKETS_READ)
 *   incidents  organizations:read (routes/connectionHealth.ts GET /incidents),
 *              plus each incident's own `view_permission`, the route's
 *              per-row rule (see loadDigestIncidents)
 *   runs       ai_agents:read (routes/aiAgents.ts GET /runs; the
 *              `list_ai_agent_runs` tool)
 *   intents    ai_agents:read — no list route reads intents; a run's intents
 *              are read on its detail (routes/aiAgents.ts GET /runs/:runId),
 *              so they follow the runs section. approvals:decide is a DECIDE
 *              right, not a read one.
 *   anomalies  devices:read (routes/devices/anomalies.ts GET list and the
 *              episode reads; the `manage_device_anomalies` list action)
 */
const DIGEST_SECTION_PERMISSION = {
  alerts: 'alerts:read',
  tickets: 'tickets:read',
  incidents: 'organizations:read',
  runs: 'ai_agents:read',
  intents: 'ai_agents:read',
  anomalies: 'devices:read',
} as const;

/** The grantor may read `permission` in `orgId` under this ceiling (org term included). */
function ceilingAllows(ceiling: GrantCeiling, orgId: string, permission: string): boolean {
  try {
    assertWithinCeiling(ceiling, { orgId, permission });
    return true;
  } catch (err) {
    if (err instanceof CeilingViolationError) return false;
    throw err;
  }
}

/**
 * Bounded reads, each pinned to `orgId` (the ceiling admitted the org; the
 * pin is the second lock) and each gated on the grantor's permission for it
 * (DIGEST_SECTION_PERMISSION): a section the grantor may not read renders
 * empty and issues no query. The sections use the `since` window, except the
 * alerts on a first look (the org's open alerts, loadOpenAlertRows) and the
 * metric anomalies, which are always current state (loadAnomalySection). The
 * metric anomalies read runs in its own system context, after the others.
 */
async function loadDigest(
  ceiling: GrantCeiling,
  orgId: string,
  currentRunId: string,
  since: Date,
  firstLook: boolean,
  anomalyIncidentId: string | null,
): Promise<AssessmentDigest> {
  const may = (section: keyof typeof DIGEST_SECTION_PERMISSION) =>
    ceilingAllows(ceiling, orgId, DIGEST_SECTION_PERMISSION[section]);
  const base = await sys(async () => {
    const alertRows = !may('alerts') ? [] : firstLook ? await loadOpenAlertRows(orgId) : await db
      .select({
        id: alerts.id, title: alerts.title, severity: alerts.severity, status: alerts.status,
        at: alerts.triggeredAt, resolvedAt: alerts.resolvedAt,
      })
      .from(alerts)
      // #10388: an alert resolved since the watermark is a change too (a
      // resolve event must leave the run something to read), ordered by
      // whichever of the two happened last.
      .where(and(eq(alerts.orgId, orgId), or(gte(alerts.triggeredAt, since), gte(alerts.resolvedAt, since))))
      .orderBy(desc(sql`GREATEST(${alerts.triggeredAt}, ${alerts.resolvedAt})`))
      .limit(DIGEST_ROW_LIMIT);
    const ticketRows = !may('tickets') ? [] : await db
      .select({ id: tickets.id, number: tickets.ticketNumber, title: tickets.subject, status: tickets.status, updatedAt: tickets.updatedAt })
      .from(tickets)
      .where(and(eq(tickets.orgId, orgId), gte(tickets.updatedAt, since)))
      .orderBy(desc(tickets.updatedAt))
      .limit(DIGEST_ROW_LIMIT);
    const incidentRows = !may('incidents') ? [] : await loadDigestIncidents(ceiling, orgId, since);
    const runRows = !may('runs') ? [] : await db
      .select({ id: aiAgentRuns.id, profile: aiAgentRuns.profile, status: aiAgentRuns.status, summary: aiAgentRuns.summary })
      .from(aiAgentRuns)
      // #11423: a no_changes skip carries nothing to read, and skips do not
      // move the watermark, so they would crowd out the real runs.
      .where(and(eq(aiAgentRuns.orgId, orgId), ne(aiAgentRuns.id, currentRunId), gte(aiAgentRuns.queuedAt, since), notNoChangesSkip()))
      .orderBy(desc(aiAgentRuns.queuedAt))
      .limit(DIGEST_ROW_LIMIT);
    const intentRows = !may('intents') ? [] : await db
      .select({ id: actionIntents.id, toolName: actionIntents.actionName, status: actionIntents.status })
      .from(actionIntents)
      .where(and(eq(actionIntents.orgId, orgId), gte(actionIntents.createdAt, since)))
      .orderBy(desc(actionIntents.createdAt))
      .limit(DIGEST_ROW_LIMIT);

    return {
      alerts: alertRows.map((r) => ({
        id: r.id,
        title: sanitizeSweepText(r.title, 160),
        severity: sanitizeSweepText(String(r.severity), 20),
        status: sanitizeSweepText(String(r.status), 30),
        // The row's latest change, matching the ORDER BY: a resolved alert
        // shows when it was resolved, not when it first fired.
        at: toIso(r.resolvedAt && r.resolvedAt > r.at ? r.resolvedAt : r.at),
      })),
      tickets: ticketRows.map((r) => ({
        id: r.id,
        number: r.number ? sanitizeSweepText(r.number, 50) : null,
        title: sanitizeSweepText(r.title, 160),
        status: sanitizeSweepText(String(r.status), 30),
        updatedAt: toIso(r.updatedAt),
      })),
      incidents: incidentRows.map((r) => ({
        id: r.id,
        sourceKind: sanitizeSweepText(r.sourceKind, 60),
        condition: sanitizeSweepText(r.condition, 60),
        openedAt: toIso(r.openedAt),
      })),
      runs: runRows.map((r) => ({
        id: r.id,
        profile: sanitizeSweepText(String(r.profile), 30),
        status: sanitizeSweepText(String(r.status), 30),
        summary: r.summary ? sanitizeSweepText(r.summary, 240) : null,
      })),
      intents: intentRows.map((r) => ({
        id: r.id,
        toolName: sanitizeSweepText(r.toolName, 100),
        status: sanitizeSweepText(String(r.status), 30),
      })),
    };
  }, 'wisp.assessment.digest');
  const anomalies = may('anomalies') ? await loadAnomalySection(orgId, anomalyIncidentId, currentRunId) : null;
  return { ...base, anomalies };
}

/**
 * The first two parts of an open anomaly incident (loadDigestAnomalies):
 * announced by the publisher, and not suppressed by its episode. Shared with
 * the no-changes gate's `anomalies` probe so the two cannot drift apart.
 */
function anomalyIncidentAnnounced(): SQL {
  return and(
    isNotNull(metricAnomalyIncidents.dispatchedAt),
    eq(metricAnomalyIncidents.suppressedByEpisode, false),
  ) as SQL;
}

/** Metric names kept per anomaly incident (the detector's distinct metric names in the bucket). */
const DIGEST_ANOMALY_METRIC_NAME_LIMIT = 10;

/**
 * #11425: the digest's metric anomalies, or null when they could not be read.
 * The read has its own system context and transaction, and the catch sits
 * outside it (CLAUDE.md: a catch around a query wraps the whole
 * transaction). It is a join over tables no other section reads, so a failure
 * there must not fail every assessment run. Like loadReadiness, a failure is
 * logged and sent to Sentry, and the section degrades to null. The prompt
 * then says the anomalies were not read, so it does not claim there are none
 * while the reason names an anomaly incident.
 */
async function loadAnomalySection(
  orgId: string,
  triggerId: string | null,
  runId: string,
): Promise<AssessmentDigest['anomalies']> {
  try {
    const rows = await sys(() => loadDigestAnomalies(orgId, triggerId), 'wisp.assessment.digest.anomalies');
    return rows.map((r) => ({
      id: r.id,
      deviceId: r.deviceId,
      deviceName: r.deviceName ? sanitizeSweepText(r.deviceName, 120) : null,
      anomalyType: sanitizeSweepText(r.anomalyType, 40),
      metricNames: (r.metricNames ?? []).slice(0, DIGEST_ANOMALY_METRIC_NAME_LIMIT).map((m) => sanitizeSweepText(m, 120)),
      // `numeric` arrives from the driver as a string.
      peakScore: Number(r.peakScore),
      openedAt: toIso(r.openedAt),
      status: sanitizeSweepText(String(r.status), 20),
    }));
  } catch (err) {
    console.warn('[wisp.assessment] metric anomaly read failed; digest carries anomalies: null', {
      runId, orgId, error: err instanceof Error ? err.message : String(err),
    });
    captureException(err, undefined, { component: 'wisp', op: 'wisp.assessment.anomalies', runId, orgId });
    return null;
  }
}

/**
 * #11425: the metric anomaly incidents section. These are the org's open
 * incidents plus the run's trigger (`reason.anomalyIncidentId`), whatever its
 * status. ≤ 25 rows, the trigger first, then newest `last_seen_at` (the
 * metric_anomaly_incidents_org_last_seen_idx order).
 *
 * "Open" has three parts:
 *   - announced: `dispatched_at` set by the publisher;
 *   - not suppressed: the publisher dispatches one incident per episode and
 *     marks the rest `suppressed_by_episode`, so this keeps about one row per
 *     anomaly episode instead of one per 5-minute bucket;
 *   - the episode is still open. The episode is the lifecycle a technician
 *     resolves or dismisses. Incidents normally carry one: the incident
 *     upsert's persistence gate requires `ma.episode_id IS NOT NULL`
 *     (metricAnomalies.ts). But `episode_id` is nullable, and the publisher
 *     dispatches an unlinked incident at once.
 *
 * `episode_id` has no FK (the cascade-cycle note in metricAnomalyIncidents.ts),
 * so the joins are LEFT and org-pinned. An incident with no episode row (NULL
 * `episode_id`, or an episode that is gone) is never listed as open; it shows
 * only as the trigger, with status 'unknown'.
 *
 * The caller provides the DB context (loadAnomalySection). Exported for the
 * integration test (wispAssessmentAnomalies.integration.test.ts), which runs
 * it on real SQL.
 */
export function loadDigestAnomalies(orgId: string, triggerId: string | null) {
  const openIncident = and(anomalyIncidentAnnounced(), eq(metricAnomalyEpisodes.status, 'open'));
  return db
    .select({
      id: metricAnomalyIncidents.id,
      deviceId: metricAnomalyIncidents.deviceId,
      deviceName: sql<string | null>`COALESCE(${devices.displayName}, ${devices.hostname})`,
      anomalyType: metricAnomalyIncidents.anomalyType,
      metricNames: metricAnomalyIncidents.metricNames,
      peakScore: metricAnomalyIncidents.peakScore,
      openedAt: metricAnomalyIncidents.firstSeenAt,
      status: sql<string>`COALESCE(${metricAnomalyEpisodes.status}, 'unknown')`,
    })
    .from(metricAnomalyIncidents)
    .leftJoin(metricAnomalyEpisodes, and(
      eq(metricAnomalyEpisodes.id, metricAnomalyIncidents.episodeId),
      eq(metricAnomalyEpisodes.orgId, metricAnomalyIncidents.orgId),
    ))
    .leftJoin(devices, and(eq(devices.id, metricAnomalyIncidents.deviceId), eq(devices.orgId, metricAnomalyIncidents.orgId)))
    .where(and(
      eq(metricAnomalyIncidents.orgId, orgId),
      triggerId ? or(eq(metricAnomalyIncidents.id, triggerId), openIncident) : openIncident,
    ))
    .orderBy(
      ...(triggerId ? [sql`(${metricAnomalyIncidents.id} = ${triggerId}) desc`] : []),
      desc(metricAnomalyIncidents.lastSeenAt),
    )
    .limit(DIGEST_ROW_LIMIT);
}

/** Alert statuses that are still open: what a first look reports as the org's current state. */
const OPEN_ALERT_STATUSES = ['active', 'acknowledged'] as const;

/**
 * #10389: a first look's alerts — the org's open alerts whenever they fired
 * (a 24 h window on triggered_at hid a high alert open for three weeks),
 * worst severity first (the enum is declared critical → info), newest first
 * within a severity, ≤ 25. The (org_id, status, triggered_at) index
 * (alerts_org_status_triggered_at_idx) finds the org's open rows; the
 * severity order is a top-N sort over all of them — one sort per (grant, org)
 * first look. Runs inside loadDigest's system context.
 */
function loadOpenAlertRows(orgId: string) {
  return db
    .select({
      id: alerts.id, title: alerts.title, severity: alerts.severity, status: alerts.status,
      at: alerts.triggeredAt, resolvedAt: alerts.resolvedAt,
    })
    .from(alerts)
    .where(and(eq(alerts.orgId, orgId), inArray(alerts.status, [...OPEN_ALERT_STATUSES])))
    .orderBy(asc(alerts.severity), desc(alerts.triggeredAt))
    .limit(DIGEST_ROW_LIMIT);
}

/**
 * The org's incidents since `since` the grantor may view: the same two-step
 * read as GET /connection-health/incidents — the distinct view permissions
 * present, kept to those inside the ceiling, then the rows carrying one of
 * them. Runs inside loadDigest's system context.
 */
async function loadDigestIncidents(ceiling: GrantCeiling, orgId: string, since: Date) {
  const window = and(eq(connectionHealthIncidents.orgId, orgId), gte(connectionHealthIncidents.openedAt, since));
  const present = await db
    .selectDistinct({ viewPermission: connectionHealthIncidents.viewPermission })
    .from(connectionHealthIncidents)
    .where(window);
  const allowed = present.map((p) => p.viewPermission).filter((text) => ceilingAllows(ceiling, orgId, text));
  if (allowed.length === 0) return [];
  return db
    .select({
      id: connectionHealthIncidents.id,
      sourceKind: connectionHealthIncidents.sourceKind,
      condition: connectionHealthIncidents.condition,
      openedAt: connectionHealthIncidents.openedAt,
    })
    .from(connectionHealthIncidents)
    .where(and(window, inArray(connectionHealthIncidents.viewPermission, allowed)))
    .orderBy(desc(connectionHealthIncidents.openedAt))
    .limit(DIGEST_ROW_LIMIT);
}

/** One compact line per feedback block; untrusted text, the prompt wraps it. */
function renderNudgeFeedbackLine(b: { subjectKey: string; content: Record<string, unknown> }): string {
  const c = b.content ?? {};
  const parts = [sanitizeSweepText(b.subjectKey, 100)];
  if (typeof c.useful === 'boolean') parts.push(c.useful ? 'useful' : 'not useful');
  if (typeof c.summary === 'string' && c.summary.trim() !== '') parts.push(sanitizeSweepText(c.summary, 160));
  if (typeof c.note === 'string' && c.note.trim() !== '') parts.push(`note: ${sanitizeSweepText(c.note, 200)}`);
  return parts.join(' · ');
}

async function loadReadiness(ceiling: GrantCeiling, orgId: string, runId: string): Promise<OrgReadiness | null> {
  try {
    const inventory = await readinessInventory(ceiling, { orgIds: [orgId] });
    return inventory.find((r) => r.orgId === orgId) ?? null;
  } catch (err) {
    console.warn('[wisp.assessment] readiness inventory failed; context carries readiness: null', {
      runId, orgId, error: err instanceof Error ? err.message : String(err),
    });
    captureException(err, undefined, { component: 'wisp', op: 'wisp.assessment.readiness', runId, orgId });
    return null;
  }
}

async function loadNudgeFeedback(ceiling: GrantCeiling, runId: string): Promise<string[]> {
  try {
    const blocks = await recallForGrant(ceiling, {
      owners: ['user'],
      blockTypes: ['preference'],
      subjectKeyPrefix: NUDGE_FEEDBACK_PREFIX,
      limit: NUDGE_FEEDBACK_LIMIT,
    });
    return blocks.slice(0, NUDGE_FEEDBACK_LIMIT).map(renderNudgeFeedbackLine);
  } catch (err) {
    console.warn('[wisp.assessment] nudge feedback recall failed; context carries none', {
      runId, error: err instanceof Error ? err.message : String(err),
    });
    captureException(err, undefined, { component: 'wisp', op: 'wisp.assessment.nudgeFeedback', runId });
    return [];
  }
}

/**
 * The assessment slice of the run context, or null when the run cannot use its
 * grant any more (no / malformed trigger ref, a ref naming another pin, an
 * inactive grant, or the run's org has left the ceiling). The run then
 * finishes with a `grant_inactive` summary and no model call.
 */
export async function loadAssessmentContext(run: {
  id: string;
  orgId: string;
  grantId: string | null;
  grantRevisionId: string | null;
  triggerRef: Record<string, unknown>;
}): Promise<AssessmentRunContext | null> {
  if (!run.grantId || !run.grantRevisionId) return null;
  const ref = parseWispTriggerRef(run.triggerRef);
  if (!ref || ref.grantId !== run.grantId || ref.grantRevisionId !== run.grantRevisionId) {
    console.warn('[wisp.assessment] assessment run without a matching trigger_ref.wisp', { runId: run.id });
    return null;
  }

  let ceiling: GrantCeiling;
  try {
    ceiling = await resolveGrantCeiling(run.grantId, run.grantRevisionId);
  } catch (err) {
    if (err instanceof GrantInactiveError) return null;
    throw err;
  }
  if (!ceiling.orgIds.has(run.orgId) || !assessableOrgIds(ceiling).has(run.orgId)) return null;

  const thread = await getOrCreateThread(run.grantId);
  const threadSummary = await seedContextForSession(thread.id, ceiling);
  const openConcerns = await listConcernsForCeiling(ceiling, { status: ['open', 'snoozed'], orgId: run.orgId });

  const since = ref.watermark ? new Date(ref.watermark) : new Date(Date.now() - DEFAULT_LOOKBACK_MS);
  // #10389: nothing earlier to diff against, so the alerts are the org's
  // current open ones rather than the 24 h fallback window. #10406: a person
  // asking "go through the open alerts" gets the same open-alerts digest,
  // whatever the watermark.
  // W07: a check-in run is a follow-up on one thing the person asked about,
  // never a look at the whole org's current state, whatever the watermark.
  const firstLook = ref.reason.kind !== 'check_in'
    && (ref.watermark === null || ref.reason.kind === 'onboarding' || ref.reason.kind === 'on_demand');
  const reason = ref.reason;
  const anomalyIncidentId = reason.kind === 'event' ? reason.anomalyIncidentId ?? null : null;
  const digest = await loadDigest(ceiling, run.orgId, run.id, since, firstLook, anomalyIncidentId);

  const watchId = reason.kind === 'watch' ? reason.watchId : null;
  const watch = watchId !== null
    ? (await listWatches(ceiling)).find((w) => w.id === watchId) ?? null
    : null;
  const readiness = await loadReadiness(ceiling, run.orgId, run.id);
  const nudgeFeedback = await loadNudgeFeedback(ceiling, run.id);

  return {
    grantId: run.grantId,
    grantRevisionId: run.grantRevisionId,
    grantorUserId: ceiling.grantorUserId,
    threadId: thread.id,
    threadSummary,
    openConcerns,
    changedSince: since.toISOString(),
    firstLook,
    noEarlierAssessment: ref.watermark === null,
    digest,
    watch,
    reason,
    readiness,
    nudgeFeedback,
  };
}

// ---------------------------------------------------------------------------
// Partner picture
// ---------------------------------------------------------------------------

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Highest severity first, then most recently updated, then id — a total order. */
function cmpConcern(a: Concern, b: Concern): number {
  return (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    || cmpStr(b.updatedAt, a.updatedAt)
    || cmpStr(a.id, b.id);
}

/**
 * Pure and deterministic: byte-identical for the same set of orgs and
 * concerns in any input order.
 *
 *   Wisp picture · <orgs with open concerns>/<orgs in ceiling> orgs · <N high / M medium / K low> · as of <ISO minute>
 *   <orgName>: <count> open — <up to 3 summaries, highest severity first, each ≤ 80 chars>
 *
 * Orgs sort by (max severity desc, open count desc, orgName asc, orgId asc);
 * zero-concern orgs are omitted; the text is cut on a line boundary with a
 * final `…` line to stay ≤ 4 000 chars. The PARTNER_WIDE_PICTURE_ORG_ID line
 * (partner-level concerns) counts toward the severity totals, not the org counts.
 */
export function renderPartnerPicture(input: { generatedAt: Date; orgs: { orgId: string; orgName: string; concerns: Concern[] }[] }): string {
  const severityCounts: Record<ConcernSeverity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  let orgsInCeiling = 0;
  let orgsWithConcerns = 0;
  const entries: { orgId: string; name: string; concerns: Concern[]; maxRank: number }[] = [];

  for (const org of input.orgs) {
    const isPseudo = org.orgId === PARTNER_WIDE_PICTURE_ORG_ID;
    if (!isPseudo) orgsInCeiling += 1;
    if (org.concerns.length === 0) continue;
    if (!isPseudo) orgsWithConcerns += 1;
    const concerns = [...org.concerns].sort(cmpConcern);
    for (const c of concerns) severityCounts[c.severity] += 1;
    entries.push({
      orgId: org.orgId,
      name: sanitizeSweepText(org.orgName, PICTURE_ORG_NAME_MAX),
      concerns,
      maxRank: SEVERITY_RANK[concerns[0]!.severity],
    });
  }

  entries.sort((a, b) => (b.maxRank - a.maxRank)
    || (b.concerns.length - a.concerns.length)
    || cmpStr(a.name, b.name)
    || cmpStr(a.orgId, b.orgId));

  const asOf = `${input.generatedAt.toISOString().slice(0, 16)}Z`;
  const header = `Wisp picture · ${orgsWithConcerns}/${orgsInCeiling} orgs · `
    + `${severityCounts.high} high / ${severityCounts.medium} medium / ${severityCounts.low} low · as of ${asOf}`;
  const lines = entries.map((e) => {
    const summaries = e.concerns
      .slice(0, PICTURE_SUMMARIES_PER_ORG)
      .map((c) => sanitizeSweepText(c.summary, PICTURE_SUMMARY_MAX));
    return `${e.name}: ${e.concerns.length} open — ${summaries.join('; ')}`;
  });

  const full = [header, ...lines].join('\n');
  if (full.length <= PICTURE_MAX_CHARS) return full;
  const ELLIPSIS_LINE = '\n…';
  let out = header;
  for (const line of lines) {
    if (out.length + 1 + line.length + ELLIPSIS_LINE.length > PICTURE_MAX_CHARS) break;
    out += `\n${line}`;
  }
  return out + ELLIPSIS_LINE;
}

/**
 * Deterministic (no model) picture of every live concern under the grant's
 * current ceiling, written to the picture column of the grant's thread (#10390:
 * never the session summary, which session close owns). Throws
 * GrantInactiveError when the grant cannot be used.
 */
export async function rollupPartnerPicture(grantId: string): Promise<string> {
  if (!wispEnabled()) throw new GrantInactiveError(grantId, 'paused', 'Wisp is disabled on this deployment', 'paused');
  const grant = await loadGrantPin(grantId);
  if (!grant) throw new GrantInactiveError(grantId, 'revoked', 'grant not found', 'ended');
  if (!grant.currentRevisionId) throw new GrantInactiveError(grantId, 'paused', 'grant has no current revision', 'corrupt');
  const ceiling = await resolveGrantCeiling(grantId, grant.currentRevisionId);

  const concerns = await listConcernsForCeiling(ceiling, { status: ['open', 'snoozed'] });
  const partnerLevelVisible = ceiling.scopeOrgId === null && ceiling.partnerWide;
  const byOrg = new Map<string, Concern[]>();
  const partnerLevel: Concern[] = [];
  for (const c of concerns) {
    if (c.orgId === null) {
      if (partnerLevelVisible) partnerLevel.push(c);
    } else if (ceiling.orgIds.has(c.orgId)) {
      const list = byOrg.get(c.orgId) ?? [];
      list.push(c);
      byOrg.set(c.orgId, list);
    }
  }

  const names = new Map<string, string>();
  if (byOrg.size > 0) {
    const rows = await sys(() => db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(and(eq(organizations.partnerId, ceiling.partnerId), inArray(organizations.id, [...byOrg.keys()]))), 'wisp.assessment.orgNames');
    for (const r of rows) names.set(r.id, r.name);
  }

  const orgs = [...ceiling.orgIds].map((orgId) => ({
    orgId,
    orgName: names.get(orgId) ?? orgId,
    concerns: byOrg.get(orgId) ?? [],
  }));
  if (partnerLevel.length > 0) {
    orgs.push({ orgId: PARTNER_WIDE_PICTURE_ORG_ID, orgName: PARTNER_WIDE_PICTURE_NAME, concerns: partnerLevel });
  }

  const text = renderPartnerPicture({ generatedAt: new Date(), orgs });
  const thread = await getOrCreateThread(grantId);
  await updateThreadPicture(thread.id, text);
  return text;
}
