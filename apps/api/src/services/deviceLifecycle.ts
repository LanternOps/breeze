/**
 * Single-device lifecycle operations shared by the single routes
 * (routes/devices/core.ts), the bulk routes (routes/devices/bulkLifecycle.ts)
 * and the bulk-purge worker (jobs/deviceBulkPurge.ts). ONE implementation so
 * single and bulk cannot drift (#2787), and so the two latent defects found in
 * the pre-#2787 single routes stay fixed:
 *
 *  1. TOCTOU — permanent delete checked `status = 'decommissioned'` OUTSIDE the
 *     deletion transaction and never re-checked under the devices lock, so a
 *     Restore committing in between was silently purged. Both operations here
 *     lock first and decide second.
 *  2. Lock-order inversion — Restore released the uninstall reason (locking
 *     device_commands rows) BEFORE touching the devices row, opposite to the
 *     cascade's devices-first order (deviceDeletion.ts). AB-BA -> 40P01. Both
 *     operations here take `devices FOR UPDATE` as their first statement.
 *
 * Purge additionally REFUSES while a `device_remove` self_uninstall is still
 * pending/sent and unexpired: device_commands is in the device cascade, so
 * purging would destroy the only thing that will ever clean the endpoint. The
 * legacy fire-and-forget WS uninstall the permanent-delete route used to send
 * is gone — it only ever reached a CONNECTED agent, which a removed device
 * usually is not, and it raced the cascade that deleted its own command row.
 *
 * Callers own authorisation and the transaction. Nothing here reads `auth`.
 */
import { eq, sql } from 'drizzle-orm';
import { devices } from '../db/schema';
import { lockTimeoutWasChanged, tightenLockTimeout } from '../db/lockTimeout';
import { deleteDeviceCascade } from './deviceDeletion';
import { dissolveLinkGroupIfBelowMinimum } from './deviceLinkGroups';
import {
  releaseDeviceRemoveReason,
  UNINSTALL_REASON_DEVICE_REMOVE,
  type Tx,
} from './deviceUninstallDrain';

export type DeviceLifecycleCode = 'NOT_FOUND' | 'NOT_REMOVED' | 'UNINSTALL_PENDING';

export class DeviceLifecycleError extends Error {
  constructor(
    public readonly code: DeviceLifecycleCode,
    message: string,
  ) {
    super(message);
    this.name = 'DeviceLifecycleError';
  }

  get status(): 404 | 409 {
    return this.code === 'NOT_FOUND' ? 404 : 409;
  }
}

export interface RestoreResult {
  /**
   * The updated row. Optional because `.returning()` is typed as an array —
   * in practice the row is present (we hold FOR UPDATE on it and the lock
   * already established that it exists and is visible under this context), but
   * every caller reads it defensively rather than asserting a non-null that
   * only holds by argument.
   */
  device: typeof devices.$inferSelect | undefined;
  uninstallAlreadyDispatched: boolean;
}

export interface PurgeResult {
  linkGroupDissolved: boolean;
}

/**
 * Same 3s bound `deviceDeletion.ts` puts on its own parent-row lock, applied
 * here because this lock now comes FIRST — the cascade's bound would otherwise
 * never be reached on a contended row and a lifecycle op racing a long-running
 * site move or moveOrg would pin a pooled connection indefinitely (#1105).
 * A 55P03 out of here reaches the route's existing lock-timeout branch.
 */
export const DEVICE_LIFECYCLE_LOCK_TIMEOUT_MS = 3000;

interface LockedRow {
  id: string;
  status: string;
  link_group_id: string | null;
}

/**
 * First statement of every operation: devices row FOR UPDATE, then decide.
 *
 * Raw SQL rather than drizzle's `.for('update')` so the selected columns match
 * the physical column names the worker's own ownership re-check reads, and so
 * a second FOR UPDATE later in the same transaction (deleteDeviceCascade takes
 * one too) is a plain no-op on a lock this transaction already holds.
 */
async function lockDevice(tx: Tx, deviceId: string): Promise<LockedRow> {
  const priorMs = await tightenLockTimeout(tx, DEVICE_LIFECYCLE_LOCK_TIMEOUT_MS);
  const restoreTo = lockTimeoutWasChanged(priorMs, DEVICE_LIFECYCLE_LOCK_TIMEOUT_MS)
    ? priorMs
    : null;

  const rows = (await tx.execute(
    sql`SELECT id, status, link_group_id FROM devices WHERE id = ${deviceId} FOR UPDATE`,
  )) as unknown as LockedRow[];

  // Restored only on the success path, deliberately — see deviceDeletion.ts:
  // a lock timeout aborts the (sub)transaction, and any statement issued after
  // that fails with 25P02, masking the 55P03 the caller needs to see.
  if (restoreTo !== null) {
    await tx.execute(sql`select set_config('lock_timeout', ${`${restoreTo}ms`}, true)`);
  }

  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) throw new DeviceLifecycleError('NOT_FOUND', 'Device not found');
  if (row.status !== 'decommissioned') {
    throw new DeviceLifecycleError('NOT_REMOVED', 'Device is not removed');
  }
  return row;
}

/**
 * Restore a removed device: cancel its pending agent uninstall and flip the
 * status back to `offline`.
 *
 * Release-then-flip inside the caller's transaction — the safety property is
 * the TRANSACTION (no session can observe "status flipped, uninstall still
 * pending", which is the window a heartbeat would use to claim the
 * self_uninstall as an ordinary command); the statement order is deliberate
 * secondary defense if a future refactor ever splits them apart. See the long
 * note this replaced in routes/devices/core.ts.
 */
export async function restoreRemovedDevice(tx: Tx, deviceId: string): Promise<RestoreResult> {
  await lockDevice(tx, deviceId);

  const release = await releaseDeviceRemoveReason(tx, deviceId, 'device_restored');

  const [device] = await tx
    .update(devices)
    .set({ status: 'offline', updatedAt: new Date() })
    .where(eq(devices.id, deviceId))
    .returning();

  return { device, uninstallAlreadyDispatched: release.alreadyDispatched > 0 };
}

/**
 * The same predicate `isDeviceUninstallDraining` uses, minus its
 * `devices.status = 'decommissioned'` arm (already established by the lock).
 *
 * Raw SQL so the `@>` array containment and the `now()` comparison compile
 * identically to that reader — an uninstall this misses is an uninstall whose
 * command row we would then delete out from under a device that will never be
 * cleaned.
 */
async function hasPendingDeviceRemoveUninstall(tx: Tx, deviceId: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT id FROM device_commands
     WHERE device_id = ${deviceId}
       AND type = 'self_uninstall'
       AND status IN ('pending', 'sent')
       AND uninstall_reasons @> ARRAY[${UNINSTALL_REASON_DEVICE_REMOVE}]::text[]
       AND device_remove_expires_at > now()
     LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  return Array.isArray(rows) && rows.length > 0;
}

export const UNINSTALL_PENDING_MESSAGE =
  'An agent uninstall is still queued for this device. Wait for it to check in, or restore the device and remove it again choosing "Leave the agent installed".';

/**
 * Permanently delete a removed device and everything referencing it.
 *
 * Refuses (`UNINSTALL_PENDING`) while a `device_remove` uninstall is still
 * collectable: `device_commands` is in the device cascade, so purging now
 * destroys the only thing that will ever remove the agent from the endpoint,
 * leaving a zombie agent nobody can see or reach.
 */
export async function purgeRemovedDevice(tx: Tx, deviceId: string): Promise<PurgeResult> {
  const row = await lockDevice(tx, deviceId);

  if (await hasPendingDeviceRemoveUninstall(tx, deviceId)) {
    throw new DeviceLifecycleError('UNINSTALL_PENDING', UNINSTALL_PENDING_MESSAGE);
  }

  await deleteDeviceCascade(tx, deviceId);

  // #2138/#2308 — the deleted device's link_group_id went with its row. If the
  // group now has a lone survivor, or a vm_host group was left headless,
  // dissolve it. Read from the LOCKED row, not from the caller's earlier
  // lookup: the caller's copy predates the lock and can be stale.
  let linkGroupDissolved = false;
  if (row.link_group_id) {
    linkGroupDissolved = await dissolveLinkGroupIfBelowMinimum(tx, row.link_group_id);
  }

  return { linkGroupDissolved };
}
