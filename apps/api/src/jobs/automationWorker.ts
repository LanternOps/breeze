/**
 * Automation Worker
 *
 * Handles:
 * - schedule trigger scans
 * - event trigger dispatch
 * - execution of automation runs
 */

import { Job, Queue, Worker } from 'bullmq';
import { and, eq, isNull, or } from 'drizzle-orm';
import * as dbModule from '../db';
import {
  automations,
  configPolicyAutomations,
  configPolicyFeatureLinks,
  configurationPolicies,
  devices,
  deviceGroupMemberships,
  organizations,
} from '../db/schema';
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
import { getBullMQConnection, isRedisAvailable } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';
import { assertQueueJobName, parseQueueJobData } from '../services/bullmqValidation';
import { automationQueueJobDataSchema, type AutomationAssignmentLevel, type AutomationQueueJobData } from './queueSchemas';
import { attachWorkerObservability } from './workerObservability';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

/** Check if a Drizzle/Postgres error is "relation does not exist" (42P01). */
function isRelationNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const cause = (error as { cause?: { code?: string } }).cause;
  return cause?.code === '42P01';
}

const _missingTableWarned = new Set<string>();
function logMissingTableWarning(worker: string, feature: string): void {
  const key = `${worker}:${feature}`;
  if (!_missingTableWarned.has(key)) {
    _missingTableWarned.add(key);
    console.warn(`[${worker}] Config policy tables not found — run "pnpm db:migrate" to create them. Skipping ${feature} scan.`);
  }
}

const AUTOMATION_QUEUE = 'automations';
const SCHEDULE_SCAN_INTERVAL_MS = 60 * 1000;

// Per-variant types are derived from the Zod union so they can never drift from
// the schema validated at the dequeue boundary (see queueSchemas.ts:233-241).
type TriggerScheduleJobData = Extract<AutomationQueueJobData, { type: 'trigger-schedule' }>;
type TriggerEventJobData = Extract<AutomationQueueJobData, { type: 'trigger-event' }>;
type ExecuteRunJobData = Extract<AutomationQueueJobData, { type: 'execute-run' }>;
type TriggerConfigPolicyScheduleJobData = Extract<AutomationQueueJobData, { type: 'trigger-config-policy-schedule' }>;
type ExecuteConfigPolicyRunJobData = Extract<AutomationQueueJobData, { type: 'execute-config-policy-run' }>;

// Shared shape for a resolved (level, targetId) assignment pair, matching the
// element type of the schema's assignmentTargets[] array.
type ConfigPolicyAssignmentTarget = { level: AutomationAssignmentLevel; targetId: string };

type AutomationJobData = AutomationQueueJobData;

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
      connection: getBullMQConnection(),
    });
  }

  return automationQueue;
}

export async function enqueueConfigPolicyRun(
  data: ExecuteConfigPolicyRunJobData,
  stableJobId?: string,
): Promise<{ jobId?: string }> {
  const queue = getAutomationQueue();

  if (stableJobId) {
    const existing = await queue.getJob(stableJobId);
    if (existing) {
      const state = await existing.getState();
      if (isReusableState(state)) {
        return { jobId: existing.id ? String(existing.id) : stableJobId };
      }
      await existing.remove().catch((error) => {
        console.error(`[AutomationWorker] Failed to remove stale config-policy run job ${stableJobId}:`, error);
      });
    }
  }

  const job = await queue.add(
    'execute-config-policy-run',
    data,
    {
      ...(stableJobId ? { jobId: stableJobId } : {}),
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    },
  );

  return { jobId: job.id ? String(job.id) : stableJobId };
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
    // '-' separator (not ':') — BullMQ rejects custom jobIds whose colon-split
    // length !== 3, and this 2-part id would throw. See #1101.
    const stableJobId = `automation-run-${runId}`;
    const existing = await queue.getJob(stableJobId);
    if (existing) {
      const state = await existing.getState();
      if (isReusableState(state)) {
        return {
          enqueued: true,
          jobId: existing.id ? String(existing.id) : stableJobId,
        };
      }
      await existing.remove().catch((error) => {
        console.error(`[AutomationWorker] Failed to remove stale automation run job ${stableJobId}:`, error);
      });
    }

    const job = await queue.add(
      'execute-run',
      {
        type: 'execute-run',
        runId,
        targetDeviceIds,
      },
      {
        jobId: stableJobId,
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
        jobId: `automation-schedule-${automation.id}-${slotKey}`,
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
          jobId: `cp-automation-schedule-${dispatch.configPolicyAutomationId}-${slotKey}`,
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 500 },
        },
      );
    }
  } catch (error: unknown) {
    // If config policy tables don't exist yet (migration not run), log once and skip
    if (isRelationNotFoundError(error)) {
      logMissingTableWarning('AutomationWorker', 'config policy automations');
    } else {
      console.error('[AutomationWorker] Failed to scan config policy automations:', error);
      throw error; // Propagate so BullMQ can retry the job
    }
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
  // null for partner-owned library policies (#1724, #2280) — they have no
  // single owning org and may carry a partner-level assignment (resolved
  // across all the partner's orgs) AND/OR org/site/group/device-level SUBSET
  // assignments into individual orgs under the partner.
  policyOrgId: string | null,
  // The policy's own partnerId (set for partner-owned policies, null for
  // org-owned ones). Used ONLY to re-clamp subset (org/site/group/device)
  // resolution below when policyOrgId is null — see the comment above the
  // switch for why this exists (#2286, mirroring the patch-scheduler fix in
  // PR #2285).
  policyPartnerId: string | null,
): Promise<string[]> {
  if (assignmentLevel === 'partner') {
    // A partner-wide policy (policyOrgId null, #1724) resolves EVERY device
    // under the assigned partner. A legacy org-owned policy at partner level
    // (now rejected at assign time) still clamps to its own org as a backstop.
    const conditions = [eq(organizations.partnerId, assignmentTargetId)];
    if (policyOrgId) conditions.push(eq(devices.orgId, policyOrgId));
    const partnerDevices = await db
      .select({ id: devices.id })
      .from(devices)
      .innerJoin(organizations, eq(devices.orgId, organizations.id))
      .where(and(...conditions));
    return partnerDevices.map((d) => d.id);
  }

  // Every remaining level is org/site/group/device-scoped. For an org-owned
  // policy, policyOrgId clamps the target to the policy's own org as
  // defense-in-depth. For a partner-owned library policy (#2280) resolving a
  // SUBSET assignment — org/site/group/device, not the partner-wide 'partner'
  // level above — policyOrgId is null: there is no single owning org to clamp
  // to, since the same policy can carry subset assignments into several of the
  // partner's orgs. The target itself was partner-scoped at ASSIGN time
  // (validateAssignmentTarget), but that check is a point-in-time snapshot —
  // if the target org is later reparented to a different partner, the stale
  // assignment row would otherwise still resolve those devices (TOCTOU). So
  // every subset branch below re-clamps to the policy's partner on every run
  // via an inner join on organizations, the same re-verification the
  // 'partner' branch above already does for assignmentTargetId (#2286).
  const needsPartnerClamp = !policyOrgId && Boolean(policyPartnerId);

  switch (assignmentLevel) {
    case 'device': {
      if (needsPartnerClamp) {
        const [device] = await db
          .select({ id: devices.id })
          .from(devices)
          .innerJoin(organizations, eq(devices.orgId, organizations.id))
          .where(and(eq(devices.id, assignmentTargetId), eq(organizations.partnerId, policyPartnerId!)))
          .limit(1);
        return device ? [device.id] : [];
      }
      const conditions = [eq(devices.id, assignmentTargetId)];
      if (policyOrgId) conditions.push(eq(devices.orgId, policyOrgId));
      const [device] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(...conditions))
        .limit(1);
      return device ? [device.id] : [];
    }

    case 'device_group': {
      if (needsPartnerClamp) {
        const members = await db
          .select({ deviceId: deviceGroupMemberships.deviceId })
          .from(deviceGroupMemberships)
          .innerJoin(organizations, eq(deviceGroupMemberships.orgId, organizations.id))
          .where(
            and(
              eq(deviceGroupMemberships.groupId, assignmentTargetId),
              eq(organizations.partnerId, policyPartnerId!),
            ),
          );
        return members.map((m) => m.deviceId);
      }
      const conditions = [eq(deviceGroupMemberships.groupId, assignmentTargetId)];
      if (policyOrgId) conditions.push(eq(deviceGroupMemberships.orgId, policyOrgId));
      const members = await db
        .select({ deviceId: deviceGroupMemberships.deviceId })
        .from(deviceGroupMemberships)
        .where(and(...conditions));
      return members.map((m) => m.deviceId);
    }

    case 'site': {
      if (needsPartnerClamp) {
        const siteDevices = await db
          .select({ id: devices.id })
          .from(devices)
          .innerJoin(organizations, eq(devices.orgId, organizations.id))
          .where(and(eq(devices.siteId, assignmentTargetId), eq(organizations.partnerId, policyPartnerId!)));
        return siteDevices.map((d) => d.id);
      }
      const conditions = [eq(devices.siteId, assignmentTargetId)];
      if (policyOrgId) conditions.push(eq(devices.orgId, policyOrgId));
      const siteDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(...conditions));
      return siteDevices.map((d) => d.id);
    }

    case 'organization': {
      if (needsPartnerClamp) {
        const orgDevices = await db
          .select({ id: devices.id })
          .from(devices)
          .innerJoin(organizations, eq(devices.orgId, organizations.id))
          .where(and(eq(devices.orgId, assignmentTargetId), eq(organizations.partnerId, policyPartnerId!)));
        return orgDevices.map((d) => d.id);
      }
      const conditions = [eq(devices.orgId, assignmentTargetId)];
      if (policyOrgId) conditions.push(eq(devices.orgId, policyOrgId));
      const orgDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(...conditions));
      return orgDevices.map((d) => d.id);
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

  // Re-load the owning policy's ownership (orgId/partnerId) at RUN time — not
  // from the queued job data — so device resolution below re-verifies against
  // current truth. The assignment targets were only partner/org-scoped at
  // ASSIGN time; without this clamp a target reparented to a different partner
  // after assignment would still resolve its devices (TOCTOU, #2286).
  const [policyOwner] = await db
    .select({
      orgId: configurationPolicies.orgId,
      partnerId: configurationPolicies.partnerId,
    })
    .from(configPolicyFeatureLinks)
    .innerJoin(configurationPolicies, eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id))
    .where(eq(configPolicyFeatureLinks.id, cpAutomation.featureLinkId))
    .limit(1);

  if (!policyOwner) {
    return { skipped: 'config_policy_not_found' };
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
    const ids = await resolveDeviceIdsForAssignment(
      target.level,
      target.targetId,
      policyOwner.orgId,
      policyOwner.partnerId,
    );
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

  await enqueueConfigPolicyRun(
    {
      type: 'execute-config-policy-run',
      configPolicyAutomationId: cpAutomation.id,
      targetDeviceIds: eligibleDeviceIds.sort(),
      triggeredBy: `schedule:${data.slotKey}`,
    },
    `cp-automation-run:${cpAutomation.id}:${data.slotKey}`,
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
        const data = parseQueueJobData(AUTOMATION_QUEUE, job, automationQueueJobDataSchema);
        switch (data.type) {
          case 'scan-schedules':
            assertQueueJobName(AUTOMATION_QUEUE, job, 'scan-schedules');
            return processScanSchedules(data.scanAt);
          case 'trigger-schedule':
            assertQueueJobName(AUTOMATION_QUEUE, job, 'trigger-schedule');
            return processTriggerSchedule(data);
          case 'trigger-event':
            assertQueueJobName(AUTOMATION_QUEUE, job, 'trigger-event');
            return processTriggerEvent(data);
          case 'execute-run':
            assertQueueJobName(AUTOMATION_QUEUE, job, 'execute-run');
            return processExecuteRun(data);
          case 'trigger-config-policy-schedule':
            assertQueueJobName(AUTOMATION_QUEUE, job, 'trigger-config-policy-schedule');
            return processTriggerConfigPolicySchedule(data);
          case 'execute-config-policy-run':
            assertQueueJobName(AUTOMATION_QUEUE, job, 'execute-config-policy-run');
            return processExecuteConfigPolicyRun(data);
        }
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 10,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
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

// Exported for the partner-RLS integration suite, which proves the dual-axis
// fan-out query against real Postgres (the BullMQ queue is mocked there).
export async function queueEventTriggers(event: BreezeEvent<Record<string, unknown>>): Promise<void> {
  const queue = getAutomationQueue();

  // --- Legacy standalone automations ---
  // Dual-ownership fan-out (#2133): match the event org's own automations OR
  // partner-wide automations (org_id NULL) owned by that org's partner. This
  // callback already runs under a system DB context, so RLS is not the filter
  // — a plain eq(orgId, ...) would silently never match partner-wide rows.
  const [eventOrg] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, event.orgId))
    .limit(1);

  const ownershipCondition = eventOrg?.partnerId
    ? or(
        eq(automations.orgId, event.orgId),
        and(isNull(automations.orgId), eq(automations.partnerId, eventOrg.partnerId)),
      )
    : eq(automations.orgId, event.orgId);

  const candidates = await db
    .select()
    .from(automations)
    .where(and(ownershipCondition, eq(automations.enabled, true)));

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
        jobId: `automation-event-${automation.id}-${event.id}`,
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

        await enqueueConfigPolicyRun(
          {
            type: 'execute-config-policy-run',
            configPolicyAutomationId: cpAutomation.id,
            targetDeviceIds: [deviceId],
            triggeredBy: `config-policy-event:${event.type}`,
          },
          `cp-automation-event-${cpAutomation.id}-${deviceId}-${event.id}`,
        );
      }
    }
  } catch (error: unknown) {
    if (isRelationNotFoundError(error)) {
      logMissingTableWarning('AutomationWorker', 'config policy event triggers');
    } else {
      console.error('[AutomationWorker] Failed to queue config policy event triggers:', error);
      throw error; // Propagate so failures are visible to BullMQ
    }
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
  attachWorkerObservability(automationWorker, 'automationWorker');

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

// Exported for unit/integration tests of config-policy assignment device
// resolution (#2286). Internal helper, not part of the worker's public surface.
export const __testOnly = {
  resolveDeviceIdsForAssignment,
};
