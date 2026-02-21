import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';

import * as dbModule from '../db';
import { devices } from '../db/schema';
import { getRedisConnection } from '../services/redis';
import { computeAndPersistDeviceReliability, computeAndPersistOrgReliability } from '../services/reliabilityScoring';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const RELIABILITY_QUEUE = 'reliability-scoring';

type ScanOrgsJobData = {
  type: 'scan-orgs';
  queuedAt: string;
};

type ComputeOrgJobData = {
  type: 'compute-org';
  orgId: string;
  queuedAt: string;
};

type ComputeDeviceJobData = {
  type: 'compute-device';
  deviceId: string;
  queuedAt: string;
};

type ReliabilityJobData = ScanOrgsJobData | ComputeOrgJobData | ComputeDeviceJobData;

let reliabilityQueue: Queue<ReliabilityJobData> | null = null;
let reliabilityWorker: Worker<ReliabilityJobData> | null = null;

export function getReliabilityQueue(): Queue<ReliabilityJobData> {
  if (!reliabilityQueue) {
    reliabilityQueue = new Queue<ReliabilityJobData>(RELIABILITY_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return reliabilityQueue;
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

  const queue = getReliabilityQueue();
  const slotKey = data.queuedAt.slice(0, 13);
  await queue.addBulk(
    orgRows.map((row) => ({
      name: 'compute-org',
      data: {
        type: 'compute-org' as const,
        orgId: row.orgId,
        queuedAt: data.queuedAt,
      },
      opts: {
        jobId: `reliability:${row.orgId}:${slotKey}`,
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 200 },
      },
    }))
  );

  return { queued: orgRows.length };
}

async function processComputeOrg(data: ComputeOrgJobData): Promise<{ orgId: string; devicesComputed: number }> {
  return computeAndPersistOrgReliability(data.orgId);
}

async function processComputeDevice(data: ComputeDeviceJobData): Promise<{ deviceId: string; computed: boolean }> {
  const computed = await computeAndPersistDeviceReliability(data.deviceId);
  return { deviceId: data.deviceId, computed };
}

export function createReliabilityWorker(): Worker<ReliabilityJobData> {
  return new Worker<ReliabilityJobData>(
    RELIABILITY_QUEUE,
    async (job: Job<ReliabilityJobData>) => {
      return runWithSystemDbAccess(async () => {
        if (job.data.type === 'scan-orgs') {
          return processScanOrgs(job.data);
        }
        if (job.data.type === 'compute-org') {
          return processComputeOrg(job.data);
        }
        return processComputeDevice(job.data);
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 5,
    }
  );
}

async function scheduleReliabilityScan(): Promise<void> {
  const queue = getReliabilityQueue();
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
      queuedAt: new Date().toISOString(),
    },
    {
      jobId: 'reliability-scan-orgs',
      repeat: { pattern: '0 2 * * *' },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    }
  );
}

export async function initializeReliabilityWorker(): Promise<void> {
  reliabilityWorker = createReliabilityWorker();
  reliabilityWorker.on('error', (error) => {
    console.error('[ReliabilityWorker] Worker error:', error);
  });
  reliabilityWorker.on('failed', (job, error) => {
    console.error(`[ReliabilityWorker] Job ${job?.id} failed:`, error);
  });

  await scheduleReliabilityScan();
  console.log('[ReliabilityWorker] Reliability worker initialized');
}

export async function shutdownReliabilityWorker(): Promise<void> {
  if (reliabilityWorker) {
    await reliabilityWorker.close();
    reliabilityWorker = null;
  }
  if (reliabilityQueue) {
    await reliabilityQueue.close();
    reliabilityQueue = null;
  }
}

export async function enqueueDeviceReliabilityComputation(deviceId: string): Promise<string> {
  const queue = getReliabilityQueue();
  const job = await queue.add(
    'compute-device',
    {
      type: 'compute-device',
      deviceId,
      queuedAt: new Date().toISOString(),
    },
    {
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 200 },
    }
  );
  return String(job.id);
}
