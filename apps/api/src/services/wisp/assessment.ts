/**
 * Wisp W05b Task 7 (#9917) — the assessment engine's admission, run context
 * and deterministic partner picture (Wisp design §7.1–7.3, §9; w00 "Triage
 * engine (W05)", A33, A34).
 *
 *   enqueueAssessment      flag → entitlement → ceiling → org in ceiling →
 *                          budget → createAndEnqueueAgentRun({ grant,
 *                          profile: 'assessment' }). An exhausted budget never
 *                          pauses the grant: the grantor is told once per UTC
 *                          day and the deterministic digest path records the
 *                          event as a low concern instead (no model call).
 *   loadAssessmentContext  the run's bounded context: thread seed, the org's
 *                          live concerns with this grant's recipient state, a
 *                          five-table digest since the watermark (each read
 *                          pinned to the run's org, gated on the grantor's
 *                          permission for it, ≤ 25 rows, sanitised), the
 *                          reason's watch, the org's readiness inventory, and
 *                          the grantor's nudge feedback. null = the grant is no
 *                          longer usable (the run finishes without a model call).
 *   rollupPartnerPicture   deterministic text of every live concern under the
 *                          ceiling → updateThreadSummary.
 *
 * DB access: every read here runs in a FRESH system context
 * (`runOutsideDbContext(withSystemDbAccessContext)`) — callers are the wake
 * worker and the run loop, which already hold the pinned grant id. Admission
 * (`createAndEnqueueAgentRun`) is always called OUTSIDE any DB context, because
 * it announces and enqueues after its own transaction commits (#1105; the same
 * seam as metricAnomalySubscriber.ts).
 */
import { and, desc, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Concern, ConcernSeverity, ConcernSubject, ConcernSubjectKind } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { alerts } from '../../db/schema/alerts';
import { connectionHealthIncidents } from '../../db/schema/connectionHealth';
import { organizations } from '../../db/schema/orgs';
import { tickets } from '../../db/schema/portal';
import { wispGrants } from '../../db/schema/wisp';
import { wispEnabled } from '../../config/env';
import { ASSESSMENT_BUDGET_CENTS_PER_RUN } from '../aiAgents/assessmentProfile';
import { createAndEnqueueAgentRun } from '../aiAgents/runService';
import { sanitizeSweepText } from '../aiAgents/runnerPrompt';
import { hasEntitlement } from '../entitlements';
import { captureException } from '../sentry';
import { chargeableUnderGrant, notifyBudgetExhaustedOnce, utcDayWindow } from './budget';
import { listConcernsForCeiling, upsertConcern } from './concerns';
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
import { getOrCreateThread, seedContextForSession, updateThreadSummary } from './threads';
import { listWatches } from './watches';
import type {
  AssessmentDigest,
  AssessmentReason,
  AssessmentRunContext,
  OrgReadiness,
  WispAssessmentTriggerRef,
} from './assessmentTypes';

export type { AssessmentReason, AssessmentRunContext, AssessmentDigest, WispAssessmentTriggerRef } from './assessmentTypes';
export { assessableOrgIds } from './assessableOrgs';

/** Rows per digest table (w00: bounded, newest first). */
const DIGEST_ROW_LIMIT = 25;
/** Digest window when the (grant, org) pair has no watermark yet (see lastAssessmentWatermark). */
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** w00 A34: the grantor's last 20 nudge-feedback preference blocks. */
const NUDGE_FEEDBACK_LIMIT = 20;
const NUDGE_FEEDBACK_PREFIX = 'nudge_feedback:';

/** updateThreadSummary's ceiling (W04 truncates at the same length). */
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

/**
 * Admit one assessment run for (grant, org). `subject` / `failed` are used
 * only on the budget-exhausted path (see DeterministicDigestHint). Never call
 * this from inside a DB transaction you still hold open: admission enqueues.
 */
export async function enqueueAssessment(
  input: { grantId: string; orgId: string; reason: AssessmentReason } & DeterministicDigestHint,
): Promise<{ runId: string } | { skipped: string }> {
  if (!wispEnabled()) return { skipped: 'wisp_disabled' };
  const { grantId, orgId, reason } = input;

  const grant = await loadGrantPin(grantId);
  if (!grant?.currentRevisionId) return { skipped: 'grant_inactive' };
  // Spec §10 claim-time re-check: a partner that lost the entitlement admits nothing.
  if (!(await hasEntitlement(grant.partnerId, 'wisp'))) return { skipped: 'not_entitled' };

  let ceiling: GrantCeiling;
  try {
    ceiling = await resolveGrantCeiling(grantId, grant.currentRevisionId);
  } catch (err) {
    if (err instanceof GrantInactiveError) return { skipped: 'grant_inactive' };
    throw err;
  }
  // Same spelling as W02's admission skip (step 1d), which re-checks it.
  if (!ceiling.orgIds.has(orgId)) return { skipped: 'grant_org_out_of_ceiling' };
  if (!assessableOrgIds(ceiling).has(orgId)) return { skipped: 'grant_org_site_restricted' };

  const budget = await chargeableUnderGrant(grantId, ASSESSMENT_BUDGET_CENTS_PER_RUN);
  if (!budget.ok) {
    // The model stops; the bookkeeping does not. Both steps are attempted even
    // if one fails, then the first failure surfaces. pauseGrant is never called.
    const failures: unknown[] = [];
    await notifyBudgetExhaustedOnce(grantId).catch((err: unknown) => { failures.push(err); });
    await recordDeterministicDigest(grantId, orgId, reason, { subject: input.subject, failed: input.failed, ceiling })
      .catch((err: unknown) => { failures.push(err); });
    if (failures.length > 0) throw failures[0];
    return { skipped: 'budget_exhausted' };
  }

  const watermark = await lastAssessmentWatermark(grantId, orgId);
  const triggerRef: WispAssessmentTriggerRef = {
    grantId,
    grantRevisionId: ceiling.revisionId,
    reason,
    watermark: watermark?.toISOString() ?? null,
  };
  // #1105: admission opens its own context and enqueues after commit, so it
  // must not run inside a caller's (request or system) context.
  const result = await runOutsideDbContext(() => createAndEnqueueAgentRun({
    orgId,
    kind: 'triage',
    triggerKind: 'schedule',
    deviceId: null,
    profile: 'assessment',
    dedupeKey: `wisp-assess-${grantId}-${orgId}-${Date.now()}`,
    triggerRef: { wisp: triggerRef },
    grant: { grantId, grantRevisionId: ceiling.revisionId },
  }));
  return result.created ? { runId: result.run.id } : { skipped: result.skipped };
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

function parseReason(v: unknown): AssessmentReason | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  switch (r.kind) {
    case 'event':
      return isNonEmptyString(r.eventType) && isNonEmptyString(r.eventId)
        ? { kind: 'event', eventType: r.eventType, eventId: r.eventId }
        : null;
    case 'tick':
      return { kind: 'tick' };
    case 'watch':
      return isNonEmptyString(r.watchId) ? { kind: 'watch', watchId: r.watchId } : null;
    case 'onboarding':
      return { kind: 'onboarding' };
    default:
      return null;
  }
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
 */
const DIGEST_SECTION_PERMISSION = {
  alerts: 'alerts:read',
  tickets: 'tickets:read',
  incidents: 'organizations:read',
  runs: 'ai_agents:read',
  intents: 'ai_agents:read',
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
 * Five bounded reads, each pinned to `orgId` (the ceiling admitted the org;
 * the pin is the second lock) and each gated on the grantor's permission for
 * it (DIGEST_SECTION_PERMISSION): a section the grantor may not read renders
 * empty and issues no query.
 */
async function loadDigest(ceiling: GrantCeiling, orgId: string, currentRunId: string, since: Date): Promise<AssessmentDigest> {
  const may = (section: keyof typeof DIGEST_SECTION_PERMISSION) =>
    ceilingAllows(ceiling, orgId, DIGEST_SECTION_PERMISSION[section]);
  return sys(async () => {
    const alertRows = !may('alerts') ? [] : await db
      .select({ id: alerts.id, title: alerts.title, severity: alerts.severity, status: alerts.status, at: alerts.triggeredAt })
      .from(alerts)
      .where(and(eq(alerts.orgId, orgId), gte(alerts.triggeredAt, since)))
      .orderBy(desc(alerts.triggeredAt))
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
      .where(and(eq(aiAgentRuns.orgId, orgId), ne(aiAgentRuns.id, currentRunId), gte(aiAgentRuns.queuedAt, since)))
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
        at: toIso(r.at),
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
  const digest = await loadDigest(ceiling, run.orgId, run.id, since);

  const reason = ref.reason;
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
 * current ceiling, written to the grant's thread summary. Throws
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
  await updateThreadSummary(thread.id, text);
  return text;
}
