import { Job, Queue, Worker } from 'bullmq';

import { getRedisConnection } from '../services/redis';
import { detectPatternCorrelation, runCorrelationRules } from '../services/logSearch';
import { captureException } from '../services/sentry';
import * as dbModule from '../db';

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[LogCorrelationWorker] withSystemDbAccessContext is not available — DB module may not have loaded correctly');
  }
  return dbModule.withSystemDbAccessContext(fn);
};

const LOG_CORRELATION_QUEUE = 'log-correlation';
const DETECTION_INTERVAL_MS = 5 * 60 * 1000;

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
};

type CorrelationJobData = DetectRulesJobData | DetectPatternJobData;

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

export function getLogCorrelationQueue(): Queue<CorrelationJobData> {
  if (!correlationQueue) {
    correlationQueue = new Queue<CorrelationJobData>(LOG_CORRELATION_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return correlationQueue;
}

export function createLogCorrelationWorker(): Worker<CorrelationJobData> {
  return new Worker<CorrelationJobData>(
    LOG_CORRELATION_QUEUE,
    async (job: Job<CorrelationJobData>) => {
      return runWithSystemDbAccess(async () => {
        if (job.data.type === 'pattern') {
          const detection = await detectPatternCorrelation({
            orgId: job.data.orgId,
            pattern: job.data.pattern,
            isRegex: job.data.isRegex,
            minDevices: job.data.minDevices,
            minOccurrences: job.data.minOccurrences,
            sampleLimit: job.data.sampleLimit,
            timeWindowSeconds: job.data.timeWindowSeconds,
          });
          return {
            mode: 'pattern',
            detected: Boolean(detection),
            result: detection,
            queuedAt: job.data.queuedAt,
          };
        }

        const detections = await runCorrelationRules({
          orgId: job.data.orgId,
          ruleIds: job.data.ruleIds,
        });

        return {
          mode: 'rules',
          detections: detections.length,
          queuedAt: job.data.queuedAt,
        };
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 1,
    }
  );
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
  const job = await queue.add(
    'rules-detect',
    {
      type: 'rules',
      orgId: options?.orgId,
      ruleIds: options?.ruleIds,
      queuedAt: new Date().toISOString(),
    },
    {
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
}): Promise<string> {
  const queue = getLogCorrelationQueue();
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
    },
    {
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
