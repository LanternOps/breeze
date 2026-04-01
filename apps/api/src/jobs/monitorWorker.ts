/**
 * Network Monitor Worker
 *
 * BullMQ worker that dispatches network check commands to agents
 * and processes results when they come back via WebSocket.
 */

import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import { networkMonitors, networkMonitorResults, devices, networkMonitorAlertRules, alerts, discoveredAssets } from '../db/schema';
import { eq, and, sql, desc, inArray } from 'drizzle-orm';
import { getRedisConnection } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';
import { sendCommandToAgent, isAgentConnected } from '../routes/agentWs';
import { buildMonitorCommand } from '../routes/monitors';
import { isCooldownActive, setCooldown } from '../services/alertCooldown';
import { resolveAlert } from '../services/alertService';
import { assertQueueJobName, parseQueueJobData } from '../services/bullmqValidation';
import {
  monitorQueueJobDataSchema,
  type MonitorQueueJobData,
  type QueueActorMeta,
  withQueueMeta,
} from './queueSchemas';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const MONITOR_QUEUE = 'monitors';

let monitorQueue: Queue | null = null;

export function getMonitorQueue(): Queue {
  if (!monitorQueue) {
    monitorQueue = new Queue(MONITOR_QUEUE, {
      connection: getRedisConnection()
    });
  }
  return monitorQueue;
}

// Job data types

interface CheckMonitorJobData {
  type: 'check-monitor';
  monitorId: string;
  orgId: string;
}

export interface MonitorCheckResult {
  monitorId: string;
  checkId?: string;
  status: 'online' | 'offline' | 'degraded';
  responseMs: number;
  statusCode?: number;
  error?: string;
  details?: Record<string, unknown>;
}

interface ProcessCheckResultJobData {
  type: 'process-check-result';
  monitorId: string;
  result: MonitorCheckResult;
}

interface MonitorSchedulerJobData {
  type: 'monitor-scheduler';
}

type MonitorJobData = MonitorQueueJobData;

const MONITOR_ALERT_COOLDOWN_MINUTES = 5;
const PRIVILEGED_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 1_000,
  },
};

const MONITOR_DISPATCH_META: QueueActorMeta = {
  actorType: 'system',
  actorId: null,
  source: 'worker:monitor:check-monitor',
};

const MONITOR_RESULT_META: QueueActorMeta = {
  actorType: 'agent',
  actorId: null,
  source: 'route:agentWs:monitor-result',
};

const MONITOR_REPEATABLE_META: QueueActorMeta = {
  actorType: 'system',
  actorId: null,
  source: 'worker:monitor:scheduler',
};

function createMonitorWorker(): Worker<MonitorJobData> {
  return new Worker<MonitorJobData>(
    MONITOR_QUEUE,
    async (job: Job<MonitorJobData>) => {
      return runWithSystemDbAccess(async () => {
        const data = parseQueueJobData(MONITOR_QUEUE, job, monitorQueueJobDataSchema);
        switch (data.type) {
          case 'monitor-scheduler':
            assertQueueJobName(MONITOR_QUEUE, job, 'monitor-scheduler');
            return await processScheduler();
          case 'check-monitor':
            assertQueueJobName(MONITOR_QUEUE, job, 'check-monitor');
            return await processCheckMonitor(data);
          case 'process-check-result':
            assertQueueJobName(MONITOR_QUEUE, job, 'process-check-result');
            return await processCheckResult(data);
          default:
            throw new Error(`Unknown job type: ${(data as { type: string }).type}`);
        }
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 10,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    }
  );
}

async function processCheckMonitor(data: CheckMonitorJobData): Promise<{
  dispatched: boolean;
  agentId: string | null;
}> {
  const [monitor] = await db
    .select()
    .from(networkMonitors)
    .where(eq(networkMonitors.id, data.monitorId))
    .limit(1);

  if (!monitor) {
    console.error(`[MonitorWorker] Monitor ${data.monitorId} not found`);
    return { dispatched: false, agentId: null };
  }

  if (!monitor.isActive) {
    console.log(`[MonitorWorker] Monitor ${data.monitorId} is inactive, skipping check`);
    return { dispatched: false, agentId: null };
  }

  const agentId = await selectExecutionAgentForMonitor(monitor);

  if (!agentId || !isAgentConnected(agentId)) {
    console.warn(`[MonitorWorker] No online agent for org ${data.orgId}`);
    return { dispatched: false, agentId: null };
  }

  const command = buildMonitorCommand(monitor);
  const sent = sendCommandToAgent(agentId, command);

  if (!sent) {
    console.error(`[MonitorWorker] Failed to send check command to agent ${agentId}`);
    return { dispatched: false, agentId };
  }

  console.log(`[MonitorWorker] Check dispatched to agent ${agentId} for monitor ${data.monitorId}`);
  return { dispatched: true, agentId };
}

function parseNumericThreshold(threshold: string | null | undefined): number | null {
  if (typeof threshold !== 'string' || threshold.trim().length === 0) return null;
  const parsed = Number(threshold);
  return Number.isFinite(parsed) ? parsed : null;
}

async function selectExecutionAgentForMonitor(
  monitor: {
    orgId: string;
    assetId: string | null;
  }
): Promise<string | null> {
  let assetSiteId: string | null = null;

  if (monitor.assetId) {
    const [asset] = await db
      .select({ siteId: discoveredAssets.siteId })
      .from(discoveredAssets)
      .where(and(eq(discoveredAssets.id, monitor.assetId), eq(discoveredAssets.orgId, monitor.orgId)))
      .limit(1);
    assetSiteId = asset?.siteId ?? null;
  }

  if (assetSiteId) {
    const [siteAgent] = await db
      .select({ agentId: devices.agentId })
      .from(devices)
      .where(and(
        eq(devices.orgId, monitor.orgId),
        eq(devices.siteId, assetSiteId),
        eq(devices.status, 'online')
      ))
      .limit(1);

    if (siteAgent?.agentId) {
      return siteAgent.agentId;
    }
  }

  const [onlineAgent] = await db
    .select({ agentId: devices.agentId })
    .from(devices)
    .where(and(eq(devices.orgId, monitor.orgId), eq(devices.status, 'online')))
    .limit(1);

  return onlineAgent?.agentId ?? null;
}

async function resolveMonitorAlertDevice(
  monitor: {
    orgId: string;
    assetId: string | null;
  }
): Promise<string | null> {
  let preferredSiteId: string | null = null;

  if (monitor.assetId) {
    const [asset] = await db
      .select({
        linkedDeviceId: discoveredAssets.linkedDeviceId,
        siteId: discoveredAssets.siteId
      })
      .from(discoveredAssets)
      .where(and(eq(discoveredAssets.id, monitor.assetId), eq(discoveredAssets.orgId, monitor.orgId)))
      .limit(1);

    if (asset?.linkedDeviceId) {
      return asset.linkedDeviceId;
    }

    preferredSiteId = asset?.siteId ?? null;
  }

  if (preferredSiteId) {
    const [siteDevice] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.orgId, monitor.orgId), eq(devices.siteId, preferredSiteId)))
      .orderBy(desc(devices.lastSeenAt), desc(devices.enrolledAt))
      .limit(1);

    if (siteDevice?.id) {
      return siteDevice.id;
    }
  }

  const [orgDevice] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(eq(devices.orgId, monitor.orgId))
    .orderBy(desc(devices.lastSeenAt), desc(devices.enrolledAt))
    .limit(1);

  return orgDevice?.id ?? null;
}

function getMonitorAlertConditionState(
  rule: typeof networkMonitorAlertRules.$inferSelect,
  result: MonitorCheckResult,
  monitor: { consecutiveFailures: number; name: string; target: string; monitorType: string }
): { matched: boolean; detail: string } {
  switch (rule.condition) {
    case 'offline':
      return {
        matched: result.status === 'offline',
        detail: `Monitor ${monitor.name} is offline`
      };
    case 'degraded':
      return {
        matched: result.status === 'degraded',
        detail: `Monitor ${monitor.name} is degraded`
      };
    case 'response_time_gt': {
      const threshold = parseNumericThreshold(rule.threshold);
      return {
        matched: threshold !== null && result.responseMs > threshold,
        detail: `Response time ${result.responseMs}ms exceeded threshold ${threshold ?? 'n/a'}ms`
      };
    }
    case 'consecutive_failures_gt': {
      const threshold = parseNumericThreshold(rule.threshold);
      return {
        matched: threshold !== null && monitor.consecutiveFailures > threshold,
        detail: `Consecutive failures ${monitor.consecutiveFailures} exceeded threshold ${threshold ?? 'n/a'}`
      };
    }
    default:
      return { matched: false, detail: `Unsupported monitor condition ${rule.condition}` };
  }
}

async function evaluateMonitorAlertRules(
  monitor: typeof networkMonitors.$inferSelect,
  result: MonitorCheckResult
): Promise<void> {
  const rules = await db
    .select()
    .from(networkMonitorAlertRules)
    .where(and(
      eq(networkMonitorAlertRules.monitorId, monitor.id),
      eq(networkMonitorAlertRules.isActive, true)
    ));

  if (rules.length === 0) return;

  const alertDeviceId = await resolveMonitorAlertDevice(monitor);
  if (!alertDeviceId) {
    console.warn(`[MonitorWorker] Skipping alert evaluation for monitor ${monitor.id}: no device context available`);
    return;
  }

  for (const rule of rules) {
    const condition = getMonitorAlertConditionState(rule, result, monitor);
    const matchingAlerts = await db
      .select({ id: alerts.id })
      .from(alerts)
      .where(and(
        eq(alerts.orgId, monitor.orgId),
        eq(alerts.deviceId, alertDeviceId),
        inArray(alerts.status, ['active', 'acknowledged']),
        sql`${alerts.context}->>'source' = 'network_monitor'`,
        sql`${alerts.context}->>'monitorId' = ${monitor.id}`,
        sql`${alerts.context}->>'alertRuleId' = ${rule.id}`
      ));

    if (condition.matched && matchingAlerts.length > 0) {
      continue;
    }

    if (!condition.matched) {
      for (const existingAlert of matchingAlerts) {
        await resolveAlert(
          existingAlert.id,
          `Auto-resolved after monitor ${monitor.name} recovered from ${rule.condition}`
        );
      }
      continue;
    }

    if (await isCooldownActive(rule.id, alertDeviceId)) {
      continue;
    }

    const title = `${monitor.name} ${rule.condition.replace(/_/g, ' ')}`;
    const message = rule.message
      ?? `${condition.detail}. Target: ${monitor.target}. Status: ${result.status}.`;

    await db.insert(alerts).values({
      ruleId: null,
      deviceId: alertDeviceId,
      orgId: monitor.orgId,
      status: 'active',
      severity: rule.severity,
      title,
      message,
      context: {
        source: 'network_monitor',
        monitorId: monitor.id,
        alertRuleId: rule.id,
        monitorType: monitor.monitorType,
        target: monitor.target,
        status: result.status,
        responseMs: result.responseMs,
        statusCode: result.statusCode ?? null,
        error: result.error ?? null,
        threshold: rule.threshold ?? null
      },
      triggeredAt: new Date()
    });

    await setCooldown(rule.id, alertDeviceId, MONITOR_ALERT_COOLDOWN_MINUTES);
  }
}

export async function recordMonitorCheckResult(
  monitorId: string,
  result: MonitorCheckResult
): Promise<void> {
  const now = new Date();

  // Use a transaction to keep results table and monitor state in sync
  await db.transaction(async (tx) => {
    // Write to results table
    await tx.insert(networkMonitorResults).values({
      monitorId,
      status: result.status,
      responseMs: result.responseMs ?? null,
      statusCode: result.statusCode ?? null,
      error: result.error ?? null,
      details: result.details ?? null,
      timestamp: now
    });

    // Update monitor state
    const isFailure = result.status === 'offline';
    const updateSet: Record<string, unknown> = {
      lastChecked: now,
      lastStatus: result.status,
      lastResponseMs: result.responseMs ?? null,
      lastError: result.error ?? null,
      updatedAt: now
    };

    if (isFailure) {
      updateSet.consecutiveFailures = sql`${networkMonitors.consecutiveFailures} + 1`;
    } else {
      updateSet.consecutiveFailures = 0;
    }

    await tx
      .update(networkMonitors)
      .set(updateSet)
      .where(eq(networkMonitors.id, monitorId));
  });

  const [monitor] = await db
    .select()
    .from(networkMonitors)
    .where(eq(networkMonitors.id, monitorId))
    .limit(1);

  if (monitor) {
    await evaluateMonitorAlertRules(monitor, result);
  }
}

async function processCheckResult(data: ProcessCheckResultJobData): Promise<{
  resultWritten: boolean;
}> {
  await recordMonitorCheckResult(data.monitorId, data.result);

  console.log(`[MonitorWorker] Result recorded for monitor ${data.monitorId}: ${data.result.status}`);
  return { resultWritten: true };
}

async function processScheduler(): Promise<{ enqueued: number }> {
  const now = new Date();

  const dueMonitors = await db
    .select({
      id: networkMonitors.id,
      orgId: networkMonitors.orgId,
      pollingInterval: networkMonitors.pollingInterval,
      lastChecked: networkMonitors.lastChecked
    })
    .from(networkMonitors)
    .where(
      and(
        eq(networkMonitors.isActive, true),
        sql`(${networkMonitors.lastChecked} IS NULL OR ${networkMonitors.lastChecked} + make_interval(secs => ${networkMonitors.pollingInterval}) <= ${now.toISOString()})`
      )
    );

  if (dueMonitors.length === 0) return { enqueued: 0 };

  let enqueued = 0;
  for (const monitor of dueMonitors) {
    try {
      await enqueueMonitorCheck(monitor.id, monitor.orgId);
      enqueued++;
    } catch (err) {
      console.error(`[MonitorWorker] Failed to enqueue check for monitor ${monitor.id}:`, err);
    }
  }

  if (enqueued > 0) {
    console.log(`[MonitorWorker] Scheduler enqueued ${enqueued} monitor checks`);
  }
  return { enqueued };
}

export async function enqueueMonitorCheck(
  monitorId: string,
  orgId: string,
  meta: QueueActorMeta = MONITOR_DISPATCH_META,
): Promise<string> {
  const queue = getMonitorQueue();
  const stableJobId = `monitor-check-${monitorId}`;
  const existing = await queue.getJob(stableJobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      return existing.id as string;
    }
    if (state === 'completed' || state === 'failed') {
      await existing.remove();
    }
  }

  const job = await queue.add(
    'check-monitor',
    monitorQueueJobDataSchema.parse(withQueueMeta({ type: 'check-monitor', monitorId, orgId }, meta)),
    {
      jobId: stableJobId,
      ...PRIVILEGED_JOB_OPTIONS,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 }
    }
  );
  return job.id!;
}

export async function enqueueMonitorCheckResult(
  monitorId: string,
  result: MonitorCheckResult,
  meta: QueueActorMeta = MONITOR_RESULT_META,
): Promise<string> {
  const queue = getMonitorQueue();
  const stableJobId = result.checkId ? `monitor-result-${result.checkId}` : null;
  if (stableJobId) {
    const existing = await queue.getJob(stableJobId);
    if (existing) {
      const state = await existing.getState();
      if (isReusableState(state)) {
        return existing.id as string;
      }
      if (state === 'completed' || state === 'failed') {
        await existing.remove();
      }
    }
  }
  const job = await queue.add(
    'process-check-result',
    monitorQueueJobDataSchema.parse(
      withQueueMeta({ type: 'process-check-result', monitorId, result }, meta)
    ),
    {
      ...(stableJobId ? { jobId: stableJobId } : {}),
      ...PRIVILEGED_JOB_OPTIONS,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 }
    }
  );
  return job.id!;
}

async function scheduleMonitorPolling(): Promise<void> {
  const queue = getMonitorQueue();

  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === 'monitor-scheduler') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'monitor-scheduler',
    monitorQueueJobDataSchema.parse(
      withQueueMeta({ type: 'monitor-scheduler' as const }, MONITOR_REPEATABLE_META)
    ),
    {
      repeat: { every: 30 * 1000 },
      attempts: 1,
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 20 }
    }
  );

  console.log('[MonitorWorker] Scheduled repeatable monitor scheduler (every 30s)');
}

let monitorWorkerInstance: Worker<MonitorJobData> | null = null;

export async function initializeMonitorWorker(): Promise<void> {
  try {
    monitorWorkerInstance = createMonitorWorker();

    monitorWorkerInstance.on('error', (error) => {
      console.error('[MonitorWorker] Worker error:', error);
    });

    monitorWorkerInstance.on('failed', (job, error) => {
      console.error(`[MonitorWorker] Job ${job?.id} failed:`, error);
    });

    await scheduleMonitorPolling();

    console.log('[MonitorWorker] Monitor worker initialized');
  } catch (error) {
    console.error('[MonitorWorker] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownMonitorWorker(): Promise<void> {
  if (monitorWorkerInstance) {
    await monitorWorkerInstance.close();
    monitorWorkerInstance = null;
  }
  if (monitorQueue) {
    await monitorQueue.close();
    monitorQueue = null;
  }
  console.log('[MonitorWorker] Monitor worker shut down');
}
