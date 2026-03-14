import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';

import * as dbModule from '../db';
import { organizationUsers } from '../db/schema';
import { getRedisConnection } from '../services/redis';
import {
  appendUserRiskSignalEvent,
  computeAndPersistUserRiskForUser,
  computeAndPersistOrgUserRisk,
  publishUserRiskScoreEvents
} from '../services/userRiskScoring';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const USER_RISK_QUEUE = 'user-risk-scoring';
function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[UserRiskJobs] Invalid ${name}="${raw}", using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

const SCAN_INTERVAL_MS = parsePositiveIntEnv('USER_RISK_SCAN_INTERVAL_MS', 6 * 60 * 60 * 1000);
const USER_RISK_WORKER_CONCURRENCY = parsePositiveIntEnv('USER_RISK_WORKER_CONCURRENCY', 3);

type ScanOrgsJobData = {
  type: 'scan-orgs';
  queuedAt: string;
};

type ComputeOrgJobData = {
  type: 'compute-org';
  orgId: string;
  queuedAt: string;
};

type ProcessSignalEventJobData = {
  type: 'process-signal-event';
  orgId: string;
  userId: string;
  eventType: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  scoreImpact?: number;
  description: string;
  details?: Record<string, unknown>;
  occurredAt?: string;
  queuedAt: string;
};

type UserRiskJobData = ScanOrgsJobData | ComputeOrgJobData | ProcessSignalEventJobData;

let userRiskQueue: Queue<UserRiskJobData> | null = null;
let userRiskWorker: Worker<UserRiskJobData> | null = null;

export function getUserRiskQueue(): Queue<UserRiskJobData> {
  if (!userRiskQueue) {
    userRiskQueue = new Queue<UserRiskJobData>(USER_RISK_QUEUE, {
      connection: getRedisConnection()
    });
  }
  return userRiskQueue;
}

async function processScanOrgs(data: ScanOrgsJobData): Promise<{ queued: number }> {
  const orgRows = await db
    .select({ orgId: organizationUsers.orgId })
    .from(organizationUsers)
    .where(sql`${organizationUsers.orgId} is not null`)
    .groupBy(organizationUsers.orgId);

  if (orgRows.length === 0) {
    return { queued: 0 };
  }

  const queue = getUserRiskQueue();
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
        jobId: `user-risk-${row.orgId}-${slotKey}`,
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 200 }
      }
    }))
  );

  return { queued: orgRows.length };
}

async function processComputeOrg(data: ComputeOrgJobData): Promise<{
  orgId: string;
  usersProcessed: number;
  changedUsers: number;
  autoTrainingAssigned: number;
  publishedHigh: number;
  publishedSpikes: number;
  publishFailures: number;
}> {
  const result = await computeAndPersistOrgUserRisk(data.orgId);
  const published = await publishUserRiskScoreEvents({
    orgId: data.orgId,
    changedUsers: result.changedUsers,
    thresholds: result.policy.thresholds,
    interventions: result.policy.interventions
  });

  return {
    orgId: data.orgId,
    usersProcessed: result.usersProcessed,
    changedUsers: result.changedUsers.length,
    autoTrainingAssigned: result.autoTrainingAssigned,
    publishedHigh: published.publishedHigh,
    publishedSpikes: published.publishedSpikes,
    publishFailures: published.failed
  };
}

async function processSignalEvent(data: ProcessSignalEventJobData): Promise<{
  orgId: string;
  userId: string;
  eventId: string;
  recomputed: boolean;
  changedUsers: number;
  publishedHigh: number;
  publishedSpikes: number;
  publishFailures: number;
}> {
  const eventId = await appendUserRiskSignalEvent({
    orgId: data.orgId,
    userId: data.userId,
    eventType: data.eventType,
    severity: data.severity,
    scoreImpact: data.scoreImpact,
    description: data.description,
    details: data.details,
    occurredAt: data.occurredAt ? new Date(data.occurredAt) : undefined
  });

  const result = await computeAndPersistUserRiskForUser(data.orgId, data.userId);
  const published = await publishUserRiskScoreEvents({
    orgId: data.orgId,
    changedUsers: result.changedUsers,
    thresholds: result.policy.thresholds,
    interventions: result.policy.interventions
  });

  return {
    orgId: data.orgId,
    userId: data.userId,
    eventId,
    recomputed: true,
    changedUsers: result.changedUsers.length,
    publishedHigh: published.publishedHigh,
    publishedSpikes: published.publishedSpikes,
    publishFailures: published.failed
  };
}

export function createUserRiskWorker(): Worker<UserRiskJobData> {
  return new Worker<UserRiskJobData>(
    USER_RISK_QUEUE,
    async (job: Job<UserRiskJobData>) => {
      return runWithSystemDbAccess(async () => {
        if (job.data.type === 'scan-orgs') {
          return processScanOrgs(job.data);
        }
        if (job.data.type === 'compute-org') {
          return processComputeOrg(job.data);
        }
        return processSignalEvent(job.data);
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: USER_RISK_WORKER_CONCURRENCY
    }
  );
}

async function scheduleUserRiskScan(): Promise<void> {
  const queue = getUserRiskQueue();
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

export async function initializeUserRiskJobs(): Promise<void> {
  userRiskWorker = createUserRiskWorker();
  userRiskWorker.on('error', (error) => {
    console.error('[UserRiskJobs] Worker error:', error);
  });
  userRiskWorker.on('failed', (job, error) => {
    console.error(`[UserRiskJobs] Job ${job?.id} (${job?.data?.type}) failed:`, error);
  });

  await scheduleUserRiskScan();
  console.log('[UserRiskJobs] User risk worker initialized');
}

export async function shutdownUserRiskJobs(): Promise<void> {
  if (userRiskWorker) {
    await userRiskWorker.close();
    userRiskWorker = null;
  }
  if (userRiskQueue) {
    await userRiskQueue.close();
    userRiskQueue = null;
  }
}

export async function triggerUserRiskRecompute(orgId: string): Promise<string> {
  const queue = getUserRiskQueue();
  const job = await queue.add(
    'compute-org',
    {
      type: 'compute-org',
      orgId,
      queuedAt: new Date().toISOString()
    },
    {
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 200 }
    }
  );
  return String(job.id);
}

export async function enqueueUserRiskSignalEvent(input: Omit<ProcessSignalEventJobData, 'type' | 'queuedAt'>): Promise<string> {
  const queue = getUserRiskQueue();
  const job = await queue.add(
    'process-signal-event',
    {
      type: 'process-signal-event',
      ...input,
      queuedAt: new Date().toISOString()
    },
    {
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 200 }
    }
  );
  return String(job.id);
}
