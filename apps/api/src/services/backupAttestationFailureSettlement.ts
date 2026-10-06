/**
 * What happens to work waiting on a snapshot the moment that snapshot fails
 * its integrity check (its attestation was refused when reported, or the
 * server found its stored objects differ from it).
 *
 * Such a snapshot is never read again: every read command for it is refused
 * at delivery. A verification still waiting on it would otherwise sit
 * `pending` / `running` until the verification timeout and then report
 * "timed out" instead of the actual reason. Settle it now, with that reason,
 * and withdraw its command while no helper has claimed it yet.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { backupVerifications } from '../db/schema/backupVerification';
import { deviceCommands } from '../db/schema/devices';
import { terminalPayloadErasureSet } from './sensitiveCommandPayload';

/** Operator-facing; matches what delivery reports for a refused read. */
export const ATTESTATION_FAILED_VERIFICATION_REASON =
  'This backup did not match its integrity record and cannot be read from storage.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fails every waiting verification of the snapshot and cancels each one's
 * still-unclaimed command. Runs in the caller's DB context and transaction
 * (the one that marked the snapshot `attestation_failed`). Returns how many
 * verifications were settled.
 */
export async function settleVerificationsForFailedAttestation(snapshotDbId: string): Promise<number> {
  const now = new Date();
  const detailsPatch = JSON.stringify({
    reason: ATTESTATION_FAILED_VERIFICATION_REASON,
    failure: 'attestation_failed',
  });
  const settled = await db
    .update(backupVerifications)
    .set({
      status: 'failed',
      completedAt: now,
      details: sql`coalesce(${backupVerifications.details}, '{}'::jsonb) || ${detailsPatch}::jsonb`,
    })
    .where(and(
      eq(backupVerifications.snapshotId, snapshotDbId),
      inArray(backupVerifications.status, ['pending', 'running']),
    ))
    .returning({
      id: backupVerifications.id,
      commandId: sql<string | null>`${backupVerifications.details}->>'commandId'`,
    });

  const commandIds = settled
    .map((row) => row.commandId)
    .filter((id): id is string => typeof id === 'string' && UUID_RE.test(id));
  if (commandIds.length > 0) {
    await db
      .update(deviceCommands)
      .set({
        status: 'cancelled',
        completedAt: now,
        result: { status: 'failed', error: ATTESTATION_FAILED_VERIFICATION_REASON },
        ...terminalPayloadErasureSet(),
      })
      .where(and(
        inArray(deviceCommands.id, commandIds),
        eq(deviceCommands.status, 'pending'),
      ));
  }

  if (settled.length > 0) {
    console.warn(
      `[BackupAttestation] Settled ${settled.length} waiting verification(s) of snapshot ${snapshotDbId}: it failed its integrity check`,
    );
  }
  return settled.length;
}
