import { Job, Queue, Worker } from 'bullmq';

import { getBullMQConnection } from '../services/redis';
import { detectPatternCorrelation, runCorrelationRules } from '../services/logSearch';
import { captureException } from '../services/sentry';
import { isReusableState } from '../services/bullmqUtils';
import {
  revalidateLogReadAuthority,
  type LogReadAuthorityEnvelope,
} from '../services/logReadAuthority';
import * as dbModule from '../db';
import { attachWorkerObservability } from './workerObservability';

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[LogCorrelationWorker] withSystemDbAccessContext is not available — DB module may not have loaded correctly');
  }
  return dbModule.withSystemDbAccessContext(fn);
};

const LOG_CORRELATION_QUEUE = 'log-correlation';
const DETECTION_INTERVAL_MS = 5 * 60 * 1000;
const ON_DEMAND_DEDUPE_WINDOW_MS = 30 * 1000;

type DetectRulesJobData = {
  type: 'rules';
  orgId?: string;
  ruleIds?: string[];
  queuedAt: string;
};

type DetectPatternJobData = {
  type: 'pattern';
  orgId: string;
  pattern: string;
  isRegex: boolean;
  timeWindowSeconds?: number;
  minDevices?: number;
  minOccurrences?: number;
  sampleLimit?: number;
  queuedAt: string;
  authority: LogReadAuthorityEnvelope;
};

type CorrelationJobData = DetectRulesJobData | DetectPatternJobData;

function isValidPatternJobData(data: DetectPatternJobData): boolean {
  const optionalInteger = (value: unknown, min: number, max: number) => value === undefined
    || (Number.isInteger(value) && Number(value) >= min && Number(value) <= max);
  return typeof data.orgId === 'string' && data.orgId.length > 0
    && typeof data.pattern === 'string' && data.pattern.length > 0 && data.pattern.length <= 1000
    && typeof data.isRegex === 'boolean'
    && typeof data.queuedAt === 'string' && Number.isFinite(Date.parse(data.queuedAt))
    && optionalInteger(data.timeWindowSeconds, 30, 86_400)
    && optionalInteger(data.minDevices, 1, 200)
    && optionalInteger(data.minOccurrences, 1, 50_000)
    && optionalInteger(data.sampleLimit, 1, 1_000);
}

export interface LogCorrelationDetectionJobSnapshot {
  id: string;
  name: string;
  state: string;
  data: CorrelationJobData;
  result: unknown;
  failedReason: string | null;
  attemptsMade: number;
  processedOn: number | null;
  finishedOn: number | null;
}

let correlationQueue: Queue<CorrelationJobData> | null = null;
let correlationWorker: Worker<CorrelationJobData> | null = null;

function stableShortHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export function getLogCorrelationQueue(): Queue<CorrelationJobData> {
  if (!correlationQueue) {
    correlationQueue = new Queue<CorrelationJobData>(LOG_CORRELATION_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return correlationQueue;
}

export function createLogCorrelationWorker(): Worker<CorrelationJobData> {
  return new Worker<CorrelationJobData>(
    LOG_CORRELATION_QUEUE,
    async (job: Job<CorrelationJobData>) => processLogCorrelationJob(job.data),
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    }
  );
}

export async function processLogCorrelationJob(data: CorrelationJobData): Promise<unknown> {
  return runWithSystemDbAccess(async () => {
    if (data.type === 'pattern') {
      if (!isValidPatternJobData(data)) {
        throw new Error('Log detection job is malformed');
      }
      const live = await revalidateLogReadAuthority(data.authority);
      if (!live || live.authority.orgId !== data.orgId) {
        throw new Error('Log detection authority is no longer valid');
      }
      const detection = await detectPatternCorrelation({
        orgId: data.orgId,
        pattern: data.pattern,
        isRegex: data.isRegex,
        minDevices: data.minDevices,
        minOccurrences: data.minOccurrences,
        sampleLimit: data.sampleLimit,
        timeWindowSeconds: data.timeWindowSeconds,
        allowedDeviceIds: live.allowedDeviceIds,
        allowedSiteIds: live.allowedSiteIds,
      });
      return {
        mode: 'pattern',
        detected: Boolean(detection),
        result: detection,
        queuedAt: data.queuedAt,
      };
    }

    const detections = await runCorrelationRules({
      orgId: data.orgId,
      ruleIds: data.ruleIds,
    });
    return { mode: 'rules', detections: detections.length, queuedAt: data.queuedAt };
  });
}

async function scheduleCorrelationDetection(): Promise<void> {
  const queue = getLogCorrelationQueue();
  const repeatable = await queue.getRepeatableJobs();

  for (const job of repeatable) {
    if (job.name === 'rules-detect' || job.name === 'detect') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'rules-detect',
    {
      type: 'rules',
      queuedAt: new Date().toISOString(),
    },
    {
      repeat: { every: DETECTION_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 100 },
    }
  );
}

export async function initializeLogCorrelationWorker(): Promise<void> {
  correlationWorker = createLogCorrelationWorker();
  attachWorkerObservability(correlationWorker, 'logCorrelationWorker');
  correlationWorker.on('error', (error) => {
    console.error('[LogCorrelationWorker] Worker error:', error);
    captureException(error);
  });
  correlationWorker.on('failed', (job, error) => {
    console.error(`[LogCorrelationWorker] Job ${job?.id} failed:`, error);
    captureException(error);
  });

  await scheduleCorrelationDetection();
  console.log('[LogCorrelationWorker] Log correlation worker initialized');
}

export async function shutdownLogCorrelationWorker(): Promise<void> {
  if (correlationWorker) {
    await correlationWorker.close();
    correlationWorker = null;
  }
  if (correlationQueue) {
    await correlationQueue.close();
    correlationQueue = null;
  }
}

export async function enqueueLogCorrelationDetection(options?: {
  orgId?: string;
  ruleIds?: string[];
}): Promise<string> {
  const queue = getLogCorrelationQueue();
  const normalizedRuleIds = options?.ruleIds
    ? Array.from(new Set(options.ruleIds.filter((ruleId) => typeof ruleId === 'string' && ruleId.length > 0))).sort()
    : undefined;
  const slot = Math.floor(Date.now() / ON_DEMAND_DEDUPE_WINDOW_MS).toString(36);
  // '-' separator (not ':') — BullMQ rejects custom jobIds whose colon-split
  // length !== 3, and this 4-part id would throw. See #1101.
  const jobId = [
    'log-correlation-rules',
    options?.orgId ?? 'all',
    stableShortHash(JSON.stringify(normalizedRuleIds ?? [])),
    slot,
  ].join('-');
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      return String(existing.id);
    }
    await existing.remove().catch((error) => {
      console.error(
        `[LogCorrelationWorker] Failed to remove stale rules detection job ${jobId}:`,
        error
      );
    });
  }

  const job = await queue.add(
    'rules-detect',
    {
      type: 'rules',
      orgId: options?.orgId,
      ruleIds: normalizedRuleIds,
      queuedAt: new Date().toISOString(),
    },
    {
      jobId,
      removeOnComplete: true,
      removeOnFail: { count: 50 },
    }
  );

  return String(job.id);
}

export async function enqueueAdHocPatternCorrelationDetection(options: {
  orgId: string;
  pattern: string;
  isRegex?: boolean;
  timeWindowSeconds?: number;
  minDevices?: number;
  minOccurrences?: number;
  sampleLimit?: number;
  authority: LogReadAuthorityEnvelope;
}): Promise<string> {
  const queue = getLogCorrelationQueue();
  const slot = Math.floor(Date.now() / ON_DEMAND_DEDUPE_WINDOW_MS).toString(36);
  const jobId = [
    'log-correlation-pattern',
    stableShortHash(JSON.stringify({
      orgId: options.orgId,
      pattern: options.pattern,
      isRegex: Boolean(options.isRegex),
      timeWindowSeconds: options.timeWindowSeconds,
      minDevices: options.minDevices,
      minOccurrences: options.minOccurrences,
      sampleLimit: options.sampleLimit,
      authorityFingerprint: options.authority.fingerprint,
    })),
    slot,
  ].join(':');
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      return String(existing.id);
    }
    await existing.remove().catch((error) => {
      console.error(
        `[LogCorrelationWorker] Failed to remove stale pattern detection job ${jobId}:`,
        error
      );
    });
  }

  const job = await queue.add(
    'pattern-detect',
    {
      type: 'pattern',
      orgId: options.orgId,
      pattern: options.pattern,
      isRegex: Boolean(options.isRegex),
      timeWindowSeconds: options.timeWindowSeconds,
      minDevices: options.minDevices,
      minOccurrences: options.minOccurrences,
      sampleLimit: options.sampleLimit,
      queuedAt: new Date().toISOString(),
      authority: options.authority,
    },
    {
      jobId,
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 100 },
    }
  );

  return String(job.id);
}

export async function getLogCorrelationDetectionJob(jobId: string): Promise<LogCorrelationDetectionJobSnapshot | null> {
  const queue = getLogCorrelationQueue();
  const job = await queue.getJob(jobId);
  if (!job) {
    return null;
  }

  const state = await job.getState();

  return {
    id: String(job.id),
    name: job.name,
    state,
    data: job.data,
    result: job.returnvalue,
    failedReason: job.failedReason ?? null,
    attemptsMade: job.attemptsMade,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
  };
}
