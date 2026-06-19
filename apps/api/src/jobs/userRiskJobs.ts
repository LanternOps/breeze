import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';

import * as dbModule from '../db';
import { organizationUsers } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import {
  appendUserRiskSignalEvent,
  computeAndPersistUserRiskForUser,
  computeAndPersistOrgUserRisk,
  publishUserRiskScoreEvents
} from '../services/userRiskScoring';
import { evaluateUserRiskSignalsForOrg } from '../services/userRiskSignals';
import { isReusableState } from '../services/bullmqUtils';
import { attachWorkerObservability } from './workerObservability';
import { shouldProduceMlOutput } from '../services/mlFeatureFlags';
import { captureException } from '../services/sentry';

const { db } = dbModule;
// #1105: withSystemDbAccessContext holds a DB transaction (pins a pooled
// connection) for the whole callback. Wrap the DB compute in
// runOutsideDbContext(() => withSystemDbAccessContext(...)) and do slow non-DB
// work (Redis publishes) AFTER the context closes — never inside it.
const runSystemDbCompute = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  const runOutside = dbModule.runOutsideDbContext;
  if (typeof withSystem !== 'function') return fn();
  if (typeof runOutside !== 'function') return withSystem(fn);
  return runOutside(() => withSystem(fn));
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
const USER_RISK_ON_DEMAND_DEDUPE_WINDOW_MS = parsePositiveIntEnv('USER_RISK_ON_DEMAND_DEDUPE_WINDOW_MS', 30 * 1000);
const USER_RISK_EVENT_TYPE_MAX_LEN = 128;
const USER_RISK_DESCRIPTION_MAX_LEN = 1024;
const USER_RISK_DETAILS_MAX_BYTES = 8 * 1024;

type ScanOrgsJobData = {
  type: 'scan-orgs';
  queuedAt?: string;
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

function truncateUserRiskString(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function sanitizeUserRiskDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(details);
    if (serialized && serialized.length <= USER_RISK_DETAILS_MAX_BYTES) {
      return details;
    }
  } catch (err) {
    console.warn('[UserRiskJobs] Failed to serialize details payload, dropping field:', err);
    return undefined;
  }
  return undefined;
}

function sanitizeUserRiskSignalEventInput(
  input: Omit<ProcessSignalEventJobData, 'type' | 'queuedAt'>
): Omit<ProcessSignalEventJobData, 'type' | 'queuedAt'> {
  return {
    ...input,
    eventType: truncateUserRiskString(input.eventType, USER_RISK_EVENT_TYPE_MAX_LEN),
    description: truncateUserRiskString(input.description, USER_RISK_DESCRIPTION_MAX_LEN),
    details: sanitizeUserRiskDetails(input.details),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function buildUserRiskSignalEventJobId(input: Omit<ProcessSignalEventJobData, 'type' | 'queuedAt'>): string {
  const sanitized = sanitizeUserRiskSignalEventInput(input);
  const fingerprint = createHash('sha256')
    .update(stableJson(sanitized))
    .digest('hex')
    .slice(0, 24);
  // #1118: BullMQ jobIds must contain 0 or exactly 2 colons — 3 colons makes
  // queue.add() silently throw and the enqueue is dropped. Use hyphen separators.
  return `user-risk-signal-${sanitized.orgId}-${sanitized.userId}-${fingerprint}`;
}

export function getUserRiskQueue(): Queue<UserRiskJobData> {
  if (!userRiskQueue) {
    userRiskQueue = new Queue<UserRiskJobData>(USER_RISK_QUEUE, {
      connection: getBullMQConnection()
    });
  }
  return userRiskQueue;
}

async function processScanOrgs(data: ScanOrgsJobData): Promise<{ queued: number }> {
  // The org enumeration is a tenant-scoped read; run it under the system
  // context so RLS lets us see every org (a bare breeze_app read would match
  // 0 rows, #1375). The result returns before we touch Redis, so the context
  // is closed by the time we enqueue (#1105).
  const orgRows = await runSystemDbCompute(() =>
    db
      .select({ orgId: organizationUsers.orgId })
      .from(organizationUsers)
      .where(sql`${organizationUsers.orgId} is not null`)
      .groupBy(organizationUsers.orgId)
  );

  if (orgRows.length === 0) {
    return { queued: 0 };
  }

  const queue = getUserRiskQueue();
  const scannedAt = new Date();
  const queuedAt = scannedAt.toISOString();
  const slotKey = queuedAt.slice(0, 13);
  await queue.addBulk(
    orgRows.map((row) => ({
      name: 'compute-org',
      data: {
        type: 'compute-org' as const,
        orgId: row.orgId,
        queuedAt
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
  skipped?: boolean;
  usersProcessed: number;
  changedUsers: number;
  autoTrainingAssigned: number;
  signalsAppended: number;
  signalsDeduped: number;
  publishedHigh: number;
  publishedSpikes: number;
  publishFailures: number;
}> {
  if (!(await shouldProduceMlOutput(data.orgId, 'ml.user_risk_v0.enabled'))) {
    return {
      orgId: data.orgId,
      skipped: true,
      usersProcessed: 0,
      changedUsers: 0,
      autoTrainingAssigned: 0,
      signalsAppended: 0,
      signalsDeduped: 0,
      publishedHigh: 0,
      publishedSpikes: 0,
      publishFailures: 0
    };
  }

  // #1105: do the DB compute inside the held system context, then RETURN and
  // run the Redis publishes AFTER the context closes (below) so the open
  // transaction never spans the per-user publishEvent round-trips.
  const { signalEvaluation, result } = await runSystemDbCompute(async () => {
    const signalEvaluation = await evaluateUserRiskSignalsForOrg(data.orgId);
    const result = await computeAndPersistOrgUserRisk(data.orgId);
    return { signalEvaluation, result };
  });

  const published = await publishUserRiskScoreEvents({
    orgId: data.orgId,
    changedUsers: result.changedUsers,
    thresholds: result.policy.thresholds,
    interventions: result.policy.interventions
  });

  if (published.failed > 0) {
    const error = new Error(
      `[UserRiskJobs] compute-org for org ${data.orgId} failed to publish ${published.failed} risk event(s)`
    );
    captureException(error);
    throw error;
  }

  return {
    orgId: data.orgId,
    usersProcessed: result.usersProcessed,
    changedUsers: result.changedUsers.length,
    autoTrainingAssigned: result.autoTrainingAssigned,
    signalsAppended: signalEvaluation.appended,
    signalsDeduped: signalEvaluation.deduped,
    publishedHigh: published.publishedHigh,
    publishedSpikes: published.publishedSpikes,
    publishFailures: published.failed
  };
}

async function processSignalEvent(data: ProcessSignalEventJobData): Promise<{
  orgId: string;
  userId: string;
  eventId: string | null;
  skipped?: boolean;
  recomputed: boolean;
  changedUsers: number;
  publishedHigh: number;
  publishedSpikes: number;
  publishFailures: number;
}> {
  if (!(await shouldProduceMlOutput(data.orgId, 'ml.user_risk_v0.enabled'))) {
    return {
      orgId: data.orgId,
      userId: data.userId,
      eventId: null,
      skipped: true,
      recomputed: false,
      changedUsers: 0,
      publishedHigh: 0,
      publishedSpikes: 0,
      publishFailures: 0
    };
  }

  // #1105: DB writes inside the held system context; publish after it closes.
  const { eventId, result } = await runSystemDbCompute(async () => {
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
    return { eventId, result };
  });

  const published = await publishUserRiskScoreEvents({
    orgId: data.orgId,
    changedUsers: result.changedUsers,
    thresholds: result.policy.thresholds,
    interventions: result.policy.interventions
  });

  if (published.failed > 0) {
    const error = new Error(
      `[UserRiskJobs] process-signal-event for org ${data.orgId} user ${data.userId} failed to publish ${published.failed} risk event(s)`
    );
    captureException(error);
    throw error;
  }

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
      // Each handler manages its own DB context (#1105): compute inside a
      // runOutsideDbContext(withSystemDbAccessContext(...)) block and publish
      // to Redis after it closes. processScanOrgs only reads via the bare pool.
      if (job.data.type === 'scan-orgs') {
        return processScanOrgs(job.data);
      }
      if (job.data.type === 'compute-org') {
        return processComputeOrg(job.data);
      }
      return processSignalEvent(job.data);
    },
    {
      connection: getBullMQConnection(),
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
  // attachWorkerObservability already routes both 'error' and 'failed' to
  // Sentry (#1379); the handlers below are console-only on purpose to avoid
  // double-reporting (S5).
  attachWorkerObservability(userRiskWorker, 'userRiskWorker');
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
  const slot = Math.floor(Date.now() / USER_RISK_ON_DEMAND_DEDUPE_WINDOW_MS).toString(36);
  const jobId = `user-risk-recompute:${orgId}:${slot}`;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      return String(existing.id);
    }
    await existing.remove().catch((error) => {
      console.error(`[UserRiskJobs] Failed to remove stale recompute job ${jobId}:`, error);
    });
  }

  const job = await queue.add(
    'compute-org',
    {
      type: 'compute-org',
      orgId,
      queuedAt: new Date().toISOString()
    },
    {
      jobId,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 200 }
    }
  );
  return String(job.id);
}

export async function enqueueUserRiskSignalEvent(input: Omit<ProcessSignalEventJobData, 'type' | 'queuedAt'>): Promise<string> {
  const queue = getUserRiskQueue();
  const sanitized = sanitizeUserRiskSignalEventInput(input);
  const jobId = buildUserRiskSignalEventJobId(sanitized);
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      return String(existing.id);
    }
    await existing.remove().catch((error) => {
      console.error(`[UserRiskJobs] Failed to remove stale signal-event job ${jobId}:`, error);
    });
  }

  const job = await queue.add(
    'process-signal-event',
    {
      type: 'process-signal-event',
      ...sanitized,
      queuedAt: new Date().toISOString()
    },
    {
      jobId,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 200 }
    }
  );
  return String(job.id);
}
