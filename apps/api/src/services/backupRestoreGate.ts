/**
 * Whether a restore may run, on integrity grounds.
 *
 * A PRIVILEGED restore installs, imports or boots a snapshot's bytes on a
 * device (file restore, MSSQL and Hyper-V restore, VM restore and instant
 * boot, bare-metal recovery and rebuild). It runs only when:
 *   - the backup helper that will perform it checks restored bytes against the
 *     snapshot attestation (integrity protocol 2); and
 *   - the snapshot has a usable attestation (services/backupRestoreIntegrity.ts):
 *     server-verified, or device-local (producer-only) restored onto the
 *     device that wrote it; or
 *   - for an unattested snapshot (one written before attestations existed,
 *     or by a helper that did not produce one), and for a device-local
 *     snapshot restored onto another device: a technician confirmed it with a
 *     two-factor step-up, recorded as a durable authorization bound to that
 *     exact snapshot, target device and command
 *     (services/backupRestoreAuthorization.ts).
 *
 * A snapshot that did not match its attestation is never restored, with or
 * without a step-up. A snapshot whose attestation is still being checked waits.
 *
 * Read-only validation (verify, test-restore, MSSQL verify) is not
 * privileged: it restores into the helper's private scratch space and never
 * installs anything. It runs for any snapshot that has not failed its check;
 * the integrity block it carries tells the helper (and its result) whether the
 * snapshot was attested.
 *
 * Every decision here is enforced twice: when the restore is requested (routes
 * and the two enqueue chokepoints) and again when the command is delivered
 * (the delivery refreshers), because the helper may change in between and
 * delivery is the one place every enqueue path passes through.
 *
 * Leaf module: imports only the command type table and types.
 */
import type { RestoreIntegrity } from './backupRestoreIntegrity';
import { CommandTypes } from './commandTypes';

/** Integrity protocol a helper must report to perform a privileged restore. */
export const MIN_RESTORE_INTEGRITY_PROTOCOL = 2;

export const PRIVILEGED_RESTORE_COMMAND_TYPES: readonly string[] = [
  CommandTypes.BACKUP_RESTORE,
  CommandTypes.MSSQL_RESTORE,
  CommandTypes.HYPERV_RESTORE,
  CommandTypes.VM_RESTORE_FROM_BACKUP,
  CommandTypes.VM_INSTANT_BOOT,
  CommandTypes.BMR_RECOVER,
  CommandTypes.BARE_METAL_REBUILD,
];

const PRIVILEGED = new Set(PRIVILEGED_RESTORE_COMMAND_TYPES);

export function isPrivilegedRestoreCommandType(type: string): boolean {
  return PRIVILEGED.has(type);
}

/**
 * Shown to the operator (route response, restore job, command result). Leads
 * with the action.
 */
export const RESTORE_HELPER_UPDATE_REQUIRED_MESSAGE =
  'Update the Breeze agent on this device, then try again. Restoring backups now requires integrity checks '
  + "this device's backup component does not support yet.";

/** Operator-facing reasons, keyed by decision code. */
export const RESTORE_INTEGRITY_MESSAGES = {
  attestation_pending: 'This backup is still being checked. Try again in a few minutes.',
  snapshot_integrity_failed: 'This backup did not match its integrity record and cannot be restored.',
  snapshot_integrity_unavailable:
    'This backup has no integrity attestation. A technician must restore it from the Breeze console with two-factor confirmation.',
  ai_unattested:
    'This backup has no integrity attestation. A technician must restore it from the Breeze console with two-factor confirmation.',
  snapshot_unresolved: 'The backup could not be found for this organization, so its integrity cannot be checked.',
  step_up_required:
    'This backup has no integrity attestation. Confirm the restore with two-factor authentication to continue.',
  producer_only_other_target:
    'This backup was written to storage only the original device can check. Confirm the restore to another device with two-factor authentication to continue.',
  authorization_missing:
    'This restore of a backup without an integrity attestation was not confirmed with two-factor authentication. Start it again from the Breeze console.',
} as const;

/**
 * The refusal for a privileged restore to a helper reporting `protocolVersion`,
 * or null when it may be queued. `null` is the stored "not reported yet" and is
 * queued (delivery waits for the report); `undefined` is refused like 0.
 */
export function restoreIntegrityHelperRefusal(
  type: string,
  protocolVersion: number | null | undefined,
): string | null {
  if (!PRIVILEGED.has(type)) return null;
  if (protocolVersion === null) return null;
  if ((protocolVersion ?? 0) >= MIN_RESTORE_INTEGRITY_PROTOCOL) return null;
  return RESTORE_HELPER_UPDATE_REQUIRED_MESSAGE;
}

/** True for exactly the refusal above, so routes can answer it as a conflict, not a dispatch failure. */
export function isRestoreHelperUpdateRequiredError(error: string | null | undefined): boolean {
  return error === RESTORE_HELPER_UPDATE_REQUIRED_MESSAGE;
}

/** Why a privileged restore needs a confirmed authorization. */
export type RestoreAuthorizationReason = 'unattested_legacy' | 'unattested' | 'producer_only_other_target';

export type RestoreGateRefusalCode =
  | 'attestation_pending'
  | 'snapshot_integrity_failed'
  | 'snapshot_integrity_unavailable'
  | 'snapshot_unresolved';

export type RestoreGateDecision =
  | { kind: 'allow' }
  | { kind: 'authorization_required'; reason: RestoreAuthorizationReason }
  | { kind: 'refuse'; code: RestoreGateRefusalCode; message: string };

const refuse = (code: RestoreGateRefusalCode): RestoreGateDecision => ({
  kind: 'refuse',
  code,
  message: RESTORE_INTEGRITY_MESSAGES[code],
});

/**
 * Pure decision for one restore. `integrity` is the snapshot's resolved
 * expectation, or null when the snapshot could not be resolved.
 */
export function decideRestoreGate(input: {
  commandType: string;
  integrity: RestoreIntegrity | null;
  targetDeviceId: string;
}): RestoreGateDecision {
  if (!PRIVILEGED.has(input.commandType)) return { kind: 'allow' };
  const { integrity } = input;
  if (!integrity) return refuse('snapshot_unresolved');
  if (integrity.mode === 'attested') {
    if (integrity.trust === 'server_verified') return { kind: 'allow' };
    return integrity.sourceDeviceId === input.targetDeviceId
      ? { kind: 'allow' }
      : { kind: 'authorization_required', reason: 'producer_only_other_target' };
  }
  switch (integrity.reason) {
    case 'pending':
      return refuse('attestation_pending');
    case 'attestation_failed':
      return refuse('snapshot_integrity_failed');
    case 'unattested_legacy':
    case 'unattested':
      return { kind: 'authorization_required', reason: integrity.reason };
  }
}

export type RestoreActorKind = 'user' | 'ai_agent' | 'system';

/**
 * Only an interactive user can confirm a restore with a step-up. For an AI
 * agent or a system actor a decision that needs one is a refusal.
 */
export function gateForActor(decision: RestoreGateDecision, actor: RestoreActorKind): RestoreGateDecision {
  if (decision.kind !== 'authorization_required' || actor === 'user') return decision;
  return {
    kind: 'refuse',
    code: 'snapshot_integrity_unavailable',
    message: actor === 'ai_agent'
      ? RESTORE_INTEGRITY_MESSAGES.ai_unattested
      : RESTORE_INTEGRITY_MESSAGES.snapshot_integrity_unavailable,
  };
}

/** The `integrity` block for a restore confirmed by a durable authorization (wire format 1). */
export function overrideIntegrityPayload(snapshotId: string, authorizationId: string): Record<string, unknown> {
  return { v: 1, mode: 'unattested_override', snapshotId, authorizationId };
}
