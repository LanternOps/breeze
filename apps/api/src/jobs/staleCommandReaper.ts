import { Job, Queue, Worker } from 'bullmq';
import { and, eq, lt, sql, inArray, isNotNull } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import {
  deviceCommands,
  scriptExecutions,
  scriptExecutionBatches,
  patchJobs,
  patchJobResults,
  deployments,
  deploymentDevices,
  remoteSessions,
  restoreJobs,
  backupJobs,
  devices,
  STALE_BACKUP_REAP_MARKER,
} from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { getCommandTimeoutMs, EXCLUDED_COMMAND_TYPES } from '../services/commandTimeouts';
import { captureException } from '../services/sentry';
import { recordBackupCommandTimeout, recordRestoreTimeout } from '../services/backupMetrics';
import { revokeViewerSession } from '../services/viewerTokenRevocation';
import { queueBackupStopCommand } from '../services/commandQueue';

const QUEUE_NAME = 'stale-command-reaper';
const REAP_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes
// Per-run cap (env-tunable). Was a hardcoded 200 which silently truncated the
// reaper above ~200 stale items per type — see scaling audit 2026-05-17. The
// per-row update logic still runs sequentially inside JS to preserve metrics
// and propagation side-effects; this just lets us cover more rows per cycle.
//
// `STALE_REAPER_MAX_PER_RUN=0` means UNLIMITED (matches the convention
// `alertWorker` + `offlineDetector` adopt in this PR). Passing `.limit(0)`
// to drizzle disables the limit clause is NOT a Postgres semantic —
// `.limit(0)` returns zero rows, which would silently disable the
// reaper. Normalize to `Number.MAX_SAFE_INTEGER` so the consistent
// "cap=0 == unlimited" knob actually behaves that way here.
const RAW_MAX_REAP = Number(process.env.STALE_REAPER_MAX_PER_RUN ?? '5000');
const MAX_REAP_PER_RUN =
  Number.isFinite(RAW_MAX_REAP) && RAW_MAX_REAP > 0
    ? RAW_MAX_REAP
    : RAW_MAX_REAP === 0
      ? Number.MAX_SAFE_INTEGER
      : 5000; // negative / NaN fall back to default rather than disabling the reaper
const SHORTEST_TIMEOUT_MS = 5 * 60 * 1000; // conservative SQL pre-filter

// Backup-related command types — used to guard backup-specific Prometheus metrics
const BACKUP_COMMAND_TYPES = new Set([
  'backup_run', 'backup_stop', 'backup_restore', 'backup_verify',
  'backup_test_restore', 'backup_cleanup', 'vm_restore_from_backup',
  'vm_instant_boot', 'bmr_recover', 'mssql_backup', 'mssql_restore',
  'hyperv_backup', 'hyperv_restore',
]);

// Deployment/patch stale thresholds
const DEPLOYMENT_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const REMOTE_SESSION_PENDING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const REMOTE_SESSION_ACTIVE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours (zombie safety net)

// Backup job orphan/stall reconciliation thresholds.
const BACKUP_STALL_TIMEOUT_MS = 15 * 60 * 1000;      // progress-capable agent went silent
const BACKUP_OFFLINE_GRACE_MS = 10 * 60 * 1000;      // device offline mid-job (covers reboot)
const BACKUP_ABSOLUTE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // legacy agents: no progress signal exists
const BACKUP_PENDING_TIMEOUT_MS = 60 * 60 * 1000;    // dispatch enqueued but never flipped/failed

// Mirrors DEFAULT_OFFLINE_THRESHOLD_MINUTES in jobs/offlineDetector.ts (not
// exported from there). Same condition shape: a device counts as offline
// once it's flipped to 'offline', OR it's still marked online/updating but
// hasn't heartbeat-ed in this long — i.e. disconnected but the async
// offline-detection sweep hasn't caught up yet.
const OFFLINE_DETECTOR_DEFAULT_THRESHOLD_MINUTES = 5;

function isDeviceOfflineForReap(status: string | null | undefined, lastSeenAt: Date | null | undefined): boolean {
  if (status === 'offline') return true;
  if (status !== 'online' && status !== 'updating') return false;
  if (!lastSeenAt) return false;
  const thresholdTime = Date.now() - OFFLINE_DETECTOR_DEFAULT_THRESHOLD_MINUTES * 60 * 1000;
  return lastSeenAt.getTime() < thresholdTime;
}

type ReaperJobData = { type: 'reap-stale-commands'; queuedAt: string };

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error('[StaleCommandReaper] withSystemDbAccessContext not available — reaper cannot run without system DB access');
  }
  return withSystem(fn);
};

let reaperQueue: Queue<ReaperJobData> | null = null;
let reaperWorker: Worker<ReaperJobData> | null = null;

function getQueue(): Queue<ReaperJobData> {
  if (!reaperQueue) {
    reaperQueue = new Queue<ReaperJobData>(QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return reaperQueue;
}

export async function propagateTimedOutDeviceCommand(params: {
  commandId: string;
  payload: Record<string, unknown> | null;
  errorMsg: string;
  completedAt: Date;
}): Promise<void> {
  const { commandId, payload, errorMsg, completedAt } = params;

  await db
    .update(restoreJobs)
    .set({
      status: 'failed',
      completedAt,
      updatedAt: completedAt,
      targetConfig: sql`coalesce(${restoreJobs.targetConfig}, '{}'::jsonb) || jsonb_build_object(
        'error', ${errorMsg}::text,
        'result', jsonb_build_object(
          'status', 'failed',
          'error', ${errorMsg}::text,
          'timedOutBy', 'server'
        )
      )`,
    })
    .where(
      and(
        eq(restoreJobs.commandId, commandId),
        inArray(restoreJobs.status, ['pending', 'running']),
      ),
    );

  const drExecutionId =
    payload && typeof payload.drExecutionId === 'string' && payload.drExecutionId.trim().length > 0
      ? payload.drExecutionId
      : null;

  if (!drExecutionId) {
    return;
  }

  const { enqueueDrExecutionReconcile } = await import('./drExecutionWorker');
  await enqueueDrExecutionReconcile(drExecutionId, 0);
}

// ── Reap functions ────────────────────────────────────────────────

export async function reapStaleDeviceCommands(): Promise<number> {
  const now = Date.now();
  const conservativeCutoff = new Date(now - SHORTEST_TIMEOUT_MS);
  const excludedTypes = [...EXCLUDED_COMMAND_TYPES];

  // Build WHERE conditions, guarding against empty exclusion set
  const whereConditions = [
    inArray(deviceCommands.status, ['pending', 'sent']),
    lt(deviceCommands.createdAt, conservativeCutoff),
  ];
  if (excludedTypes.length > 0) {
    whereConditions.push(
      sql`${deviceCommands.type} NOT IN (${sql.join(
        excludedTypes.map((t) => sql`${t}`),
        sql`, `,
      )})`,
    );
  }

  const staleCommands = await db
    .select({
      id: deviceCommands.id,
      type: deviceCommands.type,
      status: deviceCommands.status,
      payload: deviceCommands.payload,
      createdAt: deviceCommands.createdAt,
      executedAt: deviceCommands.executedAt,
    })
    .from(deviceCommands)
    .where(and(...whereConditions))
    .orderBy(deviceCommands.createdAt)
    .limit(MAX_REAP_PER_RUN);

  let reaped = 0;
  for (const cmd of staleCommands) {
    const timeoutMs = getCommandTimeoutMs(
      cmd.type,
      cmd.payload as Record<string, unknown> | null,
    );
    const referenceTime = cmd.status === 'sent' && cmd.executedAt
      ? cmd.executedAt.getTime()
      : cmd.createdAt.getTime();

    if (now - referenceTime < timeoutMs) continue;

    const errorMsg = cmd.status === 'sent'
      ? `Server-side timeout: no response from agent after ${Math.round(timeoutMs / 60000)} minutes`
      : `Command expired: agent never received the command (${Math.round(timeoutMs / 60000)} min timeout)`;

    const completedAt = new Date();

    const updated = await db
      .update(deviceCommands)
      .set({
        status: 'failed',
        completedAt,
        result: { status: 'timeout', error: errorMsg, timedOutBy: 'server' },
      })
      .where(
        and(
          eq(deviceCommands.id, cmd.id),
          inArray(deviceCommands.status, ['pending', 'sent']),
        ),
      )
      .returning({ id: deviceCommands.id });

    if (updated.length === 0) continue;

    reaped++;
    if (BACKUP_COMMAND_TYPES.has(cmd.type)) {
      recordBackupCommandTimeout(cmd.type, 'reaper');
    }
    if (cmd.type === 'backup_restore' || cmd.type === 'vm_restore_from_backup' || cmd.type === 'vm_instant_boot' || cmd.type === 'bmr_recover') {
      recordRestoreTimeout(cmd.type);
    }

    try {
      await propagateTimedOutDeviceCommand({
        commandId: cmd.id,
        payload: (cmd.payload as Record<string, unknown> | null) ?? null,
        errorMsg,
        completedAt,
      });
    } catch (error) {
      console.error(`[StaleCommandReaper] Failed to propagate stale command ${cmd.id}:`, error);
      captureException(error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (staleCommands.length === MAX_REAP_PER_RUN) {
    console.warn(`[StaleCommandReaper] deviceCommands hit ${MAX_REAP_PER_RUN}-item cap — backlog may be growing`);
  }

  return reaped;
}

async function reapStaleScriptExecutions(): Promise<number> {
  // Default script timeout + grace buffer (300s script + 300s grace = 10 min)
  const defaultTimeoutMs = 300 * 1000 + 5 * 60 * 1000;
  const conservativeCutoff = new Date(Date.now() - defaultTimeoutMs);

  const staleExecs = await db
    .select({
      id: scriptExecutions.id,
      status: scriptExecutions.status,
      scriptId: scriptExecutions.scriptId,
      createdAt: scriptExecutions.createdAt,
      startedAt: scriptExecutions.startedAt,
    })
    .from(scriptExecutions)
    .where(
      and(
        inArray(scriptExecutions.status, ['pending', 'queued', 'running']),
        lt(scriptExecutions.createdAt, conservativeCutoff),
      ),
    )
    .orderBy(scriptExecutions.createdAt)
    .limit(MAX_REAP_PER_RUN);

  const now = Date.now();
  let reaped = 0;

  for (const exec of staleExecs) {
    const referenceTime = exec.status === 'running' && exec.startedAt
      ? exec.startedAt.getTime()
      : exec.createdAt.getTime();

    if (now - referenceTime < defaultTimeoutMs) continue;

    const updated = await db
      .update(scriptExecutions)
      .set({
        status: 'timeout',
        completedAt: new Date(),
        errorMessage: 'Server-side timeout: no response from agent',
      })
      .where(
        and(
          eq(scriptExecutions.id, exec.id),
          inArray(scriptExecutions.status, ['pending', 'queued', 'running']),
        ),
      )
      .returning({ id: scriptExecutions.id });

    if (updated.length === 0) continue;
    reaped++;

    // Find the parent batch via the deviceCommand that references this execution
    const relatedCmd = await db
      .select({ payload: deviceCommands.payload })
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.type, 'script'),
          sql`${deviceCommands.payload}->>'executionId' = ${exec.id}`,
        ),
      )
      .limit(1);

    const batchId = (relatedCmd[0]?.payload as Record<string, unknown>)?.batchId as string | undefined;
    if (batchId) {
      // Atomic: increment counter + check completion in a transaction
      await db.transaction(async (tx) => {
        await tx
          .update(scriptExecutionBatches)
          .set({
            devicesFailed: sql`${scriptExecutionBatches.devicesFailed} + 1`,
          })
          .where(eq(scriptExecutionBatches.id, batchId));

        const [batch] = await tx
          .select({
            devicesTargeted: scriptExecutionBatches.devicesTargeted,
            devicesCompleted: scriptExecutionBatches.devicesCompleted,
            devicesFailed: scriptExecutionBatches.devicesFailed,
          })
          .from(scriptExecutionBatches)
          .where(eq(scriptExecutionBatches.id, batchId));

        if (batch && batch.devicesCompleted + batch.devicesFailed >= batch.devicesTargeted) {
          await tx
            .update(scriptExecutionBatches)
            .set({
              status: batch.devicesFailed > 0 ? 'failed' : 'completed',
              completedAt: new Date(),
            })
            .where(eq(scriptExecutionBatches.id, batchId));
        }
      });
    }
  }

  return reaped;
}

async function reapStalePatchJobResults(): Promise<number> {
  const cutoff = new Date(Date.now() - DEPLOYMENT_TIMEOUT_MS);

  const staleResults = await db
    .select({
      id: patchJobResults.id,
      jobId: patchJobResults.jobId,
    })
    .from(patchJobResults)
    .where(
      and(
        inArray(patchJobResults.status, ['pending', 'running']),
        lt(patchJobResults.createdAt, cutoff),
      ),
    )
    .limit(MAX_REAP_PER_RUN);

  let reaped = 0;
  const reapedPerJob = new Map<string, number>();

  for (const result of staleResults) {
    const updated = await db
      .update(patchJobResults)
      .set({
        status: 'failed',
        completedAt: new Date(),
        errorMessage: 'Server-side timeout: no response from agent',
      })
      .where(
        and(
          eq(patchJobResults.id, result.id),
          inArray(patchJobResults.status, ['pending', 'running']),
        ),
      )
      .returning({ id: patchJobResults.id });

    if (updated.length > 0) {
      reaped++;
      reapedPerJob.set(result.jobId, (reapedPerJob.get(result.jobId) ?? 0) + 1);
    }
  }

  // Update parent patch job counters (increment by actual count, not 1)
  for (const [jobId, count] of reapedPerJob) {
    await db.transaction(async (tx) => {
      await tx
        .update(patchJobs)
        .set({
          devicesFailed: sql`${patchJobs.devicesFailed} + ${count}`,
        })
        .where(eq(patchJobs.id, jobId));

      // Check if job is now complete
      const remainingActive = await tx
        .select({ id: patchJobResults.id })
        .from(patchJobResults)
        .where(
          and(
            eq(patchJobResults.jobId, jobId),
            inArray(patchJobResults.status, ['pending', 'running']),
          ),
        )
        .limit(1);

      if (remainingActive.length === 0) {
        const [jobStats] = await tx
          .select({ devicesFailed: patchJobs.devicesFailed })
          .from(patchJobs)
          .where(eq(patchJobs.id, jobId));

        await tx
          .update(patchJobs)
          .set({
            status: (jobStats?.devicesFailed ?? 0) > 0 ? 'failed' : 'completed',
            completedAt: new Date(),
          })
          .where(
            and(
              eq(patchJobs.id, jobId),
              inArray(patchJobs.status, ['scheduled', 'running']),
            ),
          );
      }
    });
  }

  return reaped;
}

async function reapStaleDeploymentDevices(): Promise<number> {
  const cutoff = new Date(Date.now() - DEPLOYMENT_TIMEOUT_MS);

  // Fetch stale devices: running with old startedAt, OR pending with null startedAt
  // (join to parent deployment for createdAt fallback when startedAt is null)
  const staleDevices = await db
    .select({
      id: deploymentDevices.id,
      deploymentId: deploymentDevices.deploymentId,
    })
    .from(deploymentDevices)
    .innerJoin(deployments, eq(deployments.id, deploymentDevices.deploymentId))
    .where(
      and(
        inArray(deploymentDevices.status, ['pending', 'running']),
        sql`COALESCE(${deploymentDevices.startedAt}, ${deployments.createdAt}) < ${cutoff.toISOString()}`,
      ),
    )
    .limit(MAX_REAP_PER_RUN);

  let reaped = 0;
  const affectedDeploymentIds = new Set<string>();

  for (const dev of staleDevices) {
    const updated = await db
      .update(deploymentDevices)
      .set({
        status: 'failed',
        completedAt: new Date(),
        result: { error: 'Server-side timeout: no response from agent', timedOutBy: 'server' },
      })
      .where(
        and(
          eq(deploymentDevices.id, dev.id),
          inArray(deploymentDevices.status, ['pending', 'running']),
        ),
      )
      .returning({ id: deploymentDevices.id });

    if (updated.length > 0) {
      reaped++;
      affectedDeploymentIds.add(dev.deploymentId);
    }
  }

  // Recompute parent deployment status
  for (const deploymentId of affectedDeploymentIds) {
    const remainingActive = await db
      .select({ id: deploymentDevices.id })
      .from(deploymentDevices)
      .where(
        and(
          eq(deploymentDevices.deploymentId, deploymentId),
          inArray(deploymentDevices.status, ['pending', 'running']),
        ),
      )
      .limit(1);

    if (remainingActive.length === 0) {
      // Check if any device actually succeeded
      const [stats] = await db
        .select({
          failedCount: sql<number>`count(*) filter (where ${deploymentDevices.status} = 'failed')`,
          totalCount: sql<number>`count(*)`,
        })
        .from(deploymentDevices)
        .where(eq(deploymentDevices.deploymentId, deploymentId));

      const allFailed = stats && stats.failedCount === stats.totalCount;

      await db
        .update(deployments)
        .set({
          status: allFailed ? 'failed' : 'completed',
          completedAt: new Date(),
        })
        .where(
          and(
            eq(deployments.id, deploymentId),
            inArray(deployments.status, ['pending', 'running', 'paused', 'downloading', 'installing']),
          ),
        );
    }
  }

  return reaped;
}

async function reapStaleRemoteSessions(): Promise<number> {
  const pendingCutoff = new Date(Date.now() - REMOTE_SESSION_PENDING_TIMEOUT_MS);
  const activeCutoff = new Date(Date.now() - REMOTE_SESSION_ACTIVE_TIMEOUT_MS);

  // Pending/connecting sessions older than 10 minutes
  const pendingResult = await db
    .update(remoteSessions)
    .set({
      status: 'disconnected',
      endedAt: new Date(),
      errorMessage: 'Session timed out: connection was never established',
    })
    .where(
      and(
        inArray(remoteSessions.status, ['pending', 'connecting']),
        lt(remoteSessions.createdAt, pendingCutoff),
      ),
    )
    .returning({ id: remoteSessions.id });

  // Zombie active sessions older than 24 hours
  const activeResult = await db
    .update(remoteSessions)
    .set({
      status: 'disconnected',
      endedAt: new Date(),
      errorMessage: 'Session timed out: exceeded maximum session duration',
    })
    .where(
      and(
        eq(remoteSessions.status, 'active'),
        lt(remoteSessions.startedAt, activeCutoff),
        isNotNull(remoteSessions.startedAt),
      ),
    )
    .returning({ id: remoteSessions.id });

  // Revoke viewer tokens for every session we just force-disconnected so a
  // lingering (up to 2h) viewer token can't resurrect it via /viewer/offer (#5).
  // The agent's max-session-duration timer is the authoritative teardown for the
  // live peer-to-peer stream of a zombie session (when a max-session-duration
  // policy is set; default 8h) (#2).
  const reapedIds = [...pendingResult, ...activeResult].map((r) => r.id);
  await Promise.all(
    reapedIds.map((id) =>
      revokeViewerSession(id).catch((err) =>
        console.warn('[reaper] viewer revoke failed', id, err)
      )
    )
  );

  return pendingResult.length + activeResult.length;
}

/**
 * Fail a stale/orphaned `backup_jobs` row, guarded so a concurrent terminal
 * transition (the real result arriving mid-reap) always wins. Appends to any
 * existing errorLog rather than clobbering it.
 */
async function reapBackupJobRow(
  jobId: string,
  existingErrorLog: string | null | undefined,
  errorMsg: string,
): Promise<boolean> {
  const now = new Date();
  // Stamp the reaper marker so the result-persistence path can later recognize a
  // "failed-because-reaped" job and still record a late-but-genuine `completed`
  // result (flipping failed→completed) instead of stranding its snapshot — see
  // STALE_BACKUP_REAP_MARKER / FIX 7 in backupResultPersistence.ts.
  const markedMsg = `${STALE_BACKUP_REAP_MARKER} ${errorMsg}`;
  const errorLog = existingErrorLog ? `${existingErrorLog}\n${markedMsg}` : markedMsg;

  const updated = await db
    .update(backupJobs)
    .set({
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorLog,
    })
    .where(
      and(
        eq(backupJobs.id, jobId),
        inArray(backupJobs.status, ['pending', 'running']),
      ),
    )
    .returning({ id: backupJobs.id });

  return updated.length > 0;
}

/**
 * Reap orphaned/stalled `backup_jobs` rows the normal WS result path will
 * never terminate on its own: a silently-dead agent (stall), a device that
 * went offline mid-upload, a legacy agent with no progress signal at all
 * (absolute cap), or a dispatch that never flipped out of `pending`.
 *
 * A `running` job is reaped when ANY of:
 *  A (stall):    lastProgressAt is set and stale past BACKUP_STALL_TIMEOUT_MS
 *  B (offline):  the owning device is offline (see isDeviceOfflineForReap)
 *                AND coalesce(lastProgressAt, startedAt) is stale past
 *                BACKUP_OFFLINE_GRACE_MS
 *  C (absolute): no progress signal was ever reported (legacy agent) and
 *                startedAt is stale past BACKUP_ABSOLUTE_TIMEOUT_MS
 *
 * A `pending` job is reaped when createdAt is stale past
 * BACKUP_PENDING_TIMEOUT_MS (dispatch never completed).
 *
 * Per reaped running job on an online device: best-effort
 * queueBackupStopCommand so a live-but-silent agent stops uploading.
 */
export async function reapStaleBackupJobs(): Promise<number> {
  const now = Date.now();
  let reaped = 0;

  // Conservative SQL pre-filter on the loosest (smallest) of the three
  // running-job thresholds; precise per-row logic below picks the actual
  // rule (mirrors the SHORTEST_TIMEOUT_MS pattern used elsewhere in this
  // file) — precise filtering happens in JS either way, so this only bounds
  // the candidate set size.
  const conservativeCutoff = new Date(now - BACKUP_OFFLINE_GRACE_MS);

  const runningCandidates = await db
    .select({
      id: backupJobs.id,
      deviceId: backupJobs.deviceId,
      lastProgressAt: backupJobs.lastProgressAt,
      startedAt: backupJobs.startedAt,
      createdAt: backupJobs.createdAt,
      errorLog: backupJobs.errorLog,
      deviceStatus: devices.status,
      deviceLastSeenAt: devices.lastSeenAt,
    })
    .from(backupJobs)
    .innerJoin(devices, eq(backupJobs.deviceId, devices.id))
    .where(
      and(
        eq(backupJobs.status, 'running'),
        // Fall back to createdAt so a `running` row with BOTH last_progress_at
        // and started_at NULL is still a candidate (createdAt is NOT NULL) —
        // otherwise COALESCE(null, null) is NULL, the `< cutoff` is never true,
        // and the row is an unreapable zombie.
        sql`COALESCE(${backupJobs.lastProgressAt}, ${backupJobs.startedAt}, ${backupJobs.createdAt}) < ${conservativeCutoff.toISOString()}`,
      ),
    )
    .limit(MAX_REAP_PER_RUN);

  for (const job of runningCandidates) {
    if (reaped >= MAX_REAP_PER_RUN) break;

    // createdAt is NOT NULL, so progressRef is always defined even for a row
    // whose last_progress_at and started_at are both NULL (the zombie case).
    const progressRef = job.lastProgressAt ?? job.startedAt ?? job.createdAt;
    if (!progressRef) continue;

    const deviceOffline = isDeviceOfflineForReap(job.deviceStatus, job.deviceLastSeenAt);

    let errorMsg: string | null = null;
    if (job.lastProgressAt && now - job.lastProgressAt.getTime() > BACKUP_STALL_TIMEOUT_MS) {
      errorMsg = 'Backup stalled: no progress reported for 15 minutes';
    } else if (deviceOffline && now - progressRef.getTime() > BACKUP_OFFLINE_GRACE_MS) {
      errorMsg = 'Device went offline during backup';
    } else if (!job.lastProgressAt && now - progressRef.getTime() > BACKUP_ABSOLUTE_TIMEOUT_MS) {
      // No progress signal ever (legacy agent) OR a zombie with no started_at —
      // reap on the absolute cap against progressRef (started_at ?? createdAt).
      errorMsg = 'Backup timed out (no completion after 24h)';
    }

    if (!errorMsg) continue;

    const wasReaped = await reapBackupJobRow(job.id, job.errorLog, errorMsg);
    if (!wasReaped) continue; // concurrent terminal transition won the race
    reaped++;

    if (!deviceOffline) {
      try {
        await queueBackupStopCommand(job.deviceId, {});
      } catch (err) {
        console.warn(`[StaleCommandReaper] Failed to queue backup_stop for reaped backup job ${job.id}:`, err);
      }
    }
  }

  const pendingCutoff = new Date(now - BACKUP_PENDING_TIMEOUT_MS);
  // applyBackupStartedAck / applyBackupProgress accept a `pending` job and bump
  // last_progress_at WITHOUT promoting it to `running`, so a pending job that is
  // still receiving progress pings is alive and must NOT be reaped on createdAt
  // alone. Spare any pending job whose last_progress_at is recent (within the
  // stall window).
  const pendingProgressCutoff = new Date(now - BACKUP_STALL_TIMEOUT_MS);
  const pendingCandidates = await db
    .select({
      id: backupJobs.id,
      errorLog: backupJobs.errorLog,
      createdAt: backupJobs.createdAt,
      lastProgressAt: backupJobs.lastProgressAt,
    })
    .from(backupJobs)
    .where(
      and(
        eq(backupJobs.status, 'pending'),
        lt(backupJobs.createdAt, pendingCutoff),
        sql`(${backupJobs.lastProgressAt} IS NULL OR ${backupJobs.lastProgressAt} < ${pendingProgressCutoff.toISOString()})`,
      ),
    )
    .limit(MAX_REAP_PER_RUN);

  for (const job of pendingCandidates) {
    if (reaped >= MAX_REAP_PER_RUN) break;
    if (now - job.createdAt.getTime() < BACKUP_PENDING_TIMEOUT_MS) continue;
    // A pending job still being kept alive by recent progress pings is not dead.
    if (job.lastProgressAt && now - job.lastProgressAt.getTime() < BACKUP_STALL_TIMEOUT_MS) continue;

    const wasReaped = await reapBackupJobRow(job.id, job.errorLog, 'Backup dispatch never completed');
    if (wasReaped) reaped++;
  }

  if (reaped > 0) {
    console.log(`[StaleCommandReaper] Reaped ${reaped} stale/orphaned backup jobs`);
  }

  return reaped;
}

// ── Worker & queue management ─────────────────────────────────────

function createWorker(): Worker<ReaperJobData> {
  return new Worker<ReaperJobData>(
    QUEUE_NAME,
    async (job: Job<ReaperJobData>) => {
      const results: Record<string, number> = {};

      const domains = [
        ['deviceCommands', reapStaleDeviceCommands],
        ['scriptExecutions', reapStaleScriptExecutions],
        ['patchJobResults', reapStalePatchJobResults],
        ['deploymentDevices', reapStaleDeploymentDevices],
        ['remoteSessions', reapStaleRemoteSessions],
        ['backupJobs', reapStaleBackupJobs],
      ] as const;

      // Each domain runs in its own transaction so a failure in one
      // doesn't abort the Postgres transaction for the others.
      for (const [name, fn] of domains) {
        try {
          results[name] = await runWithSystemDbAccess(fn);
        } catch (err) {
          console.error(`[StaleCommandReaper] Error reaping ${name}:`, err);
          captureException(err instanceof Error ? err : new Error(String(err)));
          results[name] = -1;
        }
      }

      const total = Object.values(results).filter((n) => n > 0).reduce((a, b) => a + b, 0);
      if (total > 0) {
        console.log(
          `[StaleCommandReaper] Reaped ${total} stale items:`,
          Object.entries(results)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${k}=${n}`)
            .join(', '),
        );
      }

      // Log and escalate failures
      const failures = Object.entries(results).filter(([, n]) => n === -1);
      if (failures.length > 0) {
        console.error(
          `[StaleCommandReaper] ${failures.length}/${domains.length} domains failed:`,
          failures.map(([k]) => k).join(', '),
        );
      }
      if (failures.length === domains.length) {
        throw new Error(`All reaper domains failed: ${failures.map(([k]) => k).join(', ')}`);
      }

      return results;
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    },
  );
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();

  // Remove any existing repeatable jobs (in case interval changed)
  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === 'reap-stale-commands') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'reap-stale-commands',
    { type: 'reap-stale-commands', queuedAt: new Date().toISOString() },
    {
      jobId: 'stale-command-reaper',
      repeat: { every: REAP_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeStaleCommandReaper(): Promise<void> {
  if (reaperWorker) return;

  reaperWorker = createWorker();
  reaperWorker.on('error', (error) => {
    console.error('[StaleCommandReaper] Worker error:', error);
    captureException(error);
  });
  reaperWorker.on('failed', (job, error) => {
    console.error(`[StaleCommandReaper] Job ${job?.id} failed:`, error);
    captureException(error);
  });

  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await reaperWorker.close();
    reaperWorker = null;
    throw err;
  }

  console.log('[StaleCommandReaper] Initialized');
}

export async function shutdownStaleCommandReaper(): Promise<void> {
  const worker = reaperWorker;
  const queue = reaperQueue;
  reaperWorker = null;
  reaperQueue = null;

  if (worker) {
    try { await worker.close(); } catch (err) {
      console.error('[StaleCommandReaper] Error closing worker:', err);
    }
  }
  if (queue) {
    try { await queue.close(); } catch (err) {
      console.error('[StaleCommandReaper] Error closing queue:', err);
    }
  }
}
