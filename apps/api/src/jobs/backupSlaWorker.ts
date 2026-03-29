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
} from '../db/schema';
import { eq, and, sql, isNull, desc } from 'drizzle-orm';
import { getRedisConnection } from '../services/redis';
import { getEventBus } from '../services/eventBus';

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
    slaQueue = new Queue(SLA_QUEUE, { connection: getRedisConnection() });
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
      connection: getRedisConnection(),
      concurrency: 2,
      lockDuration: 120_000,
    }
  );
}

// ── check-compliance ─────────────────────────────────────────────────────────

async function checkCompliance(): Promise<{ checked: number; breaches: number }> {
  const configs = await db
    .select()
    .from(backupSlaConfigs)
    .where(eq(backupSlaConfigs.isActive, true));

  let checked = 0;
  let breaches = 0;

  for (const config of configs) {
    const targetDeviceIds = (config.targetDevices ?? []) as string[];
    if (targetDeviceIds.length === 0) continue;

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
              eq(backupJobs.status, 'completed')
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

        // Missed backup check: no backup job created in the last rpo window
        const windowStart = new Date(Date.now() - config.rpoTargetMinutes * 60_000);
        const [recentJob] = await db
          .select({ id: backupJobs.id })
          .from(backupJobs)
          .where(
            and(
              eq(backupJobs.orgId, config.orgId),
              eq(backupJobs.deviceId, deviceId),
              sql`${backupJobs.createdAt} >= ${windowStart.toISOString()}::timestamptz`
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
    } catch {
      // eventBus may not be initialized in test environments
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
                eq(backupJobs.status, 'completed'),
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
