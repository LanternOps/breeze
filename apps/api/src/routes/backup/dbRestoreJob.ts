import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext } from '../../db';
import { restoreJobs } from '../../db/schema';
import { recordBackupDispatchFailure } from '../../services/backupMetrics';
import { queueCommandForExecution } from '../../services/commandQueue';

// #6974: application-level restores (MSSQL database, Hyper-V VM import) are
// dispatched async (#6437). Give each a `restore_jobs` row linked to its
// device command by `command_id` — the same correlation `backup_restore` /
// `vm_restore_from_backup` use — so `commandResultHandlers` (and
// `agentWs.processCommandResult`) can persist the terminal outcome and the
// Backup dashboard's restore list surfaces it.

export type DbRestoreEngine = 'mssql' | 'hyperv';

export type DbRestoreDispatchResult =
  | { ok: true; command: { id: string; status: string }; restoreJobId: string }
  | { ok: false; error: string };

function runInOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() =>
    withDbAccessContext(
      { scope: 'organization', orgId, accessibleOrgIds: [orgId] },
      fn
    )
  );
}

async function markRestoreJobFailedSafe(orgId: string, restoreJobId: string, error: string): Promise<void> {
  try {
    await markRestoreJobFailed(orgId, restoreJobId, error);
  } catch (err) {
    // Never let a bookkeeping failure mask the real dispatch error.
    console.error(`[BackupRestore] Failed to mark restore job ${restoreJobId} failed:`, err);
  }
}

async function markRestoreJobFailed(orgId: string, restoreJobId: string, error: string): Promise<void> {
  const now = new Date();
  await runInOrg(orgId, async () => {
    await db
      .update(restoreJobs)
      .set({
        status: 'failed',
        completedAt: now,
        updatedAt: now,
        targetConfig: sql`coalesce(${restoreJobs.targetConfig}, '{}'::jsonb) || jsonb_build_object(
          'error', ${error},
          'result', jsonb_build_object('status', 'failed', 'error', ${error})
        )`,
      })
      .where(eq(restoreJobs.id, restoreJobId));
  });
}

export async function dispatchTrackedDbRestore(opts: {
  orgId: string;
  /** backup_snapshots.id (the DB row, not the provider snapshot id). */
  snapshotId: string;
  deviceId: string;
  userId?: string | null;
  commandType: string;
  engine: DbRestoreEngine;
  /** Non-secret display metadata merged into restore_jobs.target_config. */
  targetConfig: Record<string, unknown>;
  /** Builds the command payload; must carry the restore job id for the agent. */
  buildPayload: (restoreJobId: string) => Record<string, unknown>;
}): Promise<DbRestoreDispatchResult> {
  const { orgId } = opts;
  const now = new Date();

  const [job] = await runInOrg(orgId, async () =>
    db
      .insert(restoreJobs)
      .values({
        orgId,
        snapshotId: opts.snapshotId,
        deviceId: opts.deviceId,
        restoreType: 'full',
        status: 'pending',
        initiatedBy: opts.userId ?? null,
        targetConfig: { engine: opts.engine, ...opts.targetConfig },
        createdAt: now,
        updatedAt: now,
      })
      .returning()
  );
  if (!job) {
    return { ok: false, error: 'Failed to create restore job' };
  }

  let queued: Awaited<ReturnType<typeof queueCommandForExecution>>;
  try {
    queued = await runInOrg(orgId, () =>
      queueCommandForExecution(
        opts.deviceId,
        opts.commandType,
        opts.buildPayload(job.id),
        { userId: opts.userId ?? undefined },
      )
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Failed to dispatch restore command to agent';
    console.error(`[BackupRestore] Failed to dispatch ${opts.commandType}:`, err);
    recordBackupDispatchFailure('manual_restore', 'enqueue_failed');
    await markRestoreJobFailedSafe(orgId, job.id, error);
    return { ok: false, error };
  }

  if (!queued.command?.id) {
    const error = queued.error || 'Restore command was queued without a command ID';
    recordBackupDispatchFailure(
      'manual_restore',
      queued.error
        ? (error.startsWith('Device is ') ? 'device_offline' : 'enqueue_failed')
        : 'missing_command_id',
    );
    await markRestoreJobFailedSafe(orgId, job.id, error);
    return { ok: false, error };
  }

  const command = queued.command;
  // The command is already dispatched: a failed link must not become a failed
  // request (the restore is running). Log both ids so the row can be
  // correlated by hand — its terminal result would otherwise be dropped.
  try {
    const linked = await runInOrg(orgId, async () =>
      db
        .update(restoreJobs)
        .set({
          commandId: command.id,
          status: command.status === 'sent' ? 'running' : 'pending',
          startedAt: command.status === 'sent' ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(restoreJobs.id, job.id))
        .returning({ id: restoreJobs.id })
    );
    if (!linked?.length) {
      console.error(`[BackupRestore] restore job ${job.id} not linked to command ${command.id}: update matched no row`);
    }
  } catch (err) {
    console.error(`[BackupRestore] Failed to link restore job ${job.id} to command ${command.id}:`, err);
  }

  return { ok: true, command: { id: command.id, status: command.status }, restoreJobId: job.id };
}
