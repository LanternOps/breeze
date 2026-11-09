/**
 * Wisp W05b Task 9 (#9917) — the wake coordinator: what makes Wisp look at an
 * org (Wisp design §7.1; w00 "Triage engine (W05)", A29, A33).
 *
 *   handleWispWakeEvent  the `wisp-wake` durable subscriber body. A bus event
 *                        for an org fans one debounced assessment request per
 *                        active grant covering that org; `wisp.grant.created`
 *                        asks for onboarding assessments of the first 10
 *                        orgs (by name) of the new grant's ceiling;
 *                        `wisp.grant.resumed` asks for one floor-tick
 *                        assessment of the round-robin org.
 *   requestAssessment    the 60 s per-(grant, org) debounce: ONE delayed
 *                        BullMQ job per pair is the window. An `on_demand`
 *                        request (#10406) skips the delay and is never
 *                        dropped: it upgrades the window job or adds a `-od`
 *                        successor (requestOnDemandAssessment).
 *   pickRoundRobinOrg    pure: never-assessed orgs first, then the oldest.
 *   enqueueCheckIn / removeCheckInJob / isCheckInJobLive
 *                        the delayed `check-in` job of a Wisp check-in timer
 *                        (#10991; services/wisp/checkIns.ts owns the rows).
 *
 * The 5-minute tick that drives floor ticks and watches lives in
 * jobs/wispWakeScheduler.ts, which also processes the delayed `assess` jobs.
 *
 * DB access: every read runs in a FRESH system context
 * (`runOutsideDbContext(withSystemDbAccessContext)`); every enqueue happens
 * after that block has returned (#1105).
 */
import { Queue, type Job } from 'bullmq';
import { sql, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { wispEnabled } from '../../config/env';
import { getBullMQConnection } from '../redis';
import { notHoldingOrgCondition } from '../unassignedPool/selectorPredicate';
import type { BreezeEvent } from '../eventBus';
import { GrantInactiveError, resolveGrantCeiling, type GrantCeiling } from './grantAuthority';
import { assessableOrgIds, ONBOARDING_ORG_LIMIT } from './assessableOrgs';
import type { AssessmentReason, DeterministicDigestHint } from './assessment';
import type { WatchHitRecord } from './assessmentTypes';

export { ONBOARDING_ORG_LIMIT };

export const WISP_WAKE_QUEUE = 'wisp-wake';
export const WISP_WAKE_DEBOUNCE_MS = 60_000;
// jobs/wispWakeScheduler.ts registers the repeatable with its own same-file
// literal (scheduleRegistry.contract.test.ts resolves `repeat: { every }`
// from same-file consts only); its test pins the two equal.
export const WISP_WAKE_TICK_INTERVAL_MS = 5 * 60 * 1000;

export const ASSESS_JOB = 'assess';
const ASSESS_JOB_ATTEMPTS = 3;
const ASSESS_JOB_BACKOFF_MS = 30_000;

export type WispAssessJobData = {
  grantId: string;
  orgId: string;
  reason: AssessmentReason;
  /** #11424: set on a watch request whose hit-set was evaluated; recorded at admission. */
  watchRecord?: WatchHitRecord;
} & DeterministicDigestHint;

/** The delayed job that fires one `wisp_check_ins` row (jobs/wispWakeScheduler.ts processCheckInJob). */
export const CHECK_IN_JOB = 'check-in';
const CHECK_IN_JOB_ATTEMPTS = 3;
const CHECK_IN_JOB_BACKOFF_MS = 30_000;

export type WispCheckInJobData = { checkInId: string };

type WakeQueueData = WispAssessJobData | WispCheckInJobData | Record<string, never>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Job states in which a job with this id still covers the window. */
const LIVE_JOB_STATES = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);

let wakeQueue: Queue<WakeQueueData> | null = null;

export function getWispWakeQueue(): Queue<WakeQueueData> {
  if (!wakeQueue) {
    wakeQueue = new Queue<WakeQueueData>(WISP_WAKE_QUEUE, { connection: getBullMQConnection() });
  }
  return wakeQueue;
}

export async function closeWispWakeQueue(): Promise<void> {
  if (wakeQueue) {
    const q = wakeQueue;
    wakeQueue = null;
    await q.close();
  }
}

function sys<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

async function rows<T>(query: SQL): Promise<T[]> {
  return [...((await db.execute(query)) as unknown as T[])];
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' && v !== '') {
    // Postgres text form: '2026-10-24 09:00:00.123456+00' → ISO-parsable.
    const d = new Date(v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

/** `wisp-assess-${grantId}-${orgId}` — no ':' (BullMQ reserves it). */
export function wakeJobId(grantId: string, orgId: string): string {
  return `wisp-assess-${grantId}-${orgId}`;
}

/**
 * #10406: the job an `on_demand` request adds when the (grant, org) window job
 * is already running and so can no longer take the on-demand reason. Its own
 * id, so BullMQ dedupes repeats onto it while it is live.
 */
export function onDemandSuccessorJobId(grantId: string, orgId: string): string {
  return `${wakeJobId(grantId, orgId)}-od`;
}

/**
 * `queued`    a new job was added;
 * `coalesced` a live job already covers this request (nothing changed);
 * `upgraded`  a tick / onboarding job no worker holds yet (waiting, delayed or
 *             prioritized) now carries `on_demand` (#10406).
 */
export type RequestAssessmentResult = 'queued' | 'coalesced' | 'upgraded';

/** Live states in which no worker holds the job yet, so its data can still change. */
const UNCLAIMED_JOB_STATES = new Set(['waiting', 'delayed', 'prioritized']);

/**
 * Reasons an on-demand request may replace in place. A tick or onboarding run
 * reads nothing the on-demand run does not; an event or watch reason names
 * what its run is about (the alert, anomaly incident or watch), so those jobs
 * keep it and the on-demand request takes the successor.
 */
const REPLACEABLE_REASONS = new Set<AssessmentReason['kind']>(['tick', 'onboarding']);

const ASSESS_JOB_OPTIONS = {
  // A transient failure (Redis / DB blip in enqueueAssessment) retries the
  // SAME job: BullMQ moves it back to 'delayed' under its own jobId for the
  // backoff, so the window keeps coalescing onto it meanwhile.
  attempts: ASSESS_JOB_ATTEMPTS,
  backoff: { type: 'exponential' as const, delay: ASSESS_JOB_BACKOFF_MS },
  removeOnComplete: true,
  removeOnFail: { count: 100 },
};

const isOnDemandJob = (data: unknown): boolean =>
  (data as Partial<WispAssessJobData> | undefined)?.reason?.kind === 'on_demand';

function assessJobData(input: WispAssessJobData): WispAssessJobData {
  const data: WispAssessJobData = { grantId: input.grantId, orgId: input.orgId, reason: input.reason };
  if (input.subject) data.subject = input.subject;
  if (input.failed !== undefined) data.failed = input.failed;
  if (input.watchRecord) data.watchRecord = input.watchRecord;
  return data;
}

/**
 * The live job with this id, or null. A retained completed / failed record
 * would make BullMQ no-op an add with the same id forever (it dedupes on any
 * job record still in Redis), so such a record is removed here. If that
 * removal fails, a debounced request only warns (the next wake retries it);
 * a `strict` caller throws, because its add would be silently ignored and it
 * must not report the request as queued (the enqueueCheckIn rule).
 */
async function liveJob(
  queue: Queue<WakeQueueData>,
  jobId: string,
  opts: { strict?: boolean } = {},
): Promise<{ job: Job<WakeQueueData>; state: string } | null> {
  const existing = await queue.getJob(jobId);
  if (!existing) return null;
  const state = await existing.getState();
  if (LIVE_JOB_STATES.has(state)) return { job: existing, state };
  try {
    await existing.remove();
  } catch (err) {
    if (opts.strict) {
      throw new Error(`[wisp-wake] could not remove the finished assess job ${jobId} (state ${state}): ${err instanceof Error ? err.message : String(err)}`);
    }
    console.warn('[wisp-wake] could not remove a finished assess job', { jobId, state, err });
  }
  return null;
}

/**
 * Ask for one assessment of (grant, org): within the next 60 s, or at once for
 * `on_demand`.
 *
 * One delayed job per (grant, org) IS the window: every other request while
 * that job is still waiting, delayed or running collapses onto it. The stored data is
 * the FIRST request's — its reason and its deterministic digest hint. Later
 * coalesced requests' hints are dropped; that is acceptable because a funded
 * assessment reads everything since the watermark, not the reason, and on the
 * budget-exhausted path the concerns list and the next funded assessment
 * cover the events whose hint was dropped.
 *
 * `on_demand` (#10406) is the exception: a person asked for the org's OPEN
 * alerts to be looked at now, which a since-watermark tick or event run does
 * not do, so it is never dropped. See `requestOnDemandAssessment`.
 *
 * Two replicas racing the empty window both add; the second add is a BullMQ
 * no-op, and both report 'queued' — a miscount, never a second job.
 */
export async function requestAssessment(input: WispAssessJobData): Promise<RequestAssessmentResult> {
  if (input.reason.kind === 'on_demand') return requestOnDemandAssessment(input);
  const queue = getWispWakeQueue();
  const jobId = wakeJobId(input.grantId, input.orgId);

  if (await liveJob(queue, jobId)) return 'coalesced';
  await queue.add(ASSESS_JOB, assessJobData(input), { jobId, delay: WISP_WAKE_DEBOUNCE_MS, ...ASSESS_JOB_OPTIONS });
  return 'queued';
}

/**
 * #10406 — an on-demand request, with no debounce delay:
 *
 *  - a live job that already carries `on_demand` (the window job or its
 *    successor) covers it → `coalesced`. A job is assessed when its RUN
 *    starts (loadAssessmentContext), after the assess job admits it, so a
 *    running on-demand assess job still reads the alerts open now. A later
 *    tick / event / watch request coalesces onto a window job carrying
 *    `on_demand`, so that job is never downgraded (those requests do not
 *    consult the successor: if the window job has finished they add a fresh
 *    window job, an extra run, never a lost one);
 *  - no live window job → the window job is added with `on_demand`;
 *  - a tick or onboarding window job no worker holds yet (waiting, delayed,
 *    prioritized) gets the `on_demand` reason (`updateData`, keeping its
 *    digest hint), and a delayed one is promoted to run now → `upgraded`;
 *  - otherwise the successor job `<window>-od` is added → `queued`: the window
 *    job is running (it is only admitting a run, no proof that run reads the
 *    open alerts), a worker claimed it while it was being updated (its state
 *    is re-read after the write, quorum finding), or it carries an event or
 *    watch reason it must keep (REPLACEABLE_REASONS).
 *
 * A finished record that cannot be removed throws (`strict`): the add would
 * be a silent BullMQ no-op, and the caller must not report it as queued.
 */
async function requestOnDemandAssessment(input: WispAssessJobData): Promise<RequestAssessmentResult> {
  const queue = getWispWakeQueue();
  const jobId = wakeJobId(input.grantId, input.orgId);
  const successorId = onDemandSuccessorJobId(input.grantId, input.orgId);

  const live = await liveJob(queue, jobId, { strict: true });
  if (live && isOnDemandJob(live.job.data)) return 'coalesced';
  if (await liveJob(queue, successorId, { strict: true })) return 'coalesced';

  if (!live) {
    await queue.add(ASSESS_JOB, assessJobData(input), { jobId, delay: 0, ...ASSESS_JOB_OPTIONS });
    return 'queued';
  }

  const liveReason = (live.job.data as Partial<WispAssessJobData> | undefined)?.reason?.kind;
  if (
    UNCLAIMED_JOB_STATES.has(live.state)
    && liveReason !== undefined && REPLACEABLE_REASONS.has(liveReason)
    && (await upgradeToOnDemand(live.job, live.state, input.reason))
  ) {
    return 'upgraded';
  }

  await queue.add(ASSESS_JOB, assessJobData(input), { jobId: successorId, delay: 0, ...ASSESS_JOB_OPTIONS });
  return 'queued';
}

/**
 * Put the on-demand reason on a job no worker held when its state was read.
 * True only when the new data is stored AND the job is still unclaimed after
 * the write; otherwise the caller adds the successor (an extra assessment at
 * worst, never a dropped request). A failed promote is not fatal: the job
 * still carries the reason and runs when its delay ends (at most 60 s).
 */
async function upgradeToOnDemand(job: Job<WakeQueueData>, state: string, reason: AssessmentReason): Promise<boolean> {
  try {
    await job.updateData({ ...(job.data as WispAssessJobData), reason });
  } catch (err) {
    console.warn('[wisp-wake] could not upgrade the assess job to on_demand; adding a successor', { jobId: job.id, state, err });
    return false;
  }
  if (state === 'delayed') {
    await job.promote().catch((err: unknown) => {
      console.warn('[wisp-wake] could not promote the upgraded assess job; it runs when its delay ends', { jobId: job.id, err });
    });
  }
  const after = await job.getState().catch(() => 'unknown');
  return UNCLAIMED_JOB_STATES.has(after);
}

// ---------------------------------------------------------------------------
// Check-in timers (#10991)
// ---------------------------------------------------------------------------

/** `wisp-check-in-${checkInId}` — no ':' (BullMQ reserves it). Stored as `wisp_check_ins.job_id`. */
export function checkInJobId(checkInId: string): string {
  return `wisp-check-in-${checkInId}`;
}

/**
 * Add the delayed `check-in` job for one row. A LIVE job with this id already
 * covers it, so that case adds nothing. A retained completed / failed record
 * would make BullMQ no-op the add, so it is removed first (the
 * requestAssessment precedent). If that removal fails this throws rather than
 * add: the add would be silently ignored, and the caller (create / reconcile)
 * must see that the row is still not queued. Callers enqueue only outside a
 * DB context (#1105).
 */
export async function enqueueCheckIn(checkInId: string, delayMs: number): Promise<void> {
  const queue = getWispWakeQueue();
  const jobId = checkInJobId(checkInId);

  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (LIVE_JOB_STATES.has(state)) return;
    try {
      await existing.remove();
    } catch (err) {
      throw new Error(`[wisp-wake] could not remove the finished check-in job ${jobId} (state ${state}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const data: WispCheckInJobData = { checkInId };
  await queue.add(CHECK_IN_JOB, data, {
    jobId,
    delay: Number.isFinite(delayMs) ? Math.max(0, Math.trunc(delayMs)) : 0,
    attempts: CHECK_IN_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: CHECK_IN_JOB_BACKOFF_MS },
    removeOnComplete: true,
    removeOnFail: { count: 100 },
  });
}

/**
 * Remove the row's job. False when there is none, or when BullMQ refuses (an
 * active job is locked by its worker): fireCheckIn's compare-and-set on
 * `scheduled` is what makes a cancelled row stay cancelled, not this removal.
 */
export async function removeCheckInJob(checkInId: string): Promise<boolean> {
  const jobId = checkInJobId(checkInId);
  const job = await getWispWakeQueue().getJob(jobId);
  if (!job) return false;
  try {
    await job.remove();
    return true;
  } catch (err) {
    console.warn('[wisp-wake] could not remove a check-in job', { jobId, err });
    return false;
  }
}

/** True while the row's job is waiting, delayed (incl. a retry backoff), active, prioritized or waiting on children. */
export async function isCheckInJobLive(checkInId: string): Promise<boolean> {
  const job = await getWispWakeQueue().getJob(checkInJobId(checkInId));
  if (!job) return false;
  return LIVE_JOB_STATES.has(await job.getState());
}

// ---------------------------------------------------------------------------
// Round-robin
// ---------------------------------------------------------------------------

/**
 * Pure. Never-assessed orgs first (lowest orgId), else the oldest
 * lastAssessedAt, ties by orgId. Code-unit string compare, so the pick never
 * depends on locale or input order.
 */
export function pickRoundRobinOrg(candidates: { orgId: string; lastAssessedAt: Date | null }[]): string | null {
  let best: { orgId: string; lastAssessedAt: Date | null } | null = null;
  for (const c of candidates) {
    if (!best) { best = c; continue; }
    const a = c.lastAssessedAt?.getTime() ?? null;
    const b = best.lastAssessedAt?.getTime() ?? null;
    if (a === null && b !== null) { best = c; continue; }
    if (a !== null && b === null) continue;
    if (a !== null && b !== null && a !== b) { if (a < b) best = c; continue; }
    if (c.orgId < best.orgId) best = c;
  }
  return best?.orgId ?? null;
}

/**
 * The org predicate of aiAgentSweepScheduler.loadPartnerOrgIds (copied, not
 * imported): live tenants only — no quick_support holder, no unassigned-pool
 * holding org, not soft-deleted, status active or trial. Written against the
 * unaliased `organizations` table because notHoldingOrgCondition() renders a
 * qualified `"organizations"."type"`.
 */
function liveOrgPredicate(): SQL {
  return sql`organizations.type <> 'quick_support'
       AND ${notHoldingOrgCondition()}
       AND organizations.deleted_at IS NULL
       AND organizations.status IN ('active', 'trial')`;
}

/** Every live org of the partner, ordered by name then id. */
export async function loadLivePartnerOrgs(partnerId: string): Promise<{ id: string; name: string }[]> {
  return sys(() => rows<{ id: string; name: string }>(sql`
    SELECT id, name
      FROM organizations
     WHERE partner_id = ${partnerId}
       AND ${liveOrgPredicate()}
     ORDER BY name, id`), 'wisp-wake-live-orgs');
}

/**
 * MAX(finished_at) of the grant's finished assessment runs, per org. A run
 * that ended `awaiting_approval` (it minted an intent) assessed the org as
 * much as a `completed` one; counting only `completed` would leave that org
 * "never assessed" and starve every other org of the round-robin.
 *
 * #11423: a `skipped / no_changes` run (the no-changes gate in
 * assessment.ts) looked at the org too. Without it here the unchanged org
 * would stay the oldest, and every floor tick would pick it and skip it.
 * The watermark still ignores those rows (assessment.ts lastAssessmentWatermark).
 * 'no_changes' is assessment.ts NO_CHANGES_ERROR_CODE (this module imports
 * assessment types only); keep the two spellings equal.
 */
export async function loadLastAssessedByOrg(grantId: string): Promise<Map<string, Date>> {
  const result = await sys(() => rows<{ org_id: string; last_assessed_at: unknown }>(sql`
    SELECT org_id, max(finished_at) AS last_assessed_at
      FROM ai_agent_runs
     WHERE grant_id = ${grantId}
       AND profile = 'assessment'
       AND (status IN ('completed', 'awaiting_approval')
            OR (status = 'skipped' AND error_code = 'no_changes'))
     GROUP BY org_id`), 'wisp-wake-last-assessed');
  const out = new Map<string, Date>();
  for (const r of result) {
    const at = toDate(r.last_assessed_at);
    if (at) out.set(r.org_id, at);
  }
  return out;
}

export type WakeGrantPin = { id: string; partnerId: string; currentRevisionId: string | null };

/** The grant's live ceiling at its current revision; null when it cannot be used. */
export async function ceilingForGrant(grant: WakeGrantPin): Promise<GrantCeiling | null> {
  if (!grant.currentRevisionId) return null;
  try {
    return await resolveGrantCeiling(grant.id, grant.currentRevisionId);
  } catch (err) {
    if (err instanceof GrantInactiveError) return null;
    throw err;
  }
}

/**
 * ONE org for this grant's next floor tick (or partner-wide watch):
 * assessableOrgIds(ceiling) ∩ the partner's live orgs, round-robin by the
 * grant's last finished (completed / awaiting_approval) assessment per org.
 * null when the grant is unusable or no live org is left in its ceiling.
 */
export async function roundRobinOrgForGrant(grant: WakeGrantPin): Promise<string | null> {
  const ceiling = await ceilingForGrant(grant);
  if (!ceiling) return null;
  // Only orgs the grant reaches whole (no site restriction): the assessment
  // digest is org-wide (assessableOrgs.ts).
  const assessable = assessableOrgIds(ceiling);
  const live = (await loadLivePartnerOrgs(grant.partnerId)).filter((o) => assessable.has(o.id));
  if (live.length === 0) return null;
  const last = await loadLastAssessedByOrg(grant.id);
  return pickRoundRobinOrg(live.map((o) => ({ orgId: o.id, lastAssessedAt: last.get(o.id) ?? null })));
}

// ---------------------------------------------------------------------------
// Event fan-out
// ---------------------------------------------------------------------------

/**
 * Active, unexpired grants whose partner owns `event.orgId` and that cover it
 * (`org_id IS NULL OR org_id = event.orgId`), for a live org only. The org's
 * membership in each grant's ceiling is re-checked at admission
 * (enqueueAssessment), not here: a storm must not resolve a ceiling per event.
 */
export async function grantsForEvent(event: BreezeEvent): Promise<{ grantId: string; orgId: string }[]> {
  const orgId = event.orgId;
  if (!isUuid(orgId)) return [];
  const nowIso = new Date().toISOString();
  const result = await sys(() => rows<{ grant_id: string }>(sql`
    SELECT g.id AS grant_id
      FROM wisp_grants g
      JOIN organizations ON organizations.partner_id = g.partner_id
     WHERE organizations.id = ${orgId}
       AND g.status = 'active'
       AND g.expires_at > ${nowIso}::timestamptz
       AND (g.org_id IS NULL OR g.org_id = organizations.id)
       AND ${liveOrgPredicate()}
     ORDER BY g.id`), 'wisp-wake-grants-for-event');
  return result.map((r) => ({ grantId: r.grant_id, orgId }));
}

/**
 * The deterministic digest hint (assessment.ts DeterministicDigestHint) an
 * event names: only for the four digest events, and only when the id is a
 * uuid.
 */
function digestHintFor(event: BreezeEvent): DeterministicDigestHint {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case 'alert.triggered':
      return isUuid(p.alertId) ? { subject: { kind: 'alert', id: p.alertId } } : {};
    case 'integration.health_opened':
      return isUuid(p.incidentId) ? { subject: { kind: 'integration', id: p.incidentId } } : {};
    case 'ticket.stale':
      return isUuid(p.ticketId) ? { subject: { kind: 'ticket', id: p.ticketId } } : {};
    case 'ai.operator.task.finished':
      return isUuid(p.taskId) ? { subject: { kind: 'task', id: p.taskId }, failed: p.state === 'failed' } : {};
    default:
      return {};
  }
}

/**
 * #10388: the event reason carries the event's subject — `alertId` /
 * `deviceId` from the payload, uuids only — so the assessment can look up the
 * alert the event is about. The bus event id alone names nothing a tool can
 * read (events live in Redis streams, not a table). A request that coalesces
 * onto a live job keeps the FIRST event's reason (requestAssessment), so a
 * later event's subject can be lost here; the changes digest (alerts
 * triggered OR resolved since the watermark) is what covers it.
 *
 * #11425: `anomaly.incident_opened` sends ids only (`{ incidentId, deviceId }`,
 * metricAnomalyIncidentPublisher.ts). Its `incidentId` is carried as
 * `anomalyIncidentId` so the assessment can load that anomaly incident.
 * Only this event's `incidentId` is read that way: `integration.health_opened`
 * also sends an `incidentId`, but it names a connection-health incident.
 */
function eventReason(event: BreezeEvent): AssessmentReason {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  return {
    kind: 'event',
    eventType: event.type,
    eventId: event.id,
    ...(isUuid(p.alertId) ? { alertId: p.alertId } : {}),
    ...(isUuid(p.deviceId) ? { deviceId: p.deviceId } : {}),
    ...(event.type === 'anomaly.incident_opened' && isUuid(p.incidentId) ? { anomalyIncidentId: p.incidentId } : {}),
  };
}

/**
 * No self-wake: an assessment run's own terminal event must not request
 * another assessment. The run events carry no profile, so it is one
 * primary-key read.
 */
async function isAssessmentRun(event: BreezeEvent): Promise<boolean> {
  const runId = (event.payload as Record<string, unknown> | undefined)?.runId;
  if (!isUuid(runId)) return false;
  const [row] = await sys(() => rows<{ profile: string }>(sql`
    SELECT profile FROM ai_agent_runs WHERE id = ${runId} LIMIT 1`), 'wisp-wake-run-profile');
  return row?.profile === 'assessment';
}

async function loadActiveGrantPin(grantId: unknown): Promise<WakeGrantPin | null> {
  if (!isUuid(grantId)) return null;
  const [row] = await sys(() => rows<{ id: string; partner_id: string; status: string; current_revision_id: string | null }>(sql`
    SELECT id, partner_id, status, current_revision_id
      FROM wisp_grants
     WHERE id = ${grantId}
     LIMIT 1`), 'wisp-wake-grant');
  if (!row || row.status !== 'active') return null;
  return { id: row.id, partnerId: row.partner_id, currentRevisionId: row.current_revision_id ?? null };
}

/**
 * w00 A33: which of a grant's assessable orgs onboarding assesses: the first 10,
 * alphabetical by org name. Pure, and shared with the first-look post (#10402),
 * which waits for this same list. Collation-independent: the DB's ORDER BY name
 * depends on the database collation, the onboarding order must not.
 */
export function onboardingBatch<T extends { id: string; name: string }>(assessableOrgs: T[]): T[] {
  return [...assessableOrgs]
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, ONBOARDING_ORG_LIMIT);
}

/** w00 A33: onboarding assessments for the first 10 orgs of the ceiling. */
async function onboardGrant(grantId: unknown): Promise<void> {
  const grant = await loadActiveGrantPin(grantId);
  if (!grant) return;
  const ceiling = await ceilingForGrant(grant);
  if (!ceiling) return;
  const assessable = assessableOrgIds(ceiling);
  const orgs = onboardingBatch((await loadLivePartnerOrgs(grant.partnerId)).filter((o) => assessable.has(o.id)));
  for (const org of orgs) {
    await requestAssessment({ grantId: grant.id, orgId: org.id, reason: { kind: 'onboarding' } });
  }
}

/** w00 A29: a resumed grant gets one floor-tick assessment now, for the round-robin org. */
async function tickResumedGrant(grantId: unknown): Promise<void> {
  const grant = await loadActiveGrantPin(grantId);
  if (!grant) return;
  const orgId = await roundRobinOrgForGrant(grant);
  if (orgId) await requestAssessment({ grantId: grant.id, orgId, reason: { kind: 'tick' } });
}

/** The `wisp-wake` subscriber body (services/eventSubscribers.ts). */
export async function handleWispWakeEvent(event: BreezeEvent): Promise<void> {
  if (!wispEnabled()) return;

  // The grant events route on the grant's org, or on its PARTNER id for a
  // partner-wide grant (routes/wisp.ts publishGrantEvent): never treat
  // event.orgId as an org here.
  if (event.type === 'wisp.grant.created') return onboardGrant(event.payload?.grantId);
  if (event.type === 'wisp.grant.resumed') return tickResumedGrant(event.payload?.grantId);

  if (!isUuid(event.orgId)) return;
  if ((event.type === 'ai.agent.run.completed' || event.type === 'ai.agent.run.failed') && (await isAssessmentRun(event))) {
    return;
  }

  const grants = await grantsForEvent(event);
  if (grants.length === 0) return;
  const reason = eventReason(event);
  const hint = digestHintFor(event);
  for (const g of grants) {
    await requestAssessment({ grantId: g.grantId, orgId: g.orgId, reason, ...hint });
  }
}
