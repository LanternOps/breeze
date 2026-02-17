/**
 * Automation Worker
 *
 * Handles:
 * - schedule trigger scans
 * - event trigger dispatch
 * - execution of automation runs
 */

import { Job, Queue, Worker } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import * as dbModule from '../db';
import { automations, configPolicyAutomations, devices, deviceGroupMemberships, organizations } from '../db/schema';
import { type BreezeEvent, getEventBus } from '../services/eventBus';
import {
  type AutomationTrigger,
  createAutomationRunRecord,
  executeAutomationRun,
  executeConfigPolicyAutomationRun,
  formatScheduleTriggerKey,
  isCronDue,
  normalizeAutomationTrigger,
} from '../services/automationRuntime';
import {
  scanScheduledAutomations,
  resolveAutomationsForDevice,
  resolveMaintenanceConfigForDevice,
  isInMaintenanceWindow,
  type ScheduledAutomationWithTarget,
} from '../services/featureConfigResolver';
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

interface ConfigPolicyAssignmentTarget {
  level: string;
  targetId: string;
}

interface TriggerConfigPolicyScheduleJobData {
  type: 'trigger-config-policy-schedule';
  configPolicyAutomationId: string;
  configPolicyAutomationName: string;
  assignmentTargets?: ConfigPolicyAssignmentTarget[];
  // Backward compatibility with already-enqueued jobs from older payloads.
  assignmentLevel?: string;
  assignmentTargetId?: string;
  policyId: string;
  policyName: string;
  slotKey: string;
  scanAt: string;
}

interface ExecuteConfigPolicyRunJobData {
  type: 'execute-config-policy-run';
  configPolicyAutomationId: string;
  targetDeviceIds: string[];
  triggeredBy: string;
}

type AutomationJobData =
  | ScanSchedulesJobData
  | TriggerScheduleJobData
  | TriggerEventJobData
  | ExecuteRunJobData
  | TriggerConfigPolicyScheduleJobData
  | ExecuteConfigPolicyRunJobData;

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

export interface DueConfigPolicyScheduleDispatch {
  configPolicyAutomationId: string;
  configPolicyAutomationName: string;
  assignmentTargets: ConfigPolicyAssignmentTarget[];
  policyId: string;
  policyName: string;
}

export function collectDueConfigPolicyScheduleDispatches(
  candidates: ScheduledAutomationWithTarget[],
  scanDate: Date,
): DueConfigPolicyScheduleDispatch[] {
  const grouped = new Map<
    string,
    DueConfigPolicyScheduleDispatch & { targetKeys: Set<string> }
  >();

  for (const candidate of candidates) {
    const { automation: cpAutomation } = candidate;

    if (!cpAutomation.cronExpression) {
      continue;
    }
    const tz = cpAutomation.timezone || 'UTC';

    if (!isCronDue(cpAutomation.cronExpression, tz, scanDate)) {
      continue;
    }

    let entry = grouped.get(cpAutomation.id);
    if (!entry) {
      entry = {
        configPolicyAutomationId: cpAutomation.id,
        configPolicyAutomationName: cpAutomation.name,
        assignmentTargets: [],
        policyId: candidate.policyId,
        policyName: candidate.policyName,
        targetKeys: new Set<string>(),
      };
      grouped.set(cpAutomation.id, entry);
    }

    const targetKey = `${candidate.assignmentLevel}:${candidate.assignmentTargetId}`;
    if (!entry.targetKeys.has(targetKey)) {
      entry.targetKeys.add(targetKey);
      entry.assignmentTargets.push({
        level: candidate.assignmentLevel,
        targetId: candidate.assignmentTargetId,
      });
    }
  }

  return Array.from(grouped.values()).map(({ targetKeys: _targetKeys, ...dispatch }) => dispatch);
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

  // ---- Standalone automations scan ----
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

  // ---- Config policy automations scan ----
  try {
    const configPolicyCandidates = await scanScheduledAutomations();
    const dueConfigPolicyDispatches = collectDueConfigPolicyScheduleDispatches(configPolicyCandidates, scanDate);

    for (const dispatch of dueConfigPolicyDispatches) {
      due += 1;
      await queue.add(
        'trigger-config-policy-schedule',
        {
          type: 'trigger-config-policy-schedule',
          configPolicyAutomationId: dispatch.configPolicyAutomationId,
          configPolicyAutomationName: dispatch.configPolicyAutomationName,
          assignmentTargets: dispatch.assignmentTargets,
          policyId: dispatch.policyId,
          policyName: dispatch.policyName,
          slotKey,
          scanAt: scanDate.toISOString(),
        },
        {
          jobId: `cp-automation:schedule:${dispatch.configPolicyAutomationId}:${slotKey}`,
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 500 },
        },
      );
    }
  } catch (error) {
    console.error('[AutomationWorker] Failed to scan config policy automations:', error);
    throw error; // Propagate so BullMQ can retry the job
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

// ============================================
// Config Policy Automation Handlers
// ============================================

/**
 * Resolves target device IDs based on an assignment level and target ID.
 *   - device:       just the single device
 *   - device_group: all devices in the group
 *   - site:         all devices at the site
 *   - organization: all devices in the org
 *   - partner:      all devices across all orgs belonging to the partner
 */
async function resolveDeviceIdsForAssignment(
  assignmentLevel: string,
  assignmentTargetId: string,
): Promise<string[]> {
  switch (assignmentLevel) {
    case 'device': {
      // Verify device exists
      const [device] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.id, assignmentTargetId))
        .limit(1);
      return device ? [device.id] : [];
    }

    case 'device_group': {
      const members = await db
        .select({ deviceId: deviceGroupMemberships.deviceId })
        .from(deviceGroupMemberships)
        .where(eq(deviceGroupMemberships.groupId, assignmentTargetId));
      return members.map((m) => m.deviceId);
    }

    case 'site': {
      const siteDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.siteId, assignmentTargetId));
      return siteDevices.map((d) => d.id);
    }

    case 'organization': {
      const orgDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.orgId, assignmentTargetId));
      return orgDevices.map((d) => d.id);
    }

    case 'partner': {
      // Get all orgs for this partner, then all devices for those orgs
      const partnerOrgs = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.partnerId, assignmentTargetId));
      const orgIds = partnerOrgs.map((o) => o.id);
      if (orgIds.length === 0) return [];

      const partnerDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(inArray(devices.orgId, orgIds));
      return partnerDevices.map((d) => d.id);
    }

    default:
      console.warn(`[AutomationWorker] Unknown assignment level: ${assignmentLevel}`);
      return [];
  }
}

async function processTriggerConfigPolicySchedule(
  data: TriggerConfigPolicyScheduleJobData,
): Promise<{ runId?: string; skipped?: string; devicesQueued?: number }> {
  // Re-verify the automation still exists and is enabled
  const [cpAutomation] = await db
    .select()
    .from(configPolicyAutomations)
    .where(and(eq(configPolicyAutomations.id, data.configPolicyAutomationId), eq(configPolicyAutomations.enabled, true)))
    .limit(1);

  if (!cpAutomation) {
    return { skipped: 'config_policy_automation_not_found_or_disabled' };
  }

  const assignmentTargets =
    data.assignmentTargets && data.assignmentTargets.length > 0
      ? data.assignmentTargets
      : data.assignmentLevel && data.assignmentTargetId
        ? [{ level: data.assignmentLevel, targetId: data.assignmentTargetId }]
        : [];

  if (assignmentTargets.length === 0) {
    return { skipped: 'no_assignment_targets' };
  }

  // Resolve target devices across all assignment targets, then deduplicate.
  const allDeviceIdSet = new Set<string>();
  for (const target of assignmentTargets) {
    const ids = await resolveDeviceIdsForAssignment(target.level, target.targetId);
    for (const id of ids) {
      allDeviceIdSet.add(id);
    }
  }
  const allDeviceIds = Array.from(allDeviceIdSet);

  if (allDeviceIds.length === 0) {
    return { skipped: 'no_target_devices' };
  }

  // Filter out devices in maintenance windows that suppress automations
  const eligibleDeviceIds: string[] = [];
  for (const deviceId of allDeviceIds) {
    try {
      const maintenanceSettings = await resolveMaintenanceConfigForDevice(deviceId);
      if (maintenanceSettings) {
        const windowStatus = isInMaintenanceWindow(maintenanceSettings);
        if (windowStatus.active && windowStatus.suppressAutomations) {
          continue;
        }
      }
      eligibleDeviceIds.push(deviceId);
    } catch (err) {
      // If maintenance check fails, exclude the device (fail-closed) to avoid
      // running automations during an active maintenance window we can't verify.
      console.warn(`[AutomationWorker] Maintenance check failed for device ${deviceId}, excluding from run:`, err);
    }
  }

  if (eligibleDeviceIds.length === 0) {
    return { skipped: 'all_devices_in_maintenance' };
  }

  // Queue execute-config-policy-run job
  const queue = getAutomationQueue();
  await queue.add(
    'execute-config-policy-run',
    {
      type: 'execute-config-policy-run',
      configPolicyAutomationId: cpAutomation.id,
      targetDeviceIds: eligibleDeviceIds,
      triggeredBy: `schedule:${data.slotKey}`,
    },
    {
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    },
  );

  return { devicesQueued: eligibleDeviceIds.length };
}

async function processExecuteConfigPolicyRun(
  data: ExecuteConfigPolicyRunJobData,
): Promise<{ runId?: string; skipped?: string }> {
  // Load the config policy automation row
  const [cpAutomation] = await db
    .select()
    .from(configPolicyAutomations)
    .where(eq(configPolicyAutomations.id, data.configPolicyAutomationId))
    .limit(1);

  if (!cpAutomation) {
    return { skipped: 'config_policy_automation_not_found' };
  }

  // Execute the automation run via the runtime
  const result = await executeConfigPolicyAutomationRun(
    cpAutomation,
    data.targetDeviceIds,
    data.triggeredBy,
  );

  return { runId: result.runId };
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
          case 'trigger-config-policy-schedule':
            return processTriggerConfigPolicySchedule(job.data);
          case 'execute-config-policy-run':
            return processExecuteConfigPolicyRun(job.data);
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

  // --- Legacy standalone automations ---
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

  // --- Config policy-based event automations ---
  // For event triggers we need a device context. If the event payload includes
  // a deviceId, resolve config-policy automations for that device.
  try {
    const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId : undefined;

    if (deviceId) {
      const cpAutomations = await resolveAutomationsForDevice(deviceId);

      for (const cpAutomation of cpAutomations) {
        if (!cpAutomation.enabled) continue;
        if (cpAutomation.triggerType !== 'event') continue;
        if (cpAutomation.eventType !== event.type) continue;

        // Check maintenance window for this device
        try {
          const maintenanceSettings = await resolveMaintenanceConfigForDevice(deviceId);
          if (maintenanceSettings) {
            const windowStatus = isInMaintenanceWindow(maintenanceSettings);
            if (windowStatus.active && windowStatus.suppressAutomations) {
              continue;
            }
          }
        } catch (err) {
          // If maintenance check fails, skip this device (fail-closed)
          console.warn(`[AutomationWorker] Maintenance check failed for device ${deviceId} during event trigger, skipping:`, err);
          continue;
        }

        await queue.add(
          'execute-config-policy-run',
          {
            type: 'execute-config-policy-run',
            configPolicyAutomationId: cpAutomation.id,
            targetDeviceIds: [deviceId],
            triggeredBy: `config-policy-event:${event.type}`,
          },
          {
            jobId: `cp-automation:event:${cpAutomation.id}:${deviceId}:${event.id}`,
            removeOnComplete: { count: 200 },
            removeOnFail: { count: 500 },
          },
        );
      }
    }
  } catch (error) {
    console.error('[AutomationWorker] Failed to queue config policy event triggers:', error);
    throw error; // Propagate so failures are visible to BullMQ
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
