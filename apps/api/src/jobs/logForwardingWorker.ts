/**
 * Log Forwarding Worker
 *
 * BullMQ worker that forwards device event logs to external destinations
 * (e.g. Elasticsearch) based on per-org forwarding configuration.
 * Includes backpressure protection to avoid overwhelming the queue.
 */

import { Queue, Worker, Job } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { bulkIndexEvents, clearClientCache } from '../services/logForwarding';

const QUEUE_NAME = 'log-forwarding';
const MAX_LOG_FORWARDING_EVENTS = 500;
const MAX_LOG_FORWARDING_HOSTNAME = 255;
const MAX_LOG_FORWARDING_FIELD = 256;
const MAX_LOG_FORWARDING_MESSAGE = 4096;
const MAX_LOG_FORWARDING_RAW_DATA_BYTES = 16 * 1024;

interface LogForwardingJobData {
  orgId: string;
  deviceId: string;
  hostname: string;
  events: Array<{
    category: string;
    level: string;
    source: string;
    message: string;
    timestamp: string;
    rawData?: unknown;
  }>;
}

let queue: Queue<LogForwardingJobData> | null = null;
let worker: Worker<LogForwardingJobData> | null = null;

function truncateLogString(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function sanitizeRawData(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized.length <= MAX_LOG_FORWARDING_RAW_DATA_BYTES) {
      return value;
    }
  } catch (err) {
    console.warn('[LogForwarding] Failed to serialize rawData payload, dropping field:', err);
    return undefined;
  }
  return undefined;
}

function sanitizeLogForwardingData(data: LogForwardingJobData): LogForwardingJobData {
  return {
    orgId: data.orgId,
    deviceId: data.deviceId,
    hostname: truncateLogString(data.hostname, MAX_LOG_FORWARDING_HOSTNAME),
    events: data.events.slice(0, MAX_LOG_FORWARDING_EVENTS).map((event) => ({
      category: truncateLogString(event.category, MAX_LOG_FORWARDING_FIELD),
      level: truncateLogString(event.level, MAX_LOG_FORWARDING_FIELD),
      source: truncateLogString(event.source, MAX_LOG_FORWARDING_FIELD),
      message: truncateLogString(event.message, MAX_LOG_FORWARDING_MESSAGE),
      timestamp: event.timestamp,
      rawData: sanitizeRawData(event.rawData),
    })),
  };
}

export function getLogForwardingQueue(): Queue<LogForwardingJobData> {
  if (!queue) {
    queue = new Queue<LogForwardingJobData>(QUEUE_NAME, {
      connection: getBullMQConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
      },
    });
  }
  return queue;
}

export async function enqueueLogForwarding(data: LogForwardingJobData): Promise<void> {
  const q = getLogForwardingQueue();
  const sanitized = sanitizeLogForwardingData(data);
  if (sanitized.events.length === 0) {
    return;
  }

  // Backpressure: skip if queue is overwhelmed
  const waiting = await q.getWaitingCount();
  if (waiting > 10000) {
    console.warn(`[logForwarding] Queue depth ${waiting} exceeds 10k, skipping enqueue for org ${sanitized.orgId}`);
    return;
  }

  await q.add('forward-events', sanitized, {
    jobId: `fwd-${sanitized.deviceId}-${Date.now()}`,
  });
}

export async function initializeLogForwardingWorker(): Promise<void> {
  worker = new Worker<LogForwardingJobData>(
    QUEUE_NAME,
    async (job: Job<LogForwardingJobData>) => {
      const { orgId, deviceId, hostname, events } = job.data;

      const docs = events.map((e) => ({
        deviceId,
        orgId,
        hostname,
        category: e.category,
        level: e.level,
        source: e.source,
        message: e.message,
        timestamp: e.timestamp,
        rawData: e.rawData,
      }));

      const result = await bulkIndexEvents(orgId, docs);
      return result;
    },
    {
      connection: getBullMQConnection(),
      concurrency: 5,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );

  worker.on('error', (error) => {
    console.error('[logForwarding] Worker error:', error);
  });

  worker.on('failed', (job, err) => {
    console.error(`[logForwarding] Job ${job?.id} failed:`, err.message);
  });

  console.log('[logForwarding] Worker started');
}

export async function shutdownLogForwardingWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  clearClientCache();
}
