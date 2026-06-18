import { Job, Queue, Worker } from 'bullmq';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../db';
import { alertCorrelations, alerts } from '../db/schema';
import { persistAlertCorrelationGroupsForAlerts } from '../services/alertCorrelationGroups';
import { isReusableState } from '../services/bullmqUtils';
import { shouldProduceMlOutput } from '../services/mlFeatureFlags';
import { getBullMQConnection } from '../services/redis';

const ALERT_CORRELATION_QUEUE = 'alert-correlation';
const DEDUPE_WINDOW_MS = 30 * 1000;
const DEFAULT_DELAY_MS = 5 * 1000;
const DEFAULT_WINDOW_MINUTES = 30;
const MAX_ALERTS_PER_DEVICE_PASS = 50;

export type AlertCorrelationJobData = {
  orgId: string;
  deviceId: string;
  queuedAt: string;
  windowMinutes?: number;
};

let alertCorrelationQueue: Queue<AlertCorrelationJobData> | null = null;
let alertCorrelationWorker: Worker<AlertCorrelationJobData> | null = null;

export function getAlertCorrelationQueue(): Queue<AlertCorrelationJobData> {
  if (!alertCorrelationQueue) {
    alertCorrelationQueue = new Queue<AlertCorrelationJobData>(ALERT_CORRELATION_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return alertCorrelationQueue;
}

export function buildAlertCorrelationJobId(orgId: string, deviceId: string, now = Date.now()): string {
  const slot = Math.floor(now / DEDUPE_WINDOW_MS).toString(36);
  return ['alert-correlation', orgId, deviceId, slot].join('-');
}

export async function enqueueAlertCorrelation(options: {
  orgId: string;
  deviceId: string;
  windowMinutes?: number;
}): Promise<string> {
  const queue = getAlertCorrelationQueue();
  const jobId = buildAlertCorrelationJobId(options.orgId, options.deviceId);

  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      return String(existing.id);
    }
    await existing.remove().catch((error) => {
      console.error(`[AlertCorrelationWorker] Failed to remove stale job ${jobId}:`, error);
    });
  }

  const job = await queue.add(
    'correlate-device-alerts',
    {
      orgId: options.orgId,
      deviceId: options.deviceId,
      windowMinutes: options.windowMinutes,
      queuedAt: new Date().toISOString(),
    },
    {
      jobId,
      delay: DEFAULT_DELAY_MS,
      removeOnComplete: true,
      removeOnFail: { count: 50 },
    }
  );

  return String(job.id);
}

export async function runAlertCorrelationForDevice(options: {
  orgId: string;
  deviceId: string;
  windowMinutes?: number;
}): Promise<{ scanned: number; created: number }> {
  if (!(await shouldProduceMlOutput(options.orgId, 'ml.alert_correlation.enabled'))) {
    return { scanned: 0, created: 0 };
  }

  const windowMinutes = options.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);

  const recentAlerts = await db
    .select({ id: alerts.id, triggeredAt: alerts.triggeredAt })
    .from(alerts)
    .where(
      and(
        eq(alerts.deviceId, options.deviceId),
        eq(alerts.orgId, options.orgId),
        gte(alerts.triggeredAt, windowStart),
        inArray(alerts.status, ['active', 'acknowledged'])
      )
    )
    .orderBy(desc(alerts.triggeredAt))
    .limit(MAX_ALERTS_PER_DEVICE_PASS);

  if (recentAlerts.length < 2) {
    return { scanned: recentAlerts.length, created: 0 };
  }

  const alertIds = recentAlerts.map((alert) => alert.id);
  const existingLinks = await db
    .select({
      parentAlertId: alertCorrelations.parentAlertId,
      childAlertId: alertCorrelations.childAlertId,
    })
    .from(alertCorrelations)
    .where(
      and(
        inArray(alertCorrelations.parentAlertId, alertIds),
        inArray(alertCorrelations.childAlertId, alertIds)
      )
    );

  const linkedPairs = new Set(
    existingLinks.map((link) => [link.parentAlertId, link.childAlertId].sort().join('|'))
  );

  let created = 0;
  const maxWindowMs = windowMinutes * 60 * 1000;
  for (let i = 0; i < recentAlerts.length; i += 1) {
    for (let j = i + 1; j < recentAlerts.length; j += 1) {
      const newer = recentAlerts[i]!;
      const older = recentAlerts[j]!;
      const pairKey = [newer.id, older.id].sort().join('|');
      if (linkedPairs.has(pairKey)) continue;

      const timeDiffMs = Math.abs(newer.triggeredAt.getTime() - older.triggeredAt.getTime());
      const confidence = Math.round((1 - timeDiffMs / maxWindowMs) * 100) / 100;
      if (confidence < 0.3) continue;

      await db
        .insert(alertCorrelations)
        .values({
          parentAlertId: older.id,
          childAlertId: newer.id,
          correlationType: 'same_device_temporal',
          confidence: String(confidence),
          metadata: {
            timeDiffMinutes: Math.round(timeDiffMs / 60000),
            deviceId: options.deviceId,
          },
        });

      linkedPairs.add(pairKey);
      created += 1;
    }
  }

  await persistAlertCorrelationGroupsForAlerts({
    orgId: options.orgId,
    alertIds,
  });

  return { scanned: recentAlerts.length, created };
}

export function createAlertCorrelationWorker(): Worker<AlertCorrelationJobData> {
  return new Worker<AlertCorrelationJobData>(
    ALERT_CORRELATION_QUEUE,
    async (job: Job<AlertCorrelationJobData>) =>
      withSystemDbAccessContext(() => runAlertCorrelationForDevice(job.data)),
    {
      connection: getBullMQConnection(),
      concurrency: 2,
    }
  );
}

export async function initializeAlertCorrelationWorker(): Promise<void> {
  alertCorrelationWorker = createAlertCorrelationWorker();
  alertCorrelationWorker.on('error', (error) => {
    console.error('[AlertCorrelationWorker] Worker error:', error);
  });
  alertCorrelationWorker.on('failed', (job, error) => {
    console.error(`[AlertCorrelationWorker] Job ${job?.id} failed:`, error);
  });
}

export async function shutdownAlertCorrelationWorker(): Promise<void> {
  if (alertCorrelationWorker) {
    await alertCorrelationWorker.close();
    alertCorrelationWorker = null;
  }
  if (alertCorrelationQueue) {
    await alertCorrelationQueue.close();
    alertCorrelationQueue = null;
  }
}
