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
} from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { getCommandTimeoutMs, EXCLUDED_COMMAND_TYPES } from '../services/commandTimeouts';
import { captureException } from '../services/sentry';
import { recordBackupCommandTimeout, recordRestoreTimeout } from '../services/backupMetrics';

const QUEUE_NAME = 'stale-command-reaper';
const REAP_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes
const MAX_REAP_PER_RUN = 200;
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

  return pendingResult.length + activeResult.length;
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
