// Restore-as-VM on the rebuild engine (bare-metal W05a, Task 5; W06d): a
// whole-machine snapshot is rebuilt into a Hyper-V-ready VHDX on a rebuild
// host of the SAME platform (Linux snapshot → Linux host, Windows snapshot →
// Windows host), driven by the `bare_metal_rebuild` device command. A Windows
// host can also create the Hyper-V VM afterwards (`hyperv`). One
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
import { rebuildPathMatchesHostOs, resolveSnapshotPlatform, type HypervOptions } from './bareMetalRebuildSchemas';
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
  /** Create a Hyper-V VM from the rebuilt VHDX (W06d). Windows rebuild hosts only. */
  hyperv?: HypervOptions;
  /**
   * Integrity decision for the snapshot (services/backupRestoreGate.ts),
   * made by the caller for its own actor: a route checks the request and its
   * step-up, an AI tool refuses unattested snapshots. Called after every other
   * check and before anything is created. A confirmed restore of a snapshot
   * without a usable attestation returns `bindRecovery`, which records the
   * authorization bound to the recovery (same transaction) before the rebuild
   * command is queued.
   */
  integrity: (snapshot: { id: string; deviceId: string }) => Promise<RebuildIntegrityDecision>;
};

export type RebuildIntegrityDecision =
  | { ok: true; bindRecovery?: (recoveryId: string) => Promise<unknown> }
  | { ok: false; status: 403 | 409; body: Record<string, unknown> };

export type RebuildEngineVmRestoreResult =
  | { ok: true; jobId: string; recoveryId: string; commandId: string; status: 'queued' }
  | {
    ok: false;
    status: 400 | 403 | 404 | 409 | 502;
    error: string;
    /** When present, the complete response body for the refusal (integrity decisions). */
    body?: Record<string, unknown>;
    /** Human-readable text for refusals whose `error` is a machine code. */
    message?: string;
    details?: Record<string, unknown>;
  };

export const HYPERV_REQUIRES_WINDOWS_HOST_MESSAGE = 'hyperv is only valid for Windows rebuild hosts';

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
  // W06d: the engine picks its phase table from the layout's platform, so a
  // layout without one cannot be rebuilt (every layout since W01 records it).
  const snapshotPlatform = resolveSnapshotPlatform(snapshot.layoutManifest);
  if (!snapshotPlatform) {
    return {
      ok: false,
      status: 409,
      error: 'snapshot_not_bare_metal_restorable',
      details: { reasons: ['snapshot disk layout manifest records no platform'] },
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
  // W06d: platform-matched, not Linux-only. rebuild.Run refuses a snapshot
  // whose platform differs from the host's; refuse here before creating rows
  // rather than after a wasted round trip (macOS never matches).
  if (host.osType !== snapshotPlatform) {
    return {
      ok: false,
      status: 409,
      error: 'rebuild_host_unsupported',
      details: { osType: host.osType, snapshotPlatform },
    };
  }
  if (input.hyperv && host.osType !== 'windows') {
    return {
      ok: false,
      status: 400,
      error: 'hyperv_requires_windows_host',
      message: `${HYPERV_REQUIRES_WINDOWS_HOST_MESSAGE}; this host is ${host.osType}`,
    };
  }
  if (!rebuildPathMatchesHostOs(input.outputPath, host.osType)) {
    return {
      ok: false,
      status: 400,
      error: 'output_path_host_mismatch',
      message: host.osType === 'windows'
        ? 'outputPath must be a drive-letter path (e.g. C:\\…) on a Windows rebuild host'
        : `outputPath must be a POSIX path (/…) on a ${host.osType} rebuild host`,
    };
  }
  if (host.status !== 'online') {
    recordBackupDispatchFailure('manual_restore', 'device_offline');
    return { ok: false, status: 409, error: `Device is ${host.status}, cannot execute command` };
  }

  const integrity = await input.integrity({ id: snapshot.id, deviceId: snapshot.deviceId });
  if (!integrity.ok) {
    return {
      ok: false,
      status: integrity.status,
      error: typeof integrity.body.code === 'string' ? integrity.body.code : 'snapshot_integrity_unavailable',
      body: integrity.body,
    };
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
    if (integrity.bindRecovery) await integrity.bindRecovery(recoveryId);
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
        ...(input.hyperv ? { hyperv: input.hyperv } : {}),
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
      ...(input.hyperv ? { hyperv: input.hyperv } : {}),
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
