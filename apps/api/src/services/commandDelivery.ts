import { releaseClaimedCommandDelivery } from './commandDispatch';
import { getPresignedUrl, isS3Configured } from './s3Storage';
import { failClaimedSecretCommandsForUnsupportedAgent } from './scriptSecretDelivery';
import {
  decryptCommandsForDelivery,
  type DeliverableCommand,
} from './sensitiveCommandPayload';
import { captureException } from './sentry';

/**
 * Re-materialises payload fields that are only valid for a short window, at the
 * moment the command is actually handed to an agent (#5128 §D / OD-8).
 *
 * A queued command may be claimed days after it was enqueued. Anything
 * time-limited in its payload — a presigned download URL, most obviously — is
 * stale by then, so payloads store STABLE references (an S3 key) and the
 * refresher turns that into a fresh URL here. Returns the payload to deliver;
 * throwing releases the row back to `pending` rather than delivering a stale
 * payload.
 */
export type DeliveryRefresher = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * Per-command-type refreshers, keyed by `device_commands.type`.
 *
 * Deliberately populated HERE rather than by side effect from the owning
 * feature module: a refresher that is only registered when some other module
 * happens to be imported would silently deliver stale payloads in any process
 * that did not import it, which is precisely the class of bug this seam exists
 * to close. Feature modules that need a refresher after boot may still assign
 * into this record (W3's patch work does).
 */
export const deliveryRefreshers: Record<string, DeliveryRefresher> = {};

/**
 * Register a refresher for a command type. Refuses to overwrite an existing
 * one: two modules silently competing for `software_install` would mean the
 * import order decides which payload an agent receives, and nothing would
 * report it.
 */
export function registerDeliveryRefresher(type: string, refresher: DeliveryRefresher): void {
  if (deliveryRefreshers[type]) {
    throw new Error(`A delivery refresher is already registered for "${type}"`);
  }
  deliveryRefreshers[type] = refresher;
}

/** Test-only: drop every registered refresher so a suite can install its own. */
export function __resetDeliveryRefreshersForTests(): void {
  for (const key of Object.keys(deliveryRefreshers)) delete deliveryRefreshers[key];
}

// Uploaded installers travel as an S3 key; the one-hour presigned URL is
// minted at delivery so an install claimed six hours later still downloads.
registerDeliveryRefresher('software_install', async (payload) => {
  const s3Key = typeof payload.s3Key === 'string' ? payload.s3Key : null;
  if (!s3Key || !isS3Configured()) return payload;
  return { ...payload, downloadUrl: await getPresignedUrl(s3Key, 3600) };
});

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
export async function prepareClaimedCommandsForDelivery(
  claimed: ClaimedCommand[],
  opts?: { reportedScriptSecretEnvVersion?: number },
): Promise<DeliverableCommand[]> {
  const refreshed = await refreshClaimedCommandPayloads(claimed);

  const deliverable = await failClaimedSecretCommandsForUnsupportedAgent(refreshed, {
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

/**
 * Backwards-compatible alias. The batch claim path was named for the one thing
 * it used to do (decrypt); it now also re-mints time-limited payload fields.
 * Removed in W5 once every call site uses the new name.
 */
export const decryptClaimedCommandsForDelivery = prepareClaimedCommandsForDelivery;

/**
 * Runs each claimed row's registered refresher (#5128 §D). A row whose
 * refresher throws is RELEASED back to `pending` and dropped from the batch:
 * delivering a payload we know to be stale (an expired installer URL, say) is
 * worse than waiting for the next heartbeat, and the release keeps the row
 * recoverable instead of stranding it as `sent`.
 */
async function refreshClaimedCommandPayloads(claimed: ClaimedCommand[]): Promise<ClaimedCommand[]> {
  const out: ClaimedCommand[] = [];
  for (const cmd of claimed) {
    const refresher = deliveryRefreshers[cmd.type];
    if (!refresher) {
      out.push(cmd);
      continue;
    }
    try {
      const payload =
        cmd.payload && typeof cmd.payload === 'object' && !Array.isArray(cmd.payload)
          ? (cmd.payload as Record<string, unknown>)
          : {};
      out.push({ ...cmd, payload: await refresher(payload) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        '[commandDelivery] delivery refresher failed; releasing the row for a later heartbeat rather than delivering a stale payload',
        { commandId: cmd.id, type: cmd.type, error: message },
      );
      try {
        if (!cmd.executedAt) {
          throw new Error('claimed command row has no executedAt — cannot release');
        }
        await releaseClaimedCommandDelivery(cmd.id, cmd.executedAt);
      } catch (releaseErr) {
        const releaseMessage = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
        console.error(
          '[commandDelivery] failed to release a command whose delivery refresher threw; it will strand as sent until the stale reaper times it out',
          { commandId: cmd.id, type: cmd.type, error: releaseMessage },
        );
        captureException(
          new Error(
            `[commandDelivery] release after refresher failure failed (commandId=${cmd.id}, type=${cmd.type}): ${releaseMessage}`,
          ),
        );
      }
    }
  }
  return out;
}

/**
 * Single-command variant for the enqueue-time WS push (`dispatchDeviceCommand`).
 * Returns null when the refresher failed — the caller releases the claim.
 */
export async function refreshPayloadForDelivery(
  type: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const refresher = deliveryRefreshers[type];
  if (!refresher) return payload;
  try {
    return await refresher(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[commandDelivery] delivery refresher failed on the enqueue-time push', {
      type,
      error: message,
    });
    // Reported, not just logged: a refresher that starts failing (an S3 outage,
    // say) silently downgrades every enqueue-time push to a heartbeat wait, and
    // nothing else on this path surfaces that.
    captureException(err instanceof Error ? err : new Error(String(err)));
    return null;
  }
}
