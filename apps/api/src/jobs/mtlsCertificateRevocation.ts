/**
 * mTLS certificate revocation worker + sweep — security remediation Wave 5
 * Task 3.
 *
 * The BullMQ Worker below processes ONE job per certificate history-row UUID
 * (never PEM/serial/provider-id — see deviceMtlsCertificateLifecycle.ts's
 * module doc for why). All the actual state-transition + provider-call logic
 * lives in `attemptCertificateRevocation` (shared with the inline
 * `revokeCertificateNowOrEnqueue` path) so both callers get identical,
 * duplicate-delivery-safe behavior for free.
 *
 * The five-minute sweep below handles the two cases where nothing else would
 * ever re-drive a `device_mtls_certificates` row to completion:
 *
 *  1. `pending_revocation` rows whose `next_revoke_attempt_at` is due — either
 *     because a prior attempt's backoff elapsed, or because the inline
 *     enqueue failed right after commit (revokeCertificateNowOrEnqueue leaves
 *     `next_revoke_attempt_at <= now()` in that case specifically so THIS
 *     sweep repairs the handoff without waiting for the full backoff).
 *  2. `pending_activation` rows whose `activation_expires_at` has passed —
 *     the agent never confirmed the new certificate, so it must be revoked.
 *     This ONLY ever touches rows still in `pending_activation` (by
 *     definition never the device's current `active` row), so it can never
 *     revoke a certificate that's actually in use.
 *
 * DB context: `runOutsideDbContext` first, then `withSystemDbAccessContext` —
 * this runs entirely outside any request.
 */

import { Job, Worker } from 'bullmq';
import { and, asc, eq, lte } from 'drizzle-orm';
import * as dbModule from '../db';
import { deviceMtlsCertificates } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import {
  MTLS_CERTIFICATE_REVOCATION_QUEUE,
  attemptCertificateRevocation,
  enqueueCertificateRevocationJob,
  type MtlsCertificateRevocationJobData,
} from '../services/deviceMtlsCertificateLifecycle';

const { db, runOutsideDbContext, withSystemDbAccessContext } = dbModule;

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SWEEP_BATCH_SIZE = 200;

/**
 * Processes a single revocation job. `retry_scheduled` is NOT rethrown as a
 * job failure — `attemptCertificateRevocation` has already durably recorded
 * the backoff (next_revoke_attempt_at) itself, and letting BullMQ's own
 * attempts/backoff ALSO retry on top would double-schedule the retry cadence.
 * The five-minute sweep is what re-enqueues a due row, not BullMQ's built-in
 * job retry.
 */
export async function processMtlsCertificateRevocationJob(
  job: Job<MtlsCertificateRevocationJobData>,
): Promise<void> {
  await attemptCertificateRevocation(job.data.certificateId);
}

/**
 * Single sweep pass. Returns counts for observability/tests. Never touches a
 * device's `active` row: the two UPDATE/SELECT statements below are scoped by
 * `state IN ('pending_revocation','pending_activation')` respectively.
 */
export async function sweepDueMtlsCertificateRevocations(): Promise<{
  dueRevocationsQueued: number;
  expiredActivationsQueued: number;
}> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const now = new Date();

    const dueRevocations = await db
      .select({ id: deviceMtlsCertificates.id })
      .from(deviceMtlsCertificates)
      .where(and(
        eq(deviceMtlsCertificates.state, 'pending_revocation'),
        lte(deviceMtlsCertificates.nextRevokeAttemptAt, now),
      ))
      .orderBy(asc(deviceMtlsCertificates.nextRevokeAttemptAt))
      .limit(SWEEP_BATCH_SIZE);

    for (const row of dueRevocations) {
      await enqueueRevocationBestEffort(row.id);
    }

    // Expired pending_activation rows never went active, so there is nothing
    // to "demote" them from — transition straight to pending_revocation and
    // queue for revoke, WITHOUT touching whatever certificate is still active
    // for that device (this UPDATE is scoped to state='pending_activation'
    // only, which by definition excludes the active row).
    const expiredActivations = await db
      .update(deviceMtlsCertificates)
      .set({ state: 'pending_revocation', nextRevokeAttemptAt: now, updatedAt: now })
      .where(and(
        eq(deviceMtlsCertificates.state, 'pending_activation'),
        lte(deviceMtlsCertificates.activationExpiresAt, now),
      ))
      .returning({ id: deviceMtlsCertificates.id });

    for (const row of expiredActivations) {
      await enqueueRevocationBestEffort(row.id);
    }

    return {
      dueRevocationsQueued: dueRevocations.length,
      expiredActivationsQueued: expiredActivations.length,
    };
  }));
}

async function enqueueRevocationBestEffort(certificateId: string): Promise<void> {
  try {
    // No delay here, deliberately: every row this sweep enqueues was already
    // selected because it's due NOW (next_revoke_attempt_at <= now(), or an
    // expired pending_activation row just transitioned straight to due). The
    // "match the enqueue delay to the backoff" logic belongs to the INLINE
    // failure branch (revokeCertificateNowOrEnqueue), which enqueues right
    // after computing a FUTURE backoff — that's the case where an undelayed
    // enqueue would defeat the backoff on its first hop.
    await enqueueCertificateRevocationJob(certificateId);
  } catch (err) {
    // Best-effort: if Redis is down for the whole sweep pass, the row's
    // next_revoke_attempt_at is already due, so the NEXT sweep pass (5 min
    // later) will try again. No need to touch the row here.
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[MtlsCertificateRevocationWorker] sweep enqueue failed', { errorCode: error.name });
    captureException(error);
  }
}

let worker: Worker<MtlsCertificateRevocationJobData> | null = null;
let sweepTimer: NodeJS.Timeout | null = null;
let activeSweep: Promise<void> | null = null;

function runScheduledSweep(): void {
  if (activeSweep) return;
  activeSweep = sweepDueMtlsCertificateRevocations()
    .then(() => undefined)
    .catch((error) => {
      // Minor (final review): bounded shape only — logging the whole error
      // object leaks postgres `detail`/`where` (column values). Matches the
      // `{ errorCode: error.name }` pattern used by the enqueue catch above.
      console.error('[MtlsCertificateRevocationWorker] sweep failed', {
        errorCode: error instanceof Error ? error.name : 'unknown',
      });
      captureException(error instanceof Error ? error : new Error(String(error)));
    })
    .finally(() => {
      activeSweep = null;
    });
}

export function initializeMtlsCertificateRevocationWorker(): void {
  if (worker) return;

  worker = new Worker<MtlsCertificateRevocationJobData>(
    MTLS_CERTIFICATE_REVOCATION_QUEUE,
    processMtlsCertificateRevocationJob,
    {
      connection: getBullMQConnection(),
      concurrency: 5,
    },
  );

  worker.on('error', (error) => {
    console.error('[MtlsCertificateRevocationWorker] Worker error:', { errorCode: error.name });
    captureException(error);
  });
  worker.on('failed', (job, error) => {
    console.error(`[MtlsCertificateRevocationWorker] Job ${job?.id} failed:`, { errorCode: error?.name ?? 'unknown' });
    captureException(error);
  });

  if (!sweepTimer) {
    sweepTimer = setInterval(runScheduledSweep, SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }
}

export async function shutdownMtlsCertificateRevocationWorker(): Promise<void> {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  await activeSweep;
  if (worker) {
    await worker.close();
    worker = null;
  }
}

export const __testOnly = {
  SWEEP_INTERVAL_MS,
  SWEEP_BATCH_SIZE,
};
