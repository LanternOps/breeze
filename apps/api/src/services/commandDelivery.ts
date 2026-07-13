import { releaseClaimedCommandDelivery } from './commandDispatch';
import {
  decryptCommandsForDelivery,
  type DeliverableCommand,
} from './sensitiveCommandPayload';
import { captureException } from './sentry';

/**
 * The subset of a just-claimed `device_commands` row that batch delivery needs.
 * `executedAt` is the claim timestamp `claimPendingCommandsForDevice` wrote when
 * it flipped the row to `sent` — `releaseClaimedCommandDelivery` keys on it so a
 * release can never clobber a newer claim.
 */
export type ClaimedCommand = {
  id: string;
  type: string;
  payload: unknown;
  executedAt: Date | null;
};

/**
 * Decrypt a batch of JUST-CLAIMED commands for delivery, releasing any that
 * fail decryption back to `pending` (issue #2414).
 *
 * `claimPendingCommandsForDevice` flips rows to `sent` before the payloads are
 * decrypted. `decryptCommandsForDelivery` then silently drops any command whose
 * sensitive payload can't be decrypted (rotated/corrupted APP_ENCRYPTION_KEY,
 * AAD mismatch) — without a release, such a command strands as `sent` with zero
 * delivery attempts until the stale reaper misattributes it to an agent
 * timeout. This helper diffs input vs output by id and releases every dropped
 * command so the failure stays recoverable (and, once the command ages out
 * while `pending`, the reaper reports "agent never received the command"
 * rather than "no response from agent"). The decrypt failure itself is
 * reported to Sentry by `decryptCommandForDelivery`; this only adds a capture
 * when the RELEASE fails, since that re-strands the command.
 *
 * Successfully decrypted siblings in the same batch are always returned — one
 * bad payload never sinks the batch (and a release failure never throws out of
 * the delivery path).
 */
export async function decryptClaimedCommandsForDelivery(
  claimed: ClaimedCommand[],
): Promise<DeliverableCommand[]> {
  const delivered = decryptCommandsForDelivery(
    claimed.map((cmd) => ({ id: cmd.id, type: cmd.type, payload: cmd.payload })),
  );
  if (delivered.length === claimed.length) {
    return delivered;
  }

  const deliveredIds = new Set(delivered.map((cmd) => cmd.id));
  for (const cmd of claimed) {
    if (deliveredIds.has(cmd.id)) continue;
    try {
      if (!cmd.executedAt) {
        // Claimed rows always carry the claim timestamp; without it the
        // conditional release cannot run safely. Surface loudly instead of
        // silently stranding the command as `sent`.
        throw new Error('claimed command row has no executedAt — cannot release');
      }
      await releaseClaimedCommandDelivery(cmd.id, cmd.executedAt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        '[commandDelivery] failed to release undeliverable claimed command back to pending; it will strand as sent until the stale reaper times it out',
        { commandId: cmd.id, type: cmd.type, error: message },
      );
      captureException(
        new Error(
          `[commandDelivery] release of undeliverable claimed command failed (commandId=${cmd.id}, type=${cmd.type}): ${message}`,
        ),
      );
    }
  }

  return delivered;
}
