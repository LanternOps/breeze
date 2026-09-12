import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { Job, Queue, Worker } from 'bullmq';

import * as dbModule from '../db';
import { devicePatches, devices, patchComplianceReports, patches, patchSourceEnum, patchSeverityEnum } from '../db/schema';
import { getBullMQConnection, isRedisAvailable } from '../services/redis';
import {
  decodeSiteScope,
  intersectSiteScopes,
  resolveLiveReportAuthority,
  type LiveSiteScopeV1,
  type PersistedSiteScopeColumns,
} from '../services/siteScope';
import { attachWorkerObservability } from './workerObservability';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const PATCH_COMPLIANCE_REPORT_QUEUE = 'patch-compliance-reports';
const PATCH_REPORT_STORAGE_PATH = process.env.PATCH_REPORT_STORAGE_PATH || './data/patch-reports';

/**
 * BullMQ's own job lock. A `running` row whose `started_at` is older than this
 * can no longer be held by a live processor: BullMQ has already released the
 * lock and re-delivered the job, so the database row is stale rather than busy.
 * The reclaim predicate below and the Worker option MUST stay the same value.
 */
export const PATCH_COMPLIANCE_REPORT_LOCK_DURATION_MS = 300_000;

/**
 * Terminal message for a job BullMQ gave up on after `maxStalledCount`. The
 * processor never runs for that delivery, so nothing else would move the row
 * off `running` and the requester would poll a report that can never finish.
 */
const STALLED_FAILURE_MESSAGE =
  'Report generation stalled and was abandoned; request the report again';

type PatchSource = typeof patchSourceEnum.enumValues[number];
type PatchSeverity = typeof patchSeverityEnum.enumValues[number];

export interface GenerateComplianceReportJobData {
  type: 'generate-compliance-report';
  reportId: string;
}

type PatchComplianceReportJobData = GenerateComplianceReportJobData;

type ComplianceSummary = {
  total: number;
  pending: number;
  installed: number;
  failed: number;
  missing: number;
  skipped: number;
  compliancePercent: number;
};

let patchComplianceReportQueue: Queue<PatchComplianceReportJobData> | null = null;
let patchComplianceReportWorker: Worker<PatchComplianceReportJobData> | null = null;

function buildSummaryFromRows(rows: Array<{ status: string; count: number }>): ComplianceSummary {
  const summary = {
    total: 0,
    pending: 0,
    installed: 0,
    failed: 0,
    missing: 0,
    skipped: 0
  };

  for (const row of rows) {
    const count = Number(row.count);
    summary.total += count;

    if (row.status in summary) {
      summary[row.status as keyof typeof summary] = count;
    }
  }

  const compliancePercent = summary.total > 0
    ? Math.round((summary.installed / summary.total) * 100)
    : 100;

  return {
    ...summary,
    compliancePercent
  };
}

async function generateComplianceSummary(
  orgId: string,
  scope: LiveSiteScopeV1,
  source?: PatchSource | null,
  severity?: PatchSeverity | null
): Promise<ComplianceSummary> {
  // Quick Support exclusion: ephemeral devices (`devices.isEphemeral`) live in
  // the hidden per-partner 'quick_support' org and are a stranger's personal
  // machine borrowed for one ~20-minute session. That org stays inside
  // technicians' accessibleOrgIds for RLS reasons, so it is NOT filtered for us
  // — a borrowed home PC must never skew an MSP's patch-compliance reporting.
  const complianceConditions = [
    eq(devicePatches.orgId, orgId),
    eq(devices.orgId, orgId),
    eq(devices.isEphemeral, false),
  ];
  if (scope.kind === 'restricted') {
    complianceConditions.push(inArray(devices.siteId, scope.siteIds));
  }
  if (source) {
    complianceConditions.push(eq(patches.source, source));
  }
  if (severity) {
    complianceConditions.push(eq(patches.severity, severity));
  }

  const statusCounts = await db
    .select({
      status: devicePatches.status,
      count: sql<number>`count(*)`
    })
    .from(devicePatches)
    .innerJoin(
      devices,
      and(
        eq(devicePatches.deviceId, devices.id),
        eq(devicePatches.orgId, devices.orgId),
      ),
    )
    .innerJoin(patches, eq(devicePatches.patchId, patches.id))
    .where(and(...complianceConditions))
    .groupBy(devicePatches.status);

  return buildSummaryFromRows(
    statusCounts.map((row) => ({
      status: row.status,
      count: Number(row.count)
    }))
  );
}

function formatComplianceCsv(reportId: string, orgId: string, source: PatchSource | null, severity: PatchSeverity | null, summary: ComplianceSummary): string {
  const nowIso = new Date().toISOString();
  const rows: Array<[string, string | number]> = [
    ['report_id', reportId],
    ['generated_at', nowIso],
    ['org_id', orgId],
    ['source', source ?? 'all'],
    ['severity', severity ?? 'all'],
    ['total', summary.total],
    ['installed', summary.installed],
    ['pending', summary.pending],
    ['failed', summary.failed],
    ['missing', summary.missing],
    ['skipped', summary.skipped],
    ['compliance_percent', summary.compliancePercent]
  ];

  return [
    'metric,value',
    ...rows.map(([metric, value]) => `${metric},${JSON.stringify(String(value))}`)
  ].join('\n');
}

async function processGenerateComplianceReport(
  data: GenerateComplianceReportJobData
): Promise<{ outputPath: string; rowCount: number } | null> {
  const [report] = await db
    .select({
      id: patchComplianceReports.id,
      orgId: patchComplianceReports.orgId,
      format: patchComplianceReports.format,
      source: patchComplianceReports.source,
      severity: patchComplianceReports.severity,
      status: patchComplianceReports.status,
      requestedBy: patchComplianceReports.requestedBy,
      executionScopeVersion: patchComplianceReports.executionScopeVersion,
      executionScopeKind: patchComplianceReports.executionScopeKind,
      executionScopeSiteIds: patchComplianceReports.executionScopeSiteIds,
      executionScopeUserId: patchComplianceReports.executionScopeUserId,
      executionScopeFingerprint: patchComplianceReports.executionScopeFingerprint,
      executionScopeCapturedAt: patchComplianceReports.executionScopeCapturedAt,
      executionScopePrincipalKind: patchComplianceReports.executionScopePrincipalKind,
    })
    .from(patchComplianceReports)
    .where(eq(patchComplianceReports.id, data.reportId))
    .limit(1);

  if (!report) {
    throw new Error('Report request not found');
  }

  // Compare-and-set the ownership claim so two deliveries of the same job
  // cannot both generate output. A `running` row is reclaimable only once its
  // `started_at` is older than the BullMQ lock: before that a live processor
  // still owns it, after that the process that claimed it is gone (an API
  // restart mid-generation is the common case) and the row would otherwise sit
  // on `running` forever, because every redelivery would find it non-pending.
  // A reclaim re-runs every authority check below exactly as a first claim does.
  const staleBefore = new Date(Date.now() - PATCH_COMPLIANCE_REPORT_LOCK_DURATION_MS);
  const claimed = await db
    .update(patchComplianceReports)
    .set({
      status: 'running',
      startedAt: new Date(),
      updatedAt: new Date(),
      errorMessage: null
    })
    .where(and(
      eq(patchComplianceReports.id, report.id),
      or(
        eq(patchComplianceReports.status, 'pending'),
        and(
          eq(patchComplianceReports.status, 'running'),
          or(
            isNull(patchComplianceReports.startedAt),
            lt(patchComplianceReports.startedAt, staleBefore),
          ),
        ),
      ),
    ))
    .returning({ id: patchComplianceReports.id });
  if (claimed.length === 0) return null;

  if (report.format !== 'csv') {
    throw new Error('Only CSV patch compliance reports are currently supported');
  }

  let persistedScope;
  try {
    if (
      report.requestedBy === null
      || report.executionScopeUserId !== report.requestedBy
      || report.executionScopePrincipalKind !== 'user'
    ) {
      throw new Error('invalid report authority principal');
    }
    persistedScope = decodeSiteScope(
      report as unknown as PersistedSiteScopeColumns,
      report.orgId,
    );
  } catch {
    throw new Error('Report execution authority is invalid or legacy');
  }
  if (persistedScope.kind === 'legacy_unscoped') {
    throw new Error('Report execution authority is invalid or legacy');
  }

  // `resolveLiveReportAuthority` passes allowPlatformAuthority = true, i.e. it
  // also honours a platform/system-scoped role, whereas the create route's
  // `resolveRequestReportAuthority` only does so when the REQUEST itself came
  // in on a system-scope token. That asymmetry is harmless here: the worker has
  // no request to scope against, and whatever it resolves is immediately
  // intersected with the immutable ceiling persisted at request time, so a
  // broader live authority can only ever narrow to that ceiling, never widen
  // past it.
  const liveResult = await resolveLiveReportAuthority(
    report.requestedBy,
    report.orgId,
    'export',
  );
  if (!liveResult.ok) {
    throw new Error('Report execution authority is no longer valid');
  }
  const effectiveScope = intersectSiteScopes(
    persistedScope,
    liveResult.authority.scope,
  );
  if (!effectiveScope || effectiveScope.kind === 'legacy_unscoped') {
    throw new Error('Report execution authority has no current site scope');
  }

  const summary = await generateComplianceSummary(
    report.orgId,
    effectiveScope,
    report.source as PatchSource | null,
    report.severity as PatchSeverity | null
  );

  await mkdir(PATCH_REPORT_STORAGE_PATH, { recursive: true });
  const outputPath = path.resolve(PATCH_REPORT_STORAGE_PATH, `${report.id}.csv`);
  const csv = formatComplianceCsv(
    report.id,
    report.orgId,
    report.source as PatchSource | null,
    report.severity as PatchSeverity | null,
    summary
  );

  await writeFile(outputPath, csv, 'utf8');

  await db
    .update(patchComplianceReports)
    .set({
      status: 'completed',
      completedAt: new Date(),
      updatedAt: new Date(),
      summary,
      rowCount: summary.total,
      outputPath,
      errorMessage: null
    })
    .where(eq(patchComplianceReports.id, report.id));

  return {
    outputPath,
    rowCount: summary.total
  };
}

export async function processPatchComplianceReportJob(
  data: GenerateComplianceReportJobData,
): Promise<{ outputPath: string; rowCount: number } | null> {
  let processingError: unknown;
  const result = await runWithSystemDbAccess(async () => {
    try {
      return await processGenerateComplianceReport(data);
    } catch (error) {
      processingError = error;
      const message = error instanceof Error
        ? error.message
        : 'Unknown report generation failure';
      // Do not rethrow inside this transaction: doing so would roll back both
      // the pending -> running claim and this terminal transition, reopening a
      // race in which a second delivery can claim the row and be overwritten.
      await db
        .update(patchComplianceReports)
        .set({
          status: 'failed',
          completedAt: new Date(),
          updatedAt: new Date(),
          errorMessage: message,
        })
        .where(and(
          eq(patchComplianceReports.id, data.reportId),
          eq(patchComplianceReports.status, 'running'),
        ));
      return null;
    }
  });
  if (processingError !== undefined) {
    throw processingError;
  }
  return result;
}

/**
 * True for the error BullMQ raises when a job exceeded `maxStalledCount`
 * ("job stalled more than allowable limit"). That delivery never reaches the
 * processor, so the terminal state has to be written from the event handler.
 */
export function isStalledLimitFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.toLowerCase().includes('stalled more than');
}

/**
 * Fail-closed terminal state for a report BullMQ abandoned. Guarded on a
 * non-terminal status so it can never overwrite a `completed` row that a
 * slow-but-successful processor wrote just before the stall was declared.
 */
export async function markStalledPatchComplianceReportFailed(
  reportId: string,
): Promise<void> {
  await runWithSystemDbAccess(async () => {
    await db
      .update(patchComplianceReports)
      .set({
        status: 'failed',
        completedAt: new Date(),
        updatedAt: new Date(),
        errorMessage: STALLED_FAILURE_MESSAGE,
      })
      .where(and(
        eq(patchComplianceReports.id, reportId),
        inArray(patchComplianceReports.status, ['pending', 'running']),
      ));
  });
}

export function getPatchComplianceReportQueue(): Queue<PatchComplianceReportJobData> {
  if (!patchComplianceReportQueue) {
    patchComplianceReportQueue = new Queue<PatchComplianceReportJobData>(PATCH_COMPLIANCE_REPORT_QUEUE, {
      connection: getBullMQConnection()
    });
  }

  return patchComplianceReportQueue;
}

async function processReportInline(reportId: string): Promise<void> {
  try {
    await processPatchComplianceReportJob({
      type: 'generate-compliance-report',
      reportId,
    });
  } catch {
    // The shared processor records the fail-closed terminal state.
  }
}

export async function enqueuePatchComplianceReport(
  reportId: string
): Promise<{ enqueued: boolean; jobId?: string }> {
  if (!isRedisAvailable()) {
    setImmediate(() => {
      processReportInline(reportId).catch((error) => {
        console.error(`[PatchComplianceReportWorker] Inline report processing failed for ${reportId}:`, error);
      });
    });

    return { enqueued: false };
  }

  try {
    const queue = getPatchComplianceReportQueue();
    const job = await queue.add(
      'generate-compliance-report',
      {
        type: 'generate-compliance-report',
        reportId
      },
      {
        jobId: `patch-compliance-report-${reportId}`,
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 }
      }
    );

    return {
      enqueued: true,
      jobId: job.id ? String(job.id) : undefined
    };
  } catch (error) {
    console.error(`[PatchComplianceReportWorker] Failed to enqueue report ${reportId}, using inline fallback:`, error);

    setImmediate(() => {
      processReportInline(reportId).catch((err) => {
        console.error(`[PatchComplianceReportWorker] Inline fallback failed for ${reportId}:`, err);
      });
    });

    return { enqueued: false };
  }
}

function createPatchComplianceReportWorker(): Worker<PatchComplianceReportJobData> {
  return new Worker<PatchComplianceReportJobData>(
    PATCH_COMPLIANCE_REPORT_QUEUE,
    async (job: Job<PatchComplianceReportJobData>) => {
      switch (job.data.type) {
        case 'generate-compliance-report':
          return processPatchComplianceReportJob(job.data);
        default:
          throw new Error(`Unknown patch compliance report job type: ${(job.data as { type: string }).type}`);
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 2,
      lockDuration: PATCH_COMPLIANCE_REPORT_LOCK_DURATION_MS,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    }
  );
}

export async function initializePatchComplianceReportWorker(): Promise<void> {
  if (!isRedisAvailable()) {
    console.warn('[PatchComplianceReportWorker] Redis unavailable; queue worker disabled (inline fallback enabled)');
    return;
  }

  if (patchComplianceReportWorker) {
    return;
  }

  patchComplianceReportWorker = createPatchComplianceReportWorker();
  attachWorkerObservability(patchComplianceReportWorker, 'patchComplianceReportWorker');
  patchComplianceReportWorker.on('error', (error) => {
    console.error('[PatchComplianceReportWorker] Worker error:', error);
  });

  patchComplianceReportWorker.on('failed', (job, error) => {
    console.error(`[PatchComplianceReportWorker] Job ${job?.id} failed:`, error);

    // The processor writes its own terminal state for every failure it saw.
    // A stalled-limit failure is the one case it never ran for, so the row
    // would stay `running` and the requester would poll forever.
    const reportId = job?.data?.reportId;
    if (reportId && isStalledLimitFailure(error)) {
      markStalledPatchComplianceReportFailed(reportId).catch((err) => {
        console.error(
          `[PatchComplianceReportWorker] Failed to record stalled state for ${reportId}:`,
          err,
        );
      });
    }
  });

  console.log('[PatchComplianceReportWorker] Initialized');
}

export async function shutdownPatchComplianceReportWorker(): Promise<void> {
  if (patchComplianceReportWorker) {
    await patchComplianceReportWorker.close();
    patchComplianceReportWorker = null;
  }

  if (patchComplianceReportQueue) {
    await patchComplianceReportQueue.close();
    patchComplianceReportQueue = null;
  }

  console.log('[PatchComplianceReportWorker] Shut down');
}
