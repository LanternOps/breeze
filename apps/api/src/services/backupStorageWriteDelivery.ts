/**
 * Delivering backups with a write-scoped storage session instead of the
 * storage destination (services/backupStorageWriteSessions.ts).
 *
 * Two delivery paths carry a backup to a device:
 *   - scheduled / profile backups: the backup worker builds each target's
 *     payload (`brokerWorkerBackupPayload`, called in its preparation phase);
 *   - on-demand MSSQL / Hyper-V backups: a queued command whose destination
 *     reference is resolved at delivery (`deliverBackupWriteCommand`, the
 *     delivery refresher for those types).
 * Either way, when the device's helper reports brokered writes and the
 * destination is S3 over https, the payload carries `storageSession` (with
 * the server-issued snapshot id) and NO `providerConfig`. Otherwise the
 * payload is delivered exactly as before — this release only adds the
 * brokered path for helpers that ask for it.
 */
import { hasDbAccessContext, withDbAccessContext } from '../db';
import { PROVIDER_CONFIG_REF_FIELD, materializeBackupStorageCredentials } from './backupCommandCredentials';
import { recordBackupWriteDispatch } from './backupMetrics';
import { resolveBackupWriteCommandDestination } from './backupProviderConfig';
import { mintBackupWriteSession } from './backupStorageWriteSessions';
import type { DeliveryRefreshContext } from './commandDeliveryRefusal';
import { captureException } from './sentry';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESTINATION_FIELDS = [PROVIDER_CONFIG_REF_FIELD, 'providerConfig', 'providerConfigEnvelope'];

function withoutDestination(payload: Record<string, unknown>): Record<string, unknown> {
  const out = { ...payload };
  for (const field of DESTINATION_FIELDS) delete out[field];
  return out;
}

function samePlan(a: unknown, b: unknown): boolean {
  const l = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
  const r = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
  return l.required === r.required && l.mode === r.mode && (l.keyReference ?? null) === (r.keyReference ?? null);
}

function baseManifestKeyFor(baseSnapshotId: string | null | undefined): string | null {
  return typeof baseSnapshotId === 'string' && baseSnapshotId.length > 0
    ? `snapshots/${baseSnapshotId}/manifest.json`
    : null;
}

export type WorkerWriteDelivery = {
  mode: 'brokered' | 'legacy' | 'local';
  reason: string;
  payload: Record<string, unknown>;
};

/**
 * For the backup worker (system context, before the send): the payload to
 * send for one target. `baseSnapshotId` is the server's own dispatch pin —
 * the only base a write session may read. A minting failure keeps today's
 * payload (logged), never fails the backup.
 */
export async function brokerWorkerBackupPayload(input: {
  orgId: string;
  jobId: string;
  deviceId: string;
  configId: string;
  commandType: string;
  provider: string;
  providerConfig: Record<string, unknown>;
  payload: Record<string, unknown>;
  baseSnapshotId: string | null;
}): Promise<WorkerWriteDelivery> {
  if (input.provider === 'local') return { mode: 'local', reason: 'no_credential', payload: input.payload };
  try {
    const minted = await mintBackupWriteSession({
      orgId: input.orgId,
      jobId: input.jobId,
      deviceId: input.deviceId,
      configId: input.configId,
      provider: input.provider,
      providerConfig: input.providerConfig,
      baseManifestKey: input.commandType === 'backup_run' ? baseManifestKeyFor(input.baseSnapshotId) : null,
    });
    if (minted.mode !== 'brokered') return { mode: 'legacy', reason: minted.reason, payload: input.payload };
    return {
      mode: 'brokered',
      reason: 'ok',
      payload: { ...withoutDestination(input.payload), provider: 's3', storageSession: minted.envelope },
    };
  } catch (err) {
    console.error('[backupStorageWriteDelivery] could not issue a write session; delivering the backup as before', {
      jobId: input.jobId,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err instanceof Error ? err : new Error(String(err)));
    return { mode: 'legacy', reason: 'mint_failed', payload: input.payload };
  }
}

/**
 * Delivery refresher for queued MSSQL / Hyper-V backup commands. Brokers the
 * write when it can; otherwise resolves the destination reference exactly as
 * before (materializeBackupStorageCredentials), which also owns every
 * refusal (device moved, configuration gone, plan changed).
 */
export async function deliverBackupWriteCommand(
  payload: Record<string, unknown>,
  ctx: DeliveryRefreshContext,
): Promise<Record<string, unknown>> {
  const ref = payload[PROVIDER_CONFIG_REF_FIELD] as Record<string, unknown> | undefined;
  const refOrg = ref && typeof ref === 'object' ? ref.orgId : undefined;
  const refConfig = ref && typeof ref === 'object' ? ref.configId : undefined;
  const jobId = [payload.jobId, payload.backupJobId].find((v): v is string => typeof v === 'string' && UUID_PATTERN.test(v));
  if (
    payload.provider !== 's3'
    || typeof refOrg !== 'string' || !UUID_PATTERN.test(refOrg)
    || typeof refConfig !== 'string' || !UUID_PATTERN.test(refConfig)
    || !jobId
  ) {
    return materializeBackupStorageCredentials(payload, ctx);
  }

  const run = async (): Promise<Record<string, unknown> | null> => {
    const destination = await resolveBackupWriteCommandDestination(refConfig, refOrg);
    if (
      !destination.ok
      || destination.destination.provider !== 's3'
      || !samePlan(payload.storageEncryption, destination.destination.storageEncryption)
    ) {
      return null;
    }
    const minted = await mintBackupWriteSession({
      orgId: refOrg,
      jobId,
      deviceId: ctx.deviceId,
      configId: refConfig,
      provider: 's3',
      providerConfig: destination.destination.providerConfig,
      baseManifestKey: null,
      reportedWriteProtocolVersion: ctx.reportedBackupWriteProtocolVersion,
    });
    if (minted.mode !== 'brokered') return null;
    recordBackupWriteDispatch(ctx.type, 'brokered', 'ok');
    return {
      ...withoutDestination(payload),
      provider: 's3',
      storageEncryption: destination.destination.storageEncryption,
      storageSession: minted.envelope,
    };
  };

  // Join the delivery path's own context; only a caller holding none (the
  // direct push) gets a fresh organization-scoped one.
  const brokered = hasDbAccessContext()
    ? await run()
    : await withDbAccessContext(
      { scope: 'organization', orgId: refOrg, accessibleOrgIds: [refOrg], label: 'backupStorageWriteDelivery' },
      run,
    );
  return brokered ?? materializeBackupStorageCredentials(payload, ctx);
}
