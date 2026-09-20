// Restore-as-VM on the rebuild engine (bare-metal W05a, Task 5): a Linux
// whole-machine snapshot is rebuilt into a Hyper-V-ready VHDX on a Linux
// helper host, driven by the `bare_metal_rebuild` device command. One
// orchestration shared by `POST /backup/restore/as-vm` (engine: 'rebuild')
// and the `restore_as_vm` AI tool, so both write the same pair of rows:
//
//   bare_metal_recoveries  — identity: 'new' (server-forced, §9), token-linked
//   restore_jobs           — deviceId = the REBUILD HOST, because
//                            updateRestoreJobByCommandId filters by the device
//                            that ran the command; the source device rides in
//                            targetConfig.sourceDeviceId.
//
// Callers authorize first (route: authorizeRouteResilienceResources; AI tool:
// loadSnapshotWithSiteAccess + the deviceArgs gate). Everything here is scoped
// by the already-authorized orgId.
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { backupSnapshots, devices, restoreJobs } from '../db/schema';
import { recordBackupDispatchFailure } from './backupMetrics';
import {
  BareMetalRecoveryError,
  cancelBareMetalRecovery,
  createBareMetalRecovery,
  mintRecoveryTokenForRecovery,
} from './bareMetalRecoveryService';
import { queueBareMetalRebuild } from './bareMetalRebuildCommand';
import { resolveServerUrl } from './recoveryBootstrap';

export const REBUILD_VHDX_RESTORE_MODE = 'rebuild_vhdx';

const GIB = 1024 * 1024 * 1024;

export type RebuildEngineVmRestoreInput = {
  orgId: string;
  snapshotId: string;
  rebuildHostDeviceId: string;
  /** Absolute `.vhdx` path on the rebuild host (validated by the caller's schema). */
  outputPath: string;
  imageSizeGb?: number;
  userId: string | null;
  /** Used only as the last fallback when neither BREEZE_SERVER nor PUBLIC_API_URL is set. */
  requestUrl?: string;
};

export type RebuildEngineVmRestoreResult =
  | { ok: true; jobId: string; recoveryId: string; commandId: string; status: 'queued' }
  | { ok: false; status: 404 | 409 | 502; error: string; details?: Record<string, unknown> };

function dispatchErrorStatus(error: string): 409 | 502 {
  return error.startsWith('Device is ') ? 409 : 502;
}

async function markRestoreJobFailed(orgId: string, restoreJobId: string, error: string): Promise<void> {
  const now = new Date();
  await db
    .update(restoreJobs)
    .set({
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      targetConfig: sql`coalesce(${restoreJobs.targetConfig}, '{}'::jsonb) || jsonb_build_object('error', ${error})`,
    })
    .where(and(eq(restoreJobs.id, restoreJobId), eq(restoreJobs.orgId, orgId)));
}

export async function startRebuildEngineVmRestore(input: RebuildEngineVmRestoreInput): Promise<RebuildEngineVmRestoreResult> {
  const { orgId } = input;

  const [snapshot] = await db
    .select({
      id: backupSnapshots.id,
      deviceId: backupSnapshots.deviceId,
      layoutManifest: backupSnapshots.layoutManifest,
      bareMetalRestorable: backupSnapshots.bareMetalRestorable,
    })
    .from(backupSnapshots)
    .where(and(eq(backupSnapshots.id, input.snapshotId), eq(backupSnapshots.orgId, orgId)))
    .limit(1);
  if (!snapshot) {
    return { ok: false, status: 404, error: 'snapshot_not_found' };
  }
  // The engine needs the disk layout to provision the image; the guard
  // verdict says the snapshot's contents are whole-machine restorable. Both
  // are required, and the service re-checks the verdict on create.
  if (!snapshot.layoutManifest || snapshot.bareMetalRestorable !== true) {
    return {
      ok: false,
      status: 409,
      error: 'snapshot_not_bare_metal_restorable',
      details: snapshot.layoutManifest ? {} : { reasons: ['snapshot has no disk layout manifest'] },
    };
  }

  const [host] = await db
    .select({ id: devices.id, status: devices.status, osType: devices.osType })
    .from(devices)
    .where(and(eq(devices.id, input.rebuildHostDeviceId), eq(devices.orgId, orgId)))
    .limit(1);
  if (!host) {
    return { ok: false, status: 404, error: 'rebuild_host_not_found' };
  }
  // The engine runs on Linux only in this wave (rebuild.Run → ErrUnsupportedHost
  // elsewhere); refuse before creating rows rather than after a wasted round trip.
  if (host.osType !== 'linux') {
    return { ok: false, status: 409, error: 'rebuild_host_unsupported', details: { osType: host.osType } };
  }
  if (host.status !== 'online') {
    recordBackupDispatchFailure('manual_restore', 'device_offline');
    return { ok: false, status: 409, error: `Device is ${host.status}, cannot execute command` };
  }

  const target = {
    kind: 'vhdx' as const,
    path: input.outputPath,
    ...(input.imageSizeGb ? { imageSizeBytes: input.imageSizeGb * GIB } : {}),
  };

  let recoveryId: string;
  let token: string;
  let tokenId: string;
  try {
    const created = await createBareMetalRecovery({
      orgId,
      snapshotId: snapshot.id,
      // Rehearsal invariant (§9): an engine-produced image never resumes the
      // production identity. Not taken from the caller — the schemas do not
      // even carry the field.
      identity: 'new',
      createdBy: input.userId,
      source: 'vm_restore',
      executingDeviceId: input.rebuildHostDeviceId,
      target,
    });
    recoveryId = created.row.id;
    const minted = await mintRecoveryTokenForRecovery({ recoveryId, orgId, createdBy: input.userId });
    token = minted.token;
    tokenId = minted.tokenId;
  } catch (err) {
    if (err instanceof BareMetalRecoveryError) {
      return { ok: false, status: err.status, error: err.code, ...(err.details ? { details: err.details } : {}) };
    }
    throw err;
  }

  const now = new Date();
  const [restoreJob] = await db
    .insert(restoreJobs)
    .values({
      orgId,
      snapshotId: snapshot.id,
      deviceId: input.rebuildHostDeviceId,
      restoreType: 'full',
      status: 'pending',
      initiatedBy: input.userId,
      recoveryTokenId: tokenId,
      targetConfig: {
        mode: REBUILD_VHDX_RESTORE_MODE,
        engine: 'rebuild',
        outputPath: input.outputPath,
        rebuildHostDeviceId: input.rebuildHostDeviceId,
        sourceDeviceId: snapshot.deviceId,
        recoveryId,
        ...(input.imageSizeGb ? { imageSizeGb: input.imageSizeGb } : {}),
      },
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: restoreJobs.id });
  if (!restoreJob) {
    await cancelBareMetalRecovery({ recoveryId, orgId, userId: input.userId, reason: 'restore_job_insert_failed' }).catch(() => {});
    throw new Error('Failed to create restore job');
  }

  const { command, error } = await queueBareMetalRebuild({
    orgId,
    hostDeviceId: input.rebuildHostDeviceId,
    ...(input.userId ? { userId: input.userId } : {}),
    payload: {
      recoveryId,
      token,
      server: resolveServerUrl(input.requestUrl),
      target,
      identity: 'new',
    },
  });

  if (error || !command) {
    const message = error ?? 'Rebuild command was queued without a command ID';
    recordBackupDispatchFailure('manual_restore', error?.startsWith('Device is ') ? 'device_offline' : 'enqueue_failed');
    await markRestoreJobFailed(orgId, restoreJob.id, message);
    // Free the "one non-terminal recovery per device" slot so the operator can retry.
    await cancelBareMetalRecovery({ recoveryId, orgId, userId: input.userId, reason: message }).catch(() => {});
    return { ok: false, status: dispatchErrorStatus(message), error: message };
  }

  await db
    .update(restoreJobs)
    .set({
      commandId: command.id,
      status: command.status === 'sent' ? 'running' : 'pending',
      startedAt: command.status === 'sent' ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(and(eq(restoreJobs.id, restoreJob.id), eq(restoreJobs.orgId, orgId)));

  return { ok: true, jobId: restoreJob.id, recoveryId, commandId: command.id, status: 'queued' };
}
