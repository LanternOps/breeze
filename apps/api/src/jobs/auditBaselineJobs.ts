import { Job, Queue, Worker } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { auditBaselines, devices } from '../db/schema';
import { queueCommandForExecution } from '../services/commandQueue';
import { getRedisConnection } from '../services/redis';
import { evaluateAuditBaselineDrift } from '../services/auditBaselineService';
import { captureException } from '../services/sentry';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[AuditBaselineJobs] withSystemDbAccessContext is not available');
  }
  return dbModule.withSystemDbAccessContext(fn);
};

const AUDIT_BASELINE_QUEUE = 'audit-baseline-jobs';

type CollectAuditPolicyJobData = {
  type: 'audit-policy-collection';
  orgId?: string;
};

type EvaluateAuditDriftJobData = {
  type: 'audit-drift-evaluator';
  orgId?: string;
};

type AuditBaselineJobData = CollectAuditPolicyJobData | EvaluateAuditDriftJobData;

let auditBaselineQueue: Queue<AuditBaselineJobData> | null = null;
let auditBaselineWorker: Worker<AuditBaselineJobData> | null = null;

export function getAuditBaselineQueue(): Queue<AuditBaselineJobData> {
  if (!auditBaselineQueue) {
    auditBaselineQueue = new Queue<AuditBaselineJobData>(AUDIT_BASELINE_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return auditBaselineQueue;
}

async function processCollectAuditPolicy(
  data: CollectAuditPolicyJobData
): Promise<{ attempted: number; queued: number; skipped: number }> {
  const where = data.orgId
    ? and(eq(devices.orgId, data.orgId), eq(devices.status, 'online'))
    : eq(devices.status, 'online');

  const rows = await db
    .selectDistinct({ id: devices.id })
    .from(devices)
    .innerJoin(auditBaselines, and(
      eq(auditBaselines.orgId, devices.orgId),
      sql`${auditBaselines.osType} = ${devices.osType}::text`,
      eq(auditBaselines.isActive, true),
    ))
    .where(where);

  let queued = 0;
  let skipped = 0;

  for (const row of rows) {
    const result = await queueCommandForExecution(
      row.id,
      'collect_audit_policy',
      {},
      { preferHeartbeat: false }
    );

    if (result.command) {
      queued++;
    } else {
      console.warn(`[AuditBaselineJobs] skipped device ${row.id}: ${result.error ?? 'unknown reason'}`);
      skipped++;
    }
  }

  return {
    attempted: rows.length,
    queued,
    skipped,
  };
}

async function processEvaluateAuditDrift(
  data: EvaluateAuditDriftJobData
): Promise<{ evaluated: number; compliant: number; nonCompliant: number }> {
  return evaluateAuditBaselineDrift({ orgId: data.orgId });
}

function createAuditBaselineWorker(): Worker<AuditBaselineJobData> {
  return new Worker<AuditBaselineJobData>(
    AUDIT_BASELINE_QUEUE,
    async (job: Job<AuditBaselineJobData>) => {
      return runWithSystemDbAccess(async () => {
        if (job.data.type === 'audit-policy-collection') {
          return processCollectAuditPolicy(job.data);
        }
        return processEvaluateAuditDrift(job.data);
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 3,
    }
  );
}

async function scheduleRecurringJobs(): Promise<void> {
  const queue = getAuditBaselineQueue();
  const existing = await queue.getRepeatableJobs();

  for (const job of existing) {
    if (job.name === 'audit-policy-collection' || job.name === 'audit-drift-evaluator') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'audit-policy-collection',
    { type: 'audit-policy-collection' },
    {
      jobId: 'audit-policy-collection-daily',
      repeat: { pattern: '0 3 * * *' }, // Daily at 03:00 UTC
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 25 },
    }
  );

  await queue.add(
    'audit-drift-evaluator',
    { type: 'audit-drift-evaluator' },
    {
      jobId: 'audit-drift-evaluator-hourly',
      repeat: { pattern: '0 * * * *' }, // Every hour on the hour
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 50 },
    }
  );
}

export async function initializeAuditBaselineJobs(): Promise<void> {
  auditBaselineWorker = createAuditBaselineWorker();

  auditBaselineWorker.on('error', (error) => {
    console.error('[AuditBaselineJobs] Worker error:', error);
    captureException(error);
  });

  auditBaselineWorker.on('failed', (job, error) => {
    console.error(`[AuditBaselineJobs] Job ${job?.id} failed:`, error);
    captureException(error);
  });

  await scheduleRecurringJobs();
  console.log('[AuditBaselineJobs] Initialized');
}

export async function shutdownAuditBaselineJobs(): Promise<void> {
  if (auditBaselineWorker) {
    await auditBaselineWorker.close();
    auditBaselineWorker = null;
  }
  if (auditBaselineQueue) {
    await auditBaselineQueue.close();
    auditBaselineQueue = null;
  }
}

export async function enqueueAuditPolicyCollection(orgId?: string): Promise<string> {
  const queue = getAuditBaselineQueue();
  const job = await queue.add(
    'audit-policy-collection',
    {
      type: 'audit-policy-collection',
      orgId,
    },
    {
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    }
  );

  return String(job.id);
}

export async function enqueueAuditDriftEvaluation(orgId?: string): Promise<string> {
  const queue = getAuditBaselineQueue();
  const job = await queue.add(
    'audit-drift-evaluator',
    {
      type: 'audit-drift-evaluator',
      orgId,
    },
    {
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    }
  );

  return String(job.id);
}

export async function getOnlineDeviceCountForAuditCollection(orgId?: string): Promise<number> {
  const deviceStatusFilter = orgId
    ? and(eq(devices.status, 'online'), eq(devices.orgId, orgId))
    : eq(devices.status, 'online');

  const [row] = await db
    .select({ count: sql<number>`count(distinct ${devices.id})::int` })
    .from(devices)
    .innerJoin(auditBaselines, and(
      eq(auditBaselines.orgId, devices.orgId),
      sql`${auditBaselines.osType} = ${devices.osType}::text`,
      eq(auditBaselines.isActive, true),
    ))
    .where(deviceStatusFilter);

  return row?.count ?? 0;
}
