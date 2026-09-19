/**
 * Backup SLA Worker
 *
 * BullMQ worker that monitors backup SLA compliance:
 * - check-compliance: Evaluates each active SLA config against device backup history
 * - resolve-events: Auto-resolves breach events when conditions are met
 */

import { Worker, Queue, Job } from 'bullmq';
import * as dbModule from '../db';
import {
  backupSlaConfigs,
  backupSlaEvents,
  backupJobs,
  recoveryReadiness,
  deviceGroupMemberships,
  deviceGroups,
  devices,
  RESTORABLE_BACKUP_JOB_STATUSES,
} from '../db/schema';
import { eq, and, sql, isNull, desc, inArray } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';
import { getEventBus } from '../services/eventBus';
import { resolveAllBackupAssignedDevices } from '../services/featureConfigResolver';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const SLA_QUEUE = 'backup-sla';

type SlaJobData =
  | { type: 'check-compliance' }
  | { type: 'resolve-events' };

// ── Queue ────────────────────────────────────────────────────────────────────

let slaQueue: Queue | null = null;

function getSlaQueue(): Queue {
  if (!slaQueue) {
    slaQueue = new Queue(SLA_QUEUE, { connection: getBullMQConnection() });
  }
  return slaQueue;
}

// ── Worker ───────────────────────────────────────────────────────────────────

function createSlaWorker(): Worker<SlaJobData> {
  return new Worker<SlaJobData>(
    SLA_QUEUE,
    async (job: Job<SlaJobData>) => {
      return runWithSystemDbAccess(async () => {
        switch (job.data.type) {
          case 'check-compliance':
            return await checkCompliance();
          case 'resolve-events':
            return await resolveEvents();
          default:
            throw new Error(`Unknown SLA job type: ${(job.data as { type: string }).type}`);
        }
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 2,
      lockDuration: 120_000,
    }
  );
}

// ── check-compliance ─────────────────────────────────────────────────────────

/**
 * #3182 — every candidate is clamped to the config's own org here, and the
 * clamp is this function's job alone: this worker runs under
 * `withSystemDbAccessContext`, so RLS is bypassed and nothing downstream will
 * catch a foreign device. `createBreachEvent` stamps events with
 * `config.orgId`, so a device that leaks through is written into the config
 * org's SLA history as though it belonged there.
 *
 * Both target arrays are plain jsonb id lists with no FK behind them, so
 * neither is trustworthy on its own:
 *  - `targetGroups` — a group id is dereferenced through
 *    device_group_memberships, whose rows named a foreign org's group for
 *    free until #3182's composite FK landed (a cross-org device move produced
 *    exactly that shape). The group's OWN org is checked too, not just the
 *    membership's, so a stale row cannot launder a foreign group through a
 *    correctly-stamped membership.
 *  - `targetDevices` — written straight through by POST/PATCH
 *    /backup/sla without an ownership check, so the ids are whatever the
 *    request body said.
 */
export async function resolveTargetDeviceIds(config: typeof backupSlaConfigs.$inferSelect): Promise<string[]> {
  const directDeviceIds = Array.isArray(config.targetDevices)
    ? config.targetDevices.filter((value): value is string => typeof value === 'string')
    : [];
  const groupIds = Array.isArray(config.targetGroups)
    ? config.targetGroups.filter((value): value is string => typeof value === 'string')
    : [];

  const ownedDirectDeviceIds = directDeviceIds.length === 0
    ? []
    : (await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(inArray(devices.id, directDeviceIds), eq(devices.orgId, config.orgId)))
      ).map((row) => row.id);

  if (groupIds.length === 0) {
    return [...new Set(ownedDirectDeviceIds)];
  }

  const memberships = await db
    .select({ deviceId: deviceGroupMemberships.deviceId })
    .from(deviceGroupMemberships)
    .innerJoin(deviceGroups, eq(deviceGroupMemberships.groupId, deviceGroups.id))
    .innerJoin(devices, eq(deviceGroupMemberships.deviceId, devices.id))
    .where(
      and(
        inArray(deviceGroupMemberships.groupId, groupIds),
        eq(deviceGroupMemberships.orgId, config.orgId),
        eq(deviceGroups.orgId, config.orgId),
        eq(devices.orgId, config.orgId),
      ),
    );

  return [...new Set([...ownedDirectDeviceIds, ...memberships.map((row) => row.deviceId)])];
}

async function loadScheduledBackupCoverageByOrg(orgId: string): Promise<Set<string>> {
  const assigned = await resolveAllBackupAssignedDevices(orgId);
  return new Set(
    assigned
      .filter((entry) => {
        const schedule = entry.settings?.schedule as Record<string, unknown> | null | undefined;
        return !!entry.configId
          && schedule
          && typeof schedule.frequency === 'string'
          && typeof schedule.time === 'string';
      })
      .map((entry) => entry.deviceId)
  );
}

export async function checkCompliance(): Promise<{ checked: number; breaches: number }> {
  const configs = await db
    .select()
    .from(backupSlaConfigs)
    .where(eq(backupSlaConfigs.isActive, true));

  let checked = 0;
  let breaches = 0;
  const scheduledCoverageByOrg = new Map<string, Set<string>>();

  for (const config of configs) {
    const targetDeviceIds = await resolveTargetDeviceIds(config);
    if (targetDeviceIds.length === 0) continue;

    let scheduledCoverage = scheduledCoverageByOrg.get(config.orgId);
    if (!scheduledCoverage) {
      try {
        scheduledCoverage = await loadScheduledBackupCoverageByOrg(config.orgId);
      } catch (err) {
        console.error(
          `[SlaWorker] Failed to resolve scheduled backup coverage for org ${config.orgId}:`,
          err instanceof Error ? err.message : err
        );
        continue;
      }
      scheduledCoverageByOrg.set(config.orgId, scheduledCoverage);
    }

    for (const deviceId of targetDeviceIds) {
      checked++;

      try {
        // RPO check: time since last successful backup
        const [lastSuccess] = await db
          .select({ completedAt: backupJobs.completedAt })
          .from(backupJobs)
          .where(
            and(
              eq(backupJobs.orgId, config.orgId),
              eq(backupJobs.deviceId, deviceId),
              inArray(backupJobs.status, RESTORABLE_BACKUP_JOB_STATUSES)
            )
          )
          .orderBy(desc(backupJobs.completedAt))
          .limit(1);

        if (lastSuccess?.completedAt) {
          const minutesSinceBackup = (Date.now() - lastSuccess.completedAt.getTime()) / 60_000;
          if (minutesSinceBackup > config.rpoTargetMinutes) {
            await createBreachEvent(config, deviceId, 'rpo_breach', {
              rpoTargetMinutes: config.rpoTargetMinutes,
              actualMinutes: Math.round(minutesSinceBackup),
              lastBackupAt: lastSuccess.completedAt.toISOString(),
            });
            breaches++;
          }
        } else {
          // No successful backup at all = RPO breach
          await createBreachEvent(config, deviceId, 'rpo_breach', {
            rpoTargetMinutes: config.rpoTargetMinutes,
            actualMinutes: null,
            lastBackupAt: null,
          });
          breaches++;
        }

        // RTO check: compare estimated_rto_minutes from recovery_readiness
        const [readiness] = await db
          .select({ estimatedRtoMinutes: recoveryReadiness.estimatedRtoMinutes })
          .from(recoveryReadiness)
          .where(
            and(
              eq(recoveryReadiness.orgId, config.orgId),
              eq(recoveryReadiness.deviceId, deviceId)
            )
          )
          .limit(1);

        if (readiness?.estimatedRtoMinutes != null) {
          if (readiness.estimatedRtoMinutes > config.rtoTargetMinutes) {
            await createBreachEvent(config, deviceId, 'rto_breach', {
              rtoTargetMinutes: config.rtoTargetMinutes,
              estimatedRtoMinutes: readiness.estimatedRtoMinutes,
            });
            breaches++;
          }
        }

        if (scheduledCoverage.has(deviceId)) {
          // Missed backup check: no successful scheduled backup completed in the last RPO window
          const windowStart = new Date(Date.now() - config.rpoTargetMinutes * 60_000);
          const [recentJob] = await db
            .select({ id: backupJobs.id })
            .from(backupJobs)
            .where(
              and(
                eq(backupJobs.orgId, config.orgId),
                eq(backupJobs.deviceId, deviceId),
                inArray(backupJobs.status, RESTORABLE_BACKUP_JOB_STATUSES),
                sql`${backupJobs.completedAt} >= ${windowStart.toISOString()}::timestamptz`
              )
            )
            .limit(1);

          if (!recentJob) {
            await createBreachEvent(config, deviceId, 'missed_backup', {
              rpoTargetMinutes: config.rpoTargetMinutes,
              windowStart: windowStart.toISOString(),
            });
            breaches++;
          }
        }
      } catch (err) {
        console.error(
          `[SlaWorker] Error checking device ${deviceId} for SLA ${config.id}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  if (breaches > 0) {
    console.log(`[SlaWorker] Compliance check: ${checked} devices, ${breaches} breaches`);
  }

  return { checked, breaches };
}

// ── createBreachEvent (deduplicates against open events) ─────────────────────

async function createBreachEvent(
  config: typeof backupSlaConfigs.$inferSelect,
  deviceId: string,
  eventType: string,
  details: Record<string, unknown>
): Promise<void> {
  // Check for existing unresolved event of same type
  const [existing] = await db
    .select({ id: backupSlaEvents.id })
    .from(backupSlaEvents)
    .where(
      and(
        eq(backupSlaEvents.slaConfigId, config.id),
        eq(backupSlaEvents.deviceId, deviceId),
        eq(backupSlaEvents.eventType, eventType),
        isNull(backupSlaEvents.resolvedAt)
      )
    )
    .limit(1);

  if (existing) return; // Already open

  await db.insert(backupSlaEvents).values({
    orgId: config.orgId,
    slaConfigId: config.id,
    deviceId,
    eventType,
    details,
    detectedAt: new Date(),
  });

  // Publish event if alerting is enabled
  if (config.alertOnBreach) {
    try {
      const eventBus = getEventBus();
      await eventBus.publish(
        'backup.sla_breach',
        config.orgId,
        {
          slaConfigId: config.id,
          slaConfigName: config.name,
          deviceId,
          eventType,
          details,
        },
        'backup-sla-worker',
        { priority: 'high' }
      );
    } catch (err) {
      console.error(
        `[SlaWorker] Failed to publish SLA breach event for device ${deviceId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

// ── resolve-events ───────────────────────────────────────────────────────────

async function resolveEvents(): Promise<{ resolved: number }> {
  const openEvents = await db
    .select()
    .from(backupSlaEvents)
    .where(isNull(backupSlaEvents.resolvedAt))
    .limit(500);

  let resolved = 0;

  for (const event of openEvents) {
    if (!event.deviceId) continue;

    try {
      let shouldResolve = false;

      if (event.eventType === 'rpo_breach' || event.eventType === 'missed_backup') {
        // Resolve if a successful backup now exists within the RPO window
        const [config] = await db
          .select({ rpoTargetMinutes: backupSlaConfigs.rpoTargetMinutes })
          .from(backupSlaConfigs)
          .where(eq(backupSlaConfigs.id, event.slaConfigId))
          .limit(1);

        if (config) {
          const windowStart = new Date(Date.now() - config.rpoTargetMinutes * 60_000);
          const [recentSuccess] = await db
            .select({ id: backupJobs.id })
            .from(backupJobs)
            .where(
              and(
                eq(backupJobs.orgId, event.orgId),
                eq(backupJobs.deviceId, event.deviceId),
                inArray(backupJobs.status, RESTORABLE_BACKUP_JOB_STATUSES),
                sql`${backupJobs.completedAt} >= ${windowStart.toISOString()}::timestamptz`
              )
            )
            .limit(1);

          shouldResolve = !!recentSuccess;
        }
      } else if (event.eventType === 'rto_breach') {
        // Resolve if estimated RTO is now within target
        const [config] = await db
          .select({ rtoTargetMinutes: backupSlaConfigs.rtoTargetMinutes })
          .from(backupSlaConfigs)
          .where(eq(backupSlaConfigs.id, event.slaConfigId))
          .limit(1);

        if (config) {
          const [readiness] = await db
            .select({ estimatedRtoMinutes: recoveryReadiness.estimatedRtoMinutes })
            .from(recoveryReadiness)
            .where(
              and(
                eq(recoveryReadiness.orgId, event.orgId),
                eq(recoveryReadiness.deviceId, event.deviceId)
              )
            )
            .limit(1);

          shouldResolve = readiness != null &&
            readiness.estimatedRtoMinutes != null &&
            readiness.estimatedRtoMinutes <= config.rtoTargetMinutes;
        }
      }

      if (shouldResolve) {
        await db
          .update(backupSlaEvents)
          .set({ resolvedAt: new Date() })
          .where(eq(backupSlaEvents.id, event.id));
        resolved++;
      }
    } catch (err) {
      console.error(
        `[SlaWorker] Error resolving event ${event.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  if (resolved > 0) {
    console.log(`[SlaWorker] Resolved ${resolved} breach event(s)`);
  }

  return { resolved };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

let slaWorkerInstance: Worker<SlaJobData> | null = null;

export async function initializeBackupSlaWorker(): Promise<void> {
  try {
    slaWorkerInstance = createSlaWorker();
    attachWorkerObservability(slaWorkerInstance, 'backupSlaWorker');

    slaWorkerInstance.on('error', (error) => {
      console.error('[SlaWorker] Worker error:', error);
    });

    slaWorkerInstance.on('failed', (job, error) => {
      console.error(`[SlaWorker] Job ${job?.id} failed:`, error);
    });

    const queue = getSlaQueue();

    // Schedule check-compliance (every 5 min)
    const complianceJob = await queue.add(
      'check-compliance',
      { type: 'check-compliance' as const },
      {
        repeat: { every: 5 * 60_000 },
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 20 },
      }
    );

    // Schedule resolve-events (every 10 min)
    const resolveJob = await queue.add(
      'resolve-events',
      { type: 'resolve-events' as const },
      {
        repeat: { every: 10 * 60_000 },
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 20 },
      }
    );

    // Clean up stale repeatable jobs
    const repeatable = await queue.getRepeatableJobs();
    for (const job of repeatable) {
      if (
        (job.name === 'check-compliance' && job.key !== complianceJob.repeatJobKey) ||
        (job.name === 'resolve-events' && job.key !== resolveJob.repeatJobKey)
      ) {
        await queue.removeRepeatableByKey(job.key);
      }
    }

    console.log('[SlaWorker] Backup SLA worker initialized');
  } catch (error) {
    console.error('[SlaWorker] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownBackupSlaWorker(): Promise<void> {
  if (slaWorkerInstance) {
    await slaWorkerInstance.close();
    slaWorkerInstance = null;
  }

  if (slaQueue) {
    await slaQueue.close();
    slaQueue = null;
  }

  console.log('[SlaWorker] Backup SLA worker shut down');
}
