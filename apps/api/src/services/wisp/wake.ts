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
 *                        BullMQ job per pair is the window.
 *   pickRoundRobinOrg    pure: never-assessed orgs first, then the oldest.
 *
 * The 5-minute tick that drives floor ticks and watches lives in
 * jobs/wispWakeScheduler.ts, which also processes the delayed `assess` jobs.
 *
 * DB access: every read runs in a FRESH system context
 * (`runOutsideDbContext(withSystemDbAccessContext)`); every enqueue happens
 * after that block has returned (#1105).
 */
import { Queue } from 'bullmq';
import { sql, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { wispEnabled } from '../../config/env';
import { getBullMQConnection } from '../redis';
import { notHoldingOrgCondition } from '../unassignedPool/selectorPredicate';
import type { BreezeEvent } from '../eventBus';
import { GrantInactiveError, resolveGrantCeiling, type GrantCeiling } from './grantAuthority';
import { assessableOrgIds } from './assessableOrgs';
import type { AssessmentReason, DeterministicDigestHint } from './assessment';

export const WISP_WAKE_QUEUE = 'wisp-wake';
export const WISP_WAKE_DEBOUNCE_MS = 60_000;
// jobs/wispWakeScheduler.ts registers the repeatable with its own same-file
// literal (scheduleRegistry.contract.test.ts resolves `repeat: { every }`
// from same-file consts only); its test pins the two equal.
export const WISP_WAKE_TICK_INTERVAL_MS = 5 * 60 * 1000;

/** w00 A33: onboarding assesses at most this many orgs at once; the rest reach the floor tick. */
export const ONBOARDING_ORG_LIMIT = 10;

export const ASSESS_JOB = 'assess';
const ASSESS_JOB_ATTEMPTS = 3;
const ASSESS_JOB_BACKOFF_MS = 30_000;

export type WispAssessJobData = { grantId: string; orgId: string; reason: AssessmentReason } & DeterministicDigestHint;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Job states in which a job with this id still covers the window. */
const LIVE_JOB_STATES = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);

let wakeQueue: Queue<WispAssessJobData | Record<string, never>> | null = null;

export function getWispWakeQueue(): Queue<WispAssessJobData | Record<string, never>> {
  if (!wakeQueue) {
    wakeQueue = new Queue<WispAssessJobData | Record<string, never>>(WISP_WAKE_QUEUE, { connection: getBullMQConnection() });
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
 * Ask for one assessment of (grant, org) within the next 60 s.
 *
 * One delayed job per (grant, org) IS the window: every request while that job
 * is still waiting, delayed or running collapses onto it. The stored data is
 * the FIRST request's — its reason and its deterministic digest hint. Later
 * coalesced requests' hints are dropped; that is acceptable because a funded
 * assessment reads everything since the watermark, not the reason, and on the
 * budget-exhausted path the concerns list and the next funded assessment
 * cover the events whose hint was dropped.
 *
 * A retained completed / failed job with the same id would make BullMQ no-op
 * the add forever (it dedupes on any job record still in Redis), so such a
 * record is removed first. Two replicas racing the empty window both add; the
 * second add is a BullMQ no-op, and both report 'queued' — a miscount, never a
 * second job.
 */
export async function requestAssessment(input: WispAssessJobData): Promise<'queued' | 'coalesced'> {
  const queue = getWispWakeQueue();
  const jobId = wakeJobId(input.grantId, input.orgId);

  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (LIVE_JOB_STATES.has(state)) return 'coalesced';
    await existing.remove().catch((err: unknown) => {
      console.warn('[wisp-wake] could not remove a finished assess job', { jobId, state, err });
    });
  }

  const data: WispAssessJobData = { grantId: input.grantId, orgId: input.orgId, reason: input.reason };
  if (input.subject) data.subject = input.subject;
  if (input.failed !== undefined) data.failed = input.failed;
  await queue.add(ASSESS_JOB, data, {
    jobId,
    delay: WISP_WAKE_DEBOUNCE_MS,
    // A transient failure (Redis / DB blip in enqueueAssessment) retries the
    // SAME job: BullMQ moves it back to 'delayed' under its own jobId for the
    // backoff, so the window above keeps coalescing onto it meanwhile.
    attempts: ASSESS_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: ASSESS_JOB_BACKOFF_MS },
    removeOnComplete: true,
    removeOnFail: { count: 100 },
  });
  return 'queued';
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
 */
export async function loadLastAssessedByOrg(grantId: string): Promise<Map<string, Date>> {
  const result = await sys(() => rows<{ org_id: string; last_assessed_at: unknown }>(sql`
    SELECT org_id, max(finished_at) AS last_assessed_at
      FROM ai_agent_runs
     WHERE grant_id = ${grantId}
       AND profile = 'assessment'
       AND status IN ('completed', 'awaiting_approval')
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

/** w00 A33: onboarding assessments for the first 10 orgs of the ceiling, alphabetical by org name. */
async function onboardGrant(grantId: unknown): Promise<void> {
  const grant = await loadActiveGrantPin(grantId);
  if (!grant) return;
  const ceiling = await ceilingForGrant(grant);
  if (!ceiling) return;
  const assessable = assessableOrgIds(ceiling);
  const orgs = (await loadLivePartnerOrgs(grant.partnerId))
    .filter((o) => assessable.has(o.id))
    // Collation-independent: the DB's ORDER BY name depends on the database
    // collation, the onboarding order must not.
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, ONBOARDING_ORG_LIMIT);
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
  const reason: AssessmentReason = { kind: 'event', eventType: event.type, eventId: event.id };
  const hint = digestHintFor(event);
  for (const g of grants) {
    await requestAssessment({ grantId: g.grantId, orgId: g.orgId, reason, ...hint });
  }
}
