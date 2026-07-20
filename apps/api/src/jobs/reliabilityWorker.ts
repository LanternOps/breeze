import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';

import * as dbModule from '../db';
import { devices } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { computeAndPersistDeviceReliability, computeAndPersistOrgReliability } from '../services/reliabilityScoring';
import { captureException } from '../services/sentry';
import { isReusableState } from '../services/bullmqUtils';

const { db } = dbModule;
// #1105 (duration variant): withSystemDbAccessContext holds a DB transaction
// for the whole callback. compute-org fans out across every device in the org,
// so the held transaction would pin one pooled connection for the entire scan.
// Wrap in runOutsideDbContext(() => withSystemDbAccessContext(...)) so the
// background job opens a fresh context (not an inherited request transaction)
// and the connection is released promptly when the compute completes.
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[ReliabilityWorker] withSystemDbAccessContext is not available — DB module may not have loaded correctly');
  }
  const runOutside = dbModule.runOutsideDbContext;
  if (typeof runOutside !== 'function') {
    return dbModule.withSystemDbAccessContext(fn);
  }
  return runOutside(() => dbModule.withSystemDbAccessContext(fn));
};

const RELIABILITY_QUEUE = 'reliability-scoring';
// Event-loop hardening: a device recomputes at most once per fixed 10-min
// wall-clock bucket on-demand regardless of post rate (the jobId slot below is
// `floor(now / window)`, so two posts straddling a bucket boundary can still both
// fire — this is a coarse throttle, not a sliding window). Widening this constant
// is the whole throttle. Trade-off: score staleness ≤~10 min.
const ON_DEMAND_RELIABILITY_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

type ScanOrgsJobData = {
  type: 'scan-orgs';
  queuedAt?: string;
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
    reliabilityQueue = createInstrumentedQueue<ReliabilityJobData>(RELIABILITY_QUEUE);
  }
  return reliabilityQueue;
}

async function processScanOrgs(data: ScanOrgsJobData): Promise<{ queued: number }> {
  // #1105 (BREEZE-K): read the org list in its own short-lived context so the
  // fan-out enqueue below runs AFTER the transaction closes — addBulk is a
  // Redis round-trip that must not run while a pooled Postgres connection sits
  // idle-in-transaction. Mirrors metricAnomalies.ts; the worker handler
  // deliberately does not wrap this job type.
  const orgRows = await runWithSystemDbAccess(async () =>
    db
      .select({ orgId: devices.orgId })
      .from(devices)
      .where(sql`${devices.status} <> 'decommissioned'`)
      .groupBy(devices.orgId)
  );

  if (orgRows.length === 0) {
    return { queued: 0 };
  }

  const queue = getReliabilityQueue();
  const scannedAt = new Date();
  const queuedAt = scannedAt.toISOString();
  const slotKey = queuedAt.slice(0, 13);
  await queue.addBulk(
    orgRows.map((row) => ({
      name: 'compute-org',
      data: {
        type: 'compute-org' as const,
        orgId: row.orgId,
        queuedAt,
      },
      opts: {
        jobId: `reliability-${row.orgId}-${slotKey}`,
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 200 },
      },
    }))
  );

  return { queued: orgRows.length };
}

async function processComputeOrg(
  data: ComputeOrgJobData
): Promise<{ orgId: string; devicesComputed: number; devicesFailed: number }> {
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
      const data = job.data;
      if (data.type === 'scan-orgs') {
        // Manages its own context: DB read inside, enqueue outside (#1105).
        return processScanOrgs(data);
      }
      return runWithSystemDbAccess(async () => {
        if (data.type === 'compute-org') {
          return processComputeOrg(data);
        }
        return processComputeDevice(data);
      });
    },
    {
      connection: getBullMQConnection(),
      // Event-loop hardening: cap simultaneous heavy computes so no burst of
      // ingests can peg the API event loop. The projected 7-column history read
      // (see getHistoryForDevice in reliabilityScoring.ts) makes each compute much
      // lighter on I/O and memory, so a cap of 2 is ample headroom.
      concurrency: 2,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
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
    captureException(error);
  });
  reliabilityWorker.on('failed', (job, error) => {
    console.error(`[ReliabilityWorker] Job ${job?.id} (${job?.data?.type}) failed after ${job?.attemptsMade} attempts:`, error);
    captureException(error);
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
  const slot = Math.floor(Date.now() / ON_DEMAND_RELIABILITY_DEDUPE_WINDOW_MS).toString(36);
  const jobId = `reliability-device:${deviceId}:${slot}`;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      return String(existing.id);
    }
    await existing.remove().catch((error) => {
      console.error(`[ReliabilityWorker] Failed to remove stale device computation job ${jobId}:`, error);
    });
  }

  const job = await queue.add(
    'compute-device',
    {
      type: 'compute-device',
      deviceId,
      queuedAt: new Date().toISOString(),
    },
    {
      jobId,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 200 },
    }
  );
  return String(job.id);
}
