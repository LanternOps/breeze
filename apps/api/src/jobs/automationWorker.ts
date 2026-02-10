/**
 * Automation Worker
 *
 * Handles:
 * - schedule trigger scans
 * - event trigger dispatch
 * - execution of automation runs
 */

import { Job, Queue, Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import * as dbModule from '../db';
import { automations } from '../db/schema';
import { type BreezeEvent, getEventBus } from '../services/eventBus';
import {
  type AutomationTrigger,
  createAutomationRunRecord,
  executeAutomationRun,
  formatScheduleTriggerKey,
  isCronDue,
  normalizeAutomationTrigger,
} from '../services/automationRuntime';
import { getRedisConnection, isRedisAvailable } from '../services/redis';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const AUTOMATION_QUEUE = 'automations';
const SCHEDULE_SCAN_INTERVAL_MS = 60 * 1000;

interface ScanSchedulesJobData {
  type: 'scan-schedules';
  scanAt: string;
}

interface TriggerScheduleJobData {
  type: 'trigger-schedule';
  automationId: string;
  slotKey: string;
  scanAt: string;
}

interface TriggerEventJobData {
  type: 'trigger-event';
  automationId: string;
  eventType: string;
  eventId?: string;
  eventPayload?: Record<string, unknown>;
  eventTimestamp: string;
}

interface ExecuteRunJobData {
  type: 'execute-run';
  runId: string;
  targetDeviceIds?: string[];
}

type AutomationJobData =
  | ScanSchedulesJobData
  | TriggerScheduleJobData
  | TriggerEventJobData
  | ExecuteRunJobData;

let automationQueue: Queue<AutomationJobData> | null = null;
let automationWorker: Worker<AutomationJobData> | null = null;
let eventSubscription: (() => void) | null = null;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePayload(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {};
}

function getNestedValue(payload: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.').filter(Boolean);
  if (segments.length === 0) return undefined;

  let cursor: unknown = payload;
  for (const segment of segments) {
    if (!isPlainRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }

  return cursor;
}

function valuesEqual(expected: unknown, actual: unknown): boolean {
  if (typeof expected === 'string') {
    return String(actual ?? '') === expected;
  }

  if (typeof expected === 'number' || typeof expected === 'boolean') {
    return expected === actual;
  }

  if (Array.isArray(expected)) {
    if (Array.isArray(actual)) {
      return expected.every((item) => actual.includes(item));
    }
    return expected.includes(actual);
  }

  if (isPlainRecord(expected) && isPlainRecord(actual)) {
    return Object.entries(expected).every(([key, value]) => valuesEqual(value, actual[key]));
  }

  return expected === actual;
}

function matchesEventFilter(filter: Record<string, unknown> | undefined, payload: Record<string, unknown>): boolean {
  if (!filter) return true;

  for (const [key, expected] of Object.entries(filter)) {
    const actual = getNestedValue(payload, key);
    if (!valuesEqual(expected, actual)) {
      return false;
    }
  }

  return true;
}

export function shouldTriggerScheduleAutomation(trigger: Extract<AutomationTrigger, { type: 'schedule' }>, scanDate: Date): boolean {
  return isCronDue(trigger.cronExpression, trigger.timezone, scanDate);
}

export function shouldTriggerEventAutomation(
  trigger: Extract<AutomationTrigger, { type: 'event' }>,
  eventType: string,
  payload: Record<string, unknown>,
): boolean {
  return trigger.eventType === eventType && matchesEventFilter(trigger.filter, payload);
}

export function getAutomationQueue(): Queue<AutomationJobData> {
  if (!automationQueue) {
    automationQueue = new Queue<AutomationJobData>(AUTOMATION_QUEUE, {
      connection: getRedisConnection(),
    });
  }

  return automationQueue;
}

async function executeRunInline(runId: string, targetDeviceIds?: string[]): Promise<void> {
  await runWithSystemDbAccess(async () => {
    await executeAutomationRun(runId, targetDeviceIds);
  });
}

export async function enqueueAutomationRun(
  runId: string,
  targetDeviceIds?: string[],
): Promise<{ enqueued: boolean; jobId?: string }> {
  if (!isRedisAvailable()) {
    setImmediate(() => {
      executeRunInline(runId, targetDeviceIds).catch((error) => {
        console.error(`[AutomationWorker] Inline run execution failed for ${runId}:`, error);
      });
    });

    return { enqueued: false };
  }

  try {
    const queue = getAutomationQueue();
    const job = await queue.add(
      'execute-run',
      {
        type: 'execute-run',
        runId,
        targetDeviceIds,
      },
      {
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    );

    return {
      enqueued: true,
      jobId: job.id ? String(job.id) : undefined,
    };
  } catch (error) {
    console.error(`[AutomationWorker] Failed to enqueue run ${runId}, using inline fallback:`, error);

    setImmediate(() => {
      executeRunInline(runId, targetDeviceIds).catch((err) => {
        console.error(`[AutomationWorker] Inline fallback failed for ${runId}:`, err);
      });
    });

    return { enqueued: false };
  }
}

async function processScanSchedules(_scanAt: string): Promise<{ due: number }> {
  const scanDate = new Date();

  const queue = getAutomationQueue();
  const slotKey = formatScheduleTriggerKey(scanDate);

  const candidates = await db
    .select()
    .from(automations)
    .where(eq(automations.enabled, true));

  let due = 0;

  for (const automation of candidates) {
    let trigger;
    try {
      trigger = normalizeAutomationTrigger(automation.trigger);
    } catch {
      continue;
    }

    if (trigger.type !== 'schedule') {
      continue;
    }

    if (!shouldTriggerScheduleAutomation(trigger, scanDate)) {
      continue;
    }

    due += 1;

    await queue.add(
      'trigger-schedule',
      {
        type: 'trigger-schedule',
        automationId: automation.id,
        slotKey,
        scanAt: scanDate.toISOString(),
      },
      {
        jobId: `automation:schedule:${automation.id}:${slotKey}`,
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    );
  }

  return { due };
}

async function processTriggerSchedule(data: TriggerScheduleJobData): Promise<{ runId?: string; skipped?: string }> {
  const [automation] = await db
    .select()
    .from(automations)
    .where(and(eq(automations.id, data.automationId), eq(automations.enabled, true)))
    .limit(1);

  if (!automation) {
    return { skipped: 'automation_not_found_or_disabled' };
  }

  let trigger;
  try {
    trigger = normalizeAutomationTrigger(automation.trigger);
  } catch {
    return { skipped: 'invalid_trigger' };
  }

  if (trigger.type !== 'schedule') {
    return { skipped: 'not_schedule_trigger' };
  }

  const scanDate = new Date(data.scanAt);
  if (!shouldTriggerScheduleAutomation(trigger, scanDate)) {
    return { skipped: 'not_due' };
  }

  const { run, targetDeviceIds } = await createAutomationRunRecord({
    automation,
    triggeredBy: `schedule:${data.slotKey}`,
    details: {
      slotKey: data.slotKey,
      scanAt: data.scanAt,
    },
  });

  await enqueueAutomationRun(run.id, targetDeviceIds);

  return { runId: run.id };
}

async function processTriggerEvent(data: TriggerEventJobData): Promise<{ runId?: string; skipped?: string }> {
  const [automation] = await db
    .select()
    .from(automations)
    .where(and(eq(automations.id, data.automationId), eq(automations.enabled, true)))
    .limit(1);

  if (!automation) {
    return { skipped: 'automation_not_found_or_disabled' };
  }

  let trigger;
  try {
    trigger = normalizeAutomationTrigger(automation.trigger);
  } catch {
    return { skipped: 'invalid_trigger' };
  }

  if (trigger.type !== 'event') {
    return { skipped: 'event_mismatch' };
  }

  const payload = normalizePayload(data.eventPayload);
  if (!shouldTriggerEventAutomation(trigger, data.eventType, payload)) {
    return { skipped: 'filter_mismatch' };
  }

  const { run, targetDeviceIds } = await createAutomationRunRecord({
    automation,
    triggeredBy: `event:${data.eventType}`,
    details: {
      eventId: data.eventId,
      eventType: data.eventType,
      eventTimestamp: data.eventTimestamp,
    },
  });

  await enqueueAutomationRun(run.id, targetDeviceIds);

  return { runId: run.id };
}

async function processExecuteRun(data: ExecuteRunJobData): Promise<{ runId: string }> {
  await executeAutomationRun(data.runId, data.targetDeviceIds);
  return { runId: data.runId };
}

function createAutomationWorker(): Worker<AutomationJobData> {
  return new Worker<AutomationJobData>(
    AUTOMATION_QUEUE,
    async (job: Job<AutomationJobData>) => {
      return runWithSystemDbAccess(async () => {
        switch (job.data.type) {
          case 'scan-schedules':
            return processScanSchedules(job.data.scanAt);
          case 'trigger-schedule':
            return processTriggerSchedule(job.data);
          case 'trigger-event':
            return processTriggerEvent(job.data);
          case 'execute-run':
            return processExecuteRun(job.data);
          default:
            throw new Error(`Unknown automation job type: ${(job.data as { type: string }).type}`);
        }
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 10,
    },
  );
}

async function scheduleAutomationScans(): Promise<void> {
  const queue = getAutomationQueue();
  const existingJobs = await queue.getRepeatableJobs();

  for (const job of existingJobs) {
    if (job.name === 'scan-schedules') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'scan-schedules',
    {
      type: 'scan-schedules',
      scanAt: new Date().toISOString(),
    },
    {
      repeat: { every: SCHEDULE_SCAN_INTERVAL_MS },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );
}

async function queueEventTriggers(event: BreezeEvent<Record<string, unknown>>): Promise<void> {
  const queue = getAutomationQueue();

  const candidates = await db
    .select()
    .from(automations)
    .where(and(eq(automations.orgId, event.orgId), eq(automations.enabled, true)));

  const payload = normalizePayload(event.payload);

  for (const automation of candidates) {
    let trigger;
    try {
      trigger = normalizeAutomationTrigger(automation.trigger);
    } catch {
      continue;
    }

    if (trigger.type !== 'event') {
      continue;
    }

    if (!shouldTriggerEventAutomation(trigger, event.type, payload)) {
      continue;
    }

    await queue.add(
      'trigger-event',
      {
        type: 'trigger-event',
        automationId: automation.id,
        eventType: event.type,
        eventId: event.id,
        eventPayload: payload,
        eventTimestamp: event.metadata.timestamp,
      },
      {
        jobId: `automation:event:${automation.id}:${event.id}`,
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    );
  }
}

function subscribeToAutomationEvents(): void {
  if (eventSubscription) {
    return;
  }

  const eventBus = getEventBus();
  eventSubscription = eventBus.subscribe('*', async (event) => {
    try {
      if (!isRedisAvailable()) {
        return;
      }

      await runWithSystemDbAccess(async () => {
        await queueEventTriggers(event as BreezeEvent<Record<string, unknown>>);
      });
    } catch (error) {
      console.error('[AutomationWorker] Failed handling event trigger dispatch:', error);
    }
  });
}

export async function initializeAutomationWorker(): Promise<void> {
  automationWorker = createAutomationWorker();

  automationWorker.on('error', (error) => {
    console.error('[AutomationWorker] Worker error:', error);
  });

  automationWorker.on('failed', (job, error) => {
    console.error(`[AutomationWorker] Job ${job?.id} failed:`, error);
  });

  await scheduleAutomationScans();
  subscribeToAutomationEvents();

  console.log('[AutomationWorker] Automation worker initialized');
}

export async function shutdownAutomationWorker(): Promise<void> {
  if (eventSubscription) {
    eventSubscription();
    eventSubscription = null;
  }

  if (automationWorker) {
    await automationWorker.close();
    automationWorker = null;
  }

  if (automationQueue) {
    await automationQueue.close();
    automationQueue = null;
  }

  console.log('[AutomationWorker] Automation worker shut down');
}
