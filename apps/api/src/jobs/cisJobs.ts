import { Job, Queue, Worker } from 'bullmq';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import {
  cisBaselines,
  cisRemediationActions,
  devices,
} from '../db/schema';
import { queueCommand } from '../services/commandQueue';
import { normalizeCisSchedule } from '../services/cisHardening';
import { seedDefaultCisCheckCatalog } from '../services/cisCatalog';
import { publishEvent } from '../services/eventBus';
import { getRedisConnection } from '../services/redis';
import { captureException } from '../services/sentry';

const { db } = dbModule;

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem === 'function') {
    return withSystem(fn);
  }
  console.warn('[CisJobs] withSystemDbAccessContext not available, running without system context');
  return fn();
};

const CIS_QUEUE = 'cis-hardening';
const CIS_SCAN_COMMAND = 'cis_benchmark';
const CIS_REMEDIATION_COMMAND = 'apply_cis_remediation';
// Devices with score below this threshold are considered non-compliant for aggregation
const CIS_COMPLIANCE_THRESHOLD = 80;

type ScheduleScansJobData = {
  type: 'schedule-scans';
};

type RunBaselineScanJobData = {
  type: 'run-baseline-scan';
  baselineId: string;
  requestedBy?: string | null;
  deviceIds?: string[];
  origin?: 'scheduled' | 'manual';
};

type AggregateScoresJobData = {
  type: 'aggregate-scores';
};

type RemediateActionJobData = {
  type: 'remediate-action';
  actionId: string;
};

type CisJobData =
  | ScheduleScansJobData
  | RunBaselineScanJobData
  | AggregateScoresJobData
  | RemediateActionJobData;

let cisQueue: Queue<CisJobData> | null = null;
let cisWorker: Worker<CisJobData> | null = null;

export function getCisQueue(): Queue<CisJobData> {
  if (!cisQueue) {
    cisQueue = new Queue<CisJobData>(CIS_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return cisQueue;
}

async function processScheduleScans(): Promise<{ enqueued: number }> {
  const now = new Date();
  const dueBaselines = await db
    .select({
      id: cisBaselines.id,
      scanSchedule: cisBaselines.scanSchedule,
    })
    .from(cisBaselines)
    .where(
      and(
        eq(cisBaselines.isActive, true),
        sql`COALESCE((${cisBaselines.scanSchedule}->>'enabled')::boolean, true) = true`,
        sql`COALESCE((${cisBaselines.scanSchedule}->>'nextScanAt')::timestamptz, now()) <= ${now.toISOString()}::timestamptz`
      )
    );

  if (dueBaselines.length === 0) {
    return { enqueued: 0 };
  }

  const queue = getCisQueue();
  // Hourly slot used as jobId suffix to deduplicate scans within the same scheduling window
  const slot = Math.floor(Date.now() / (60 * 60 * 1000));
  let enqueued = 0;

  for (const baseline of dueBaselines) {
    try {
      await queue.add(
        'run-baseline-scan',
        {
          type: 'run-baseline-scan',
          baselineId: baseline.id,
          origin: 'scheduled',
        },
        {
          jobId: `cis-scan-${baseline.id}-${slot}`,
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 200 },
          attempts: 2,
          backoff: { type: 'exponential', delay: 5000 },
        }
      );
      enqueued++;

      const schedule = normalizeCisSchedule(baseline.scanSchedule);
      await db
        .update(cisBaselines)
        .set({
          scanSchedule: {
            ...schedule,
            nextScanAt: new Date(now.getTime() + schedule.intervalHours * 60 * 60 * 1000).toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(eq(cisBaselines.id, baseline.id));
    } catch (error) {
      console.error(`[CisJobs] processScheduleScans: failed to enqueue baseline ${baseline.id}:`, error);
      captureException(error);
    }
  }

  return { enqueued };
}

async function processRunBaselineScan(data: RunBaselineScanJobData): Promise<{
  baselineId: string;
  devicesTargeted: number;
  commandsQueued: number;
}> {
  const [baseline] = await db
    .select()
    .from(cisBaselines)
    .where(and(
      eq(cisBaselines.id, data.baselineId),
      eq(cisBaselines.isActive, true),
    ))
    .limit(1);

  if (!baseline) {
    console.warn(
      `[CisJobs] processRunBaselineScan: baseline ${data.baselineId} not found or inactive (origin: ${data.origin ?? 'unknown'})`,
    );
    return {
      baselineId: data.baselineId,
      devicesTargeted: 0,
      commandsQueued: 0,
    };
  }

  const deviceConditions = [
    eq(devices.orgId, baseline.orgId),
    eq(devices.osType, baseline.osType),
    ne(devices.status, 'decommissioned'),
  ];

  if (Array.isArray(data.deviceIds) && data.deviceIds.length > 0) {
    deviceConditions.push(inArray(devices.id, data.deviceIds));
  }

  const rows = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(...deviceConditions));

  let commandsQueued = 0;
  const uniqueDeviceIds = Array.from(new Set(rows.map((row) => row.id)));
  for (const deviceId of uniqueDeviceIds) {
    try {
      await queueCommand(
        deviceId,
        CIS_SCAN_COMMAND,
        {
          source: 'cis_hardening',
          baselineId: baseline.id,
          orgId: baseline.orgId,
          benchmarkVersion: baseline.benchmarkVersion,
          level: baseline.level,
          customExclusions: baseline.customExclusions ?? [],
        },
        data.requestedBy ?? undefined
      );
      commandsQueued++;
    } catch (error) {
      console.error(`[CisJobs] processRunBaselineScan: failed to queue command for device ${deviceId}:`, error);
      captureException(error);
    }
  }

  return {
    baselineId: baseline.id,
    devicesTargeted: uniqueDeviceIds.length,
    commandsQueued,
  };
}

async function processAggregateScores(): Promise<{ orgsProcessed: number }> {
  const snapshotRows = await db.execute(sql<{
    org_id: string;
    current_average_score: number | null;
    previous_average_score: number | null;
    devices_audited: number;
    non_compliant_devices: number;
  }>`
    WITH ranked AS (
      SELECT
        org_id,
        device_id,
        score,
        row_number() OVER (PARTITION BY org_id, device_id, baseline_id ORDER BY checked_at DESC) AS rn
      FROM cis_baseline_results
    ),
    aggregated AS (
      SELECT
        org_id,
        AVG(CASE WHEN rn = 1 THEN score END)::numeric(6,2) AS current_average_score,
        AVG(CASE WHEN rn = 2 THEN score END)::numeric(6,2) AS previous_average_score,
        COUNT(*) FILTER (WHERE rn = 1)::int AS devices_audited,
        SUM(CASE WHEN rn = 1 AND score < ${CIS_COMPLIANCE_THRESHOLD} THEN 1 ELSE 0 END)::int AS non_compliant_devices
      FROM ranked
      WHERE rn <= 2
      GROUP BY org_id
    )
    SELECT
      org_id,
      current_average_score,
      previous_average_score,
      devices_audited,
      non_compliant_devices
    FROM aggregated
  `);

  const rows = snapshotRows as unknown as Array<{
    org_id: string;
    current_average_score: number | null;
    previous_average_score: number | null;
    devices_audited: number;
    non_compliant_devices: number;
  }>;

  for (const row of rows) {
    const currentAverageScore = Number(row.current_average_score ?? 0);
    const previousAverageScore = row.previous_average_score === null
      ? null
      : Number(row.previous_average_score);
    if (previousAverageScore === null || previousAverageScore === currentAverageScore) {
      continue;
    }

    try {
      await publishEvent(
        'compliance.cis_score_changed',
        row.org_id,
        {
          averageScore: currentAverageScore,
          previousAverageScore,
          delta: currentAverageScore - previousAverageScore,
          devicesAudited: Number(row.devices_audited ?? 0),
          nonCompliantDevices: Number(row.non_compliant_devices ?? 0),
          capturedAt: new Date().toISOString(),
          source: 'cis-score-aggregator',
        },
        'cis-score-aggregator'
      );
    } catch (error) {
      console.error('[CisJobs] Failed to publish compliance.cis_score_changed event:', error);
      captureException(error);
    }
  }

  return { orgsProcessed: rows.length };
}

async function processRemediationAction(data: RemediateActionJobData): Promise<{
  actionId: string;
  queued: boolean;
  commandId: string | null;
}> {
  const [action] = await db
    .select()
    .from(cisRemediationActions)
    .where(eq(cisRemediationActions.id, data.actionId))
    .limit(1);

  if (!action) {
    console.warn(`[CisJobs] processRemediationAction: action ${data.actionId} not found`);
    return { actionId: data.actionId, queued: false, commandId: null };
  }
  if (action.status !== 'queued' || action.approvalStatus !== 'approved') {
    console.warn(
      `[CisJobs] processRemediationAction: action ${data.actionId} not eligible (status=${action.status}, approvalStatus=${action.approvalStatus})`,
    );
    return { actionId: data.actionId, queued: false, commandId: null };
  }

  let command;
  try {
    command = await queueCommand(
      action.deviceId,
      CIS_REMEDIATION_COMMAND,
      {
        source: 'cis_hardening',
        actionId: action.id,
        baselineId: action.baselineId,
        baselineResultId: action.baselineResultId,
        checkId: action.checkId,
        action: action.action,
        details: action.details ?? {},
      },
      action.requestedBy ?? undefined
    );
  } catch (error) {
    console.error(`[CisJobs] processRemediationAction: failed to queue command for action ${action.id}:`, error);
    captureException(error);
    await db
      .update(cisRemediationActions)
      .set({
        status: 'failed',
        details: {
          ...(action.details ?? {}),
          queueError: error instanceof Error ? error.message : 'Queue unavailable',
          queueFailedAt: new Date().toISOString(),
        },
      })
      .where(eq(cisRemediationActions.id, action.id));
    return { actionId: action.id, queued: false, commandId: null };
  }

  await db
    .update(cisRemediationActions)
    .set({
      status: 'in_progress',
      commandId: command.id,
      details: {
        ...(action.details ?? {}),
        queuedAt: new Date().toISOString(),
      },
    })
    .where(eq(cisRemediationActions.id, action.id));

  return {
    actionId: action.id,
    queued: true,
    commandId: command.id,
  };
}

function createCisWorker(): Worker<CisJobData> {
  return new Worker<CisJobData>(
    CIS_QUEUE,
    async (job: Job<CisJobData>) => {
      return runWithSystemDbAccess(async () => {
        switch (job.data.type) {
          case 'schedule-scans':
            return processScheduleScans();
          case 'run-baseline-scan':
            return processRunBaselineScan(job.data);
          case 'aggregate-scores':
            return processAggregateScores();
          case 'remediate-action':
            return processRemediationAction(job.data);
          default:
            throw new Error(`Unknown CIS job type: ${(job.data as { type: string }).type}`);
        }
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 4,
    }
  );
}

async function scheduleRecurringCisJobs(): Promise<void> {
  const queue = getCisQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === 'schedule-scans' || job.name === 'aggregate-scores') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'schedule-scans',
    { type: 'schedule-scans' },
    {
      repeat: { pattern: '0 * * * *' },
      jobId: 'cis-scan-scheduler',
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 20 },
    }
  );

  await queue.add(
    'aggregate-scores',
    { type: 'aggregate-scores' },
    {
      repeat: { pattern: '0 * * * *' },
      jobId: 'cis-score-aggregator',
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 50 },
    }
  );
}

export async function initializeCisJobs(): Promise<void> {
  const seeded = await seedDefaultCisCheckCatalog();
  if (seeded > 0) {
    console.log(`[CisJobs] Seeded ${seeded} CIS check catalog entries`);
  }

  cisWorker = createCisWorker();

  cisWorker.on('error', (error) => {
    console.error('[CisJobs] Worker error:', error);
    captureException(error);
  });

  cisWorker.on('failed', (job, error) => {
    console.error('[CisJobs] Job failed:', { jobId: job?.id, data: job?.data, error });
    captureException(error);
  });

  await scheduleRecurringCisJobs();
  console.log('[CisJobs] Initialized');
}

export async function shutdownCisJobs(): Promise<void> {
  if (cisWorker) {
    await cisWorker.close();
    cisWorker = null;
  }
  if (cisQueue) {
    await cisQueue.close();
    cisQueue = null;
  }
}

export async function scheduleCisScan(
  baselineId: string,
  options: {
    requestedBy?: string | null;
    deviceIds?: string[];
  } = {}
): Promise<string> {
  const queue = getCisQueue();
  const job = await queue.add(
    'run-baseline-scan',
    {
      type: 'run-baseline-scan',
      baselineId,
      requestedBy: options.requestedBy ?? null,
      deviceIds: options.deviceIds,
      origin: 'manual',
    },
    {
      jobId: `cis-manual-scan-${baselineId}-${Date.now()}`,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
    }
  );

  return String(job.id);
}

export type CisRemediationScheduleResult = {
  queuedActionIds: string[];
  failedActionIds: string[];
};

export async function scheduleCisRemediationWithResult(
  actionIds: string[]
): Promise<CisRemediationScheduleResult> {
  const queue = getCisQueue();
  const uniqueActionIds = Array.from(new Set(actionIds.filter((id) => typeof id === 'string' && id.length > 0)));
  const queuedActionIds: string[] = [];
  const failedActionIds: string[] = [];

  for (const actionId of uniqueActionIds) {
    try {
      await queue.add(
        'remediate-action',
        {
          type: 'remediate-action',
          actionId,
        },
        {
          jobId: `cis-remediation-${actionId}`,
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 200 },
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        }
      );
      queuedActionIds.push(actionId);
    } catch (error) {
      failedActionIds.push(actionId);
      console.error(`[CisJobs] Failed to queue remediation action ${actionId}:`, error);
      captureException(error);
    }
  }

  return {
    queuedActionIds,
    failedActionIds,
  };
}

export async function scheduleCisRemediation(actionIds: string[]): Promise<number> {
  const result = await scheduleCisRemediationWithResult(actionIds);
  if (result.failedActionIds.length > 0) {
    throw new Error(`Failed to queue ${result.failedActionIds.length} CIS remediation action(s)`);
  }
  return result.queuedActionIds.length;
}
