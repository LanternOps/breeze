import { and, eq, gt, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { deviceCommands, devices, peripheralPolicyDeviceStates } from '../db/schema';
import { partitionClaimable } from './commandClaimEligibility';
import { terminalPayloadErasureSet } from './sensitiveCommandPayload';

type DeviceCommandRow = typeof deviceCommands.$inferSelect;

export async function claimPendingCommandForDelivery(
  commandId: string,
  executedAt: Date = new Date(),
): Promise<{ id: string; executedAt: Date } | null> {
  // device_commands is system-scoped (agent WS path) and this runs from
  // executeCommand's runOutsideDbContext block — establish a system context so
  // the write isn't a contextless bare-pool write (#1375 warning flood).
  const rows = await withSystemDbAccessContext(() =>
    db
      .update(deviceCommands)
      .set({ status: 'sent', executedAt })
      .where(
        and(
          eq(deviceCommands.id, commandId),
          eq(deviceCommands.status, 'pending'),
          // #5128: never deliver a row the reaper is about to expire. A row
          // whose deadline has passed stays `pending` for the reaper to
          // terminalise with `reason: not_delivered_before_deadline`.
          or(isNull(deviceCommands.deliverBy), gt(deviceCommands.deliverBy, executedAt)),
        ),
      )
      .returning({ id: deviceCommands.id }),
  );

  return rows.length > 0 ? { id: commandId, executedAt } : null;
}

/**
 * How many commands this device already has in flight (`sent`, awaiting a
 * result). Same predicate the heartbeat claim uses for the power-state barrier,
 * so the enqueue-time push and the heartbeat claim agree on when a reboot may
 * go out (#5128 §E.4).
 */
export async function countInFlightCommandsForDevice(
  deviceId: string,
  targetRole: string = 'agent',
): Promise<number> {
  const rows = await withSystemDbAccessContext(() =>
    db
      .select({ inFlight: sql<number>`count(*)::int` })
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.deviceId, deviceId),
          eq(deviceCommands.status, 'sent'),
          eq(deviceCommands.targetRole, targetRole),
        ),
      )
      .limit(1),
  );
  return rows[0]?.inFlight ?? 0;
}

/**
 * Put a claimed-but-undelivered command back to `pending`. Keyed on
 * `(id, status='sent', executedAt=<claim ts>)` so a stale release can never
 * clobber a newer claim or resurrect a terminal command (0-row no-op is the
 * correct outcome in both cases).
 *
 * Context note: `withSystemDbAccessContext` does NOT escalate when a request
 * context is already active — on the heartbeat paths (#2414) this UPDATE runs
 * inside the caller's org-scoped transaction. That is safe solely because
 * `device_commands` is intentionally RLS-free; if it ever gains a system-only
 * write policy, this release would become a silent 0-row no-op on the hottest
 * delivery path.
 */
export async function releaseClaimedCommandDelivery(
  commandId: string,
  executedAt: Date,
): Promise<void> {
  await withSystemDbAccessContext(() =>
    db
      .update(deviceCommands)
      .set({ status: 'pending', executedAt: null })
      .where(
        and(
          eq(deviceCommands.id, commandId),
          eq(deviceCommands.status, 'sent'),
          eq(deviceCommands.executedAt, executedAt),
        ),
      ),
  );
}

export async function claimPendingCommandsForDevice(
  deviceId: string,
  limit: number = 10,
  targetRole: 'agent' | 'watchdog' = 'agent',
  // #2774 — when set (offboarding drain window), only commands of these types
  // are claimable; anything else stays `pending` and is reaped/cancelled by
  // the normal lifecycle. The drain callers pass ['self_uninstall'].
  typeAllowlist?: readonly string[],
  capabilities?: {
    peripheralPolicyProtocolVersion?: number;
    rollbackProtocolVersion?: number;
    pamLifetimeProtocolVersion?: number;
  },
): Promise<DeviceCommandRow[]> {
  // Only HTTP delivery paths (heartbeat responses) claim batches; the agent
  // WebSocket never embeds command batches in frames (#2407 removed the
  // connect-time/heartbeat_ack claims — no agent version ever consumed them),
  // so the per-frame payload budget that #2399 added here is gone with it.
  return db.transaction(async (tx) => {
    const peripheralV2IsClaimable =
      typeAllowlist === undefined || typeAllowlist.includes('peripheral_policy_sync_v2');
    if (
      targetRole === 'agent'
      && peripheralV2IsClaimable
      && capabilities?.peripheralPolicyProtocolVersion !== 2
    ) {
      await tx
        .update(deviceCommands)
        .set({
          status: 'cancelled',
          completedAt: new Date(),
          result: { status: 'failed', error: 'peripheral_policy_protocol_v2_not_reported' },
          ...terminalPayloadErasureSet(),
        })
        .where(and(
          eq(deviceCommands.deviceId, deviceId),
          eq(deviceCommands.status, 'pending'),
          eq(deviceCommands.targetRole, 'agent'),
          eq(deviceCommands.type, 'peripheral_policy_sync_v2'),
        ));
      await tx
        .update(peripheralPolicyDeviceStates)
        .set({
          deliveryStatus: 'rejected',
          lastErrorCode: 'protocol_capability_not_reported',
          updatedAt: new Date(),
        })
        .where(and(
          eq(peripheralPolicyDeviceStates.deviceId, deviceId),
          eq(peripheralPolicyDeviceStates.deliveryStatus, 'pending'),
        ));
    }

    const unsupportedProtocolTypes: string[] = [];
    if (targetRole === 'agent' && capabilities?.peripheralPolicyProtocolVersion !== 2) {
      unsupportedProtocolTypes.push('peripheral_policy_sync_v2');
    }
    if (targetRole === 'agent' && capabilities?.rollbackProtocolVersion !== 1) {
      unsupportedProtocolTypes.push('agent_rollback_v1');
    }
    if (targetRole === 'agent' && capabilities?.pamLifetimeProtocolVersion !== 2) {
      unsupportedProtocolTypes.push('pam_apply_v2', 'pam_cleanup_v2');
    }

    const now = new Date();
    const pendingCommands = await tx
      .select()
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.deviceId, deviceId),
          eq(deviceCommands.status, 'pending'),
          eq(deviceCommands.targetRole, targetRole),
          // #5128: a row past its delivery deadline is the reaper's, not ours.
          or(isNull(deviceCommands.deliverBy), gt(deviceCommands.deliverBy, now)),
          ...(typeAllowlist ? [inArray(deviceCommands.type, [...typeAllowlist])] : []),
          ...(unsupportedProtocolTypes.length > 0
            ? [notInArray(deviceCommands.type, unsupportedProtocolTypes)]
            : []),
        ),
      )
      .orderBy(deviceCommands.createdAt)
      .limit(limit)
      .for('update', { skipLocked: true });

    // #5128 §G: re-check eligibility at the moment of delivery. A queued
    // command may have been requested days ago, so the device's org, lifecycle,
    // partner trust and the requester's account are all re-evaluated here, and
    // the power-state barrier is applied. Cancels are written on `tx`, so a row
    // this rejects cannot be delivered by a concurrent claim.
    let deliverable = pendingCommands;
    if (pendingCommands.length > 0) {
      const [dev] = await tx
        .select({
          id: devices.id,
          orgId: devices.orgId,
          status: devices.status,
        })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1);
      if (!dev) return [];

      const [inFlightRow] = await tx
        .select({ inFlight: sql<number>`count(*)::int` })
        .from(deviceCommands)
        .where(
          and(
            eq(deviceCommands.deviceId, deviceId),
            eq(deviceCommands.status, 'sent'),
            eq(deviceCommands.targetRole, targetRole),
          ),
        )
        .limit(1);

      const { claimable } = await partitionClaimable(tx, dev, pendingCommands, {
        inFlight: inFlightRow?.inFlight ?? 0,
      });
      const claimableIds = new Set(claimable.map((c) => c.id));
      deliverable = pendingCommands.filter((c) => claimableIds.has(c.id));
      if (deliverable.length === 0) return [];
    }

    const claimed: DeviceCommandRow[] = [];
    for (const command of deliverable) {
      const executedAt = new Date();
      const rows = await tx
        .update(deviceCommands)
        .set({ status: 'sent', executedAt })
        .where(
          and(
            eq(deviceCommands.id, command.id),
            eq(deviceCommands.deviceId, deviceId),
            eq(deviceCommands.status, 'pending'),
            eq(deviceCommands.targetRole, targetRole),
          ),
        )
        .returning();
      if (rows[0]) {
        claimed.push(rows[0]);
      }
    }

    return claimed;
  });
}
