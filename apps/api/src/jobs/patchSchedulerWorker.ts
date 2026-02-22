/**
 * Patch Scheduler Worker
 *
 * Periodic BullMQ worker (every 60s) that scans config policy schedules
 * and creates patch jobs when due.
 */

import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  patchPolicies,
  patchJobs,
  devices,
  deviceGroupMemberships,
  organizations,
} from '../db/schema';
import { and, eq, inArray, gte, sql } from 'drizzle-orm';
import { getRedisConnection } from '../services/redis';
import { checkDeviceMaintenanceWindow } from '../services/featureConfigResolver';
import { enqueuePatchJob } from './patchJobExecutor';

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

let _configPolicyTableWarningLogged = false;

// ============================================
// Queue
// ============================================

const QUEUE_NAME = 'patch-scheduler';

let schedulerQueue: Queue | null = null;
let schedulerWorker: Worker | null = null;

function getSchedulerQueue(): Queue {
  if (!schedulerQueue) {
    schedulerQueue = new Queue(QUEUE_NAME, {
      connection: getRedisConnection(),
    });
  }
  return schedulerQueue;
}

// ============================================
// Schedule checking
// ============================================

interface ScheduleConfig {
  scheduleFrequency: string;
  scheduleTime: string;
  scheduleDayOfWeek?: string;
  scheduleDayOfMonth?: number;
}

/**
 * Check if a schedule is due right now (within 1-minute tolerance).
 */
function isScheduleDue(config: ScheduleConfig, now: Date): boolean {
  const { scheduleFrequency, scheduleTime, scheduleDayOfWeek, scheduleDayOfMonth } = config;

  // Parse scheduleTime (HH:MM)
  const parts = (scheduleTime || '02:00').split(':');
  const targetHour = parseInt(parts[0] ?? '2', 10);
  const targetMinute = parseInt(parts[1] ?? '0', 10);

  const currentHour = now.getUTCHours();
  const currentMinute = now.getUTCMinutes();

  // Must match hour and minute (within the 60s poll window)
  if (currentHour !== targetHour || currentMinute !== targetMinute) {
    return false;
  }

  switch (scheduleFrequency) {
    case 'daily':
      return true;

    case 'weekly': {
      const dayMap: Record<string, number> = {
        sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
      };
      const targetDay = dayMap[(scheduleDayOfWeek || 'sun').toLowerCase()];
      return targetDay === undefined || now.getUTCDay() === targetDay;
    }

    case 'monthly': {
      const targetDayOfMonth = scheduleDayOfMonth ?? 1;
      return now.getUTCDate() === targetDayOfMonth;
    }

    default:
      return false;
  }
}

/**
 * Get the start of the current schedule window for idempotency checks.
 */
function getWindowStart(frequency: string, now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);

  switch (frequency) {
    case 'daily':
      // Window = today midnight UTC
      return d;

    case 'weekly': {
      // Window = start of current week (Sunday)
      const day = d.getUTCDay();
      d.setUTCDate(d.getUTCDate() - day);
      return d;
    }

    case 'monthly':
      // Window = start of current month
      d.setUTCDate(1);
      return d;

    default:
      return d;
  }
}

// ============================================
// Device resolution (mirrors automationWorker pattern)
// ============================================

async function resolveDeviceIdsForAssignment(
  assignmentLevel: string,
  assignmentTargetId: string
): Promise<string[]> {
  switch (assignmentLevel) {
    case 'device': {
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
      return [];
  }
}

// ============================================
// Main scan logic
// ============================================

async function scanAndCreateJobs(): Promise<{ created: number; scanned: number }> {
  const now = new Date();
  let created = 0;

  // 1. Find active config policies with patch feature links
  const patchFeatureLinks = await db
    .select({
      featureLinkId: configPolicyFeatureLinks.id,
      configPolicyId: configPolicyFeatureLinks.configPolicyId,
      featurePolicyId: configPolicyFeatureLinks.featurePolicyId,
      inlineSettings: configPolicyFeatureLinks.inlineSettings,
      policyName: configurationPolicies.name,
      policyOrgId: configurationPolicies.orgId,
    })
    .from(configPolicyFeatureLinks)
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active')
      )
    )
    .where(eq(configPolicyFeatureLinks.featureType, 'patch'));

  for (const link of patchFeatureLinks) {
    try {
      // 2. Extract schedule from inlineSettings
      const inline = (link.inlineSettings ?? {}) as Record<string, unknown>;
      const scheduleConfig: ScheduleConfig = {
        scheduleFrequency: (inline.scheduleFrequency as string) ?? 'weekly',
        scheduleTime: (inline.scheduleTime as string) ?? '02:00',
        scheduleDayOfWeek: inline.scheduleDayOfWeek as string | undefined,
        scheduleDayOfMonth: inline.scheduleDayOfMonth as number | undefined,
      };

      // 3. Check if schedule is due
      if (!isScheduleDue(scheduleConfig, now)) continue;

      // 4. Idempotency: check if a job already exists for this config policy in the current window
      const windowStart = getWindowStart(scheduleConfig.scheduleFrequency, now);
      const [existingJob] = await db
        .select({ id: patchJobs.id })
        .from(patchJobs)
        .where(
          and(
            eq(patchJobs.configPolicyId, link.configPolicyId),
            gte(patchJobs.createdAt, windowStart)
          )
        )
        .limit(1);

      if (existingJob) continue; // Already created this window

      // 5. Resolve target devices from assignments
      const assignments = await db
        .select({
          level: configPolicyAssignments.level,
          targetId: configPolicyAssignments.targetId,
        })
        .from(configPolicyAssignments)
        .where(eq(configPolicyAssignments.configPolicyId, link.configPolicyId));

      if (assignments.length === 0) continue;

      const allDeviceIds = new Set<string>();
      for (const assignment of assignments) {
        const ids = await resolveDeviceIdsForAssignment(assignment.level, assignment.targetId);
        for (const id of ids) allDeviceIds.add(id);
      }

      if (allDeviceIds.size === 0) continue;

      // 6. Filter maintenance-suppressed devices
      const deviceIds: string[] = [];
      for (const deviceId of allDeviceIds) {
        const maint = await checkDeviceMaintenanceWindow(deviceId);
        if (!maint.active || !maint.suppressPatching) {
          deviceIds.push(deviceId);
        }
      }

      if (deviceIds.length === 0) continue;

      // 7. Load ring config if featurePolicyId is set
      let ringId: string | null = null;
      let ringName: string | null = null;
      let categoryRules: unknown[] = [];
      let autoApprove: unknown = {};

      if (link.featurePolicyId) {
        const [ring] = await db
          .select({
            id: patchPolicies.id,
            name: patchPolicies.name,
            categoryRules: patchPolicies.categoryRules,
            autoApprove: patchPolicies.autoApprove,
          })
          .from(patchPolicies)
          .where(eq(patchPolicies.id, link.featurePolicyId))
          .limit(1);

        if (ring) {
          ringId = ring.id;
          ringName = ring.name;
          categoryRules = Array.isArray(ring.categoryRules) ? ring.categoryRules : [];
          autoApprove = ring.autoApprove;
        }
      }

      const rebootPolicy = (inline.rebootPolicy as string) ?? 'if_required';

      // 8. Create patch job
      const [job] = await db
        .insert(patchJobs)
        .values({
          orgId: link.policyOrgId,
          configPolicyId: link.configPolicyId,
          ringId,
          name: `Scheduled Patch Job - ${link.policyName}`,
          patches: {
            ringId,
            ringName,
            categoryRules,
            autoApprove,
          },
          targets: {
            deviceIds,
            configPolicyId: link.configPolicyId,
            configPolicyName: link.policyName,
            deployment: {
              scheduleFrequency: scheduleConfig.scheduleFrequency,
              scheduleTime: scheduleConfig.scheduleTime,
              scheduleDayOfWeek: scheduleConfig.scheduleDayOfWeek,
              scheduleDayOfMonth: scheduleConfig.scheduleDayOfMonth,
              rebootPolicy,
            },
          },
          status: 'scheduled',
          scheduledAt: now,
          devicesTotal: deviceIds.length,
          devicesPending: deviceIds.length,
        })
        .returning();

      if (job) {
        await enqueuePatchJob(job.id);
        created++;
        console.log(`[PatchScheduler] Created job ${job.id} for config policy ${link.configPolicyId} (${deviceIds.length} devices)`);
      }
    } catch (err) {
      console.error(`[PatchScheduler] Error processing config policy ${link.configPolicyId}:`, err instanceof Error ? err.message : err);
    }
  }

  return { created, scanned: patchFeatureLinks.length };
}

// ============================================
// Worker
// ============================================

function createSchedulerWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (_job: Job) => {
      return runWithSystemDbAccess(async () => {
        try {
          return await scanAndCreateJobs();
        } catch (error: unknown) {
          if (isRelationNotFoundError(error)) {
            if (!_configPolicyTableWarningLogged) {
              _configPolicyTableWarningLogged = true;
              console.warn('[PatchScheduler] Config policy tables not found — run "pnpm db:migrate" to create them. Skipping patch schedule scan.');
            }
            return { created: 0, scanned: 0 };
          }
          throw error;
        }
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 1,
    }
  );
}

// ============================================
// Lifecycle
// ============================================

export async function initializePatchSchedulerWorker(): Promise<void> {
  schedulerWorker = createSchedulerWorker();

  schedulerWorker.on('error', (error) => {
    console.error('[PatchScheduler] Worker error:', error);
  });

  const queue = getSchedulerQueue();

  // Remove existing repeatable jobs
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    await queue.removeRepeatableByKey(job.key);
  }

  // Schedule every 60 seconds
  await queue.add(
    'scan-schedules',
    {},
    {
      repeat: {
        every: 60 * 1000,
      },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    }
  );

  console.log('[PatchScheduler] Scheduler worker initialized (60s interval)');
}

export async function shutdownPatchSchedulerWorker(): Promise<void> {
  if (schedulerWorker) {
    await schedulerWorker.close();
    schedulerWorker = null;
  }
  if (schedulerQueue) {
    await schedulerQueue.close();
    schedulerQueue = null;
  }
}
