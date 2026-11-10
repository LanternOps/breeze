/**
 * Wisp W05b Task 9 (#9917) — the wake scheduler. Three job shapes on ONE queue
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
 *      1b. reconcilePartnerSwitches — w00 A35 (W08): a partner whose Wisp
 *         switch is off has its active grants paused `partner_disabled`; one
 *         switched back on has exactly those grants resumed. Runs AFTER (1)
 *         so a grant (1) just resumed for a still-disabled partner is paused
 *         again before the floor ticks. Every pause is onlyFromActive and
 *         every resume a CAS on its own reason, so (1) and (1b) never move a
 *         grant the other paused.
 *      2. stopWatchesForInactiveGrants (W05a; it sends the one orphan notice).
 *      3. floor ticks — every active grant whose last_floor_tick_at is NULL or
 *         older than floor_tick_minutes is claimed with a compare-and-set, and
 *         ONE org per grant (round-robin over ceiling ∩ live orgs) gets a
 *         `tick` request: a quiet partner pays once per floor tick, not N×.
 *      4. due watches — claimDueWatches (which advances next_due_at in the
 *         same statement), then each watch is evaluated in code (#11424,
 *         services/wisp/watchHits.ts): a `watch` request only when its
 *         hit-set changed since the last recorded one, none is recorded, the
 *         kind is not evaluated, or the evaluation failed (fail-open). The
 *         new hit-set is recorded by processAssessJob once a run is
 *         admitted. A partner-wide watch (orgId null) takes its grant's
 *         round-robin org, for the evaluation and the request alike.
 *      4b. reconcileCheckIns (#10991) — a `scheduled` check-in more than
 *         2 minutes overdue with no live job is re-enqueued with delay 0
 *         (services/wisp/checkIns.ts reconcileOrphanCheckIns).
 *      4c. reconcileCheckInTriggers (W04 #11493) — every `scheduled` event
 *         check-in before its deadline is fired if its state now holds, or
 *         cancelled if its subject is gone (reconcileCheckInTriggers).
 *      4d. reconcileRunningCheckIns (W07 #11496) — a `running` run check-in
 *         whose run settled without its post gets it now
 *         (services/wisp/checkInRuns.ts).
 *      5. pollStaleTickets, 6. pollTicketClusters, 7. correlateIncidents,
 *      8. rollupDeviceConcerns (#11426: ≥ 3 device concerns of one org
 *         sharing a pattern → one org-level parent; services/wisp/concernRollup.ts).
 *  - `assess` — the debounced per-(grant, org) job requestAssessment adds;
 *    processAssessJob hands it to enqueueAssessment.
 *  - `check-in` — the delayed job of one Wisp check-in timer (#10991);
 *    processCheckInJob hands it to fireCheckIn.
 *
 * Gating mirrors aiAgentSweepScheduler.ts: the worker and the repeatable are
 * registered unconditionally (registry-driven); the tick, the assess job and
 * the check-in job return at once when `!wispEnabled()`, so flipping the flag
 * needs no restart.
 *
 * One worker, concurrency 4, for every name (BullMQ workers cannot filter by
 * job name — see aiAgentSweepScheduler.ts). The tick's single-flight comes
 * from its repeatable jobId and the per-grant CAS, not from concurrency.
 *
 * DB access: every read/write runs in a FRESH system context; every
 * requestAssessment / enqueueAssessment / enqueueCheckIn / notifyUser call
 * happens outside it (#1105).
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
import { reconcilePartnerDisabled } from '../services/wisp/partnerSettings';
import { setWispGrantsActive } from '../services/wispMetrics';
import { correlateIncidents } from '../services/wisp/incidentCorrelator';
import { rollupDeviceConcerns } from '../services/wisp/concernRollup';
import { pollStaleTickets, pollTicketClusters } from '../services/wisp/pollers';
import { claimDueWatches, recordWatchHits, stopWatchesForInactiveGrants } from '../services/wisp/watches';
import { evaluateWatchHits, parseWatchHitRecord, watchHitChange, type WatchHitSet } from '../services/wisp/watchHits';
import type { AssessmentReason } from '../services/wisp/assessmentTypes';
import { fireCheckIn, reconcileCheckInTriggers, reconcileOrphanCheckIns } from '../services/wisp/checkIns';
import { reconcileRunningCheckIns } from '../services/wisp/checkInRuns';
import {
  ASSESS_JOB,
  CHECK_IN_JOB,
  WISP_WAKE_QUEUE,
  closeWispWakeQueue,
  getWispWakeQueue,
  ceilingForGrant,
  requestAssessment,
  roundRobinOrgForGrant,
  type WakeGrantPin,
  type WispAssessJobData,
  type WispCheckInJobData,
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
  /** #11424: due watches evaluated whose hit-set had not changed — no request. */
  watchesUnchanged: number;
  staleTicketsPublished: number;
  watchesStopped: number;
  grantsPaused: number;
  grantsResumed: number;
  ticketClustersOpened: number;
  incidentsOpened: number;
  /** #11426: org-level parents the same-org device-concern rollup opened. */
  concernRollupsOpened: number;
  checkInsRefired: number;
  checkInTriggersFired: number;
  checkInTriggersCancelled: number;
  /** W07: settled run check-ins whose result the tick posted. */
  checkInRunsPosted: number;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
export async function reconcileEntitlements(now: Date): Promise<{ paused: number; resumed: number; active: number }> {
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
  // Active grants after this reconcile: the gauge's value, from rows already loaded.
  const active = grants.filter((g) => g.status === 'active').length - paused;
  return { paused, resumed, active: active + resumed };
}

/**
 * w00 A35 partner enable switch. ONE query finds the partners whose grants
 * disagree with their switch — disabled (enabled = false) with an active
 * grant, or enabled (or no settings row: enabled by default) with a grant
 * paused `partner_disabled` — then reconcilePartnerDisabled per partner. A
 * partner that fails is logged, reported and retried on the next tick.
 */
export async function reconcilePartnerSwitches(now: Date): Promise<{ paused: number; resumed: number }> {
  const nowIso = now.toISOString();
  const partners = await sys(() => rows<{ partner_id: string }>(sql`
    SELECT DISTINCT g.partner_id
      FROM wisp_grants g
      LEFT JOIN wisp_partner_nudge_settings s ON s.partner_id = g.partner_id
     WHERE g.expires_at > ${nowIso}::timestamptz
       AND ((COALESCE(s.enabled, true) = false AND g.status = 'active')
         OR (COALESCE(s.enabled, true) = true AND g.status = 'paused' AND g.paused_reason = 'partner_disabled'))
     ORDER BY g.partner_id`), 'wisp-wake-reconcile-partner-switch');

  let paused = 0;
  let resumed = 0;
  for (const { partner_id: partnerId } of partners) {
    try {
      const r = await reconcilePartnerDisabled(partnerId, now);
      paused += r.paused;
      resumed += r.resumed;
    } catch (err) {
      console.error('[wisp-wake] reconcilePartnerDisabled: partner failed; retried next tick', { partnerId, error: errMessage(err) });
      report(err, { op: 'reconcile_partner_disabled' });
    }
  }
  return { paused, resumed };
}

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

/**
 * Due watches → `watch` requests, for a changed hit-set only (#11424).
 * `fired` = watches that got a request; `unchanged` = watches evaluated with
 * the same hit-set as last recorded (no request).
 */
async function runDueWatches(now: Date): Promise<{ fired: number; unchanged: number }> {
  // claimDueWatches advances next_due_at in the claim itself, before any
  // request below — same trade as the floor-tick CAS: no rollback (it could
  // double-fire across replicas), so a failure after the claim loses that
  // watch's run for one cadence interval, and is reported.
  const watches = await claimDueWatches(now, WATCH_CLAIM_LIMIT);
  if (watches.length === 0) return { fired: 0, unchanged: 0 };

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
  let unchanged = 0;
  for (const w of watches) {
    try {
      const pin = pins.get(w.grantId);
      if (!pin) continue;
      const partnerWide = w.orgId === null;
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

      // #11424: evaluate in code. An unchanged hit-set launches no run — the
      // claim already moved last_ran_at and next_due_at.
      let hits: WatchHitSet | null = null;
      try {
        hits = await evaluateWatchHits(w, orgId, now);
      } catch (err) {
        // Fail open to the pre-#11424 behaviour (a plain watch run): a broken
        // evaluator must cost a run, never silence the watch.
        console.error('[wisp-wake] dueWatches: watch evaluation failed; running it unevaluated', { watchId: w.id, grantId: w.grantId, error: errMessage(err) });
        report(err, { op: 'watch_evaluate' });
      }
      const change = hits ? watchHitChange(w, hits, { orgId, partnerWide }) : null;
      if (hits && !change) {
        unchanged += 1;
        continue;
      }
      const reason: AssessmentReason = change
        ? { kind: 'watch', watchId: w.id, hits: change }
        : { kind: 'watch', watchId: w.id };
      // The new hit-set rides on the job and is recorded by processAssessJob
      // only once a run is ADMITTED for it. A coalesced request (another
      // assess job for the org is live and keeps its own data), a failed
      // request, or an admission skip (budget, no Triage agent, …) leaves the
      // stored hit-set alone, so the next cadence asks again rather than
      // losing the change.
      await requestAssessment({
        grantId: w.grantId,
        orgId,
        reason,
        ...(hits ? { watchRecord: { watchId: w.id, previousHash: w.hitHash, hash: hits.hash, count: hits.count } } : {}),
      });
      fired += 1;
    } catch (err) {
      console.error('[wisp-wake] dueWatches: watch failed', { watchId: w.id, grantId: w.grantId, error: errMessage(err) });
      report(err, { op: 'due_watch' });
    }
  }
  return { fired, unchanged };
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
  let activeGrants: number | null = null;
  const result: WakeTickResult = {
    grantsTicked: 0,
    watchesFired: 0,
    watchesUnchanged: 0,
    staleTicketsPublished: 0,
    watchesStopped: 0,
    grantsPaused: 0,
    grantsResumed: 0,
    ticketClustersOpened: 0,
    incidentsOpened: 0,
    concernRollupsOpened: 0,
    checkInsRefired: 0,
    checkInTriggersFired: 0,
    checkInTriggersCancelled: 0,
    checkInRunsPosted: 0,
  };
  if (!wispEnabled()) return result;

  await section('reconcileEntitlements', async () => {
    const r = await reconcileEntitlements(now);
    result.grantsPaused = r.paused;
    result.grantsResumed = r.resumed;
    activeGrants = r.active;
  });
  await section('reconcilePartnerDisabled', async () => {
    const r = await reconcilePartnerSwitches(now);
    result.grantsPaused += r.paused;
    result.grantsResumed += r.resumed;
    if (activeGrants !== null) activeGrants = activeGrants - r.paused + r.resumed;
  });
  await section('stopWatchesForInactiveGrants', async () => {
    result.watchesStopped = (await stopWatchesForInactiveGrants(now)).stopped;
  });
  await section('floorTicks', async () => {
    result.grantsTicked = await runFloorTicks(now);
  });
  await section('dueWatches', async () => {
    const watches = await runDueWatches(now);
    result.watchesFired = watches.fired;
    result.watchesUnchanged = watches.unchanged;
  });
  await section('reconcileCheckIns', async () => {
    result.checkInsRefired = (await reconcileOrphanCheckIns(now)).refired;
  });
  await section('reconcileCheckInTriggers', async () => {
    const r = await reconcileCheckInTriggers(now);
    result.checkInTriggersFired = r.fired;
    result.checkInTriggersCancelled = r.cancelled;
  });
  await section('reconcileRunningCheckIns', async () => {
    result.checkInRunsPosted = (await reconcileRunningCheckIns(now)).posted;
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
  await section('rollupDeviceConcerns', async () => {
    result.concernRollupsOpened = (await rollupDeviceConcerns(now)).opened;
  });
  // null when the reconcile section failed: leave the gauge at its last value.
  if (activeGrants !== null) setWispGrantsActive(activeGrants);
  return result;
}

/**
 * The debounced assess job. A grant paused or revoked since the wake admits
 * nothing (enqueueAssessment → skip 'grant_inactive'); every skip is logged
 * at info, never thrown.
 */
export async function processAssessJob(data: WispAssessJobData, occurrenceKey?: string): Promise<void> {
  if (!wispEnabled()) return;
  // The job occurrence makes the assessment's dedupe key retry-stable.
  const result = await enqueueAssessment(occurrenceKey ? { ...data, occurrenceKey } : data);
  if ('skipped' in result) {
    console.info('[wisp-wake] assessment skipped', { grantId: data.grantId, orgId: data.orgId, reason: data.reason.kind, skipped: result.skipped });
    return;
  }
  if (data.watchRecord !== undefined) await recordAdmittedWatchHits(data.watchRecord);
}

/**
 * #11424: a run was admitted for this watch's hit-set — store it, so the next
 * cadence launches nothing unless the hit-set changes again. Never throws: a
 * BullMQ retry would only hit the run's dedupe key, so a failure is reported
 * and the next cadence, still seeing the old hash, asks once more (a
 * duplicate run, never a lost change).
 */
async function recordAdmittedWatchHits(raw: unknown): Promise<void> {
  const rec = parseWatchHitRecord(raw);
  if (!rec) {
    console.warn('[wisp-wake] assess job carried a malformed watchRecord; not recorded');
    report(new Error('assess job with a malformed watchRecord'), { op: 'watch_record_malformed' });
    return;
  }
  try {
    const written = await recordWatchHits(rec.watchId, rec.previousHash, { hash: rec.hash, count: rec.count });
    if (!written) {
      // Another writer recorded first, or the watch was deleted: left as stored.
      console.warn('[wisp-wake] watch hit-set not recorded: the stored hash moved on or the watch is gone', { watchId: rec.watchId });
    }
  } catch (err) {
    console.error('[wisp-wake] could not record a watch hit-set', { watchId: rec.watchId, error: errMessage(err) });
    report(err, { op: 'watch_record' });
  }
}

/**
 * The delayed job of one check-in timer (#10991). Dark while `!wispEnabled()`:
 * the job completes without firing, the row stays `scheduled`, and the tick's
 * reconcile fires it once Wisp is back on. A malformed payload is dropped
 * (retrying cannot fix it). A fireCheckIn throw propagates so BullMQ retries
 * (attempts 3, exponential 30 s); fireCheckIn's dedupe key and
 * compare-and-set make a retry safe.
 */
export async function processCheckInJob(data: WispCheckInJobData): Promise<void> {
  if (!wispEnabled()) return;
  const checkInId = (data as { checkInId?: unknown } | null | undefined)?.checkInId;
  if (typeof checkInId !== 'string' || !UUID_RE.test(checkInId)) {
    console.warn('[wisp-wake] check-in job dropped: malformed checkInId', { checkInId });
    // Only enqueueCheckIn produces these jobs, so this is a bug worth seeing.
    report(new Error('check-in job with a malformed checkInId'), { op: 'check_in_malformed_payload' });
    return;
  }
  const outcome = await fireCheckIn(checkInId);
  if (outcome !== 'fired' && outcome !== 'running') console.info('[wisp-wake] check-in not fired', { checkInId, outcome });
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

type WakeJobData = WispAssessJobData | WispCheckInJobData | Record<string, never>;

let wakeWorker: Worker<WakeJobData> | null = null;

function createWispWakeWorker(): Worker<WakeJobData> {
  return new Worker<WakeJobData>(
    WISP_WAKE_QUEUE,
    async (job: Job<WakeJobData>) => {
      switch (job.name) {
        case TICK_JOB:
          return processWakeTick();
        case ASSESS_JOB:
          return processAssessJob(job.data as WispAssessJobData, `${job.id ?? ''}@${job.timestamp}`);
        case CHECK_IN_JOB:
          return processCheckInJob(job.data as WispCheckInJobData);
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
