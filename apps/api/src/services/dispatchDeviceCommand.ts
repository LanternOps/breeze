import { eq } from 'drizzle-orm';
import { db } from '../db';
import { devices } from '../db/schema';
import { sendCommandToAgent } from '../routes/agentWs';
import { refreshPayloadForDelivery } from './commandDelivery';
import { POWER_STATE_BARRIER_TYPES } from './commandClaimEligibility';
import { claimPendingCommandForDelivery, releaseClaimedCommandDelivery } from './commandDispatch';
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
      deliverBy: Date;
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
 * any DB access) → device lookup → expectedOrgId → lifecycle → partner trust →
 * reject-or-queue → PERSIST THE ROW (always, before any transport) →
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

  try {
    await assertDeviceExecuteAllowed(input.deviceId, input.type, input.userId);
  } catch (e) {
    if (e instanceof TrustDeniedError) {
      return { ok: false, code: 'trust_denied', error: e.code, trust: { capability: e.capability, reason: e.reason } };
    }
    throw e;
  }

  const online = device.status === 'online';
  if (!online && policy.kind === 'reject') {
    return { ok: false, code: 'device_offline', error: `Device is ${device.status}, cannot execute command` };
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

  // #5128 §E.4 — power-state commands are NEVER pushed from here. The barrier
  // that stops a reboot landing mid-script lives in `partitionClaimable`, which
  // only runs on the heartbeat claim; pushing a reboot straight down the socket
  // would walk right past it. OD-3 accepts a same-second race, not a
  // deterministic bypass for every reboot issued to an online device.
  //
  // This also preserves the pre-#5128 behaviour of the generic device-command
  // routes exactly: they raw-inserted a pending row and let the next heartbeat
  // collect it, so a reboot was never socket-pushed on that path either.
  if (POWER_STATE_BARRIER_TYPES.has(input.type)) {
    return { ok: true, command, delivery: 'queued_live', deliverBy };
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
