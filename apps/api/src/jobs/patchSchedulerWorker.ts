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
  partners,
  sites,
} from '../db/schema';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { resolveEffectiveTimezone, canonicalizeTimezone } from '@breeze/shared';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';
import { checkDeviceMaintenanceWindow } from '../services/featureConfigResolver';
import {
  enqueuePatchJob,
  selectStaleScheduledJobIds,
  filterOrphanedJobIds,
  type StaleScheduledJob,
} from './patchJobExecutor';
import { captureException } from '../services/sentry';
import { buildPatchesSnapshot } from '../services/patchJobSnapshot';
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
      connection: getBullMQConnection(),
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

// Partner tz with the column as source of truth and the legacy
// `settings.timezone` JSONB key as a non-destructive fallback (issue #1318).
// canonicalizeTimezone folds a non-canonical stored 'utc' to the 'UTC' sentinel
// so it is treated as "still at the default" rather than an explicit choice.
function parsePartnerTimezone(column: string | null | undefined, settings: unknown): string | null {
  const canonicalColumn = canonicalizeTimezone(column);
  if (canonicalColumn !== null && canonicalColumn !== 'UTC') return canonicalColumn;
  const fromSettings = parseOrgTimezone(settings);
  if (fromSettings) return fromSettings;
  return canonicalColumn;
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
  assignmentTargetId: string,
  policyOrgId: string
): Promise<string[]> {
  switch (assignmentLevel) {
    case 'device': {
      const [device] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.id, assignmentTargetId), eq(devices.orgId, policyOrgId)))
        .limit(1);
      return device ? [device.id] : [];
    }

    case 'device_group': {
      const members = await db
        .select({ deviceId: deviceGroupMemberships.deviceId })
        .from(deviceGroupMemberships)
        .where(
          and(
            eq(deviceGroupMemberships.groupId, assignmentTargetId),
            eq(deviceGroupMemberships.orgId, policyOrgId)
          )
        );
      return members.map((m) => m.deviceId);
    }

    case 'site': {
      const siteDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.siteId, assignmentTargetId), eq(devices.orgId, policyOrgId)));
      return siteDevices.map((d) => d.id);
    }

    case 'organization': {
      const orgDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.orgId, assignmentTargetId), eq(devices.orgId, policyOrgId)));
      return orgDevices.map((d) => d.id);
    }

    case 'partner': {
      const partnerDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .innerJoin(organizations, eq(devices.orgId, organizations.id))
        .where(
          and(
            eq(organizations.partnerId, assignmentTargetId),
            eq(devices.orgId, policyOrgId)
          )
        );
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
      partnerTimezone: partners.timezone,
      partnerSettings: partners.settings,
    })
    .from(devices)
    .innerJoin(organizations, eq(devices.orgId, organizations.id))
    // leftJoin (not inner) on partners: the partners SELECT RLS policy is
    // breeze_has_partner_access(id), which is FALSE for an org-scoped request,
    // so an inner join would drop the entire device row when the partner row is
    // RLS-invisible. This worker runs under system scope (partners visible), but
    // a left join is the correct, defensive shape: if the partner row is ever
    // invisible the device still gets a context, with partnerTimezone null so
    // resolveEffectiveTimezone falls through site -> org -> UTC (#1318).
    .leftJoin(partners, eq(organizations.partnerId, partners.id))
    .leftJoin(sites, eq(devices.siteId, sites.id))
    .where(inArray(devices.id, deviceIds));

  return rows.map((row) => ({
    deviceId: row.deviceId,
    orgId: row.orgId,
    // explicit (n/a) -> site -> org -> partner -> UTC (issue #1318). The
    // resolver IANA-validates each candidate, so normalizeTimezone here just
    // guards the (already-valid) result for the older call shape.
    //
    // BEHAVIORAL CHANGE (intended): adding the `partner` branch means an
    // existing device under a partner that has set a non-UTC tz now has its
    // patch window evaluated in partner-LOCAL time instead of UTC — so its
    // scheduled patch occurrence effectively shifts on upgrade. This is the
    // explicit intent of #1318 (partner tz is the default), not a regression.
    // Partners left at the 'UTC' default are unaffected.
    timezone: normalizeTimezone(
      resolveEffectiveTimezone({
        siteTz: row.siteTimezone,
        orgTz: parseOrgTimezone(row.orgSettings),
        partnerTz: parsePartnerTimezone(row.partnerTimezone, row.partnerSettings),
      }),
    ),
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

async function scanAndCreateJobs(): Promise<{
  created: number;
  scanned: number;
  enqueueJobIds: string[];
  staleScheduledJobs: StaleScheduledJob[];
}> {
  const now = new Date();
  let created = 0;
  // Job ids to enqueue to Redis AFTER the system DB access-context transaction
  // closes. Enqueuing inside it held the pooled connection idle-in-transaction
  // across BullMQ/Redis round-trips — a contributor to the #1105 pool-poisoning
  // pattern (txn around slow non-DB work). DB writes stay in the context; the
  // Redis enqueue happens outside it (see the worker processor).
  const enqueueJobIds: string[] = [];

  const patchPoliciesWithSchedules = await db
    .select({
      configPolicyId: configurationPolicies.id,
      policyName: configurationPolicies.name,
      policyOrgId: configurationPolicies.orgId,
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
      // Partner-owned policies (org_id NULL, #1724) cannot carry a patch
      // feature link — the feature-link route rejects 'patch' on partner-wide
      // policies (ORG_SCOPED_ONLY_FEATURES), so this query never returns one.
      // The guard is a defensive backstop; it never skips real work.
      if (row.policyOrgId === null) continue;

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
        const ids = await resolveDeviceIdsForAssignment(assignment.level, assignment.targetId, row.policyOrgId);
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
            patches: buildPatchesSnapshot(policyLocal),
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
          enqueueJobIds.push(job.id);
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

  // Orphan-recovery read (#1733): collect `scheduled` patch_jobs rows whose
  // intended run time has passed (plus grace) so the worker can re-enqueue any
  // whose Redis job was lost in the create->enqueue gap. This is a DB-only read;
  // the queue-state check + re-enqueue happen outside this DB access context
  // (see the worker). A failure here silently disables the backstop, so surface
  // it to Sentry, not just the console (#1379 worker-observability convention).
  let staleScheduledJobs: StaleScheduledJob[] = [];
  try {
    staleScheduledJobs = await selectStaleScheduledJobIds(now);
  } catch (err) {
    const message = '[PatchScheduler] Failed to read stale scheduled jobs for reconcile';
    console.error(`${message}:`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(message));
  }

  return {
    created,
    scanned: patchPoliciesWithSchedules.length,
    enqueueJobIds,
    staleScheduledJobs,
  };
}

// Post-scan Redis work, run OUTSIDE the system DB access context (#1105): all
// DB writes committed when scanAndCreateJobs returned, so doing the BullMQ
// round-trips here keeps the pooled connection from sitting idle-in-transaction.
// Two phases:
//   1. Enqueue the just-created jobs.
//   2. Orphan-recovery sweep (#1733). The create->enqueue gap is not atomic: a
//      process restart or Redis-connection drop between the DB commit and
//      enqueuePatchJob leaves the patch_jobs row status='scheduled' with no
//      queue job, and the occurrence-idempotency guard stops the next scan from
//      ever re-creating it. We re-enqueue any `scheduled` row whose run time has
//      passed (past the grace window) that has no active queue job, preserving
//      the remaining delay so a future-scheduled job recovered early still waits
//      for its window. Just-created ids are also in this list, but they were
//      enqueued moments ago so the filter normally sees their active job and
//      skips them; in the rare case a just-created job already completed, the
//      status re-check in processExecutePatchJob makes the redundant enqueue a
//      no-op. enqueuePatchJob is idempotent on the stable jobId.
//
// Observability (#1379): failing to recover an orphan, or a non-zero recovery
// count (the #1733 race is actively firing in prod), is surfaced to Sentry —
// console-only logging is not observable in this stack.
async function enqueueScanResults(
  result: {
    enqueueJobIds: string[];
    staleScheduledJobs: StaleScheduledJob[];
  },
  now: Date = new Date()
): Promise<{ enqueued: number; recovered: number }> {
  let enqueued = 0;
  for (const jobId of result.enqueueJobIds) {
    try {
      await enqueuePatchJob(jobId);
      enqueued += 1;
    } catch (err) {
      console.error(
        `[PatchScheduler] Failed to enqueue patch job ${jobId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  let recovered = 0;
  try {
    const orphaned = await filterOrphanedJobIds(result.staleScheduledJobs);
    for (const job of orphaned) {
      try {
        // Preserve any remaining delay: a future-scheduled orphan (POST route)
        // recovered before its window must still wait, not fire immediately.
        const delayMs = job.scheduledAt
          ? Math.max(0, job.scheduledAt.getTime() - now.getTime())
          : 0;
        await enqueuePatchJob(job.id, delayMs || undefined);
        recovered += 1;
        console.warn(`[PatchScheduler] Re-enqueued orphaned scheduled patch job ${job.id} (#1733 recovery)`);
      } catch (err) {
        const message = `[PatchScheduler] Failed to re-enqueue orphaned patch job ${job.id} (#1733 recovery)`;
        console.error(`${message}:`, err instanceof Error ? err.message : err);
        // A recovery enqueue that fails means a silently-lost run stays lost —
        // page-worthy, surface it.
        captureException(err instanceof Error ? err : new Error(message));
      }
    }
  } catch (err) {
    const message = '[PatchScheduler] Orphan-reconcile sweep failed';
    console.error(`${message}:`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(message));
  }

  if (recovered > 0) {
    // A non-zero recovery means the #1733 create->enqueue race fired in prod and
    // we backstopped it. Surface as a warning-level Sentry signal so the rate is
    // observable (vs. only living in container logs).
    captureException(
      new Error(`[PatchScheduler] Recovered ${recovered} orphaned scheduled patch job(s) — #1733 race active`)
    );
  }

  return { enqueued, recovered };
}

function createSchedulerWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (_job: Job) => {
      const result = await runWithSystemDbAccess(async () => {
        try {
          return await scanAndCreateJobs();
        } catch (error: unknown) {
          if (isRelationNotFoundError(error)) {
            if (!_configPolicyTableWarningLogged) {
              _configPolicyTableWarningLogged = true;
              console.warn('[PatchScheduler] Config policy tables not found — run "pnpm db:migrate" to create them. Skipping patch schedule scan.');
            }
            return { created: 0, scanned: 0, enqueueJobIds: [], staleScheduledJobs: [] };
          }
          throw error;
        }
      });

      const { recovered } = await enqueueScanResults(result);

      return { created: result.created, scanned: result.scanned, recovered };
    },
    {
      connection: getBullMQConnection(),
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
  attachWorkerObservability(schedulerWorker, 'patchSchedulerWorker');

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

// Exported for unit tests of the partner-tz scheduling-context resolution
// (#1318). Internal helper, not part of the worker's public surface.
export const __testOnly = {
  loadDeviceSchedulingContexts,
  enqueueScanResults,
};
