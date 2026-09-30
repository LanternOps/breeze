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
 * A backup to S3 storage is delivered ONLY with `storageSession` (carrying
 * the server-issued snapshot id) and never with `providerConfig`. When no
 * write session can be issued — the helper does not report brokered writes,
 * the endpoint is not https, the server origin is not usable, the job has
 * ended — the backup is refused with a reason the operator can act on; the
 * storage destination is never sent instead. Only a LOCAL destination, which
 * is a path and not a credential, is delivered as a destination.
 *
 * A device that has not reported its helper yet (a new or re-enrolled
 * install before its first heartbeat) gets nothing until the report arrives.
 * The worker holds the whole dispatch (jobs/backupWorker.ts) and the
 * refresher defers the queued command, so the next heartbeat — which
 * carries the report — decides.
 */
import { hasDbAccessContext, withDbAccessContext } from '../db';
import { PROVIDER_CONFIG_REF_FIELD, materializeBackupStorageCredentials } from './backupCommandCredentials';
import { BACKUP_HELPER_UNREPORTED_DEFERRAL_MESSAGE } from './backupHelperProtocols';
import { recordBackupWriteDispatch } from './backupMetrics';
import { resolveBackupWriteCommandDestination } from './backupProviderConfig';
import { loadStoredBackupWriteProtocol, mintBackupWriteSession } from './backupStorageWriteSessions';
import { BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE } from './backupWriteHelperGate';
import {
  CommandDeliveryDeferredError,
  CommandDeliveryRefusedError,
  type DeliveryRefreshContext,
} from './commandDeliveryRefusal';
import { captureException } from './sentry';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESTINATION_FIELDS = [PROVIDER_CONFIG_REF_FIELD, 'providerConfig', 'providerConfigEnvelope'];

function withoutDestination(payload: Record<string, unknown>): Record<string, unknown> {
  const out = { ...payload };
  for (const field of DESTINATION_FIELDS) delete out[field];
  return out;
}

function hasInlineDestination(payload: Record<string, unknown>): boolean {
  return 'providerConfig' in payload || 'providerConfigEnvelope' in payload;
}

/**
 * Why a backup was not delivered, for the backup job / command result it ends
 * up on. Operator-facing; never names a credential or a key.
 */
const WRITE_REFUSAL_MESSAGES: Record<string, string> = {
  helper_unsupported: BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE,
  provider_not_s3:
    'This backup destination uses a storage provider that backups no longer support. '
    + 'Change the backup destination to S3-compatible storage or a local path.',
  insecure_endpoint:
    'Backups to S3 storage require the storage endpoint to use HTTPS. Change the backup destination endpoint to HTTPS.',
  server_origin_mismatch:
    'This device connects to Breeze at an address the server is not configured to serve, so a secure storage session '
    + 'cannot be issued. Set PUBLIC_API_URL to the address agents use.',
  server_origin_unavailable:
    'The server address agents use is not configured, so a secure storage session cannot be issued. Set PUBLIC_API_URL.',
  insecure_server_origin:
    'Backups to S3 storage require agents to reach Breeze over HTTPS. Serve the agent API over HTTPS.',
  device_org_mismatch: 'The target device no longer belongs to the organization that owns this backup destination.',
  job_not_live: 'This backup job has already finished or been cancelled.',
  inline_destination:
    'This backup was queued by an earlier version of Breeze and can no longer be delivered. Start it again.',
  no_reference: 'This backup command carries no usable backup destination reference. Start it again.',
  no_job: 'This backup command is not linked to a backup job. Start it again.',
  provider_changed: 'The backup destination changed provider after this backup was queued. Start it again.',
  encryption_plan_changed:
    'The backup destination encryption settings changed after this backup was queued. Start it again.',
  mint_failed: 'The backup was not started: a secure storage session could not be issued for it. Run the backup again.',
};

export function backupWriteRefusalMessage(reason: string): string {
  return WRITE_REFUSAL_MESSAGES[reason] ?? 'This backup cannot be written securely.';
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
    mode: 'brokered' | 'local';
    reason: string;
    payload: Record<string, unknown>;
  }
  // No write session could be issued: nothing is sent, the target fails
  // with `message`.
  | { mode: 'refused'; reason: string; message: string }
  // The device has not reported its helper: there is nothing to send.
  | { mode: 'held'; reason: 'helper_unreported' };

function refused(reason: string): Extract<WorkerWriteDelivery, { mode: 'refused' }> {
  return { mode: 'refused', reason, message: backupWriteRefusalMessage(reason) };
}

/**
 * For the backup worker (system context, before the send): the payload to
 * send for one target. `baseSnapshotId` is the server's own dispatch pin —
 * the only base a write session may read. A backup to S3 storage is sent
 * only with a write session; when none can be issued (including a minting
 * failure, which is logged) the target is refused and nothing is sent. A
 * device that has not reported its helper gets no payload at all (`held`);
 * the worker checks for that before it gets here, so it only happens when a
 * re-enrollment lands in between.
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
  if (input.provider !== 's3') return refused('provider_not_s3');
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
      return refused(minted.reason);
    }
    return {
      mode: 'brokered',
      reason: 'ok',
      payload: { ...withoutDestination(input.payload), provider: 's3', storageSession: minted.envelope },
    };
  } catch (err) {
    console.error('[backupStorageWriteDelivery] could not issue a write session; the backup target is not sent', {
      jobId: input.jobId,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err instanceof Error ? err : new Error(String(err)));
    return refused('mint_failed');
  }
}

function deferUntilHelperReported(ctx: DeliveryRefreshContext): never {
  recordBackupWriteDispatch(ctx.type, 'deferred', 'helper_unreported');
  throw new CommandDeliveryDeferredError(BACKUP_HELPER_UNREPORTED_DEFERRAL_MESSAGE);
}

function refuseDelivery(ctx: DeliveryRefreshContext, reason: string, message = backupWriteRefusalMessage(reason)): never {
  recordBackupWriteDispatch(ctx.type, 'refused', reason);
  throw new CommandDeliveryRefusedError(message);
}

/**
 * Delivery refresher for queued MSSQL / Hyper-V backup commands. A backup to
 * S3 storage is delivered only with a write session; anything that cannot be
 * brokered is refused (CommandDeliveryRefusedError) with its reason — the
 * storage destination is never resolved into the frame. A LOCAL destination
 * is resolved by the destination refresher (materializeBackupStorageCredentials),
 * which also owns its refusals (device moved, configuration gone, plan
 * changed).
 *
 * Before any of that, a device that has not reported its helper yet is
 * DEFERRED (CommandDeliveryDeferredError): the row goes back to pending and
 * the next heartbeat, which carries the report, delivers it. A failure to
 * issue the session is transient: the error propagates and the row is
 * released for a later attempt.
 */
export async function deliverBackupWriteCommand(
  payload: Record<string, unknown>,
  ctx: DeliveryRefreshContext,
): Promise<Record<string, unknown>> {
  if (payload.provider === 'local' && !hasInlineDestination(payload)) {
    // A local destination is a path the device reaches itself. The resolver
    // refuses if the referenced configuration is no longer local.
    return materializeBackupStorageCredentials(payload, ctx);
  }

  const ref = payload[PROVIDER_CONFIG_REF_FIELD] as Record<string, unknown> | undefined;
  const refOrg = ref && typeof ref === 'object' ? ref.orgId : undefined;
  const refConfig = ref && typeof ref === 'object' ? ref.configId : undefined;
  const jobId = [payload.jobId, payload.backupJobId].find((v): v is string => typeof v === 'string' && UUID_PATTERN.test(v));
  if (
    typeof ctx.reportedBackupWriteProtocolVersion !== 'number'
    && (await loadStoredBackupWriteProtocol(
      ctx.deviceId,
      typeof refOrg === 'string' && UUID_PATTERN.test(refOrg) ? refOrg : null,
    )) === null
  ) {
    deferUntilHelperReported(ctx);
  }
  // Queued before destination references existed: its only way to be
  // delivered is its inline destination, which is never sent for a backup.
  if (hasInlineDestination(payload)) refuseDelivery(ctx, 'inline_destination');
  if (payload.provider !== 's3') refuseDelivery(ctx, 'provider_not_s3');
  if (typeof refOrg !== 'string' || !UUID_PATTERN.test(refOrg) || typeof refConfig !== 'string' || !UUID_PATTERN.test(refConfig)) {
    refuseDelivery(ctx, 'no_reference');
  }
  if (!jobId) refuseDelivery(ctx, 'no_job');

  type Outcome =
    | { payload: Record<string, unknown> }
    | { refused: string; message?: string }
    | { deferred: true };
  const run = async (): Promise<Outcome> => {
    const destination = await resolveBackupWriteCommandDestination(refConfig, refOrg);
    if (!destination.ok) {
      return { refused: 'destination_unavailable', message: `The backup destination can no longer be used: ${destination.message}` };
    }
    if (destination.destination.provider !== 's3') return { refused: 'provider_changed' };
    if (!samePlan(payload.storageEncryption, destination.destination.storageEncryption)) {
      return { refused: 'encryption_plan_changed' };
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
    if (minted.mode !== 'brokered') return { refused: minted.reason };
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
  // savepoint, so a failure leaves the delivery transaction usable; it is
  // logged and rethrown, which releases the row for a later attempt.
  let outcome: Outcome;
  try {
    outcome = hasDbAccessContext()
      ? await run()
      : await withDbAccessContext(
        { scope: 'organization', orgId: refOrg, accessibleOrgIds: [refOrg], label: 'backupStorageWriteDelivery' },
        run,
      );
  } catch (err) {
    console.error('[backupStorageWriteDelivery] could not issue a write session; the backup will be delivered later', {
      commandId: ctx.commandId,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
  if ('payload' in outcome) return outcome.payload;
  if ('deferred' in outcome) deferUntilHelperReported(ctx);
  return refuseDelivery(ctx, outcome.refused, outcome.message);
}
