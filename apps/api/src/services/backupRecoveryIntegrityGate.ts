/**
 * Integrity enforcement for bare-metal recovery clients: the recovery media /
 * `breeze-backup bmr-recover` / rebuild host, at token authentication
 * (`POST /bmr/recover/authenticate`, called again on every re-authentication)
 * and at code exchange (`POST /bmr/recover/exchange`).
 *
 * A recovery client must report `integrityProtocolVersion` >= 2 (it checks
 * every restored byte against the snapshot attestation); an older client, or
 * one that reports nothing, is refused with an instruction to get current
 * recovery media. The snapshot is then decided like any privileged restore
 * (services/backupRestoreGate.ts): attested → the attested block; attestation
 * still being checked → retry; failed or unresolved → refused; no usable
 * attestation → only with a confirmed authorization bound to the recovery
 * token or to the recovery it belongs to
 * (services/backupRestoreAuthorization.ts), delivered as an override block.
 *
 * Because authentication re-runs this on every call, recovery tokens and
 * sessions created before this check existed are covered at their next
 * authentication.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { bareMetalRecoveries } from '../db/schema/bareMetalRecoveries';
import { recordRestoreIntegrity, type RestoreIntegrityMetricStatus } from './backupMetrics';
import {
  authorizationCovers,
  findRecoveryRestoreAuthorizations,
  type StoredRestoreAuthorization,
} from './backupRestoreAuthorization';
import {
  MIN_RESTORE_INTEGRITY_PROTOCOL,
  RESTORE_INTEGRITY_MESSAGES,
  decideRestoreGate,
  overrideIntegrityPayload,
} from './backupRestoreGate';
import {
  RECOVERY_BOOTSTRAP_INTEGRITY_TYPE,
  integrityMetricLabels,
  integrityPayload,
  resolveRestoreIntegrity,
  type RestoreIntegrity,
} from './backupRestoreIntegrity';
import { CommandTypes } from './commandTypes';

export const RECOVERY_CLIENT_UPDATE_REQUIRED_MESSAGE =
  'This recovery tool is too old to check backup integrity. Download current recovery media or the current recovery tool, then try again.';

/** Seconds a recovery client waits before asking again while an attestation is being checked. */
export const ATTESTATION_PENDING_RETRY_SECONDS = 60;

/** Authorizations that cover a recovery: a token/recovery restore, or a rebuild of the same recovery. */
const RECOVERY_COMMAND_TYPES = [CommandTypes.BMR_RECOVER, CommandTypes.BARE_METAL_REBUILD];

export interface RecoveryIntegrityDeps {
  resolve(snapshotDbId: string): Promise<RestoreIntegrity | null>;
  findAuthorizations(binding: { recoveryTokenId: string | null; recoveryId: string | null }): Promise<StoredRestoreAuthorization[]>;
  recordIntegrity(type: string, status: RestoreIntegrityMetricStatus, reason: string): void;
}

export const defaultRecoveryIntegrityDeps: RecoveryIntegrityDeps = {
  resolve: (snapshotDbId) => resolveRestoreIntegrity(snapshotDbId),
  findAuthorizations: async ({ recoveryTokenId, recoveryId }) => {
    // A token minted by a recovery's exchange (or for a rebuild) carries the
    // recovery's authorization: resolve the recovery from the token.
    let resolvedRecoveryId = recoveryId;
    if (!resolvedRecoveryId && recoveryTokenId) {
      const [row] = await db
        .select({ id: bareMetalRecoveries.id })
        .from(bareMetalRecoveries)
        .where(eq(bareMetalRecoveries.recoveryTokenId, recoveryTokenId))
        .limit(1);
      resolvedRecoveryId = row?.id ?? null;
    }
    return findRecoveryRestoreAuthorizations({ recoveryTokenId, recoveryId: resolvedRecoveryId });
  },
  recordIntegrity: (type, status, reason) => recordRestoreIntegrity(type, status, reason),
};

export type RecoveryIntegrityOutcome =
  | { ok: true; integrity: Record<string, unknown> }
  | { ok: false; status: 409; body: { error: string; message: string; retryAfterSeconds?: number } };

/**
 * Decides one recovery authentication or exchange, in the caller's DB context
 * (the recovery's org). On success returns the bootstrap `integrity` block.
 */
export async function evaluateRecoveryIntegrity(
  input: {
    snapshotDbId: string;
    /** The device being recovered. */
    targetDeviceId: string;
    /** As reported by the client (request body); anything but an integer >= 2 is refused. */
    clientIntegrityProtocolVersion: unknown;
    recoveryTokenId?: string | null;
    recoveryId?: string | null;
  },
  deps: RecoveryIntegrityDeps = defaultRecoveryIntegrityDeps,
): Promise<RecoveryIntegrityOutcome> {
  const refuse = (error: string, message: string, extra: { retryAfterSeconds?: number } = {}): RecoveryIntegrityOutcome => {
    deps.recordIntegrity(RECOVERY_BOOTSTRAP_INTEGRITY_TYPE, 'refused', error);
    return { ok: false, status: 409, body: { error, message, ...extra } };
  };

  const version = input.clientIntegrityProtocolVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < MIN_RESTORE_INTEGRITY_PROTOCOL) {
    return refuse('recovery_client_update_required', RECOVERY_CLIENT_UPDATE_REQUIRED_MESSAGE);
  }

  const integrity = await deps.resolve(input.snapshotDbId);
  const decision = decideRestoreGate({
    commandType: CommandTypes.BMR_RECOVER,
    integrity,
    targetDeviceId: input.targetDeviceId,
  });
  if (decision.kind === 'allow') {
    const labels = integrityMetricLabels(integrity);
    deps.recordIntegrity(RECOVERY_BOOTSTRAP_INTEGRITY_TYPE, labels.status as RestoreIntegrityMetricStatus, labels.reason);
    return { ok: true, integrity: integrityPayload(integrity!) };
  }
  if (decision.kind === 'refuse') {
    return decision.code === 'attestation_pending'
      ? refuse(decision.code, decision.message, { retryAfterSeconds: ATTESTATION_PENDING_RETRY_SECONDS })
      : refuse(decision.code, decision.message);
  }

  const authorizations = await deps.findAuthorizations({
    recoveryTokenId: input.recoveryTokenId ?? null,
    recoveryId: input.recoveryId ?? null,
  });
  const covering = authorizations.find((a) => authorizationCovers(a, {
    snapshotDbId: input.snapshotDbId,
    targetDeviceId: input.targetDeviceId,
    commandTypes: RECOVERY_COMMAND_TYPES,
  }));
  if (!covering) return refuse('authorization_missing', RESTORE_INTEGRITY_MESSAGES.authorization_missing);
  deps.recordIntegrity(RECOVERY_BOOTSTRAP_INTEGRITY_TYPE, 'override', decision.reason);
  return { ok: true, integrity: overrideIntegrityPayload(integrity!.snapshotId, covering.id) };
}
