import { BACKUP_WRITE_GATED_COMMAND_TYPES } from './backupWriteHelperGate';
import { deliverBackupWriteCommand } from './backupStorageWriteDelivery';
import { hasDbAccessContext, withDbTransaction } from '../db';
import { BROKERED_READ_COMMAND_TYPES, deliverBrokeredReadCommand } from './backupStorageSessions';
import { RECOVERY_INTEGRITY_COMMAND_TYPES, deliverRecoveryCommandIntegrity } from './backupRecoveryCommandIntegrity';
import { expireRefusedClaimedCommandDelivery, releaseClaimedCommandDelivery } from './commandDispatch';
import {
  isCommandDeliveryDeferral,
  isCommandDeliveryRefusal,
  type DeliveryRefreshContext,
  type ReportedBackupHelperProtocols,
} from './commandDeliveryRefusal';
import { getPresignedUrl, isS3Configured } from './s3Storage';
import { failClaimedSecretCommandsForUnsupportedAgent } from './scriptSecretDelivery';
import {
  decryptCommandsForDelivery,
  type DeliverableCommand,
} from './sensitiveCommandPayload';
import { captureException } from './sentry';
import { prepareDiagnosticDelivery } from './diagnosticAccess/delivery';

export {
  CommandDeliveryDeferredError,
  CommandDeliveryRefusedError,
  type DeliveryRefreshContext,
} from './commandDeliveryRefusal';

/**
 * Re-materialises payload fields that are only valid for a short window, or
 * must never be persisted, at the moment the command is actually handed to an
 * agent (#5128 §D / OD-8).
 *
 * A queued command may be claimed days after it was enqueued. Anything
 * time-limited in its payload — a presigned download URL, most obviously — is
 * stale by then, so payloads store STABLE references (an S3 key, a storage
 * destination reference) and the refresher turns that into the deliverable
 * value here. Returns the payload to deliver. Throwing an ordinary error
 * releases the row back to `pending` rather than delivering a stale payload;
 * throwing `CommandDeliveryRefusedError` expires the row instead (it can never
 * be delivered as queued, so re-claiming it on every heartbeat is pointless).
 * Throwing `CommandDeliveryDeferredError` releases the row like an ordinary
 * error, but records why and is not reported as a fault: the command will be
 * deliverable shortly (a snapshot file index that is still being prepared).
 *
 * `ctx` identifies the command being prepared — id, device, type and the claim
 * timestamp of this delivery attempt — so a refresher can bind what it mints
 * to exactly this command and device.
 */
export type DeliveryRefresher = (
  payload: Record<string, unknown>,
  ctx: DeliveryRefreshContext,
) => Promise<Record<string, unknown>>;

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

// Administrator-approved diagnostic reads: the signed per-command
// authorization is minted here, at delivery, after the grant is re-checked; it
// is never stored in the queued payload (services/diagnosticAccess/delivery.ts).
registerDeliveryRefresher('diag_file_list', (payload, ctx) => prepareDiagnosticDelivery('list', payload, ctx));
registerDeliveryRefresher('diag_file_read', (payload, ctx) => prepareDiagnosticDelivery('read', payload, ctx));

// Uploaded installers travel as an S3 key; the one-hour presigned URL is
// minted at delivery so an install claimed six hours later still downloads.
registerDeliveryRefresher('software_install', async (payload) => {
  const s3Key = typeof payload.s3Key === 'string' ? payload.s3Key : null;
  if (!s3Key || !isS3Configured()) return payload;
  return { ...payload, downloadUrl: await getPresignedUrl(s3Key, 3600) };
});

// Backup/restore/verify commands persist a storage destination REFERENCE; the
// destination itself is resolved here, into the outgoing frame only, so it is
// never written to `device_commands` (see services/backupCommandCredentials.ts).
//
// Restore-shaped READS go through ONE refresher that delivers a short-lived
// storage session instead of the destination; a read that cannot be brokered
// is refused or deferred, never sent the destination — except a local one,
// which is a path, not a credential (services/backupStorageSessions.ts). One
// refresher per type: the storage-session refresher composes the destination
// refresher, it does not compete with it.
for (const type of BROKERED_READ_COMMAND_TYPES) {
  registerDeliveryRefresher(type, deliverBrokeredReadCommand);
}
// Every restore-shaped read above also carries the snapshot's integrity
// expectation, written at delivery (services/backupRestoreIntegrity.ts). The
// bare-metal recovery commands read no storage destination from their payload
// (they run against a recovery token) and get only the expectation.
for (const type of RECOVERY_INTEGRITY_COMMAND_TYPES) {
  registerDeliveryRefresher(type, deliverRecoveryCommandIntegrity);
}
// Backup WRITES queued as commands (on-demand MSSQL / Hyper-V; backup_run is
// never queued by this server, but a row that exists anyway takes the same
// path): a backup to S3 storage is delivered only with a write-scoped storage
// session and otherwise refused; a local destination — a path, not a
// credential — is resolved as before (services/backupStorageWriteDelivery.ts).
for (const type of BACKUP_WRITE_GATED_COMMAND_TYPES) {
  registerDeliveryRefresher(type, deliverBackupWriteCommand);
}

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

/** Backup helper protocol fields a heartbeat may hand to delivery refreshers. */
const REPORTED_BACKUP_HELPER_PROTOCOL_FIELDS = [
  'reportedBackupReadProtocolVersion',
  'reportedBackupIntegrityProtocolVersion',
  'reportedBackupWriteProtocolVersion',
] as const satisfies ReadonlyArray<keyof ReportedBackupHelperProtocols>;

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
 * heartbeat's own non-sticky device write. The backup helper protocol
 * fields are passed to every delivery refresher the same way.
 */
export async function prepareClaimedCommandsForDelivery(
  claimed: ClaimedCommand[],
  opts?: { reportedScriptSecretEnvVersion?: number } & ReportedBackupHelperProtocols,
): Promise<DeliverableCommand[]> {
  const helperProtocols: ReportedBackupHelperProtocols = {};
  for (const field of REPORTED_BACKUP_HELPER_PROTOCOL_FIELDS) {
    const value = opts?.[field];
    if (typeof value === 'number') helperProtocols[field] = value;
  }
  const refreshed = await refreshClaimedCommandPayloads(claimed, helperProtocols);

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
 * Expire a claimed row whose refresher REFUSED it. Best-effort like the
 * release paths: a failure is reported, never thrown into the delivery path
 * (the row then sits `sent` until the reaper's execution clock times it out).
 */
async function expireRefusedClaim(
  commandId: string,
  type: string,
  claimedAt: Date | null,
  reason: string,
): Promise<void> {
  try {
    if (!claimedAt) {
      throw new Error('claimed command row has no executedAt — cannot expire');
    }
    await expireRefusedClaimedCommandDelivery(commandId, claimedAt, reason);
  } catch (expireErr) {
    const expireMessage = expireErr instanceof Error ? expireErr.message : String(expireErr);
    console.error(
      '[commandDelivery] failed to expire a command whose delivery was refused; it will strand as sent until the stale reaper times it out',
      { commandId, type, error: expireMessage },
    );
    captureException(
      new Error(
        `[commandDelivery] expiry after delivery refusal failed (commandId=${commandId}, type=${type}): ${expireMessage}`,
      ),
    );
  }
}

/**
 * Release a claimed row whose refresher DEFERRED it, recording why. Best-effort
 * like the other release paths: a failure is reported, never thrown.
 */
async function releaseDeferredClaim(
  commandId: string,
  type: string,
  claimedAt: Date | null,
  reason: string,
): Promise<void> {
  console.warn('[commandDelivery] delivery deferred; releasing the row for a later attempt', {
    commandId,
    type,
    reason,
  });
  try {
    if (!claimedAt) {
      throw new Error('claimed command row has no executedAt — cannot release');
    }
    await releaseClaimedCommandDelivery(commandId, claimedAt, reason);
  } catch (releaseErr) {
    const releaseMessage = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
    console.error(
      '[commandDelivery] failed to release a command whose delivery was deferred; it will strand as sent until the stale reaper times it out',
      { commandId, type, error: releaseMessage },
    );
    captureException(
      new Error(
        `[commandDelivery] release after delivery deferral failed (commandId=${commandId}, type=${type}): ${releaseMessage}`,
      ),
    );
  }
}

/**
 * Run one command's refresher. When the caller already holds a transaction
 * (the heartbeat's organization-scoped transaction, the REST poll and drain
 * system contexts, a request context on the enqueue-time push) the refresher
 * runs in its own savepoint: a statement error or timeout while preparing one
 * command rolls back to that savepoint and fails that command only, instead
 * of aborting the caller's transaction — and with it the sibling commands, the
 * release/expiry writes below and the rest of the heartbeat. The refresher's
 * error propagates unchanged, so a refusal is still recognised as one.
 */
function runRefresher(
  refresher: DeliveryRefresher,
  payload: Record<string, unknown>,
  ctx: DeliveryRefreshContext,
): Promise<Record<string, unknown>> {
  if (!hasDbAccessContext()) return refresher(payload, ctx);
  return withDbTransaction(() => refresher(payload, ctx));
}

/**
 * Runs each claimed row's registered refresher (#5128 §D). A row whose
 * refresher throws is RELEASED back to `pending` and dropped from the batch:
 * delivering a payload we know to be stale (an expired installer URL, say) is
 * worse than waiting for the next heartbeat, and the release keeps the row
 * recoverable instead of stranding it as `sent`. A row whose refresher REFUSES
 * it (CommandDeliveryRefusedError) is dropped and EXPIRED instead: it can
 * never be delivered as queued, and the reaper's delivery clock then fails it
 * with the refusal reason and propagates that to its owning records.
 */
async function refreshClaimedCommandPayloads(
  claimed: ClaimedCommand[],
  extraCtx: ReportedBackupHelperProtocols = {},
): Promise<ClaimedCommand[]> {
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
      out.push({
        ...cmd,
        payload: await runRefresher(refresher, payload, {
          commandId: cmd.id,
          deviceId: cmd.deviceId,
          type: cmd.type,
          claimedAt: cmd.executedAt,
          ...extraCtx,
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isCommandDeliveryRefusal(err)) {
        console.warn('[commandDelivery] delivery refused; expiring the row instead of re-claiming it', {
          commandId: cmd.id,
          type: cmd.type,
          reason: message,
        });
        await expireRefusedClaim(cmd.id, cmd.type, cmd.executedAt, message);
        continue;
      }
      if (isCommandDeliveryDeferral(err)) {
        await releaseDeferredClaim(cmd.id, cmd.type, cmd.executedAt, message);
        continue;
      }
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

export type PushRefreshOutcome =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; refusal: string | null };

/**
 * Single-command variant for the direct pushes that hold a claim on ONE row
 * (`dispatchDeviceCommand`'s enqueue-time push and `executeCommand`'s WS
 * push). On a refusal the claim is expired here (so the caller's subsequent
 * release is a 0-row no-op) and the reason is returned; on any other failure
 * the caller releases the claim.
 */
export async function refreshClaimedPayloadForPush(
  type: string,
  payload: Record<string, unknown>,
  ctx: DeliveryRefreshContext,
): Promise<PushRefreshOutcome> {
  const refresher = deliveryRefreshers[type];
  if (!refresher) return { ok: true, payload };
  try {
    return { ok: true, payload: await runRefresher(refresher, payload, ctx) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isCommandDeliveryRefusal(err)) {
      console.warn('[commandDelivery] delivery refused on a direct push; expiring the row', {
        commandId: ctx.commandId,
        type,
        reason: message,
      });
      await expireRefusedClaim(ctx.commandId, type, ctx.claimedAt, message);
      return { ok: false, refusal: message };
    }
    if (isCommandDeliveryDeferral(err)) {
      // Released here with its reason, so the caller's own release is a 0-row
      // no-op; the next claim tries again.
      await releaseDeferredClaim(ctx.commandId, type, ctx.claimedAt, message);
      return { ok: false, refusal: null };
    }
    console.error('[commandDelivery] delivery refresher failed on a direct push', {
      commandId: ctx.commandId,
      type,
      error: message,
    });
    // Reported, not just logged: a refresher that starts failing (an S3 outage,
    // say) silently downgrades every direct push to a heartbeat wait, and
    // nothing else on this path surfaces that.
    captureException(err instanceof Error ? err : new Error(String(err)));
    return { ok: false, refusal: null };
  }
}

/**
 * Compatibility form of `refreshClaimedPayloadForPush` for the enqueue-time
 * push: returns the payload, or null when the refresher failed or refused
 * (the caller releases the claim; after a refusal that release is a no-op).
 */
export async function refreshPayloadForDelivery(
  type: string,
  payload: Record<string, unknown>,
  ctx?: DeliveryRefreshContext,
): Promise<Record<string, unknown> | null> {
  const outcome = await refreshClaimedPayloadForPush(
    type,
    payload,
    ctx ?? { commandId: '', deviceId: '', type, claimedAt: null },
  );
  return outcome.ok ? outcome.payload : null;
}
