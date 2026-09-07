import { eq } from 'drizzle-orm';
import { db } from '../db';
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
import { captureException } from './sentry';
import { decryptCommandForDelivery, toAgentCommandFrame } from './sensitiveCommandPayload';

export type DispatchDeviceCommandInput = {
  deviceId: string;
  type: string;
  payload?: CommandPayload;
  userId?: string;
  /** Explicit policy; omit to take the registry default for the type. */
  offlinePolicy?: OfflinePolicy;
  /**
   * True for callers that hard-rejected offline devices before #5128. The
   * DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED flag gates their switch to queueing;
   * callers that already queued (scripts, software, generic routes) pass false.
   */
  previouslyRejected?: boolean;
  /** Defense-in-depth for callers running under a system context. */
  expectedOrgId?: string;
  /** Skip the socket push even when connected (watchdog-style consumers). */
  preferHeartbeat?: boolean;
  /** Reserve the command id up-front (#3409: the secret envelope's AAD binds it). */
  commandId?: string;
};

export type DispatchDeviceCommandResult =
  | {
      ok: true;
      command: QueuedCommand;
      /**
       * `delivered` = pushed over the live socket now. `queued_live` = device is
       * online but the push did not happen (no socket, push failed, or
       * preferHeartbeat); the next heartbeat claims it. `queued_offline` = the
       * device was not online at enqueue.
       */
      delivery: 'delivered' | 'queued_offline' | 'queued_live';
      /** NULL for a `reject` policy: those rows stay on the legacy execution clock. */
      deliverBy: Date | null;
    }
  | {
      ok: false;
      code: 'device_not_found' | 'device_offline' | 'device_decommissioned' | 'trust_denied';
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
  // Resolved first, so an unregistered command type fails loudly before any
  // device lookup or write happens.
  const policy = resolveOfflinePolicy(input.type, input.offlinePolicy, {
    previouslyRejected: input.previouslyRejected ?? false,
  });

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

  const deliverBy = deliverByFor(policy);
  const payload = input.payload ?? {};
  const command = await queueCommand(input.deviceId, input.type, payload, input.userId, {
    ...(input.commandId ? { commandId: input.commandId } : {}),
    deliverBy,
    submittedOrgId: device.orgId,
  });

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
  if (!claimed) return { ok: true, command, delivery: 'queued_live', deliverBy };

  // The enqueue-time push runs the same late-binding preparation the heartbeat
  // batch does, so a `software_install` pushed now and one claimed in six hours
  // are prepared identically.
  const fresh = await refreshPayloadForDelivery(
    input.type,
    payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {},
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
