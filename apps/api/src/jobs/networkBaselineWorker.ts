import { Job, Queue, Worker } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import {
  discoveryJobs,
  discoveryProfiles,
  networkBaselines
} from '../db/schema';
import { getRedisConnection } from '../services/redis';
import { compareBaselineScan, normalizeBaselineScanSchedule } from '../services/networkBaseline';
import { enqueueDiscoveryScan, type DiscoveredHostResult } from './discoveryWorker';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const NETWORK_BASELINE_QUEUE = 'network-baseline';

interface ScheduleBaselineScansJobData {
  type: 'schedule-baseline-scans';
}

interface ExecuteBaselineScanJobData {
  type: 'execute-baseline-scan';
  baselineId: string;
  orgId: string;
  siteId: string;
  subnet: string;
}

interface CompareBaselineJobData {
  type: 'compare-baseline';
  baselineId: string;
  orgId: string;
  siteId: string;
  jobId: string;
  hosts: DiscoveredHostResult[];
}

type NetworkBaselineJobData =
  | ScheduleBaselineScansJobData
  | ExecuteBaselineScanJobData
  | CompareBaselineJobData;

let networkBaselineQueue: Queue | null = null;
let networkBaselineWorkerInstance: Worker<NetworkBaselineJobData> | null = null;

export function getNetworkBaselineQueue(): Queue {
  if (!networkBaselineQueue) {
    networkBaselineQueue = new Queue(NETWORK_BASELINE_QUEUE, {
      connection: getRedisConnection()
    });
  }
  return networkBaselineQueue;
}

function createNetworkBaselineWorker(): Worker<NetworkBaselineJobData> {
  return new Worker<NetworkBaselineJobData>(
    NETWORK_BASELINE_QUEUE,
    async (job: Job<NetworkBaselineJobData>) => {
      return runWithSystemDbAccess(async () => {
        switch (job.data.type) {
          case 'schedule-baseline-scans':
            return processScheduleScans();
          case 'execute-baseline-scan':
            return processExecuteScan(job.data);
          case 'compare-baseline':
            return processCompareBaseline(job.data);
          default:
            throw new Error(`Unknown network baseline job type: ${(job.data as { type: string }).type}`);
        }
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 5
    }
  );
}

async function processScheduleScans(): Promise<{ enqueued: number }> {
  const now = new Date();

  const dueBaselines = await db
    .select({
      id: networkBaselines.id,
      orgId: networkBaselines.orgId,
      siteId: networkBaselines.siteId,
      subnet: networkBaselines.subnet,
      scanSchedule: networkBaselines.scanSchedule
    })
    .from(networkBaselines)
    .where(
      sql`COALESCE((${networkBaselines.scanSchedule}->>'enabled')::boolean, false) = true
          AND COALESCE((${networkBaselines.scanSchedule}->>'nextScanAt')::timestamptz, now()) <= ${now.toISOString()}::timestamptz`
    );

  if (dueBaselines.length === 0) {
    return { enqueued: 0 };
  }

  const queue = getNetworkBaselineQueue();

  let enqueued = 0;
  for (const baseline of dueBaselines) {
    const schedule = normalizeBaselineScanSchedule(baseline.scanSchedule);

    await queue.add(
      'execute-baseline-scan',
      {
        type: 'execute-baseline-scan',
        baselineId: baseline.id,
        orgId: baseline.orgId,
        siteId: baseline.siteId,
        subnet: baseline.subnet
      },
      {
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 100 }
      }
    );

    enqueued++;

    const nextScanAt = new Date(Date.now() + schedule.intervalHours * 60 * 60 * 1000).toISOString();
    await db
      .update(networkBaselines)
      .set({
        scanSchedule: {
          ...schedule,
          nextScanAt
        },
        updatedAt: new Date()
      })
      .where(eq(networkBaselines.id, baseline.id));
  }

  if (enqueued > 0) {
    console.log(`[NetworkBaselineWorker] Scheduled ${enqueued} baseline scan job(s)`);
  }

  return { enqueued };
}

async function processExecuteScan(data: ExecuteBaselineScanJobData): Promise<{
  queued: boolean;
  discoveryJobId: string | null;
}> {
  const [baseline] = await db
    .select()
    .from(networkBaselines)
    .where(eq(networkBaselines.id, data.baselineId))
    .limit(1);

  if (!baseline) {
    console.warn(`[NetworkBaselineWorker] Baseline ${data.baselineId} not found`);
    return { queued: false, discoveryJobId: null };
  }

  let [profile] = await db
    .select()
    .from(discoveryProfiles)
    .where(
      and(
        eq(discoveryProfiles.orgId, baseline.orgId),
        eq(discoveryProfiles.siteId, baseline.siteId),
        sql`${discoveryProfiles.subnets} @> ARRAY[${baseline.subnet}]::text[]`
      )
    )
    .limit(1);

  if (!profile) {
    const [createdProfile] = await db
      .insert(discoveryProfiles)
      .values({
        orgId: baseline.orgId,
        siteId: baseline.siteId,
        name: `Baseline Scan ${baseline.subnet}`,
        description: `Auto-created profile for network baseline ${baseline.subnet}`,
        enabled: true,
        subnets: [baseline.subnet],
        excludeIps: [],
        methods: ['arp', 'ping'] as typeof discoveryProfiles.$inferInsert.methods,
        portRanges: null,
        snmpCommunities: [],
        snmpCredentials: null,
        schedule: { type: 'manual' },
        deepScan: false,
        identifyOS: false,
        resolveHostnames: true,
        timeout: 2,
        concurrency: 128,
        createdBy: null
      })
      .returning();

    profile = createdProfile;
  }

  if (!profile) {
    throw new Error(`Unable to resolve discovery profile for baseline ${baseline.id}`);
  }

  const [discoveryJob] = await db
    .insert(discoveryJobs)
    .values({
      profileId: profile.id,
      orgId: baseline.orgId,
      siteId: baseline.siteId,
      status: 'scheduled',
      scheduledAt: new Date()
    })
    .returning();

  if (!discoveryJob) {
    throw new Error(`Failed to create discovery job for baseline ${baseline.id}`);
  }

  try {
    await enqueueDiscoveryScan(
      discoveryJob.id,
      profile.id,
      baseline.orgId,
      baseline.siteId,
      null
    );
  } catch (error) {
    await db
      .update(discoveryJobs)
      .set({
        status: 'failed',
        completedAt: new Date(),
        errors: { message: 'Failed to enqueue baseline discovery scan' },
        updatedAt: new Date()
      })
      .where(eq(discoveryJobs.id, discoveryJob.id));

    throw error;
  }

  await db
    .update(networkBaselines)
    .set({
      lastScanJobId: discoveryJob.id,
      updatedAt: new Date()
    })
    .where(eq(networkBaselines.id, baseline.id));

  return {
    queued: true,
    discoveryJobId: discoveryJob.id
  };
}

async function processCompareBaseline(data: CompareBaselineJobData) {
  return compareBaselineScan({
    baselineId: data.baselineId,
    orgId: data.orgId,
    siteId: data.siteId,
    jobId: data.jobId,
    hosts: data.hosts ?? []
  });
}

async function scheduleRecurringScanPlanner(): Promise<void> {
  const queue = getNetworkBaselineQueue();

  const repeatable = await queue.getRepeatableJobs();
  for (const job of repeatable) {
    if (job.name === 'schedule-baseline-scans') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'schedule-baseline-scans',
    { type: 'schedule-baseline-scans' as const },
    {
      repeat: {
        every: 15 * 60 * 1000
      },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 20 }
    }
  );
}

export async function enqueueBaselineScan(
  baselineId: string,
  orgId: string,
  siteId: string,
  subnet: string
): Promise<string> {
  const queue = getNetworkBaselineQueue();
  const job = await queue.add(
    'execute-baseline-scan',
    {
      type: 'execute-baseline-scan',
      baselineId,
      orgId,
      siteId,
      subnet
    },
    {
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 }
    }
  );

  return job.id!;
}

export async function enqueueBaselineComparison(
  baselineId: string,
  jobId: string,
  orgId: string,
  siteId: string,
  hosts: DiscoveredHostResult[]
): Promise<string> {
  const queue = getNetworkBaselineQueue();
  const job = await queue.add(
    'compare-baseline',
    {
      type: 'compare-baseline',
      baselineId,
      jobId,
      orgId,
      siteId,
      hosts
    },
    {
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 }
    }
  );

  return job.id!;
}

export async function initializeNetworkBaselineWorker(): Promise<void> {
  networkBaselineWorkerInstance = createNetworkBaselineWorker();

  networkBaselineWorkerInstance.on('error', (error) => {
    console.error('[NetworkBaselineWorker] Worker error:', error);
  });

  networkBaselineWorkerInstance.on('failed', (job, error) => {
    console.error(`[NetworkBaselineWorker] Job ${job?.id} failed:`, error);
  });

  await scheduleRecurringScanPlanner();

  console.log('[NetworkBaselineWorker] Network baseline worker initialized');
}

export async function shutdownNetworkBaselineWorker(): Promise<void> {
  if (networkBaselineWorkerInstance) {
    await networkBaselineWorkerInstance.close();
    networkBaselineWorkerInstance = null;
  }

  if (networkBaselineQueue) {
    await networkBaselineQueue.close();
    networkBaselineQueue = null;
  }

  console.log('[NetworkBaselineWorker] Network baseline worker shut down');
}
