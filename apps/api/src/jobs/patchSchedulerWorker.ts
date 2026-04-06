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
  patchJobs,
  devices,
  deviceGroupMemberships,
  organizations,
  sites,
} from '../db/schema';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { getRedisConnection } from '../services/redis';
import { checkDeviceMaintenanceWindow } from '../services/featureConfigResolver';
import { enqueuePatchJob } from './patchJobExecutor';
import {
  backfillMissingPatchSettings,
  listAllPatchInventory,
  loadPolicyLocalPatchConfig,
  summarizePatchInventory,
  type PatchInlineSettings,
} from '../services/configPolicyPatching';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

function isRelationNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const cause = (error as { cause?: { code?: string } }).cause;
  return cause?.code === '42P01';
}

let _configPolicyTableWarningLogged = false;

const QUEUE_NAME = 'patch-scheduler';
const IDEMPOTENCY_LOOKBACK_MS = 45 * 24 * 60 * 60 * 1000;

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

interface LocalTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
}

interface DeviceSchedulingContext {
  deviceId: string;
  orgId: string;
  timezone: string;
}

interface DueGroup {
  orgId: string;
  timezone: string;
  occurrenceKey: string;
  deviceIds: string[];
}

function parseOrgTimezone(settings: unknown): string | null {
  if (!settings || typeof settings !== 'object') return null;
  const timezone = (settings as Record<string, unknown>).timezone;
  return typeof timezone === 'string' && timezone.length > 0 ? timezone : null;
}

function normalizeTimezone(timezone: string | null | undefined): string {
  const candidate = timezone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch (err) {
    console.warn(`[PatchScheduler] Invalid timezone "${candidate}", falling back to UTC:`, err);
    return 'UTC';
  }
}

function getLocalTimeParts(now: Date, timezone: string): LocalTimeParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '0';
  const weekday = get('weekday').toLowerCase().slice(0, 3) as LocalTimeParts['weekday'];

  return {
    year: Number.parseInt(get('year'), 10),
    month: Number.parseInt(get('month'), 10),
    day: Number.parseInt(get('day'), 10),
    hour: Number.parseInt(get('hour'), 10),
    minute: Number.parseInt(get('minute'), 10),
    second: Number.parseInt(get('second'), 10),
    weekday,
  };
}

function getDueOccurrenceKey(settings: PatchInlineSettings, timezone: string, now: Date): string | null {
  const parts = getLocalTimeParts(now, timezone);
  const [targetHourRaw, targetMinuteRaw] = (settings.scheduleTime || '02:00').split(':');
  const targetHour = Number.parseInt(targetHourRaw ?? '2', 10);
  const targetMinute = Number.parseInt(targetMinuteRaw ?? '0', 10);

  if (parts.hour !== targetHour || parts.minute !== targetMinute) {
    return null;
  }

  switch (settings.scheduleFrequency) {
    case 'daily':
      break;
    case 'weekly':
      if (parts.weekday !== (settings.scheduleDayOfWeek ?? 'sun')) {
        return null;
      }
      break;
    case 'monthly':
      if (parts.day !== (settings.scheduleDayOfMonth ?? 1)) {
        return null;
      }
      break;
    default:
      return null;
  }

  const yyyy = String(parts.year).padStart(4, '0');
  const mm = String(parts.month).padStart(2, '0');
  const dd = String(parts.day).padStart(2, '0');
  const hh = String(targetHour).padStart(2, '0');
  const min = String(targetMinute).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

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

async function loadDeviceSchedulingContexts(deviceIds: string[]): Promise<DeviceSchedulingContext[]> {
  if (deviceIds.length === 0) return [];

  const rows = await db
    .select({
      deviceId: devices.id,
      orgId: devices.orgId,
      siteTimezone: sites.timezone,
      orgSettings: organizations.settings,
    })
    .from(devices)
    .innerJoin(organizations, eq(devices.orgId, organizations.id))
    .leftJoin(sites, eq(devices.siteId, sites.id))
    .where(inArray(devices.id, deviceIds));

  return rows.map((row) => ({
    deviceId: row.deviceId,
    orgId: row.orgId,
    timezone: normalizeTimezone(row.siteTimezone || parseOrgTimezone(row.orgSettings) || 'UTC'),
  }));
}

async function hasExistingOccurrenceJob(
  configPolicyId: string,
  orgId: string,
  timezone: string,
  occurrenceKey: string,
  now: Date
): Promise<boolean> {
  const jobs = await db
    .select({
      id: patchJobs.id,
      targets: patchJobs.targets,
    })
    .from(patchJobs)
    .where(
      and(
        eq(patchJobs.configPolicyId, configPolicyId),
        eq(patchJobs.orgId, orgId),
        gte(patchJobs.createdAt, new Date(now.getTime() - IDEMPOTENCY_LOOKBACK_MS))
      )
    );

  return jobs.some((job) => {
    const targets = (job.targets ?? {}) as Record<string, unknown>;
    return (
      targets.scheduleOccurrenceKey === occurrenceKey &&
      targets.resolvedTimezone === timezone
    );
  });
}

async function scanAndCreateJobs(): Promise<{ created: number; scanned: number }> {
  const now = new Date();
  let created = 0;

  const patchPoliciesWithSchedules = await db
    .select({
      configPolicyId: configurationPolicies.id,
      policyName: configurationPolicies.name,
      featureLinkId: configPolicyFeatureLinks.id,
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

  for (const row of patchPoliciesWithSchedules) {
    try {
      const policyLocal = await loadPolicyLocalPatchConfig(row.configPolicyId);
      if (!policyLocal) continue;

      if (!policyLocal.ring.valid) {
        console.error(
          `[PatchScheduler] Skipping config policy ${row.configPolicyId}: invalid ring reference (${policyLocal.ring.classification})`
        );
        continue;
      }

      const assignments = await db
        .select({
          level: configPolicyAssignments.level,
          targetId: configPolicyAssignments.targetId,
        })
        .from(configPolicyAssignments)
        .where(eq(configPolicyAssignments.configPolicyId, row.configPolicyId));

      if (assignments.length === 0) continue;

      const allDeviceIds = new Set<string>();
      for (const assignment of assignments) {
        const ids = await resolveDeviceIdsForAssignment(assignment.level, assignment.targetId);
        for (const id of ids) allDeviceIds.add(id);
      }

      if (allDeviceIds.size === 0) continue;

      const schedulingContexts = await loadDeviceSchedulingContexts(Array.from(allDeviceIds));
      const groupedContexts = new Map<string, { orgId: string; timezone: string; deviceIds: string[] }>();

      for (const context of schedulingContexts) {
        const key = `${context.orgId}:${context.timezone}`;
        const group = groupedContexts.get(key) ?? {
          orgId: context.orgId,
          timezone: context.timezone,
          deviceIds: [],
        };
        group.deviceIds.push(context.deviceId);
        groupedContexts.set(key, group);
      }

      const dueGroups: DueGroup[] = [];
      for (const group of groupedContexts.values()) {
        const occurrenceKey = getDueOccurrenceKey(policyLocal.settings, group.timezone, now);
        if (!occurrenceKey) continue;
        dueGroups.push({
          orgId: group.orgId,
          timezone: group.timezone,
          occurrenceKey,
          deviceIds: group.deviceIds,
        });
      }

      for (const group of dueGroups) {
        if (await hasExistingOccurrenceJob(row.configPolicyId, group.orgId, group.timezone, group.occurrenceKey, now)) {
          continue;
        }

        const eligibleDeviceIds: string[] = [];
        for (const deviceId of group.deviceIds) {
          const maintenance = await checkDeviceMaintenanceWindow(deviceId);
          if (!maintenance.active || !maintenance.suppressPatching) {
            eligibleDeviceIds.push(deviceId);
          }
        }

        if (eligibleDeviceIds.length === 0) {
          continue;
        }

        const [job] = await db
          .insert(patchJobs)
          .values({
            orgId: group.orgId,
            configPolicyId: row.configPolicyId,
            ringId: policyLocal.ring.ringId,
            name: `Scheduled Patch Job - ${row.policyName}`,
            patches: {
              ringId: policyLocal.ring.ringId,
              ringName: policyLocal.ring.ringName,
              categoryRules: policyLocal.ring.categoryRules,
              autoApprove: policyLocal.ring.autoApprove,
              sources: policyLocal.settings.sources,
              ringValidation: {
                classification: policyLocal.ring.classification,
                valid: policyLocal.ring.valid,
              },
            },
            targets: {
              deviceIds: eligibleDeviceIds,
              configPolicyId: row.configPolicyId,
              configPolicyName: row.policyName,
              deployment: policyLocal.settings,
              resolvedTimezone: group.timezone,
              scheduleOccurrenceKey: group.occurrenceKey,
            },
            status: 'scheduled',
            scheduledAt: now,
            devicesTotal: eligibleDeviceIds.length,
            devicesPending: eligibleDeviceIds.length,
          })
          .returning();

        if (job) {
          await enqueuePatchJob(job.id);
          created += 1;
          console.log(
            `[PatchScheduler] Created job ${job.id} for config policy ${row.configPolicyId} (${eligibleDeviceIds.length} devices, ${group.timezone}, ${group.occurrenceKey})`
          );
        }
      }
    } catch (err) {
      console.error(
        `[PatchScheduler] Error processing config policy ${row.configPolicyId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return { created, scanned: patchPoliciesWithSchedules.length };
}

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
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    }
  );
}

export async function initializePatchSchedulerWorker(): Promise<void> {
  await runWithSystemDbAccess(async () => {
    try {
      const repair = await backfillMissingPatchSettings();
      const inventory = await listAllPatchInventory();
      const summary = summarizePatchInventory(inventory);

      console.log(
        `[PatchScheduler] Patch config repair: repaired=${repair.repaired}, fromInline=${repair.repairedFromInline}, defaults=${repair.repairedWithDefaults}`
      );
      console.log(
        `[PatchScheduler] Patch inventory: total=${summary.total}, ok=${summary.ok}, needsRepair=${summary.needsRepair}, invalidReference=${summary.invalidReference}`
      );
    } catch (error) {
      if (!isRelationNotFoundError(error)) {
        throw error;
      }
    }
  });

  schedulerWorker = createSchedulerWorker();

  schedulerWorker.on('error', (error) => {
    console.error('[PatchScheduler] Worker error:', error);
  });

  const queue = getSchedulerQueue();

  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    await queue.removeRepeatableByKey(job.key);
  }

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
