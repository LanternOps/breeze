import { eq } from 'drizzle-orm';
import { db, getCurrentDbAccessContext, withSystemDbAccessContext } from '../db';
import { devices } from '../db/schema';
import { sendCommandToAgent } from '../routes/agentWs';
import { refreshPayloadForDelivery } from './commandDelivery';
import { POWER_STATE_BARRIER_TYPES } from './commandClaimEligibility';
import {
  claimPendingCommandForDelivery,
  countInFlightCommandsForDevice,
  releaseClaimedCommandDelivery,
} from './commandDispatch';
import { deliverByFor, resolveOfflinePolicy, type OfflinePolicy } from './commandOfflinePolicy';
import { queueCommand, type CommandPayload, type QueuedCommand } from './commandQueue';
import { assertDeviceExecuteAllowed, TrustDeniedError } from './partnerTrust.commands';
import { backupReadHelperRefusal } from './backupReadHelperGate';
import { backupWriteHelperRefusal } from './backupWriteHelperGate';
import { restoreIntegrityHelperRefusal } from './backupRestoreGate';
import { captureException } from './sentry';
import {
  isParkedDeliverableCommandType,
  isParkedDevice,
  PARKED_DEVICE_COMMAND_REFUSAL_MESSAGE,
} from './unassignedPool/deliveryEligibility';
import { decryptCommandForDelivery, toAgentCommandFrame } from './sensitiveCommandPayload';

import type { AiOriginRef } from '@breeze/shared';

export type DispatchDeviceCommandInput = {
  deviceId: string;
  type: string;
  payload?: CommandPayload;
  userId?: string;
  /** Explicit policy; omit to take the registry default for the type. */
  offlinePolicy?: OfflinePolicy;
  /** Defense-in-depth for callers running under a system context. */
  expectedOrgId?: string;
  /** Skip the socket push even when connected (watchdog-style consumers). */
  preferHeartbeat?: boolean;
  /** Reserve the command id up-front (#3409: the secret envelope's AAD binds it). */
  commandId?: string;
  /** #5022 W01 — who DECIDED this command, when an AI surface did. */
  aiOrigin?: AiOriginRef;
  /**
   * #7187 — persist the row but do NOT claim or push it; return a `deliver()`
   * continuation instead (the #3445 `scriptDispatch` shape).
   *
   * For a caller whose transaction stays open after this returns (the
   * automation runtime's claim transaction around a software deployment). The
   * row is INSERTed through that transaction, and the agent result path reads
   * `device_commands` on its own connection: a push before commit lets a fast
   * agent answer against a row it cannot see, and the result is dropped as an
   * orphan. Such a caller passes this flag and calls `deliver()` after its
   * transaction commits.
   */
  deferDelivery?: boolean;
};

export type DispatchDeviceCommandResult =
  | {
      ok: true;
      command: QueuedCommand;
      /**
       * `delivered` = pushed over the live socket now. `queued_live` = device is
       * online but the push did not happen (no socket, push failed, or
       * preferHeartbeat); the next heartbeat claims it. `queued_offline` = the
       * device was not online at enqueue. `cancelled` = the push's claim-time
       * eligibility check (the same one the heartbeat claim runs) refused and
       * terminalised the row; it will never be delivered — see `cancelReason`.
       */
      delivery: 'delivered' | 'queued_offline' | 'queued_live' | 'cancelled';
      /** Present only when `delivery` is `cancelled`: `device_commands.result.reason`. */
      cancelReason?: string;
      /** NULL for a `reject` policy: those rows stay on the legacy execution clock. */
      deliverBy: Date | null;
      /**
       * #7187 — present only for a `deferDelivery` dispatch to a device with a
       * live agent socket (`delivery` is then `queued_live`). Claims and pushes
       * the persisted row exactly as the immediate path would, and resolves to
       * the real delivery. MUST run after the caller's transaction commits,
       * with no ambient context (the claim and release open their own). Never
       * rejects: a transport failure leaves the committed row `queued_live`
       * for the heartbeat claim.
       */
      deliver?: () => Promise<DispatchDeviceCommandResult>;
    }
  | {
      ok: false;
      code:
        | 'device_not_found'
        | 'device_offline'
        | 'device_decommissioned'
        /** The device is parked in a holding org: lifecycle removal only. */
        | 'device_pending_assignment'
        | 'trust_denied'
        | 'backup_helper_update_required';
      error: string;
      trust?: { capability: 'device_execute'; reason: string };
    };

/**
 * The single enqueue seam for device commands (#5128 §D).
 *
 * Order: resolve the offline policy (throws for an unregistered type, before
 * any DB access) → device lookup → expectedOrgId → lifecycle → reject-or-queue
 * → partner trust → PERSIST THE ROW (always, before any transport) →
 * claim/refresh/push/release when the socket is live.
 *
 * Persisting before the transport is what makes a command recoverable: the
 * software-install path used to push over the websocket WITHOUT creating a row,
 * so a push that the agent never acted on left nothing for the reaper or the UI
 * to find.
 */
export async function dispatchDeviceCommand(
  input: DispatchDeviceCommandInput,
): Promise<DispatchDeviceCommandResult> {
  const policy = resolveOfflinePolicy(input.type, input.offlinePolicy);
  const prepared = await prepareDeviceCommand(input, policy);
  if (!prepared.ok) return prepared;
  if (input.deferDelivery) {
    const { command, deliverBy } = prepared;
    if (!prepared.online) return { ok: true, command, delivery: 'queued_offline', deliverBy };
    if (!prepared.device.agentId || input.preferHeartbeat) {
      return { ok: true, command, delivery: 'queued_live', deliverBy };
    }
    return {
      ok: true,
      command,
      delivery: 'queued_live',
      deliverBy,
      deliver: () => deliverCommittedDeviceCommand(input, prepared),
    };
  }
  return deliverPreparedDeviceCommand(input, prepared);
}

/**
 * For self-managed routes: commit device/trust checks and persistence in a
 * short system transaction before any socket transport. The expected tenant
 * is mandatory because the device lookup bypasses tenant RLS.
 */
export async function dispatchDeviceCommandWithSystemPrecheck(
  input: DispatchDeviceCommandInput & { expectedOrgId: string },
): Promise<DispatchDeviceCommandResult> {
  if (getCurrentDbAccessContext()) {
    throw new Error('dispatchDeviceCommandWithSystemPrecheck requires no ambient DB context');
  }
  const policy = resolveOfflinePolicy(input.type, input.offlinePolicy);
  const prepared = await withSystemDbAccessContext(
    () => prepareDeviceCommand(input, policy),
    'dispatchDeviceCommandWithSystemPrecheck',
  );
  if (!prepared.ok) return prepared;
  return deliverCommittedDeviceCommand(input, prepared);
}

/** Transport for a row whose transaction has already committed. Never rejects. */
async function deliverCommittedDeviceCommand(
  input: DispatchDeviceCommandInput,
  prepared: PreparedDeviceCommand,
): Promise<DispatchDeviceCommandResult> {
  try {
    return await deliverPreparedDeviceCommand(input, prepared);
  } catch (error) {
    // Persistence already committed. Returning failure would orphan the
    // caller's run even though heartbeat delivery or the reaper can still
    // finish this command. Retain its identity for result reconciliation.
    captureException(error instanceof Error ? error : new Error(String(error)));
    return { ok: true, command: prepared.command, delivery: 'queued_live', deliverBy: prepared.deliverBy };
  }
}

type PreparedDeviceCommand = {
  ok: true;
  device: typeof devices.$inferSelect;
  online: boolean;
  payload: CommandPayload;
  command: QueuedCommand;
  deliverBy: Date | null;
};

async function prepareDeviceCommand(
  input: DispatchDeviceCommandInput,
  policy: OfflinePolicy,
): Promise<PreparedDeviceCommand | Extract<DispatchDeviceCommandResult, { ok: false }>> {
  const [device] = await db.select().from(devices).where(eq(devices.id, input.deviceId)).limit(1);
  if (!device) return { ok: false, code: 'device_not_found', error: 'Device not found' };

  // Defense-in-depth: this lookup can run under withSystemDbAccessContext (RLS
  // off), so callers that know the expected owning org pass expectedOrgId to
  // stop a cross-tenant device id from receiving a command. Reported as
  // not-found so the response never confirms the device exists.
  if (input.expectedOrgId !== undefined && device.orgId !== input.expectedOrgId) {
    return { ok: false, code: 'device_not_found', error: 'Device not found' };
  }

  if (device.status === 'decommissioned') {
    // Error text is byte-identical to the pre-#5128 offline rejection so callers
    // that surface `error` verbatim are unchanged; `code` is what routes branch on.
    return {
      ok: false,
      code: 'device_decommissioned',
      error: `Device is ${device.status}, cannot execute command`,
    };
  }

  // A device parked in a holding org receives lifecycle removal only. Refused
  // here, before trust and persistence, so the caller gets a structured code
  // instead of `queueCommand`'s thrown refusal.
  if (!isParkedDeliverableCommandType(input.type) && (await isParkedDevice(db, input.deviceId))) {
    return { ok: false, code: 'device_pending_assignment', error: PARKED_DEVICE_COMMAND_REFUSAL_MESSAGE };
  }

  // OFFLINE-REJECT COMES BEFORE TRUST, deliberately (#5128 review round 2, M).
  // Four backup routes classify a failure by the `Device is <status>, cannot
  // execute command` prefix (routes/backup/vmrestore.ts, restore.ts,
  // verificationService.ts, verificationScheduled.ts). With trust first, an
  // offline AND trust-denied device answered with the raw trust code and those
  // callers mis-classified it. Trust is not weakened: the command is refused
  // either way, and nothing is persisted before both checks have run.
  const online = device.status === 'online';
  if (!online && policy.kind === 'reject') {
    return { ok: false, code: 'device_offline', error: `Device is ${device.status}, cannot execute command` };
  }

  try {
    await assertDeviceExecuteAllowed(input.deviceId, input.type, input.userId);
  } catch (e) {
    if (e instanceof TrustDeniedError) {
      return { ok: false, code: 'trust_denied', error: e.code, trust: { capability: e.capability, reason: e.reason } };
    }
    throw e;
  }

  const payload = input.payload ?? {};

  // A storage read or a backup to S3 storage for a helper that cannot use a
  // storage session could only be served by sending it the storage
  // destination, which is never done. Refused here, before a row exists, so
  // the caller can say so; the delivery refreshers enforce the same rules
  // against the helper's reported capability at the moment of delivery.
  // A privileged restore (one that installs, imports or boots snapshot
  // bytes) additionally needs a helper that checks restored bytes against the
  // snapshot attestation (services/backupRestoreGate.ts); delivery re-checks.
  const helperRefusal = backupReadHelperRefusal(input.type, payload, device.backupReadProtocolVersion)
    ?? backupWriteHelperRefusal(input.type, payload, device.backupWriteProtocolVersion)
    ?? restoreIntegrityHelperRefusal(input.type, device.backupIntegrityProtocolVersion);
  if (helperRefusal) {
    return { ok: false, code: 'backup_helper_update_required', error: helperRefusal };
  }

  const deliverBy = deliverByFor(policy);
  const command = await queueCommand(input.deviceId, input.type, payload, input.userId, {
    ...(input.commandId ? { commandId: input.commandId } : {}),
    deliverBy,
    submittedOrgId: device.orgId,
    ...(input.aiOrigin ? { aiOrigin: input.aiOrigin } : {}),
  });

  return { ok: true, device, online, payload, command, deliverBy };
}

async function deliverPreparedDeviceCommand(
  input: DispatchDeviceCommandInput,
  queued: PreparedDeviceCommand,
): Promise<DispatchDeviceCommandResult> {
  const { device, online, payload, command, deliverBy } = queued;
  if (!online) return { ok: true, command, delivery: 'queued_offline', deliverBy };
  if (!device.agentId || input.preferHeartbeat) return { ok: true, command, delivery: 'queued_live', deliverBy };

  // #5128 §E.4 — the power-state barrier, applied HERE rather than skipping the
  // push entirely. `partitionClaimable` enforces it on the heartbeat claim, and
  // pushing a reboot straight down the socket would walk right past it: a
  // queued reboot could land in the middle of a running script.
  //
  // Review round 2 (J): a blanket skip was too blunt. `maintenanceRebootWorker`
  // and the fleet-findings dispatch map both issue reboots that ALWAYS pushed
  // before #5128, and downgrading them to "wait for the next heartbeat" delays
  // a maintenance-window reboot by a whole heartbeat interval. So apply the
  // barrier's actual condition instead: push only when nothing is in flight on
  // this device, which is exactly what the heartbeat claim checks.
  if (POWER_STATE_BARRIER_TYPES.has(input.type)) {
    const inFlight = await countInFlightCommandsForDevice(input.deviceId);
    if (inFlight > 0) {
      return { ok: true, command, delivery: 'queued_live', deliverBy };
    }
  }

  const claimed = await claimPendingCommandForDelivery(command.id);
  if (claimed.status === 'cancelled') {
    return {
      ok: true,
      command: { ...command, status: 'cancelled' } as QueuedCommand,
      delivery: 'cancelled',
      cancelReason: claimed.reason,
      deliverBy,
    };
  }
  if (claimed.status !== 'claimed') return { ok: true, command, delivery: 'queued_live', deliverBy };

  // The enqueue-time push runs the same late-binding preparation the heartbeat
  // batch does, so a `software_install` pushed now and one claimed in six hours
  // are prepared identically. A refusal expires this claim inside the
  // refresher step, which makes the release below a 0-row no-op.
  const fresh = await refreshPayloadForDelivery(
    input.type,
    payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {},
    { commandId: command.id, deviceId: input.deviceId, type: input.type, claimedAt: claimed.executedAt },
  );
  const prepared = fresh
    ? decryptCommandForDelivery({ id: command.id, type: input.type, deviceId: input.deviceId, payload: fresh })
    : null;
  const sent = prepared ? sendCommandToAgent(device.agentId, toAgentCommandFrame(prepared)) : false;
  if (sent) {
    return {
      ok: true,
      command: { ...command, status: 'sent', executedAt: claimed.executedAt } as QueuedCommand,
      delivery: 'delivered',
      deliverBy,
    };
  }

  // The push failed, so the row must go back to `pending` for the next
  // heartbeat. A release that ITSELF fails must not take the caller down with
  // it — the command IS persisted and the caller's response is already true.
  // The cost of a failed release is that the row sits `sent` until the
  // reaper's EXECUTION clock times it out (`no response from agent`), which is
  // recoverable; throwing here would 500 a request whose write already
  // committed.
  try {
    await releaseClaimedCommandDelivery(command.id, claimed.executedAt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      '[dispatchDeviceCommand] failed to release a claim after a failed push; the row will sit `sent` until the reaper times it out',
      { commandId: command.id, type: input.type, error: message },
    );
    captureException(
      new Error(
        `[dispatchDeviceCommand] release after failed push failed (commandId=${command.id}, type=${input.type}): ${message}`,
      ),
    );
  }
  return { ok: true, command, delivery: 'queued_live', deliverBy };
}
