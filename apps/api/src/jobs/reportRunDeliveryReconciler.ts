/**
 * #4248 W03 (Task 8) — reconciliation pass for unsettled narrative deliveries
 * (`report_run_deliveries`). Runs every 15 minutes.
 *
 * What it does, and deliberately does not do:
 *
 * - `pending` rows older than one cadence tick → the full gated delivery path
 *   (`deliverNarrativeEmails`: authority gate → claim → send → settle), once
 *   per run. A crash BEFORE the claim means nothing was sent, so this is safe.
 *   The one-tick age floor keeps the sweep off rows whose finalizer pass is
 *   still in flight.
 * - `claimed` rows older than `STALE_CLAIM_MS` → settled to `unknown` with
 *   `last_error = 'reconciler: claim went stale; send outcome unknown'`.
 *   **Never resent.** The email service has no idempotency key, so a resend is
 *   a real duplicate risk; making the ambiguity visible is the honest move.
 *   Exception (#3198 W02): a stale claim under a PARTNER-owned run is settled
 *   `failed` — nothing can have been sent for it (see the partner arm below).
 * - `unknown` rows → never touched. Replay is a human decision.
 *
 * Every DB touch is a short-lived system context of its own; the send itself
 * happens outside any context (`deliverNarrativeEmails` enforces that).
 */

import { Job, Queue, Worker } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { reportRuns, reports } from '../db/schema/reports';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { deliverNarrativeEmails } from '../services/reportNarrativeDelivery';
import {
  STALE_CLAIM_MS,
  claimDelivery,
  listUnsettledDeliveries,
  settleDelivery,
} from '../services/reportRunDelivery';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'report-run-delivery-reconciler';
const JOB_NAME = 'reconcile-report-run-deliveries';
export const RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
/** Rows examined per pass; the unsettled partial index keeps this cheap. */
const MAX_ROWS_PER_PASS = 500;
export const STALE_CLAIM_ERROR = 'reconciler: claim went stale; send outcome unknown';
/** #3198 W02 (addendum B7): the stable last_error of a delivery settled as
 *  failed because its run is partner-owned (narrative delivery is org-only). */
export const PARTNER_OWNED_DELIVERY_ERROR = 'reconciler: run is partner-owned; narrative delivery is org-only';

type ReconcilerJobData = { type: typeof JOB_NAME; queuedAt: string };

let reconcilerQueue: Queue<ReconcilerJobData> | null = null;
let reconcilerWorker: Worker<ReconcilerJobData> | null = null;

function getQueue(): Queue<ReconcilerJobData> {
  if (!reconcilerQueue) {
    reconcilerQueue = new Queue<ReconcilerJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return reconcilerQueue;
}

/**
 * Each run's owning report axis. #3198 W01 made `reports.org_id` nullable
 * (org XOR partner), so the owner is carried as a discriminated value rather
 * than a bare org id: narrative delivery is org-keyed, and a partner-owned
 * run must be handled explicitly, never coerced into an org slot.
 */
type RunOwner = { orgId: string } | { partnerId: string };

async function loadRunOwners(reportRunIds: string[]): Promise<Map<string, RunOwner>> {
  if (reportRunIds.length === 0) return new Map();
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db
      .select({ reportRunId: reportRuns.id, orgId: reports.orgId, partnerId: reports.partnerId })
      .from(reportRuns)
      .innerJoin(reports, eq(reports.id, reportRuns.reportId))
      .where(inArray(reportRuns.id, reportRunIds)),
  ));
  const owners = new Map<string, RunOwner>();
  for (const row of rows) {
    if (row.orgId) owners.set(row.reportRunId, { orgId: row.orgId });
    else if (row.partnerId) owners.set(row.reportRunId, { partnerId: row.partnerId });
    // Neither axis violates reports_one_owner_chk; left out, it takes the
    // logged "vanished" path below rather than being guessed at.
  }
  return owners;
}

export async function reconcileReportRunDeliveries(
  now: Date = new Date(),
): Promise<{ resent: number; markedUnknown: number }> {
  let resent = 0;
  let markedUnknown = 0;

  // One cadence tick for pending rows, STALE_CLAIM_MS for claimed ones. The
  // list query uses the pending cutoff and the claimed rows are re-checked
  // below against their own window. The two constants are EQUAL today
  // (15 min each — asserted by this job's test), so that re-check currently
  // never rejects a row the query returned; it exists so raising
  // STALE_CLAIM_MS above the cadence keeps working without a second edit.
  const pendingCutoff = new Date(now.getTime() - RECONCILE_INTERVAL_MS);
  const staleClaimCutoff = new Date(now.getTime() - STALE_CLAIM_MS);
  const unsettled = await listUnsettledDeliveries(pendingCutoff, MAX_ROWS_PER_PASS);

  const pendingRuns = new Set<string>();
  const pendingByRun = new Map<string, string[]>();
  const staleClaims: { id: string; reportRunId: string }[] = [];
  for (const row of unsettled) {
    if (row.state === 'claimed') {
      if (row.claimedAt && row.claimedAt < staleClaimCutoff) staleClaims.push(row);
      continue;
    }
    if (row.state === 'pending') {
      pendingRuns.add(row.reportRunId);
      pendingByRun.set(row.reportRunId, [...(pendingByRun.get(row.reportRunId) ?? []), row.id]);
    }
  }

  const runOwners = await loadRunOwners([
    ...new Set([...pendingRuns, ...staleClaims.map((c) => c.reportRunId)]),
  ]);

  for (const claim of staleClaims) {
    // #3198 W02: a claim under a PARTNER-owned run was only ever taken by the
    // partner-owned settle below (narrative delivery is org-only, nothing is
    // sent), so a stale one is a settle that threw — settle it failed, not
    // "outcome unknown". Every other stale claim stays unknown (never resent).
    const claimOwner = runOwners.get(claim.reportRunId);
    if (claimOwner && 'partnerId' in claimOwner) {
      await settleDelivery(claim.id, { state: 'failed', error: PARTNER_OWNED_DELIVERY_ERROR });
      continue;
    }
    await settleDelivery(claim.id, { state: 'unknown', error: STALE_CLAIM_ERROR });
    markedUnknown += 1;
  }

  if (pendingRuns.size > 0) {
    for (const reportRunId of pendingRuns) {
      const owner = runOwners.get(reportRunId);
      if (!owner) {
        // Normally benign: the run (and, by cascade, its rows) went away
        // between the two reads. Logged anyway — if the join ever diverges
        // for any OTHER reason, these rows are dropped from every future
        // pass, and without this line that happens with no trace at all.
        console.warn('[ReportRunDeliveryReconciler] run vanished between reads; skipping its pending deliveries', {
          reportRunId,
        });
        continue;
      }
      if ('partnerId' in owner) {
        // Narrative deliveries exist only for the org-owned weekly narrative;
        // a pending row under a partner-owned run has no org-keyed authority
        // gate to go through, so it can never be sent. #3198 W02 (addendum
        // B7): settle it as failed ONCE (pending -> claimed -> failed, the
        // state machine's permanent-refusal path; nothing is sent) and report
        // the invariant break once, instead of re-reporting every pass.
        const unsupported = new Error(
          '[ReportRunDeliveryReconciler] pending delivery on a partner-owned run; narrative delivery is org-only, settling it as failed',
        );
        const deliveryIds = pendingByRun.get(reportRunId) ?? [];
        console.error(unsupported.message, { reportRunId, partnerId: owner.partnerId, deliveryIds });
        captureException(unsupported);
        try {
          for (const deliveryId of deliveryIds) {
            if (await claimDelivery(deliveryId)) {
              await settleDelivery(deliveryId, { state: 'failed', error: PARTNER_OWNED_DELIVERY_ERROR });
            }
          }
        } catch (error) {
          // Never stops the sweep. A claim that failed leaves the row pending
          // (next pass retries); a settle that failed AFTER a successful claim
          // leaves it claimed, and the stale-claim sweep above settles it
          // failed (not unknown) once STALE_CLAIM_MS passes.
          console.error('[ReportRunDeliveryReconciler] could not settle partner-owned deliveries', { reportRunId, error });
          captureException(error instanceof Error ? error : new Error(String(error)));
        }
        continue;
      }
      const { orgId } = owner;
      try {
        const result = await deliverNarrativeEmails(reportRunId, { orgId });
        resent += result.sentNow;
      } catch (error) {
        // One run's failure must not stop the sweep for every other run.
        console.error('[ReportRunDeliveryReconciler] delivery pass failed for run', { reportRunId, orgId, error });
        captureException(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  if (unsettled.length === MAX_ROWS_PER_PASS) {
    // Sentry, not just a log line: a sustained cap hit means narratives are
    // piling up undelivered across orgs, and every other failure path in this
    // file already reports. A warning nobody is paged for is how a backlog
    // becomes a quarter of missing weekly reports.
    const capped = new Error(
      `[ReportRunDeliveryReconciler] hit the ${MAX_ROWS_PER_PASS}-row cap; unsettled delivery backlog may be growing`,
    );
    console.warn(capped.message);
    captureException(capped);
  }
  if (resent > 0 || markedUnknown > 0) {
    console.info('[ReportRunDeliveryReconciler] pass finished', { resent, markedUnknown, examined: unsettled.length });
  }
  return { resent, markedUnknown };
}

function createWorker(): Worker<ReconcilerJobData> {
  return new Worker<ReconcilerJobData>(
    QUEUE_NAME,
    async (_job: Job<ReconcilerJobData>) => {
      try {
        return await reconcileReportRunDeliveries();
      } catch (err) {
        console.error('[ReportRunDeliveryReconciler] Run failed:', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();
  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  await queue.add(
    JOB_NAME,
    { type: JOB_NAME, queuedAt: new Date().toISOString() },
    {
      jobId: 'report-run-delivery-reconciler',
      // Sub-hourly: deliberately `every:`, not a scheduleRegistry slot (the
      // registry governs >= hourly cadences only).
      repeat: { every: RECONCILE_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeReportRunDeliveryReconciler(): Promise<void> {
  if (reconcilerWorker) return;
  reconcilerWorker = createWorker();
  attachWorkerObservability(reconcilerWorker, 'reportRunDeliveryReconciler');
  reconcilerWorker.on('error', (error) => {
    console.error('[ReportRunDeliveryReconciler] Worker error:', error);
    captureException(error);
  });
  reconcilerWorker.on('failed', (job, error) => {
    console.error(`[ReportRunDeliveryReconciler] Job ${job?.id} failed:`, error);
    captureException(error);
  });
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await reconcilerWorker.close();
    reconcilerWorker = null;
    throw err;
  }
  console.log('[ReportRunDeliveryReconciler] Initialized');
}

export async function shutdownReportRunDeliveryReconciler(): Promise<void> {
  const worker = reconcilerWorker;
  const queue = reconcilerQueue;
  reconcilerWorker = null;
  reconcilerQueue = null;
  if (worker) {
    try { await worker.close(); } catch (err) { console.error('[ReportRunDeliveryReconciler] Error closing worker:', err); }
  }
  if (queue) {
    try { await queue.close(); } catch (err) { console.error('[ReportRunDeliveryReconciler] Error closing queue:', err); }
  }
}
