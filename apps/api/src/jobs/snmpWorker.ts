/**
 * SNMP Worker
 *
 * BullMQ worker that dispatches SNMP poll commands to agents
 * and processes metric results when they come back via WebSocket.
 */

import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import { snmpDevices, snmpMetrics, snmpTemplates, devices } from '../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { getRedisConnection } from '../services/redis';
import { sendCommandToAgent, isAgentConnected, type AgentCommand } from '../routes/agentWs';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const SNMP_QUEUE = 'snmp';

let snmpQueue: Queue | null = null;

export function getSnmpQueue(): Queue {
  if (!snmpQueue) {
    snmpQueue = new Queue(SNMP_QUEUE, {
      connection: getRedisConnection()
    });
  }
  return snmpQueue;
}

// Job data types

interface PollDeviceJobData {
  type: 'poll-device';
  deviceId: string;
  orgId: string;
}

export interface SnmpMetricResult {
  oid: string;
  name: string;
  value: unknown;
  timestamp: string;
}

interface ProcessPollResultsJobData {
  type: 'process-poll-results';
  deviceId: string;
  metrics: SnmpMetricResult[];
}

interface PollSchedulerJobData {
  type: 'poll-scheduler';
}

type SnmpJobData = PollDeviceJobData | ProcessPollResultsJobData | PollSchedulerJobData;

function createSnmpWorker(): Worker<SnmpJobData> {
  return new Worker<SnmpJobData>(
    SNMP_QUEUE,
    async (job: Job<SnmpJobData>) => {
      return runWithSystemDbAccess(async () => {
        switch (job.data.type) {
          case 'poll-scheduler':
            return await processScheduler();
          case 'poll-device':
            return await processPollDevice(job.data);
          case 'process-poll-results':
            return await processPollResults(job.data);
          default:
            throw new Error(`Unknown job type: ${(job.data as { type: string }).type}`);
        }
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 10
    }
  );
}

/**
 * Dispatch an SNMP poll command to an agent
 */
async function processPollDevice(data: PollDeviceJobData): Promise<{
  dispatched: boolean;
  agentId: string | null;
}> {
  // Load the device config
  const [device] = await db
    .select()
    .from(snmpDevices)
    .where(eq(snmpDevices.id, data.deviceId))
    .limit(1);

  if (!device) {
    console.error(`[SnmpWorker] Device ${data.deviceId} not found`);
    return { dispatched: false, agentId: null };
  }

  // Load template OIDs if device has a template
  let oids: string[] = [];
  if (device.templateId) {
    const [template] = await db
      .select({ oids: snmpTemplates.oids })
      .from(snmpTemplates)
      .where(eq(snmpTemplates.id, device.templateId))
      .limit(1);

    if (template && Array.isArray(template.oids)) {
      oids = (template.oids as Array<{ oid: string }>).map((o) => o.oid);
    }
  }

  if (oids.length === 0) {
    console.warn(`[SnmpWorker] No OIDs configured for device ${data.deviceId}`);
    return { dispatched: false, agentId: null };
  }

  // Find an online agent for this org
  const [onlineAgent] = await db
    .select({ agentId: devices.agentId })
    .from(devices)
    .where(
      and(
        eq(devices.orgId, data.orgId),
        eq(devices.status, 'online')
      )
    )
    .limit(1);

  const agentId = onlineAgent?.agentId ?? null;

  if (!agentId || !isAgentConnected(agentId)) {
    console.warn(`[SnmpWorker] No online agent for org ${data.orgId}`);
    return { dispatched: false, agentId: null };
  }

  // Build and send the command payload
  const command = buildSnmpPollCommand(data.deviceId, device, oids);

  const sent = sendCommandToAgent(agentId, command);
  if (!sent) {
    console.error(`[SnmpWorker] Failed to send poll command to agent ${agentId}`);
    return { dispatched: false, agentId };
  }

  console.log(`[SnmpWorker] Poll dispatched to agent ${agentId} for device ${data.deviceId}`);
  return { dispatched: true, agentId };
}

/**
 * Process SNMP poll results — write metrics to DB
 */
async function processPollResults(data: ProcessPollResultsJobData): Promise<{
  metricsWritten: number;
}> {
  const now = new Date();

  const rows = data.metrics.map((metric) => ({
    deviceId: data.deviceId,
    oid: metric.oid,
    name: metric.name || metric.oid,
    value: metric.value != null ? String(metric.value) : null,
    valueType: resolveValueType(metric.value),
    timestamp: metric.timestamp ? new Date(metric.timestamp) : now
  }));

  if (rows.length > 0) {
    await db.insert(snmpMetrics).values(rows);
  }

  // Update device lastPolled and status
  await db
    .update(snmpDevices)
    .set({
      lastPolled: now,
      lastStatus: 'online'
    })
    .where(eq(snmpDevices.id, data.deviceId));

  console.log(`[SnmpWorker] Wrote ${rows.length} metrics for device ${data.deviceId}`);
  return { metricsWritten: rows.length };
}

function resolveValueType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return 'object';
}

/**
 * Build an SNMP poll command payload from device config and OIDs.
 * Shared between the worker poll flow and the test endpoint in routes.
 */
export function buildSnmpPollCommand(
  deviceId: string,
  device: {
    ipAddress: string;
    port: number | null;
    snmpVersion: string | null;
    community: string | null;
    username: string | null;
    authProtocol: string | null;
    authPassword: string | null;
    privProtocol: string | null;
    privPassword: string | null;
  },
  oids: string[],
  idPrefix = 'snmp'
): AgentCommand {
  return {
    id: `${idPrefix}-${deviceId}-${Date.now()}`,
    type: 'snmp_poll',
    payload: {
      deviceId,
      target: device.ipAddress,
      port: device.port ?? 161,
      version: device.snmpVersion ?? 'v2c',
      community: device.community ?? 'public',
      username: device.username ?? '',
      authProtocol: device.authProtocol ?? '',
      authPassword: device.authPassword ?? '',
      privProtocol: device.privProtocol ?? '',
      privPassword: device.privPassword ?? '',
      oids
    }
  };
}

/**
 * Enqueue a single device poll
 */
export async function enqueueSnmpPoll(
  deviceId: string,
  orgId: string
): Promise<string> {
  const queue = getSnmpQueue();
  const job = await queue.add(
    'poll-device',
    {
      type: 'poll-device',
      deviceId,
      orgId
    },
    {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 }
    }
  );
  return job.id!;
}

/**
 * Enqueue processing of poll results
 */
export async function enqueueSnmpPollResults(
  deviceId: string,
  metrics: SnmpMetricResult[]
): Promise<string> {
  const queue = getSnmpQueue();
  const job = await queue.add(
    'process-poll-results',
    {
      type: 'process-poll-results',
      deviceId,
      metrics
    },
    {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 }
    }
  );
  return job.id!;
}

/**
 * Schedule repeatable polling jobs for all active SNMP devices.
 *
 * Runs a "poll-scheduler" job every 60 seconds. That job scans
 * `snmp_devices` for rows whose `pollingInterval` has elapsed since
 * `lastPolled` (or that have never been polled) and enqueues individual
 * `poll-device` jobs for each.
 */
async function scheduleSnmpPolling(): Promise<void> {
  const queue = getSnmpQueue();

  // Remove any existing repeatable scheduler jobs
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === 'poll-scheduler') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  // Run the scheduler every 60 seconds
  await queue.add(
    'poll-scheduler',
    { type: 'poll-scheduler' as const },
    {
      repeat: {
        every: 60 * 1000
      },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 20 }
    }
  );

  console.log('[SnmpWorker] Scheduled repeatable SNMP poll scheduler (every 60s)');
}

/**
 * The scheduler job: find all active SNMP devices due for polling
 * and enqueue individual poll-device jobs for each.
 */
async function processScheduler(): Promise<{ enqueued: number }> {
  const now = new Date();

  // Find all active devices that are due for polling:
  //   lastPolled IS NULL  OR  lastPolled + pollingInterval <= now
  const dueDevices = await db
    .select({
      id: snmpDevices.id,
      orgId: snmpDevices.orgId,
      pollingInterval: snmpDevices.pollingInterval,
      lastPolled: snmpDevices.lastPolled
    })
    .from(snmpDevices)
    .where(
      and(
        eq(snmpDevices.isActive, true),
        sql`(${snmpDevices.lastPolled} IS NULL OR ${snmpDevices.lastPolled} + make_interval(secs => ${snmpDevices.pollingInterval}) <= ${now.toISOString()})`
      )
    );

  if (dueDevices.length === 0) return { enqueued: 0 };

  let enqueued = 0;
  for (const device of dueDevices) {
    try {
      await enqueueSnmpPoll(device.id, device.orgId);
      enqueued++;
    } catch (err) {
      console.error(`[SnmpWorker] Failed to enqueue poll for device ${device.id}:`, err);
    }
  }

  if (enqueued > 0) {
    console.log(`[SnmpWorker] Scheduler enqueued ${enqueued} device polls`);
  }
  return { enqueued };
}

// Worker instance
let snmpWorkerInstance: Worker<SnmpJobData> | null = null;

export async function initializeSnmpWorker(): Promise<void> {
  try {
    snmpWorkerInstance = createSnmpWorker();

    snmpWorkerInstance.on('error', (error) => {
      console.error('[SnmpWorker] Worker error:', error);
    });

    snmpWorkerInstance.on('failed', (job, error) => {
      console.error(`[SnmpWorker] Job ${job?.id} failed:`, error);
    });

    // Schedule the repeatable polling scheduler
    await scheduleSnmpPolling();

    console.log('[SnmpWorker] SNMP worker initialized');
  } catch (error) {
    console.error('[SnmpWorker] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownSnmpWorker(): Promise<void> {
  if (snmpWorkerInstance) {
    await snmpWorkerInstance.close();
    snmpWorkerInstance = null;
  }
  if (snmpQueue) {
    await snmpQueue.close();
    snmpQueue = null;
  }
  console.log('[SnmpWorker] SNMP worker shut down');
}
