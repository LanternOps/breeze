import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';

import * as dbModule from '../db';
import { devices } from '../db/schema';
import { publishEvent } from '../services/eventBus';
import { getRedisConnection } from '../services/redis';
import { computeAndPersistOrgSecurityPosture } from '../services/securityPosture';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const SECURITY_POSTURE_QUEUE = 'security-posture';
const SCAN_INTERVAL_MS = 60 * 60 * 1000;

type ScanOrgsJobData = {
  type: 'scan-orgs';
  queuedAt: string;
};

type ComputeOrgJobData = {
  type: 'compute-org';
  orgId: string;
  queuedAt: string;
};

type SecurityPostureJobData = ScanOrgsJobData | ComputeOrgJobData;

let securityPostureQueue: Queue<SecurityPostureJobData> | null = null;
let securityPostureWorker: Worker<SecurityPostureJobData> | null = null;

export function getSecurityPostureQueue(): Queue<SecurityPostureJobData> {
  if (!securityPostureQueue) {
    securityPostureQueue = new Queue<SecurityPostureJobData>(SECURITY_POSTURE_QUEUE, {
      connection: getRedisConnection()
    });
  }
  return securityPostureQueue;
}

async function processScanOrgs(data: ScanOrgsJobData): Promise<{ queued: number }> {
  const orgRows = await db
    .select({ orgId: devices.orgId })
    .from(devices)
    .where(sql`${devices.status} <> 'decommissioned'`)
    .groupBy(devices.orgId);

  if (orgRows.length === 0) {
    return { queued: 0 };
  }

  const queue = getSecurityPostureQueue();
  const slotKey = data.queuedAt.slice(0, 13);
  await queue.addBulk(
    orgRows.map((row) => ({
      name: 'compute-org',
      data: {
        type: 'compute-org' as const,
        orgId: row.orgId,
        queuedAt: data.queuedAt
      },
      opts: {
        jobId: `security-posture:${row.orgId}:${slotKey}`,
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 200 }
      }
    }))
  );

  return { queued: orgRows.length };
}

async function processComputeOrg(data: ComputeOrgJobData): Promise<{
  orgId: string;
  devicesAudited: number;
  changedEventsPublished: number;
}> {
  const result = await computeAndPersistOrgSecurityPosture(data.orgId);

  let changedEventsPublished = 0;
  for (const item of result.changedDevices.slice(0, 200)) {
    await publishEvent(
      'security.score_changed',
      item.orgId,
      {
        deviceId: item.deviceId,
        previousScore: item.previousScore,
        currentScore: item.currentScore,
        delta: item.delta,
        previousRiskLevel: item.previousRiskLevel,
        currentRiskLevel: item.currentRiskLevel,
        changedFactors: item.changedFactors,
        capturedAt: result.capturedAt
      },
      'security-posture-worker'
    );
    changedEventsPublished++;
  }

  return {
    orgId: data.orgId,
    devicesAudited: result.summary.devicesAudited,
    changedEventsPublished
  };
}

export function createSecurityPostureWorker(): Worker<SecurityPostureJobData> {
  return new Worker<SecurityPostureJobData>(
    SECURITY_POSTURE_QUEUE,
    async (job: Job<SecurityPostureJobData>) => {
      return runWithSystemDbAccess(async () => {
        if (job.data.type === 'scan-orgs') {
          return processScanOrgs(job.data);
        }
        return processComputeOrg(job.data);
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 3
    }
  );
}

async function scheduleSecurityPostureScan(): Promise<void> {
  const queue = getSecurityPostureQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === 'scan-orgs') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'scan-orgs',
    {
      type: 'scan-orgs',
      queuedAt: new Date().toISOString()
    },
    {
      repeat: { every: SCAN_INTERVAL_MS },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 }
    }
  );
}

export async function initializeSecurityPostureWorker(): Promise<void> {
  securityPostureWorker = createSecurityPostureWorker();
  securityPostureWorker.on('error', (error) => {
    console.error('[SecurityPostureWorker] Worker error:', error);
  });
  securityPostureWorker.on('failed', (job, error) => {
    console.error(`[SecurityPostureWorker] Job ${job?.id} failed:`, error);
  });

  await scheduleSecurityPostureScan();
  console.log('[SecurityPostureWorker] Security posture worker initialized');
}

export async function shutdownSecurityPostureWorker(): Promise<void> {
  if (securityPostureWorker) {
    await securityPostureWorker.close();
    securityPostureWorker = null;
  }
  if (securityPostureQueue) {
    await securityPostureQueue.close();
    securityPostureQueue = null;
  }
}

export async function triggerSecurityPostureRecompute(orgId: string): Promise<string> {
  const queue = getSecurityPostureQueue();
  const job = await queue.add(
    'compute-org',
    {
      type: 'compute-org',
      orgId,
      queuedAt: new Date().toISOString()
    },
    {
      removeOnComplete: true,
      removeOnFail: { count: 100 }
    }
  );
  return String(job.id);
}
