/**
 * Device mTLS certificate revocation lifecycle — security remediation Wave 5
 * Task 3.
 *
 * Ties together the `device_mtls_certificates` state machine (Wave 5 Task 1)
 * and the typed Cloudflare provider contract (cloudflareMtls.ts) into a
 * durable, idempotent revocation path:
 *
 *  - `queueCertificateRevocation` demotes a device's currently-active
 *    certificate to `pending_revocation`, but only once a replacement exists
 *    (never strands a device with zero certificates in flight).
 *  - `revokeCertificateNowOrEnqueue` is the post-commit entry point: it tries
 *    the provider call inline for low latency, and falls back to the durable
 *    BullMQ retry path (jobs/mtlsCertificateRevocation.ts) on anything other
 *    than an immediate `revoked`/`not_found`.
 *  - `attemptCertificateRevocation` is the single idempotent state-transition
 *    used by BOTH the inline path above and the worker job handler, so
 *    "duplicate delivery" (inline attempt + a queued retry both landing, or
 *    two BullMQ deliveries of the same job) is safe by construction: it locks
 *    the row, reads its CURRENT state, releases the lock, THEN calls the
 *    provider (never holding a DB transaction across the outbound HTTP call —
 *    see apps/api/src/db/index.ts's #1105 held-context tripwire), and writes
 *    the outcome in a second short transaction guarded by
 *    `state = 'pending_revocation'`. A second concurrent caller's write is
 *    then a guarded no-op (0 rows affected), not a correctness bug.
 *
 * DB context: every DB op here runs `runOutsideDbContext` first, then
 * `withSystemDbAccessContext` — this module is invoked from background/worker
 * code paths (never mid-request), and `device_mtls_certificates` is
 * FORCE-RLS, so a contextless op would silently affect 0 rows.
 *
 * Logging: never log PEM, keys, serials, fingerprints, provider certificate
 * IDs, or tokens. `last_revoke_error` stores ONLY the bounded category from
 * `categorizeCloudflareMtlsError` (never a raw message).
 */

import type { Queue } from 'bullmq';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceMtlsCertificates } from '../db/schema';
import { createInstrumentedQueue } from './bullmqQueue';
import { captureException } from './sentry';
import {
  CloudflareMtlsService,
  categorizeCloudflareMtlsError,
  type CertificateRevocationResult,
  type CloudflareMtlsErrorCategory,
} from './cloudflareMtls';

/**
 * The type of a drizzle transaction handle (`tx` inside `db.transaction(async
 * (tx) => ...)`), extracted the same way authLifecycle.ts's `Tx` does. Lets
 * `queueCertificateRevocationCore` compose into a CALLER's transaction (e.g. a
 * future activation-confirmation route that must activate-new/demote-old/
 * update-legacy-columns atomically) instead of always opening its own.
 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const BASE_RETRY_DELAY_MS = 60_000; // 60s
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * `min(60s * 2^attempts, 24h)`, where `priorAttempts` is the number of
 * failures that already happened BEFORE this one — so the first failure
 * (priorAttempts=0) schedules a retry 60s out, the second 120s, and so on,
 * capped at 24h.
 */
export function computeNextRevokeAttemptAt(priorAttempts: number, now: Date = new Date()): Date {
  const safePriorAttempts = Math.max(0, priorAttempts);
  const delayMs = Math.min(BASE_RETRY_DELAY_MS * 2 ** safePriorAttempts, MAX_RETRY_DELAY_MS);
  return new Date(now.getTime() + delayMs);
}

// ── BullMQ queue (owned here; the worker in jobs/mtlsCertificateRevocation.ts
// imports enqueueCertificateRevocationJob rather than constructing its own
// Queue for the same name) ──────────────────────────────────────────────────

export const MTLS_CERTIFICATE_REVOCATION_QUEUE = 'mtls-certificate-revocation';

export interface MtlsCertificateRevocationJobData {
  certificateId: string;
}

let revocationQueue: Queue<MtlsCertificateRevocationJobData> | null = null;

function getMtlsCertificateRevocationQueue(): Queue<MtlsCertificateRevocationJobData> {
  if (!revocationQueue) {
    revocationQueue = createInstrumentedQueue<MtlsCertificateRevocationJobData>(
      MTLS_CERTIFICATE_REVOCATION_QUEUE,
      {
        defaultJobOptions: {
          removeOnComplete: true,
          removeOnFail: { count: 200 },
        },
      },
    );
  }
  return revocationQueue;
}

/** Test-only: forces the next call to re-create the Queue instance. */
export function __resetMtlsCertificateRevocationQueueForTests(): void {
  revocationQueue = null;
}

/**
 * jobId is derived from the history-row UUID (hyphens only — BullMQ jobIds
 * must never contain a colon, repo-wide rule) so a duplicate enqueue for the
 * same row while a job is still waiting/active/delayed is deduped by BullMQ
 * itself rather than double-processed.
 *
 * `delayMs` lets a caller that just computed a backoff (e.g.
 * `revokeCertificateNowOrEnqueue` after an inline provider failure) hand the
 * SAME delay to BullMQ, so the worker doesn't hammer the provider again
 * immediately. Callers that already know the row is due NOW (the five-minute
 * sweep) omit it — `add()`'s default `delay` is 0.
 */
export async function enqueueCertificateRevocationJob(certificateId: string, delayMs?: number): Promise<void> {
  await getMtlsCertificateRevocationQueue().add(
    'revoke',
    { certificateId },
    {
      jobId: `mtls-revoke-${certificateId}`,
      ...(delayMs !== undefined ? { delay: Math.max(0, delayMs) } : {}),
    },
  );
}

// ── State transitions ───────────────────────────────────────────────────────

/**
 * Demotes `certificateId` (which must currently be `active`) to
 * `pending_revocation`, but ONLY when a replacement certificate for the same
 * device already exists in `pending_activation` or `active` state — refusing
 * to strand a device with zero certificates in flight. Returns whether the
 * transition actually happened.
 *
 * Takes an injected transaction handle so a caller with its own atomic
 * sequence (e.g. Task 4's activation-confirmation route: activate the new
 * cert + demote the old one + update the device's legacy mTLS columns, all
 * atomically) can compose this INTO that transaction — required ordering
 * anyway, since the partial unique index allows only one `active` row per
 * device at a time, so the demote must land before the promote in the same
 * transaction. `queueCertificateRevocation` below is a thin
 * self-transacting wrapper for standalone callers.
 *
 * Sets `nextRevokeAttemptAt = now()` on the demotion write — the column has
 * no DB default, and the sweep's due-query is `nextRevokeAttemptAt <= now()`
 * (NULL never matches `lte`). Without this, a crash between this commit and
 * the row's first outcome write would leave it `pending_revocation` but
 * permanently invisible to the five-minute sweep.
 */
export async function queueCertificateRevocationCore(tx: Tx, certificateId: string): Promise<boolean> {
  const [current] = await tx
    .select({
      id: deviceMtlsCertificates.id,
      deviceId: deviceMtlsCertificates.deviceId,
      state: deviceMtlsCertificates.state,
    })
    .from(deviceMtlsCertificates)
    .where(eq(deviceMtlsCertificates.id, certificateId))
    .limit(1);

  if (!current || current.state !== 'active') {
    return false;
  }

  const [replacement] = await tx
    .select({ id: deviceMtlsCertificates.id })
    .from(deviceMtlsCertificates)
    .where(and(
      eq(deviceMtlsCertificates.deviceId, current.deviceId),
      ne(deviceMtlsCertificates.id, certificateId),
      inArray(deviceMtlsCertificates.state, ['pending_activation', 'active']),
    ))
    .limit(1);

  if (!replacement) {
    return false;
  }

  const now = new Date();
  const updated = await tx
    .update(deviceMtlsCertificates)
    .set({ state: 'pending_revocation', nextRevokeAttemptAt: now, updatedAt: now })
    .where(and(
      eq(deviceMtlsCertificates.id, certificateId),
      eq(deviceMtlsCertificates.state, 'active'),
    ))
    .returning({ id: deviceMtlsCertificates.id });

  return updated.length === 1;
}

/**
 * Self-transacting wrapper around `queueCertificateRevocationCore` for
 * standalone callers (and this module's own tests). Opens its own system-
 * scoped transaction via `db.transaction(...)` — mirroring
 * `authEmailWorker.ts`'s `withSystemDbAccessContext(() => db.transaction(...))`
 * composition — rather than duplicating the guard+demote logic.
 */
export async function queueCertificateRevocation(certificateId: string): Promise<boolean> {
  return runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.transaction((tx) => queueCertificateRevocationCore(tx, certificateId)),
  ));
}

async function markCertificateRevoked(certificateId: string): Promise<void> {
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await db
      .update(deviceMtlsCertificates)
      .set({
        state: 'revoked',
        revokedAt: new Date(),
        lastRevokeError: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(deviceMtlsCertificates.id, certificateId),
        eq(deviceMtlsCertificates.state, 'pending_revocation'),
      ));
  }));
}

async function scheduleRevocationRetry(
  certificateId: string,
  priorAttempts: number,
  category: CloudflareMtlsErrorCategory | undefined,
): Promise<Date> {
  const nextRevokeAttemptAt = computeNextRevokeAttemptAt(priorAttempts);
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await db
      .update(deviceMtlsCertificates)
      .set({
        revokeAttempts: priorAttempts + 1,
        lastRevokeError: category ?? null,
        nextRevokeAttemptAt,
        updatedAt: new Date(),
      })
      .where(and(
        eq(deviceMtlsCertificates.id, certificateId),
        eq(deviceMtlsCertificates.state, 'pending_revocation'),
      ));
  }));
  return nextRevokeAttemptAt;
}

export type RevocationAttemptOutcome =
  | { outcome: 'revoked' | 'not_found' }
  | { outcome: 'already_revoked' }
  | { outcome: 'not_applicable' }
  | { outcome: 'retry_scheduled'; nextRevokeAttemptAt: Date };

/**
 * The single idempotent revocation attempt shared by the inline
 * (`revokeCertificateNowOrEnqueue`) and worker (jobs/mtlsCertificateRevocation.ts)
 * paths. Safe under duplicate delivery: locks the row, reads its state,
 * RELEASES the lock (transaction commits) before ever calling the provider —
 * so the outbound HTTP call never holds a DB transaction open — then writes
 * the outcome in a second short transaction guarded by
 * `state = 'pending_revocation'`, so a second concurrent caller's write is a
 * no-op rather than a corruption.
 */
export async function attemptCertificateRevocation(certificateId: string): Promise<RevocationAttemptOutcome> {
  const row = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [r] = await db
      .select({
        id: deviceMtlsCertificates.id,
        state: deviceMtlsCertificates.state,
        providerCertificateId: deviceMtlsCertificates.providerCertificateId,
        revokeAttempts: deviceMtlsCertificates.revokeAttempts,
      })
      .from(deviceMtlsCertificates)
      .where(eq(deviceMtlsCertificates.id, certificateId))
      .limit(1)
      .for('update');
    return r ?? null;
  }));

  if (!row) {
    return { outcome: 'not_applicable' };
  }
  if (row.state === 'revoked') {
    return { outcome: 'already_revoked' };
  }
  if (row.state !== 'pending_revocation') {
    return { outcome: 'not_applicable' };
  }

  const cfService = CloudflareMtlsService.fromEnv();
  if (!cfService) {
    // Not configured — nothing to call. Leave a due retry so the sweep keeps
    // trying once configuration lands, rather than silently dropping it.
    const nextRevokeAttemptAt = await scheduleRevocationRetry(certificateId, row.revokeAttempts, undefined);
    return { outcome: 'retry_scheduled', nextRevokeAttemptAt };
  }

  let result: CertificateRevocationResult;
  try {
    result = await cfService.revokeCertificate(row.providerCertificateId);
  } catch (err) {
    const category = categorizeCloudflareMtlsError(err);
    const nextRevokeAttemptAt = await scheduleRevocationRetry(certificateId, row.revokeAttempts, category);
    return { outcome: 'retry_scheduled', nextRevokeAttemptAt };
  }

  await markCertificateRevoked(certificateId);
  return { outcome: result };
}

/**
 * Runs only AFTER the replacement-activation transaction commits (see
 * `queueCertificateRevocation`). Attempts provider revocation inline for low
 * latency; `revoked`/`not_found` completes immediately. Any other outcome
 * leaves the row `pending_revocation` with a computed backoff and attempts to
 * hand off to the durable BullMQ retry path. If the enqueue itself fails
 * (e.g. Redis is down right after the DB commit), the row is left with
 * `next_revoke_attempt_at <= now()` so the five-minute sweep
 * (jobs/mtlsCertificateRevocation.ts) repairs the handoff on its next pass —
 * regardless of what backoff delay was just computed.
 */
export async function revokeCertificateNowOrEnqueue(certificateId: string): Promise<void> {
  const outcome = await attemptCertificateRevocation(certificateId);
  if (outcome.outcome !== 'retry_scheduled') {
    return;
  }

  // Match the enqueue's delay to the backoff we just computed — without
  // this, the worker would retry Cloudflare almost immediately after a
  // 429/5xx, defeating computeNextRevokeAttemptAt on the very first hop.
  const delayMs = Math.max(0, outcome.nextRevokeAttemptAt.getTime() - Date.now());

  try {
    await enqueueCertificateRevocationJob(certificateId, delayMs);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(
      '[deviceMtlsCertificateLifecycle] failed to enqueue revocation retry after DB commit; the 5-minute sweep will repair the handoff',
      { errorCode: error.name },
    );
    captureException(error);

    await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      await db
        .update(deviceMtlsCertificates)
        .set({ nextRevokeAttemptAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(deviceMtlsCertificates.id, certificateId),
          eq(deviceMtlsCertificates.state, 'pending_revocation'),
        ));
    }));
  }
}
