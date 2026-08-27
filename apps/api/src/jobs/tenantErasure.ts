/**
 * Tenant Erasure Worker (Task 30 — GDPR org-wide erasure)
 *
 * Processes one job per platform-admin erasure request. Each job
 * payload is `{ orgId, performedBy, performedByEmail }` and the worker
 * invokes `cascadeDeleteOrg`. The route handler does NOT run the
 * cascade inline because:
 *   - Erasure can touch every device/agent_logs/etc. row for a tenant
 *     (potentially millions of rows). Doing it on the HTTP path holds
 *     the request open for minutes and is fragile to reverse-proxy
 *     timeouts.
 *   - Single-replica processing keeps the cascade serial across the
 *     fleet — two simultaneous erasures of different orgs are fine, but
 *     two erasures of the SAME org would compete for locks.
 *
 * No cron / no kill switch: this queue ONLY runs when a platform admin
 * POSTs to `/admin/tenant-erasure`. Jobs are uniquely identified by
 * `tenant-erasure-<orgId>` so a double-POST collapses to a single job.
 *
 * On failure: BullMQ's default retry is disabled here (`attempts: 1`)
 * because a partial-cascade re-run could hide a structural issue
 * (e.g. a new table added without cascade-list entry). We want the
 * job to fail loudly so on-call investigates manually. The audit log
 * records the failure with the partial-deletion state.
 */

import { Queue, Worker, Job } from 'bullmq';
import { captureException } from '../services/sentry';
import { getBullMQConnection } from '../services/redis';
import { cascadeDeleteOrg } from '../services/tenantCascade';
import { createAuditLog } from '../services/auditService';
import { enqueueOrReplaceStale } from '../services/bullmqUtils';

const QUEUE_NAME = 'tenant-erasure';
const JOB_NAME = 'tenant-erasure';

export interface TenantErasureJobPayload {
  orgId: string;
  performedBy: string;
  performedByEmail?: string;
}

let erasureQueue: Queue | null = null;
let erasureWorker: Worker | null = null;

export function getTenantErasureQueue(): Queue {
  if (!erasureQueue) {
    erasureQueue = new Queue(QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return erasureQueue;
}

/**
 * Enqueue an erasure job. `jobId = tenant-erasure-<orgId>` so a double-POST,
 * or a sweeper re-enqueue for an erasure that was already handed off, coalesces
 * into the one job rather than running the cascade twice.
 *
 * CORRECTED (org-lifecycle Wave 2 final review): this used a bare `queue.add`,
 * and "BullMQ refuses to enqueue a duplicate" was doing more damage than the
 * old comment implied. `attempts: 1` is deliberate here — a failed erasure must
 * fail loudly for on-call — and `removeOnFail: { count: 50 }` keeps the failed
 * record for inspection. Together those meant a FAILED erasure permanently
 * suppressed every later enqueue for that org: the admin's retry and
 * `tenantOffboarding.ts`'s case-1 sweeper both silently no-opped, `add`
 * returned the dead job's id, and the tenant was never erased. For a GDPR
 * erasure path that is the worst possible way to fail — the retry mechanism
 * designed to catch it was itself the thing being swallowed.
 *
 * `enqueueOrReplaceStale` reuses a genuinely live job (so two erasures of the
 * same org still never compete for locks, which is the property the module
 * docstring above cares about) and replaces a spent one.
 */
export async function enqueueTenantErasure(
  payload: TenantErasureJobPayload,
): Promise<{ id: string }> {
  return enqueueOrReplaceStale(
    getTenantErasureQueue(),
    JOB_NAME,
    `tenant-erasure-${payload.orgId}`,
    payload,
    {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 50 },
    },
    '[TenantErasure]',
  );
}

export function createTenantErasureWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job<TenantErasureJobPayload>) => {
      if (job.name !== JOB_NAME) {
        console.warn(`[TenantErasure] Ignoring unknown job name: ${job.name}`);
        return { skipped: true };
      }
      const { orgId, performedBy, performedByEmail } = job.data;
      try {
        const stats = await cascadeDeleteOrg(orgId, performedBy, performedByEmail);
        return { ...stats, jobId: job.id };
      } catch (err) {
        // Record the failure as an audit row so the operator has a
        // structured pointer back to the job + the partial state.
        try {
          await createAuditLog({
            orgId: null,
            actorType: 'user',
            actorId: performedBy,
            actorEmail: performedByEmail,
            action: 'tenant.erasure.failed',
            resourceType: 'organization',
            resourceId: orgId,
            details: {
              jobId: job.id,
              error: err instanceof Error ? err.message : String(err),
            },
            result: 'failure',
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        } catch (auditErr) {
          console.error('[TenantErasure] audit write for failure also failed', auditErr);
        }
        throw err;
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    },
  );
}

export async function initializeTenantErasureWorker(): Promise<void> {
  try {
    erasureWorker = createTenantErasureWorker();
    erasureWorker.on('error', (error) => {
      console.error('[TenantErasure] Worker error:', error);
      captureException(error);
    });
    erasureWorker.on('failed', (job, error) => {
      console.error(`[TenantErasure] Job ${job?.id} failed:`, error);
      captureException(error);
    });
    console.log('[TenantErasure] Worker initialized');
  } catch (error) {
    console.error('[TenantErasure] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownTenantErasureWorker(): Promise<void> {
  if (erasureWorker) {
    await erasureWorker.close();
    erasureWorker = null;
  }
  if (erasureQueue) {
    await erasureQueue.close();
    erasureQueue = null;
  }
}

// Exported for test introspection.
export const __testOnly = {
  QUEUE_NAME,
  JOB_NAME,
};
