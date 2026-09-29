/**
 * Decommission ONE device inside the caller's transaction — the status write,
 * the cancellation of its ordinary queued work (and of the records that own
 * that work), and optionally the queued agent uninstall, all committing or
 * rolling back together. Shared by the device Remove route
 * (routes/devices/core.ts) and parked-device expiry
 * (services/unassignedPool/parkedExpiry.ts) so the two can never drift.
 *
 * `device_commands` has no RLS: the caller's context (request or system) is
 * the one this runs in. Never wrap it in `runOutsideDbContext` — the command
 * writes would then commit independently of the status write.
 */
import { and, eq, ne } from 'drizzle-orm';
import type { db } from '../db';
import { deviceCommands, devices } from '../db/schema';
import { terminalPayloadErasureSet } from './sensitiveCommandPayload';
import { propagateCancelledDeviceCommands } from './commandCancelPropagation';
import { queueDeviceUninstall } from './deviceUninstallDrain';

export type DeviceDecommissionTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function decommissionDeviceInTransaction(
  tx: DeviceDecommissionTx,
  input: { deviceId: string; queueUninstall: boolean; actorUserId: string | null },
): Promise<{ updated: typeof devices.$inferSelect | undefined; uninstallQueued: boolean }> {
  const { deviceId } = input;
  const [updated] = await tx
    .update(devices)
    .set({
      status: 'decommissioned',
      // #2787 item 4 — the window the `device_lifecycle` retention policy
      // measures ("purge removed devices after N days") starts HERE.
      // `updatedAt` cannot serve: every unrelated write to the row
      // afterwards would push the purge date out. Cleared again on Restore.
      decommissionedAt: new Date(),
      updatedAt: new Date()
    })
    .where(eq(devices.id, deviceId))
    .returning();

  // #5128 — cancel this device's ordinary queued work in the SAME
  // transaction as the status write. `self_uninstall` is explicitly
  // EXCLUDED: the uninstall drain's whole purpose is to survive
  // decommission and deliver when the machine next checks in, and
  // `queueDeviceUninstall` below may be about to write exactly such a row.
  // Claim-time eligibility refuses to deliver ordinary work to a
  // decommissioned device anyway; this is what stops those rows sitting
  // `pending` until their deadline.
  // Read id/type/payload BEFORE the erasing UPDATE: the propagation below
  // keys on `payload.executionId`, which `terminalPayloadErasureSet()` strips.
  const cancelledOnDecommission = await tx
    .select({
      id: deviceCommands.id,
      type: deviceCommands.type,
      payload: deviceCommands.payload,
    })
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, deviceId),
        eq(deviceCommands.status, 'pending'),
        ne(deviceCommands.type, 'self_uninstall'),
      ),
    );

  const decommissionCancelledAt = new Date();
  await tx
    .update(deviceCommands)
    .set({
      status: 'cancelled',
      completedAt: decommissionCancelledAt,
      result: {
        status: 'cancelled',
        reason: 'device_decommissioned',
        cancelledBy: 'device_decommission',
      },
      ...terminalPayloadErasureSet(),
    })
    .where(
      and(
        eq(deviceCommands.deviceId, deviceId),
        eq(deviceCommands.status, 'pending'),
        ne(deviceCommands.type, 'self_uninstall'),
      ),
    );

  // Terminalise the OWNING records in the same transaction — otherwise a
  // cancelled command strands its script_executions / deployment_results
  // row `pending` forever (the command reaper only scans pending/sent
  // COMMANDS, and this one is already terminal).
  await propagateCancelledDeviceCommands(
    cancelledOnDecommission.map((row) => ({
      id: row.id,
      type: row.type,
      payload: row.payload as Record<string, unknown> | null,
    })),
    decommissionCancelledAt,
    tx,
  );

  let uninstallQueued = false;
  if (input.queueUninstall) {
    const queueResult = await queueDeviceUninstall(tx, deviceId, input.actorUserId);
    uninstallQueued = queueResult.queued || queueResult.mergedIntoExisting;
  }

  return { updated, uninstallQueued };
}
