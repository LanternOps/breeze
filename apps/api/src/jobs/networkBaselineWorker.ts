import { Job, Queue, Worker } from 'bullmq';
import { and, eq, lt, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import {
  discoveryJobs,
  discoveryProfiles,
  networkBaselines,
  networkChangeEvents
} from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { compareBaselineScan, normalizeBaselineScanSchedule } from '../services/networkBaseline';
import { enqueueDiscoveryScan, type DiscoveredHostResult } from './discoveryWorker';
import { createDiscoveryJobIfIdle } from '../services/discoveryJobCreation';
import { attachWorkerObservability } from './workerObservability';
import {
  resolveBaselineDispatchAuthority,
  type BaselineBlockedReason
} from '../services/networkBaselineAuthority';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[NetworkBaselineWorker] withSystemDbAccessContext is not available — DB module may not have loaded correctly');
  }
  return dbModule.withSystemDbAccessContext(fn);
};

const NETWORK_BASELINE_QUEUE = 'network-baseline';

interface ScheduleBaselineScansJobData {
  type: 'schedule-baseline-scans';
}

interface ExecuteBaselineScanJobData {
  type: 'execute-baseline-scan';
  baselineId: string;
  orgId: string;
  siteId: string;
  subnet: string;
  /**
   * SEC-2026-09-05-146. `schedule` = the recurring planner issued this tick and
   * it must match `authorityGeneration` exactly. `manual` = an interactive
   * operator scan, already authorized live by the request that triggered it, so
   * it carries no generation. An absent trigger is a pre-upgrade payload still
   * sitting in Redis and is treated as `schedule` — fail closed.
   */
  trigger?: 'schedule' | 'manual';
  authorityGeneration?: number;
}

interface CompareBaselineJobData {
  type: 'compare-baseline';
  baselineId: string;
  orgId: string;
  siteId: string;
  jobId: string;
  hosts: DiscoveredHostResult[];
}

interface PruneChangeEventsJobData {
  type: 'prune-change-events';
}

type NetworkBaselineJobData =
  | ScheduleBaselineScansJobData
  | ExecuteBaselineScanJobData
  | CompareBaselineJobData
  | PruneChangeEventsJobData;

let networkBaselineQueue: Queue | null = null;
let networkBaselineWorkerInstance: Worker<NetworkBaselineJobData> | null = null;

export function getNetworkBaselineQueue(): Queue {
  if (!networkBaselineQueue) {
    networkBaselineQueue = new Queue(NETWORK_BASELINE_QUEUE, {
      connection: getBullMQConnection()
    });
  }
  return networkBaselineQueue;
}

function createNetworkBaselineWorker(): Worker<NetworkBaselineJobData> {
  return new Worker<NetworkBaselineJobData>(
    NETWORK_BASELINE_QUEUE,
    async (job: Job<NetworkBaselineJobData>) => {
      return runWithSystemDbAccess(async () => {
        switch (job.data.type) {
          case 'schedule-baseline-scans':
            return processScheduleScans();
          case 'execute-baseline-scan':
            return processExecuteScan(job.data);
          case 'compare-baseline':
            return processCompareBaseline(job.data);
          case 'prune-change-events':
            return handlePruneChangeEvents();
          default:
            throw new Error(`Unknown network baseline job type: ${(job.data as { type: string }).type}`);
        }
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 5,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    }
  );
}

async function processScheduleScans(): Promise<{ enqueued: number; blocked: number }> {
  const now = new Date();

  const dueBaselines = await db
    .select({
      id: networkBaselines.id,
      orgId: networkBaselines.orgId,
      siteId: networkBaselines.siteId,
      subnet: networkBaselines.subnet,
      scanSchedule: networkBaselines.scanSchedule,
      authorityUserId: networkBaselines.authorityUserId,
      authoritySiteIds: networkBaselines.authoritySiteIds,
      authorityPermissionsEpoch: networkBaselines.authorityPermissionsEpoch,
      authorityMfaEpoch: networkBaselines.authorityMfaEpoch,
      authorityFingerprint: networkBaselines.authorityFingerprint,
      authorityGeneration: networkBaselines.authorityGeneration
    })
    .from(networkBaselines)
    .where(
      sql`COALESCE((${networkBaselines.scanSchedule}->>'enabled')::boolean, false) = true
          AND COALESCE((${networkBaselines.scanSchedule}->>'nextScanAt')::timestamptz, now()) <= ${now.toISOString()}::timestamptz`
    );

  if (dueBaselines.length === 0) {
    return { enqueued: 0, blocked: 0 };
  }

  const queue = getNetworkBaselineQueue();

  let enqueued = 0;
  let blocked = 0;
  for (const baseline of dueBaselines) {
    try {
      const schedule = normalizeBaselineScanSchedule(baseline.scanSchedule);

      // SEC-146: an enabled schedule is only a REQUEST to scan. The authority
      // that armed it must still resolve before anything is enqueued, so a
      // revoked schedule produces no Redis effect at all — not merely a job
      // that later declines to run.
      const decision = await resolveBaselineDispatchAuthority(baseline, {
        expectedGeneration: baseline.authorityGeneration
      });
      if (!decision.allowed) {
        blocked++;
        await recordScheduleBlocked(baseline.id, decision.reason);
        // Still advance nextScanAt: a blocked baseline must not be re-evaluated
        // every 15 minutes forever, and must not starve the rest of the tick.
        await advanceNextScanAt(baseline.id, schedule);
        continue;
      }

      await queue.add(
        'execute-baseline-scan',
        {
          type: 'execute-baseline-scan',
          baselineId: baseline.id,
          orgId: baseline.orgId,
          siteId: baseline.siteId,
          subnet: baseline.subnet,
          trigger: 'schedule',
          authorityGeneration: baseline.authorityGeneration
        },
        {
          jobId: `baseline-scan-${baseline.id}`,
          removeOnComplete: { count: 50 },
          removeOnFail: { count: 100 }
        }
      );

      enqueued++;

      await advanceNextScanAt(baseline.id, schedule);
    } catch (error) {
      console.error(
        `[NetworkBaselineWorker] Failed to schedule scan for baseline ${baseline.id} (${baseline.subnet}):`,
        error instanceof Error ? error.message : error
      );
      captureException(error);
    }
  }

  if (enqueued > 0) {
    console.log(`[NetworkBaselineWorker] Scheduled ${enqueued} baseline scan job(s)`);
  }
  if (blocked > 0) {
    console.warn(
      `[NetworkBaselineWorker] Skipped ${blocked} due baseline scan(s) whose arming authority no longer resolves (SEC-146)`
    );
  }

  return { enqueued, blocked };
}

/**
 * Record why a recurring schedule was not dispatched. Surfaced to operators on
 * the network baseline page; the existing enable/save control re-arms it.
 */
async function recordScheduleBlocked(baselineId: string, reason: BaselineBlockedReason): Promise<void> {
  console.warn(`[NetworkBaselineWorker] Baseline ${baselineId} recurring scan blocked: ${reason} (SEC-146)`);
  await db
    .update(networkBaselines)
    .set({ scheduleBlockedReason: reason, updatedAt: new Date() })
    .where(eq(networkBaselines.id, baselineId));
}

async function advanceNextScanAt(
  baselineId: string,
  schedule: ReturnType<typeof normalizeBaselineScanSchedule>
): Promise<void> {
  const nextScanAt = new Date(Date.now() + schedule.intervalHours * 60 * 60 * 1000).toISOString();
  await db
    .update(networkBaselines)
    .set({
      scanSchedule: { ...schedule, nextScanAt },
      updatedAt: new Date()
    })
    .where(eq(networkBaselines.id, baselineId));
}

export async function processExecuteScan(data: ExecuteBaselineScanJobData): Promise<{
  queued: boolean;
  discoveryJobId: string | null;
  blockedReason?: BaselineBlockedReason;
}> {
  // SEC-146: lock the baseline row for the remainder of this job's transaction
  // (the worker's withSystemDbAccessContext IS the transaction) before deciding
  // anything. A concurrent re-arm or disable then serialises against this read
  // instead of racing it, and the authority resolution below observes state that
  // cannot change underneath the dispatch.
  const [baseline] = await db
    .select()
    .from(networkBaselines)
    .where(eq(networkBaselines.id, data.baselineId))
    .limit(1)
    .for('update');

  if (!baseline) {
    console.warn(`[NetworkBaselineWorker] Baseline ${data.baselineId} not found — may have been deleted. Skipping scan.`);
    return { queued: false, discoveryJobId: null };
  }

  // SEC-146: the recurring gate answers "may this schedule keep firing with
  // nobody watching". An interactive "Scan Now" is a live request that
  // POST /network/baselines/:id/scan already authorized (org reach + site
  // ceiling + devices:write), so it is NOT subject to the envelope, schedule-
  // enabled or generation checks — running them there broke manual scans for
  // exactly the baselines an operator most needs to reach: paused ones and every
  // legacy row awaiting re-approval. A manual run also never writes
  // scheduleBlockedReason, in either direction: it must neither block a schedule
  // nor silently clear a block the recurring path recorded.
  //
  // An absent trigger is a pre-upgrade queue payload: treat it as scheduled with
  // no generation, so a legacy row (no envelope) fails closed.
  const isScheduled = data.trigger !== 'manual';

  if (isScheduled) {
    const decision = await resolveBaselineDispatchAuthority(baseline, {
      expectedGeneration:
        typeof data.authorityGeneration === 'number' ? data.authorityGeneration : null
    });

    if (!decision.allowed) {
      // No discovery job, no auto-created profile, no Redis effect — and no
      // throw, so one revoked baseline never takes down the tick.
      console.warn(
        `[NetworkBaselineWorker] Baseline ${baseline.id} dispatch denied: ${decision.reason} (SEC-146)`
      );
      await db
        .update(networkBaselines)
        .set({ scheduleBlockedReason: decision.reason, updatedAt: new Date() })
        .where(eq(networkBaselines.id, baseline.id));
      return { queued: false, discoveryJobId: null, blockedReason: decision.reason };
    }
  }

  let [profile] = await db
    .select()
    .from(discoveryProfiles)
    .where(
      and(
        eq(discoveryProfiles.orgId, baseline.orgId),
        eq(discoveryProfiles.siteId, baseline.siteId),
        sql`${discoveryProfiles.subnets} @> ARRAY[${baseline.subnet}]::text[]`
      )
    )
    .limit(1);

  if (!profile) {
    const [createdProfile] = await db
      .insert(discoveryProfiles)
      .values({
        orgId: baseline.orgId,
        siteId: baseline.siteId,
        name: `Baseline Scan ${baseline.subnet}`,
        description: `Auto-created profile for network baseline ${baseline.subnet}`,
        enabled: true,
        subnets: [baseline.subnet],
        excludeIps: [],
        methods: ['arp', 'ping'] as typeof discoveryProfiles.$inferInsert.methods,
        portRanges: null,
        snmpCommunities: [],
        snmpCredentials: null,
        schedule: { type: 'manual' },
        deepScan: false,
        identifyOS: false,
        resolveHostnames: true,
        timeout: 2,
        concurrency: 128,
        createdBy: null
      })
      .returning();

    profile = createdProfile;
  }

  if (!profile) {
    throw new Error(`Unable to resolve discovery profile for baseline ${baseline.id}`);
  }

  const created = await createDiscoveryJobIfIdle({
    profileId: profile.id,
    orgId: baseline.orgId,
    siteId: baseline.siteId,
  });

  const discoveryJob = created?.job;
  if (!discoveryJob) {
    throw new Error(`Failed to create discovery job for baseline ${baseline.id}`);
  }

  if (created.created) {
    try {
      await enqueueDiscoveryScan(
        discoveryJob.id,
        profile.id,
        baseline.orgId,
        baseline.siteId,
        null
      );
    } catch (error) {
      await db
        .update(discoveryJobs)
        .set({
          status: 'failed',
          completedAt: new Date(),
          errors: { message: 'Failed to enqueue baseline discovery scan' },
          updatedAt: new Date()
        })
        .where(eq(discoveryJobs.id, discoveryJob.id));

      throw error;
    }
  }

  await db
    .update(networkBaselines)
    .set({
      lastScanJobId: discoveryJob.id,
      // Only a recurring dispatch that passed the gate may clear the block — a
      // manual scan proves nothing about the schedule's authority.
      ...(isScheduled ? { scheduleBlockedReason: null } : {}),
      updatedAt: new Date()
    })
    .where(eq(networkBaselines.id, baseline.id));

  return {
    queued: true,
    discoveryJobId: discoveryJob.id
  };
}

async function processCompareBaseline(data: CompareBaselineJobData) {
  return compareBaselineScan({
    baselineId: data.baselineId,
    orgId: data.orgId,
    siteId: data.siteId,
    jobId: data.jobId,
    hosts: data.hosts ?? []
  });
}

/**
 * Prune expired change events based on each profile's changeRetentionDays setting.
 */
async function handlePruneChangeEvents(): Promise<{ totalDeleted: number }> {
  const profiles = await db
    .select({ id: discoveryProfiles.id, alertSettings: discoveryProfiles.alertSettings })
    .from(discoveryProfiles)
    .where(sql`${discoveryProfiles.alertSettings}->>'enabled' = 'true'`);

  let totalDeleted = 0;
  for (const profile of profiles) {
    const settings = profile.alertSettings as { changeRetentionDays?: number } | null;
    const days = settings?.changeRetentionDays ?? 90;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const deleted = await db.delete(networkChangeEvents).where(
      and(
        eq(networkChangeEvents.profileId, profile.id),
        lt(networkChangeEvents.detectedAt, cutoff)
      )
    ).returning({ id: networkChangeEvents.id });
    totalDeleted += deleted.length;
  }
  console.log(`[NetworkBaselineWorker] Pruned ${totalDeleted} expired change events`);
  return { totalDeleted };
}

async function scheduleRecurringScanPlanner(): Promise<void> {
  const queue = getNetworkBaselineQueue();

  // Add the new repeatable job first, so a scheduler always exists
  const newJob = await queue.add(
    'schedule-baseline-scans',
    { type: 'schedule-baseline-scans' as const },
    {
      repeat: {
        every: 15 * 60 * 1000
      },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 20 }
    }
  );

  // Then remove stale repeatable entries (any that aren't the one we just created)
  const repeatable = await queue.getRepeatableJobs();
  for (const job of repeatable) {
    if (job.name === 'schedule-baseline-scans' && job.key !== newJob.repeatJobKey) {
      await queue.removeRepeatableByKey(job.key);
    }
  }
}

export async function enqueueBaselineScan(
  baselineId: string,
  orgId: string,
  siteId: string,
  subnet: string
): Promise<string> {
  const queue = getNetworkBaselineQueue();
  const job = await queue.add(
    'execute-baseline-scan',
    {
      type: 'execute-baseline-scan',
      baselineId,
      orgId,
      siteId,
      subnet,
      // Interactive operator scan: authorized live by the request that triggered
      // it, so it carries no recurring-authority generation. The dispatch gate
      // still runs — it just does not require a generation match.
      trigger: 'manual'
    },
    {
      jobId: `baseline-scan-${baselineId}`,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 }
    }
  );

  if (!job.id) {
    throw new Error('BullMQ returned a job without an ID');
  }
  return job.id;
}

export async function enqueueBaselineComparison(
  baselineId: string,
  jobId: string,
  orgId: string,
  siteId: string,
  hosts: DiscoveredHostResult[]
): Promise<string> {
  const queue = getNetworkBaselineQueue();
  const job = await queue.add(
    'compare-baseline',
    {
      type: 'compare-baseline',
      baselineId,
      jobId,
      orgId,
      siteId,
      hosts
    },
    {
      jobId: `baseline-compare:${baselineId}:${jobId}`,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 }
    }
  );

  if (!job.id) {
    throw new Error('BullMQ returned a job without an ID');
  }
  return job.id;
}

export async function initializeNetworkBaselineWorker(): Promise<void> {
  networkBaselineWorkerInstance = createNetworkBaselineWorker();
  attachWorkerObservability(networkBaselineWorkerInstance, 'networkBaselineWorker');

  networkBaselineWorkerInstance.on('error', (error) => {
    console.error('[NetworkBaselineWorker] Worker error:', error);
    captureException(error);
  });

  networkBaselineWorkerInstance.on('failed', (job, error) => {
    console.error(`[NetworkBaselineWorker] Job ${job?.id} failed:`, error);
    captureException(error);
  });

  await scheduleRecurringScanPlanner();

  console.log('[NetworkBaselineWorker] Network baseline worker initialized');
}

export async function shutdownNetworkBaselineWorker(): Promise<void> {
  if (networkBaselineWorkerInstance) {
    await networkBaselineWorkerInstance.close();
    networkBaselineWorkerInstance = null;
  }

  if (networkBaselineQueue) {
    await networkBaselineQueue.close();
    networkBaselineQueue = null;
  }

  console.log('[NetworkBaselineWorker] Network baseline worker shut down');
}
