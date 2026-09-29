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
 *
 * A device that has not reported its helper yet (a new or re-enrolled
 * install before its first heartbeat) is neither: nothing is delivered until
 * the report arrives. The worker holds the whole dispatch (jobs/backupWorker.ts)
 * and the refresher defers the queued command, so the next heartbeat — which
 * carries the report — decides.
 */
import { hasDbAccessContext, withDbAccessContext } from '../db';
import { PROVIDER_CONFIG_REF_FIELD, materializeBackupStorageCredentials } from './backupCommandCredentials';
import { BACKUP_HELPER_UNREPORTED_DEFERRAL_MESSAGE } from './backupHelperProtocols';
import { recordBackupWriteDispatch } from './backupMetrics';
import { resolveBackupWriteCommandDestination } from './backupProviderConfig';
import { loadStoredBackupWriteProtocol, mintBackupWriteSession } from './backupStorageWriteSessions';
import { CommandDeliveryDeferredError, type DeliveryRefreshContext } from './commandDeliveryRefusal';
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

export type WorkerWriteDelivery =
  | {
    mode: 'brokered' | 'legacy' | 'local';
    reason: string;
    payload: Record<string, unknown>;
  }
  // The device has not reported its helper: there is nothing to send.
  | { mode: 'held'; reason: 'helper_unreported' };

/**
 * For the backup worker (system context, before the send): the payload to
 * send for one target. `baseSnapshotId` is the server's own dispatch pin —
 * the only base a write session may read. A minting failure keeps today's
 * payload (logged), never fails the backup. A device that has not reported
 * its helper gets no payload at all (`held`); the worker checks for that
 * before it gets here, so it only happens when a re-enrollment lands in
 * between.
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
    if (minted.mode !== 'brokered') {
      if (minted.reason === 'helper_unreported') return { mode: 'held', reason: 'helper_unreported' };
      return { mode: 'legacy', reason: minted.reason, payload: input.payload };
    }
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

function deferUntilHelperReported(ctx: DeliveryRefreshContext): never {
  recordBackupWriteDispatch(ctx.type, 'deferred', 'helper_unreported');
  throw new CommandDeliveryDeferredError(BACKUP_HELPER_UNREPORTED_DEFERRAL_MESSAGE);
}

/**
 * Delivery refresher for queued MSSQL / Hyper-V backup commands. Brokers the
 * write when it can; otherwise resolves the destination reference exactly as
 * before (materializeBackupStorageCredentials), which also owns every
 * refusal (device moved, configuration gone, plan changed).
 *
 * Before any of that, a device that has not reported its helper yet is
 * DEFERRED (CommandDeliveryDeferredError): the row goes back to pending and
 * the next heartbeat, which carries the report, delivers it. Only a local
 * destination — a path, not a credential — is delivered as before.
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
    payload.provider !== 'local'
    && typeof ctx.reportedBackupWriteProtocolVersion !== 'number'
    && (await loadStoredBackupWriteProtocol(
      ctx.deviceId,
      typeof refOrg === 'string' && UUID_PATTERN.test(refOrg) ? refOrg : null,
    )) === null
  ) {
    deferUntilHelperReported(ctx);
  }
  if (payload.provider !== 's3') return materializeBackupStorageCredentials(payload, ctx, { legacyReason: 'provider_not_s3' });
  if (typeof refOrg !== 'string' || !UUID_PATTERN.test(refOrg) || typeof refConfig !== 'string' || !UUID_PATTERN.test(refConfig)) {
    return materializeBackupStorageCredentials(payload, ctx, { legacyReason: 'no_reference' });
  }
  if (!jobId) return materializeBackupStorageCredentials(payload, ctx, { legacyReason: 'no_job' });

  type Outcome = { payload: Record<string, unknown> } | { legacyReason: string } | { deferred: true };
  const run = async (): Promise<Outcome> => {
    const destination = await resolveBackupWriteCommandDestination(refConfig, refOrg);
    if (!destination.ok) return { legacyReason: 'destination_unavailable' };
    if (destination.destination.provider !== 's3') return { legacyReason: 'provider_not_s3' };
    if (!samePlan(payload.storageEncryption, destination.destination.storageEncryption)) {
      return { legacyReason: 'encryption_plan_changed' };
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
    // A re-enrollment between the check above and this mint.
    if (minted.mode !== 'brokered' && minted.reason === 'helper_unreported') return { deferred: true };
    if (minted.mode !== 'brokered') return { legacyReason: minted.reason };
    recordBackupWriteDispatch(ctx.type, 'brokered', 'ok');
    return {
      payload: {
        ...withoutDestination(payload),
        provider: 's3',
        storageEncryption: destination.destination.storageEncryption,
        storageSession: minted.envelope,
      },
    };
  };

  // Join the delivery path's own context; only a caller holding none (the
  // direct push) gets a fresh organization-scoped one. The mint writes in a
  // savepoint, so a failure leaves the delivery transaction usable: it is
  // logged and the backup is delivered as before, counted with its reason —
  // the same fallback the backup worker takes.
  let outcome: Outcome;
  try {
    outcome = hasDbAccessContext()
      ? await run()
      : await withDbAccessContext(
        { scope: 'organization', orgId: refOrg, accessibleOrgIds: [refOrg], label: 'backupStorageWriteDelivery' },
        run,
      );
  } catch (err) {
    console.error('[backupStorageWriteDelivery] could not issue a write session; delivering the backup as before', {
      commandId: ctx.commandId,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err instanceof Error ? err : new Error(String(err)));
    outcome = { legacyReason: 'mint_failed' };
  }
  if ('payload' in outcome) return outcome.payload;
  // Thrown here, outside the catch above, so it can never become a fallback.
  if ('deferred' in outcome) deferUntilHelperReported(ctx);
  return materializeBackupStorageCredentials(payload, ctx, { legacyReason: outcome.legacyReason });
}
