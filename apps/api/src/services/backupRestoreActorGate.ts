/**
 * Integrity decision for a restore requested by an AI agent or a system actor
 * (services/backupRestoreGate.ts). Neither can confirm a restore with a
 * step-up, so a snapshot without a usable attestation is refused here with an
 * operator-facing message; a technician restores it from the console.
 * Delivery enforces the same rule again.
 *
 * Runs in the caller's DB context (RLS applies to the snapshot lookup).
 */
import { decideRestoreGate, gateForActor, type RestoreGateRefusalCode } from './backupRestoreGate';
import { resolveRestoreIntegrity } from './backupRestoreIntegrity';

export async function restoreIntegrityRefusalForActor(input: {
  snapshotDbId: string;
  targetDeviceId: string;
  commandType: string;
  actor: 'ai_agent' | 'system';
}): Promise<{ code: RestoreGateRefusalCode; message: string } | null> {
  const integrity = await resolveRestoreIntegrity(input.snapshotDbId);
  const decision = gateForActor(
    decideRestoreGate({ commandType: input.commandType, integrity, targetDeviceId: input.targetDeviceId }),
    input.actor,
  );
  if (decision.kind === 'refuse') return { code: decision.code, message: decision.message };
  // gateForActor never leaves an authorization requirement for a non-user actor.
  return null;
}
