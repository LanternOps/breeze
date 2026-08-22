import { releaseClaimedCommandDelivery } from './commandDispatch';
import { failClaimedSecretCommandsForUnsupportedAgent } from './scriptSecretDelivery';
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
  /** Bound into the #3409 secret envelope's AAD, so delivery cannot omit it. */
  deviceId: string;
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
 *
 * #3409 PR4c-2 — the secret-delivery claim gate runs FIRST, before anything is
 * decrypted: a `script` command carrying a sealed `secretEnvEnvelope` must
 * never be opened for an agent that cannot export the env var, because that
 * agent would run the script with the credential silently unset. The gate
 * withholds such a command from the batch — driving it TERMINAL (`failed`,
 * payload erased) when the device row actually reports an unsupported
 * version, or leaving it `sent` for the stale reaper when the device row
 * could not be read at all (that refusal has to stay reversible; see
 * scriptSecretDelivery.ts). Either way, and unlike the #2414 decrypt-failure
 * path below, a withheld command is deliberately NOT released back to
 * `pending` — an incapable agent would immediately re-claim it. Withheld ids
 * therefore never reach the release loop, which only ever sees the gate's
 * survivors.
 *
 * The gate throws only on a caller contract violation (a single agent's
 * reported capability handed to a multi-device batch); that must surface, not
 * be swallowed into a delivery.
 *
 * The gate needs the DB (a capability read plus terminal writes), so this
 * function must be called inside a DB access context — the heartbeat's
 * ambient org context on the heartbeat paths, an explicit system context on
 * the self-managed-context REST poll (routes/agents/commands.ts).
 *
 * `opts.reportedScriptSecretEnvVersion` lets a caller that just received the
 * agent's own capability report (the heartbeat) hand it to the gate as
 * authoritative, avoiding both the extra select and the race against the
 * heartbeat's own non-sticky device write.
 */
export async function decryptClaimedCommandsForDelivery(
  claimed: ClaimedCommand[],
  opts?: { reportedScriptSecretEnvVersion?: number },
): Promise<DeliverableCommand[]> {
  const deliverable = await failClaimedSecretCommandsForUnsupportedAgent(claimed, {
    ...(typeof opts?.reportedScriptSecretEnvVersion === 'number'
      ? { reportedVersion: opts.reportedScriptSecretEnvVersion }
      : {}),
  });

  const delivered = decryptCommandsForDelivery(
    deliverable.map((cmd) => ({
      id: cmd.id,
      type: cmd.type,
      deviceId: cmd.deviceId,
      payload: cmd.payload,
    })),
  );
  if (delivered.length === deliverable.length) {
    return delivered;
  }

  const deliveredIds = new Set(delivered.map((cmd) => cmd.id));
  for (const cmd of deliverable) {
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
