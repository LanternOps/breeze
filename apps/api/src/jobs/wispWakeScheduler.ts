/**
 * Wisp W05b Task 9 (#9917) — the wake scheduler. Two job shapes on ONE queue
 * (`wisp-wake`, services/wisp/wake.ts):
 *
 *  - `tick` — a repeatable every 5 minutes. In order, each section separately
 *    caught so a failing one never stops the next:
 *      1. reconcileEntitlements — spec §10: an active grant whose partner lost
 *         the `wisp` entitlement is paused `entitlement_lost`; a grant paused
 *         for that reason whose partner is entitled again is resumed. One
 *         lookup per distinct partner. W02's reconciler leaves this reason
 *         alone (W02 cannot import W01); no other paused_reason — above all
 *         `user_paused` (w00 A29) — is ever touched here.
 *      2. stopWatchesForInactiveGrants (W05a; it sends the one orphan notice).
 *      3. floor ticks — every active grant whose last_floor_tick_at is NULL or
 *         older than floor_tick_minutes is claimed with a compare-and-set, and
 *         ONE org per grant (round-robin over ceiling ∩ live orgs) gets a
 *         `tick` request: a quiet partner pays once per floor tick, not N×.
 *      4. due watches — claimDueWatches (which advances next_due_at in the
 *         same statement) → a `watch` request; a partner-wide watch (orgId
 *         null) takes its grant's round-robin org.
 *      5. pollStaleTickets, 6. pollTicketClusters, 7. correlateIncidents.
 *  - `assess` — the debounced per-(grant, org) job requestAssessment adds;
 *    processAssessJob hands it to enqueueAssessment.
 *
 * Gating mirrors aiAgentSweepScheduler.ts: the worker and the repeatable are
 * registered unconditionally (registry-driven); the tick and the assess job
 * return at once when `!wispEnabled()`, so flipping the flag needs no restart.
 *
 * One worker, concurrency 4, for both names (BullMQ workers cannot filter by
 * job name — see aiAgentSweepScheduler.ts). The tick's single-flight comes
 * from its repeatable jobId and the per-grant CAS, not from concurrency.
 *
 * DB access: every read/write runs in a FRESH system context; every
 * requestAssessment / enqueueAssessment call happens outside it (#1105).
 */
import { Worker, type Job } from 'bullmq';
import { sql, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { wispEnabled } from '../config/env';
import { getBullMQConnection } from '../services/redis';
import { hasEntitlement } from '../services/entitlements';
import { captureException } from '../services/sentry';
import { ASSESSMENT_BUDGET_CENTS_PER_RUN } from '../services/aiAgents/assessmentProfile';
import { enqueueAssessment } from '../services/wisp/assessment';
import { assessableOrgIds } from '../services/wisp/assessableOrgs';
import { chargeableUnderGrant, notifyBudgetExhaustedOnce } from '../services/wisp/budget';
import { pauseGrant, resumeGrant } from '../services/wisp/grants';
import { correlateIncidents } from '../services/wisp/incidentCorrelator';
import { pollStaleTickets, pollTicketClusters } from '../services/wisp/pollers';
import { claimDueWatches, stopWatchesForInactiveGrants } from '../services/wisp/watches';
import {
  ASSESS_JOB,
  WISP_WAKE_QUEUE,
  closeWispWakeQueue,
  getWispWakeQueue,
  ceilingForGrant,
  requestAssessment,
  roundRobinOrgForGrant,
  type WakeGrantPin,
  type WispAssessJobData,
} from '../services/wisp/wake';
import { attachWorkerObservability } from './workerObservability';

const TICK_JOB = 'tick';
const TICK_JOB_ID = 'wisp-wake-tick';
/**
 * Same value as WISP_WAKE_TICK_INTERVAL_MS (wake.ts; the test pins them
 * equal). A same-file literal because scheduleRegistry.contract.test.ts
 * resolves `repeat: { every }` statically from same-file consts only.
 */
const WAKE_TICK_EVERY_MS = 5 * 60 * 1000;
const WAKE_WORKER_CONCURRENCY = 4;
/** Due watches claimed per tick. */
const WATCH_CLAIM_LIMIT = 200;
/** Due grants floor-ticked per tick; the rest are still due on the next one. */
const FLOOR_TICK_GRANT_LIMIT = 500;

export type WakeTickResult = {
  grantsTicked: number;
  watchesFired: number;
  staleTicketsPublished: number;
  watchesStopped: number;
  grantsPaused: number;
  grantsResumed: number;
  ticketClustersOpened: number;
  incidentsOpened: number;
};

function sys<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

async function rows<T>(query: SQL): Promise<T[]> {
  return [...((await db.execute(query)) as unknown as T[])];
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Every swallowed tick failure is reported, not only logged: a lost tick must be visible. */
function report(err: unknown, tags: Record<string, string>): void {
  captureException(err, undefined, { component: 'wisp.wakeScheduler', ...tags });
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

type ReconcileRow = { id: string; partner_id: string; status: string; paused_reason: string | null };

/**
 * spec §10 entitlement reconcile. Reads only active grants and grants paused
 * `entitlement_lost`; a row of any other shape is skipped even if it appears.
 * A partner whose lookup fails is left untouched this tick.
 */
export async function reconcileEntitlements(now: Date): Promise<{ paused: number; resumed: number }> {
  const nowIso = now.toISOString();
  const grants = await sys(() => rows<ReconcileRow>(sql`
    SELECT id, partner_id, status, paused_reason
      FROM wisp_grants
     WHERE (status = 'active' AND expires_at > ${nowIso}::timestamptz)
        OR (status = 'paused' AND paused_reason = 'entitlement_lost')
     ORDER BY partner_id, id`), 'wisp-wake-reconcile-entitlements');

  const entitled = new Map<string, boolean>();
  for (const partnerId of new Set(grants.map((g) => g.partner_id))) {
    try {
      entitled.set(partnerId, await hasEntitlement(partnerId, 'wisp'));
    } catch (err) {
      console.error('[wisp-wake] reconcileEntitlements: entitlement lookup failed; partner left untouched', { partnerId, error: errMessage(err) });
      report(err, { op: 'reconcile_entitlement_lookup' });
    }
  }

  let paused = 0;
  let resumed = 0;
  for (const g of grants) {
    const ok = entitled.get(g.partner_id);
    if (ok === undefined) continue;
    try {
      if (g.status === 'active' && !ok) {
        // onlyFromActive: a pause the grantor made meanwhile stays theirs.
        await pauseGrant(g.id, 'entitlement_lost', { onlyFromActive: true });
        paused += 1;
      } else if (g.status === 'paused' && g.paused_reason === 'entitlement_lost' && ok) {
        // CAS on exactly this reason: a different pause set meanwhile is left alone.
        await resumeGrant(g.id, 'entitlement_lost');
        resumed += 1;
      }
    } catch (err) {
      console.error('[wisp-wake] reconcileEntitlements: grant update failed', { grantId: g.id, error: errMessage(err) });
      report(err, { op: 'reconcile_grant_update' });
    }
  }
  return { paused, resumed };
}

// A35 reconcilePartnerDisabled goes here (wisp_partner_settings.enabled = false
// ⇒ pauseGrant(id, 'partner_disabled'); true again ⇒ resume; skips user_paused)
// once W08's partner settings column exists.

type DueGrantRow = { id: string; partner_id: string; current_revision_id: string | null; last_floor_tick_text: string | null };

/** Floor ticks: one claimed request per due grant. Returns the grants that got a request. */
async function runFloorTicks(now: Date): Promise<number> {
  const nowIso = now.toISOString();
  // last_floor_tick_at is read as TEXT so the CAS below compares the exact
  // stored value (a JS Date would drop microseconds and never match).
  const due = await sys(() => rows<DueGrantRow>(sql`
    SELECT id, partner_id, current_revision_id, last_floor_tick_at::text AS last_floor_tick_text
      FROM wisp_grants
     WHERE status = 'active'
       AND expires_at > ${nowIso}::timestamptz
       AND (last_floor_tick_at IS NULL OR last_floor_tick_at <= ${nowIso}::timestamptz - floor_tick_minutes * interval '1 minute')
     ORDER BY last_floor_tick_at NULLS FIRST, id
     LIMIT ${FLOOR_TICK_GRANT_LIMIT}`), 'wisp-wake-floor-due');

  let ticked = 0;
  for (const g of due) {
    try {
      const claimed = await sys(() => rows<{ id: string }>(sql`
        UPDATE wisp_grants
           SET last_floor_tick_at = ${nowIso}::timestamptz
         WHERE id = ${g.id}
           AND status = 'active'
           AND last_floor_tick_at IS NOT DISTINCT FROM ${g.last_floor_tick_text}::timestamptz
        RETURNING id`), 'wisp-wake-floor-claim');
      if (claimed.length === 0) continue; // another replica won this grant's tick
      // The claim advanced the cursor BEFORE the request below. Kept that way
      // on purpose: rolling it back after a failure could let two replicas
      // both fire this grant. Accepted loss: a failure after the claim skips
      // this grant's floor tick for one floor interval (it is reported below).
      // Spec §9: an exhausted UTC-day budget suspends the floor tick (the model
      // is off until the window rolls; event-driven bookkeeping continues in
      // enqueueAssessment). The grantor is told once per window; the grant is
      // never paused. The claim above still advances the cursor, so the next
      // check is one floor interval away, not every tick.
      const budget = await chargeableUnderGrant(g.id, ASSESSMENT_BUDGET_CENTS_PER_RUN);
      if (!budget.ok) {
        await notifyBudgetExhaustedOnce(g.id, now);
        continue;
      }
      const orgId = await roundRobinOrgForGrant({ id: g.id, partnerId: g.partner_id, currentRevisionId: g.current_revision_id });
      if (!orgId) continue;
      await requestAssessment({ grantId: g.id, orgId, reason: { kind: 'tick' } });
      ticked += 1;
    } catch (err) {
      console.error('[wisp-wake] floorTicks: grant failed', { grantId: g.id, error: errMessage(err) });
      report(err, { op: 'floor_tick_grant' });
    }
  }
  return ticked;
}

/** Due watches → `watch` requests. Returns the watches that got a request. */
async function runDueWatches(now: Date): Promise<number> {
  // claimDueWatches advances next_due_at in the claim itself, before any
  // request below — same trade as the floor-tick CAS: no rollback (it could
  // double-fire across replicas), so a failure after the claim loses that
  // watch's run for one cadence interval, and is reported.
  const watches = await claimDueWatches(now, WATCH_CLAIM_LIMIT);
  if (watches.length === 0) return 0;

  // claimDueWatches is a system claim with no ceiling filter: every watch is
  // re-checked here against its grant's LIVE ceiling, and one whose org is
  // outside it (or reached only through a site restriction) is skipped — its
  // next_due_at has already advanced, so it simply stays idle until the
  // grant's reach covers it again (or the watch is stopped).
  const grantIds = [...new Set(watches.map((w) => w.grantId))];
  const pins = new Map<string, WakeGrantPin>();
  const grantRows = await sys(() => rows<{ id: string; partner_id: string; current_revision_id: string | null }>(sql`
    SELECT id, partner_id, current_revision_id
      FROM wisp_grants
     WHERE id IN (${sql.join(grantIds.map((id) => sql`${id}`), sql`, `)})`), 'wisp-wake-watch-grants');
  for (const r of grantRows) pins.set(r.id, { id: r.id, partnerId: r.partner_id, currentRevisionId: r.current_revision_id ?? null });
  // One ceiling read and one round-robin pick per grant per tick.
  const assessable = new Map<string, Promise<Set<string>>>();
  const assessableFor = (pin: WakeGrantPin): Promise<Set<string>> => {
    let p = assessable.get(pin.id);
    if (!p) {
      p = ceilingForGrant(pin).then((c) => (c ? assessableOrgIds(c) : new Set<string>()));
      assessable.set(pin.id, p);
    }
    return p;
  };
  const picks = new Map<string, Promise<string | null>>();

  let fired = 0;
  for (const w of watches) {
    try {
      const pin = pins.get(w.grantId);
      if (!pin) continue;
      let orgId = w.orgId;
      if (orgId !== null) {
        if (!(await assessableFor(pin)).has(orgId)) {
          console.info('[wisp-wake] dueWatches: watch org outside the grant\'s assessable ceiling; skipped', { watchId: w.id, grantId: w.grantId });
          continue;
        }
      } else {
        let pick = picks.get(w.grantId);
        if (!pick) {
          pick = roundRobinOrgForGrant(pin);
          picks.set(w.grantId, pick);
        }
        orgId = await pick;
      }
      if (!orgId) continue;
      await requestAssessment({ grantId: w.grantId, orgId, reason: { kind: 'watch', watchId: w.id } });
      fired += 1;
    } catch (err) {
      console.error('[wisp-wake] dueWatches: watch failed', { watchId: w.id, grantId: w.grantId, error: errMessage(err) });
      report(err, { op: 'due_watch' });
    }
  }
  return fired;
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

async function section(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[wisp-wake] tick section ${name} failed`, errMessage(err));
    report(err, { op: 'tick_section', section: name });
  }
}

export async function processWakeTick(now: Date = new Date()): Promise<WakeTickResult> {
  const result: WakeTickResult = {
    grantsTicked: 0,
    watchesFired: 0,
    staleTicketsPublished: 0,
    watchesStopped: 0,
    grantsPaused: 0,
    grantsResumed: 0,
    ticketClustersOpened: 0,
    incidentsOpened: 0,
  };
  if (!wispEnabled()) return result;

  await section('reconcileEntitlements', async () => {
    const r = await reconcileEntitlements(now);
    result.grantsPaused = r.paused;
    result.grantsResumed = r.resumed;
  });
  await section('stopWatchesForInactiveGrants', async () => {
    result.watchesStopped = (await stopWatchesForInactiveGrants(now)).stopped;
  });
  await section('floorTicks', async () => {
    result.grantsTicked = await runFloorTicks(now);
  });
  await section('dueWatches', async () => {
    result.watchesFired = await runDueWatches(now);
  });
  await section('pollStaleTickets', async () => {
    result.staleTicketsPublished = (await pollStaleTickets(now)).published;
  });
  await section('pollTicketClusters', async () => {
    result.ticketClustersOpened = (await pollTicketClusters(now)).clustersOpened;
  });
  await section('correlateIncidents', async () => {
    result.incidentsOpened = (await correlateIncidents(now)).partnerIncidentsOpened;
  });
  // W07 Task 8 adds setWispGrantsActive(count) here.
  return result;
}

/**
 * The debounced assess job. A grant paused or revoked since the wake admits
 * nothing (enqueueAssessment → skip 'grant_inactive'); every skip is logged
 * at info, never thrown.
 */
export async function processAssessJob(data: WispAssessJobData): Promise<void> {
  if (!wispEnabled()) return;
  const result = await enqueueAssessment(data);
  if ('skipped' in result) {
    console.info('[wisp-wake] assessment skipped', { grantId: data.grantId, orgId: data.orgId, reason: data.reason.kind, skipped: result.skipped });
  }
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

type WakeJobData = WispAssessJobData | Record<string, never>;

let wakeWorker: Worker<WakeJobData> | null = null;

function createWispWakeWorker(): Worker<WakeJobData> {
  return new Worker<WakeJobData>(
    WISP_WAKE_QUEUE,
    async (job: Job<WakeJobData>) => {
      switch (job.name) {
        case TICK_JOB:
          return processWakeTick();
        case ASSESS_JOB:
          return processAssessJob(job.data as WispAssessJobData);
        default:
          throw new Error(`[wisp-wake] unknown job name: ${job.name}`);
      }
    },
    { connection: getBullMQConnection(), concurrency: WAKE_WORKER_CONCURRENCY },
  );
}

/**
 * Boot reconcile (aiAgentSweepScheduler.ts): remove any existing `tick`
 * repeatable before adding, so a changed interval never leaves the previous
 * one running alongside.
 */
export async function initializeWispWakeScheduler(): Promise<void> {
  wakeWorker = createWispWakeWorker();
  attachWorkerObservability(wakeWorker, 'wispWakeScheduler');
  wakeWorker.on('error', (error) => {
    console.error('[wisp-wake] worker error:', error);
  });

  const queue = getWispWakeQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === TICK_JOB) await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(
    TICK_JOB,
    {},
    {
      jobId: TICK_JOB_ID,
      repeat: { every: WAKE_TICK_EVERY_MS },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );
  console.log('[wisp-wake] scheduler initialized');
}

export async function shutdownWispWakeScheduler(): Promise<void> {
  if (wakeWorker) {
    const w = wakeWorker;
    wakeWorker = null;
    await w.close();
  }
  await closeWispWakeQueue();
}
