/**
 * The `portal-directory-deprovision` worker (portal registration W8 #11385,
 * plan D10). Concurrency 2. Job names:
 *  - `apply-run` — apply one `applying` run as the system actor. In report
 *    mode `applyRun` refuses (`PORTAL_DIRECTORY_ENFORCEMENT_OFF`): that is
 *    TERMINAL here (the job completes and logs), never a retry;
 *  - `google-sweep` (daily repeatable, slot `portal-directory-google`) — fan
 *    out one `google-org` job per eligible org (googleSource.ts);
 *  - `google-org` — one org's Google snapshot for one UTC day;
 *  - `recover` (hourly repeatable, slot `portal-directory-recover`) —
 *    re-enqueue `applying` runs untouched for 15 min (enforce mode only: in
 *    report mode they are counted, or every hour would re-enqueue a job that
 *    refuses), retry session purges, prune old runs.
 *
 * The run row is the outbox; every leg is idempotent. Errors that reach
 * BullMQ carry a class name and SQLSTATE only — a failed query's message
 * embeds its parameters.
 */
import { Worker, type Job } from 'bullmq';
import { and, eq, lt, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { portalDirectoryRuns } from '../../db/schema';
import { attachWorkerObservability } from '../../jobs/workerObservability';
import { jobSchedule } from '../../jobs/scheduleRegistry';
import { pgErrorCode } from '../../utils/pgErrors';
import { bullmqJobId } from '../bullmqUtils';
import { getBullMQConnection } from '../redis';
import { captureException } from '../sentry';
import { PortalDirectoryIdentityError, retryPendingPurges } from './identityDisable';
import { isDirectoryDeprovisionEnforced } from './mode';
import { evaluateGoogleOrg, runGoogleSweep } from './googleSource';
import {
  PORTAL_DIRECTORY_APPLY_JOB,
  PORTAL_DIRECTORY_GOOGLE_ORG_JOB,
  PORTAL_DIRECTORY_GOOGLE_SWEEP_JOB,
  PORTAL_DIRECTORY_QUEUE,
  closePortalDirectoryQueue,
  enqueueApplyRun,
  getPortalDirectoryQueue,
  portalDirectoryBackoff,
} from './queue';
import { applyRun, pruneDirectoryRuns } from './runStore';

const LOG = '[portal-directory]';
export const PORTAL_DIRECTORY_WORKER_NAME = 'portalDirectoryWorker';
export const PORTAL_DIRECTORY_RECOVER_JOB = 'recover';
/** D8b: an `applying` run untouched this long is re-enqueued by `recover`. */
export const APPLYING_STALE_AFTER_MS = 15 * 60_000;
const RECOVER_BATCH = 500;
const WORKER_CONCURRENCY = 2;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type PortalDirectoryJob = Pick<Job, 'name' | 'data'>;

/** The error BullMQ, the shared failure listener and Sentry see: job name, class and SQLSTATE only. */
function sanitized(label: string, err: unknown): Error {
  const code = pgErrorCode(err);
  return new Error(`portal directory ${label} failed: ${err instanceof Error ? err.name : 'unknown'}${code ? ` (${code})` : ''}`);
}

async function processApplyRun(data: unknown): Promise<Record<string, unknown>> {
  const { runId, orgId } = (data ?? {}) as { runId?: unknown; orgId?: unknown };
  if (typeof runId !== 'string' || typeof orgId !== 'string' || !UUID_RE.test(runId) || !UUID_RE.test(orgId)) {
    console.warn(`${LOG} apply-run dropped: malformed payload`);
    return { status: 'invalid' };
  }
  try {
    const out = await applyRun({ orgId, runId });
    // Enforcement turned off mid-batch (applyRun logged the counts): terminal
    // like report mode; the run stays `applying` for an enforced `recover`.
    if (out.halted) return { status: 'enforcement_off', applied: out.applied, skipped: out.skipped, remaining: out.remaining };
    return { status: 'applied', applied: out.applied, skipped: out.skipped };
  } catch (err) {
    if (err instanceof PortalDirectoryIdentityError) {
      if (err.code === 'PORTAL_DIRECTORY_ENFORCEMENT_OFF') {
        // Report mode (D7): nothing may disable anyone. Terminal, so the job
        // completes; the run stays `applying` for an enforced `recover`.
        console.log(`${LOG} apply-run skipped: report-only mode`, { orgId, runId, applied: 0, skipped: 0 });
        return { status: 'enforcement_off' };
      }
      console.warn(`${LOG} apply-run refused`, { orgId, runId, code: err.code });
      return { status: err.code };
    }
    console.error(`${LOG} apply-run failed`, { orgId, runId, error: err instanceof Error ? err.name : 'unknown' });
    throw sanitized('apply-run', err);
  }
}

async function staleApplyingRuns(now: Date): Promise<Array<{ id: string; orgId: string }>> {
  const before = new Date(now.getTime() - APPLYING_STALE_AFTER_MS);
  return withSystemDbAccessContext(() => db
    .select({ id: portalDirectoryRuns.id, orgId: portalDirectoryRuns.orgId })
    .from(portalDirectoryRuns)
    .where(and(
      eq(portalDirectoryRuns.disposition, 'applying'),
      // An MSP Apply moves a held run to `applying` at decided_at.
      lt(sql`coalesce(${portalDirectoryRuns.decidedAt}, ${portalDirectoryRuns.createdAt})`, before),
    ))
    .orderBy(portalDirectoryRuns.createdAt)
    .limit(RECOVER_BATCH), 'portalDirectory.recoverApplying');
}

/** D10 `recover`: three independent legs; one failing never skips the others. */
export async function runDirectoryRecovery(now: Date): Promise<Record<string, unknown>> {
  const failures: string[] = [];
  const leg = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      failures.push(name);
      console.error(`${LOG} recover leg failed`, {
        leg: name, error: err instanceof Error ? err.name : 'unknown', code: pgErrorCode(err) ?? null,
      });
      return fallback;
    }
  };

  const enforced = isDirectoryDeprovisionEnforced();
  const stale = await leg('applying', () => staleApplyingRuns(now), []);
  let requeued = 0;
  if (enforced) {
    for (const run of stale) {
      if (await enqueueApplyRun(run.id, run.orgId)) requeued += 1;
    }
  }
  const purgesRetried = await leg('purges', () => retryPendingPurges(now), 0);
  const pruned = await leg('prune', () => pruneDirectoryRuns(now), 0);

  const counts = { staleApplying: stale.length, requeued, purgesRetried, pruned };
  console.log(`${LOG} recover`, { mode: enforced ? 'enforce' : 'report', ...counts });
  if (failures.length > 0) throw new Error(`portal directory recover failed: ${failures.join(', ')}`);
  return { status: 'ok', ...counts };
}

export async function processPortalDirectoryJob(job: PortalDirectoryJob, now: Date = new Date()): Promise<unknown> {
  switch (job.name) {
    case PORTAL_DIRECTORY_APPLY_JOB:
      return processApplyRun(job.data);
    case PORTAL_DIRECTORY_RECOVER_JOB:
      return runDirectoryRecovery(now);
    case PORTAL_DIRECTORY_GOOGLE_SWEEP_JOB:
      return runGoogleSweep(now);
    case PORTAL_DIRECTORY_GOOGLE_ORG_JOB: {
      const { orgId, utcDate } = (job.data ?? {}) as { orgId?: unknown; utcDate?: unknown };
      if (typeof orgId !== 'string' || typeof utcDate !== 'string' || !UUID_RE.test(orgId) || !UTC_DATE_RE.test(utcDate)) {
        console.warn(`${LOG} google-org dropped: malformed payload`);
        return { status: 'invalid' };
      }
      // Listing failures are recorded runs, not throws; a throw here is
      // already sanitized and earns the job retry.
      return evaluateGoogleOrg(orgId, utcDate);
    }
    default:
      console.warn(`${LOG} unknown job dropped`, { name: job.name });
      return { status: 'unknown_job' };
  }
}

let worker: Worker | null = null;

async function scheduleRepeatables(): Promise<void> {
  const queue = getPortalDirectoryQueue();
  const owned = new Set([PORTAL_DIRECTORY_RECOVER_JOB, PORTAL_DIRECTORY_GOOGLE_SWEEP_JOB]);
  for (const repeatable of await queue.getRepeatableJobs()) {
    if (owned.has(repeatable.name)) await queue.removeRepeatableByKey(repeatable.key);
  }
  await queue.add(PORTAL_DIRECTORY_GOOGLE_SWEEP_JOB, {}, {
    jobId: bullmqJobId('portal-dir-google-sweep'),
    repeat: { pattern: jobSchedule('portal-directory-google') },
    // Tomorrow's sweep is the retry; each org job retries on its own.
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: { count: 30 },
  });
  await queue.add(PORTAL_DIRECTORY_RECOVER_JOB, {}, {
    jobId: bullmqJobId('portal-dir-recover'),
    repeat: { pattern: jobSchedule('portal-directory-recover') },
    // The next hour is the retry.
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: { count: 30 },
  });
}

export async function initializePortalDirectoryWorker(): Promise<void> {
  if (worker) return;
  worker = new Worker(
    PORTAL_DIRECTORY_QUEUE,
    async (job: Job) => processPortalDirectoryJob(job),
    {
      connection: getBullMQConnection(),
      concurrency: WORKER_CONCURRENCY,
      // A Google listing may take up to its 10-minute pass deadline.
      lockDuration: 300_000,
      settings: { backoffStrategy: (attemptsMade: number) => portalDirectoryBackoff(attemptsMade) },
    },
  );
  attachWorkerObservability(worker, PORTAL_DIRECTORY_WORKER_NAME);
  worker.on('error', (error) => {
    console.error(`${LOG} worker error:`, error instanceof Error ? error.name : 'unknown');
    captureException(error);
  });
  try {
    await scheduleRepeatables();
  } catch (err) {
    await shutdownPortalDirectoryWorker();
    throw err;
  }
  console.log(`${LOG} worker initialized`);
}

export async function shutdownPortalDirectoryWorker(): Promise<void> {
  const w = worker;
  worker = null;
  if (w) {
    try { await w.close(); } catch (err) { console.error(`${LOG} error closing worker:`, err instanceof Error ? err.name : 'unknown'); }
  }
  await closePortalDirectoryQueue();
}
