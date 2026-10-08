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
 * Callers own the initial authorization and the transaction. Purge callers
 * also pass the request-time site ceiling so an implicit group dissolve is
 * checked again under member locks; this service never accepts an AuthContext.
 *
 * Restore also admits the device against its partner's licensed device limit
 * (partnerDeviceCapacity.ts, the admission enrollment and provisioning use),
 * so it needs a SYSTEM-scoped transaction: the partner row and the
 * partner-wide count are invisible under tenant RLS. Its callers therefore
 * pass where their tenant-scoped read found the device, and restore refuses
 * if the locked row is no longer there.
 */
import { eq, sql } from 'drizzle-orm';
import { devices } from '../db/schema';
import { lockTimeoutWasChanged, tightenLockTimeout } from '../db/lockTimeout';
import { deleteDeviceCascade } from './deviceDeletion';
import { findPolicyBackupLegalHoldInContext } from './erasureBackupLegalHold';
import {
  admitPartnerDeviceCapacity,
  deviceTakesLicensedSlot,
  PartnerDeviceCapacityError,
} from './partnerDeviceCapacity';
import { dissolveLinkGroupIfBelowMinimum, LinkGroupSiteAccessError } from './deviceLinkGroups';
import {
  releaseDeviceRemoveReason,
  UNINSTALL_REASON_DEVICE_REMOVE,
  type Tx,
} from './deviceUninstallDrain';

export type DeviceLifecycleCode =
  | 'NOT_FOUND'
  | 'NOT_REMOVED'
  | 'UNINSTALL_PENDING'
  | 'SITE_ACCESS_DENIED'
  | 'STATE_CHANGED'
  | 'BACKUP_PROTECTED'
  | 'DEVICE_LIMIT_REACHED';

export class DeviceLifecycleError extends Error {
  constructor(
    public readonly code: DeviceLifecycleCode,
    message: string,
    /** Extra response fields. DEVICE_LIMIT_REACHED carries the partner's count
     *  and limit, the same fields the enrollment refusal returns. */
    public readonly details?: { currentDevices: number; maxDevices: number },
  ) {
    super(message);
    this.name = 'DeviceLifecycleError';
  }

  get status(): 403 | 404 | 409 {
    if (this.code === 'SITE_ACCESS_DENIED' || this.code === 'DEVICE_LIMIT_REACHED') return 403;
    return this.code === 'NOT_FOUND' ? 404 : 409;
  }
}

/** Where the caller's own tenant-scoped read found the device it authorized. */
export interface RestoreAuthorization {
  orgId: string;
  siteId: string | null;
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
  /**
   * The device's `link_group_id` AS READ UNDER THE LOCK — deliberately not the
   * caller's pre-flight copy, which predates the lock and can disagree with it.
   * Callers must key their audit entry on THIS value, so the group id and the
   * `linkGroupDissolved` flag beside it come off the same read. Dissolving a
   * group unlinks sibling devices that were never in the request, so a
   * mismatched pair leaves that unexplainable.
   */
  linkGroupId: string | null;
  linkGroupDissolved: boolean;
  /**
   * Site-owned topology alerts this device originated that the cascade
   * removed (possibly owned by another org after a move-org). Audited.
   */
  removedTopologyAlerts: number;
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
  org_id: string;
  site_id: string | null;
  is_ephemeral: boolean;
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
    sql`SELECT id, status, org_id, site_id, is_ephemeral, link_group_id FROM devices WHERE id = ${deviceId} FOR UPDATE`,
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
 * Restore a removed device: admit it against the partner device limit, cancel
 * its pending agent uninstall and flip the status back to `offline`.
 *
 * Must run in a SYSTEM-scoped transaction (see the file header), after the
 * caller authorized the device; `authorized` is where that read found it.
 *
 * Admission comes BEFORE the devices row lock. Enrollment takes the partner
 * lock first and then renames a decommissioned row with the same hostname, so
 * locking the device first here would be the opposite order: AB-BA, 40P01.
 * Admitting first also serializes two restores racing for the last slot on
 * the partner row, exactly as enrollment and provisioning are serialized.
 * Parked-device assignment (holdingAreaLock.ts) takes the device before the
 * partner, the other way round, but the two never meet on one device:
 * assignment refuses a decommissioned device before it admits, and restore
 * does not admit a parked device (it takes no licensed slot).
 * Cost: while waiting up to 3s for a contended devices row, restore holds the
 * partner row, so that partner's admissions wait with it.
 *
 * Release-then-flip inside the caller's transaction — the safety property is
 * the TRANSACTION (no session can observe "status flipped, uninstall still
 * pending", which is the window a heartbeat would use to claim the
 * self_uninstall as an ordinary command); the statement order is deliberate
 * secondary defense if a future refactor ever splits them apart. See the long
 * note this replaced in routes/devices/core.ts.
 */
export async function restoreRemovedDevice(
  tx: Tx,
  deviceId: string,
  authorized: RestoreAuthorization,
): Promise<RestoreResult> {
  const target = await admitRestore(tx, deviceId, authorized);

  const locked = await lockDevice(tx, deviceId);
  // The admission and the caller's authorization both describe the row as
  // read before this lock. A device moved to another org or site, or whose
  // licensed standing changed, in between is not the device they approved.
  if (
    locked.org_id !== authorized.orgId ||
    locked.site_id !== authorized.siteId ||
    locked.is_ephemeral !== target.is_ephemeral
  ) {
    throw new DeviceLifecycleError('STATE_CHANGED', 'Device changed before it could be restored; try again');
  }

  const release = await releaseDeviceRemoveReason(tx, deviceId, 'device_restored');

  // `decommissionedAt: null` is not cosmetic (#2787 item 4): it is the field
  // the retention purge job measures its window from. A restored device that
  // kept its stamp would stay eligible for permanent deletion by the very
  // policy the operator just overrode by hand.
  const [device] = await tx
    .update(devices)
    .set({ status: 'offline', decommissionedAt: null, updatedAt: new Date() })
    .where(eq(devices.id, deviceId))
    .returning();

  return { device, uninstallAlreadyDispatched: release.alreadyDispatched > 0 };
}

interface RestoreTarget {
  org_id: string;
  status: string;
  is_ephemeral: boolean;
  partner_id: string;
}

/**
 * Unlocked pre-read, then partner-device-limit admission for a device that
 * takes a licensed slot once active. Ephemeral and parked devices never take
 * a slot and are not admitted.
 */
async function admitRestore(
  tx: Tx,
  deviceId: string,
  authorized: RestoreAuthorization,
): Promise<RestoreTarget> {
  const rows = (await tx.execute(sql`
    SELECT d.org_id, d.status, d.is_ephemeral, o.partner_id
      FROM devices d
      JOIN organizations o ON o.id = d.org_id
     WHERE d.id = ${deviceId}
  `)) as unknown as RestoreTarget[];
  const target = Array.isArray(rows) ? rows[0] : undefined;
  if (!target) throw new DeviceLifecycleError('NOT_FOUND', 'Device not found');
  if (target.org_id !== authorized.orgId) {
    throw new DeviceLifecycleError('STATE_CHANGED', 'Device changed before it could be restored; try again');
  }
  // An already-active device is answered here, not by admission.
  if (target.status !== 'decommissioned') {
    throw new DeviceLifecycleError('NOT_REMOVED', 'Device is not removed');
  }

  if (!(await deviceTakesLicensedSlot(tx, deviceId))) return target;

  let admission;
  try {
    // The device is left out of the count so the answer is "may THIS device
    // be active". A concurrent restore of the same device that commits while
    // this one waits on the partner lock then surfaces as NOT_REMOVED under
    // the device lock, not as a misleading "limit reached".
    admission = await admitPartnerDeviceCapacity(tx, {
      orgId: authorized.orgId,
      expectedPartnerId: target.partner_id,
      excludeDeviceId: deviceId,
    });
  } catch (err) {
    if (err instanceof PartnerDeviceCapacityError) {
      throw new DeviceLifecycleError('STATE_CHANGED', 'Device admission state changed; retry');
    }
    throw err;
  }
  if (!admission.allowed) {
    throw new DeviceLifecycleError('DEVICE_LIMIT_REACHED', 'Device limit reached', {
      currentDevices: admission.activeCount,
      maxDevices: admission.maxDevices,
    });
  }
  return target;
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
 * Backup snapshots explicitly preserved — under legal hold, or inside their
 * immutability window — must survive an ordinary device purge, the same way
 * `deleteSnapshotRow` (jobs/backupRetention.ts) already refuses to delete
 * them during normal retention cleanup. `deleteDeviceCascade`'s generic
 * device-id cascade loop has no such check: it unconditionally deletes every
 * `backup_snapshots`/`backup_snapshot_retirements` row for the device, so a
 * hold placed for legal/compliance reasons on a device slated for removal was
 * silently destroyed along with everything else. This predicate is the gate
 * `purgeRemovedDevice` (and jobs/quickSupportReaper.ts) checks before entering
 * that cascade.
 *
 * A hold is not only a flag on a snapshot row (#7982). It can also be set on
 * the backup policy the device's jobs ran under, or come from a configuration
 * policy in effect for the device — the sources org erasure refuses on
 * (services/erasureBackupLegalHold.ts, #7980). Both are checked here through
 * that same function, narrowed to this device, with the hold-bearing rows
 * locked FOR SHARE so a hold set concurrently cannot commit between this
 * check and the cascade.
 *
 * Must run inside a system DB context whose transaction `tx` belongs to
 * (every caller: a `db.transaction` inside `withSystemDbAccessContext`): the
 * policy check reads through the context's handle, so it sees and locks in
 * the same transaction as the cascade.
 */
export const BACKUP_PROTECTED_MESSAGE =
  'This device has backups under legal hold (on a snapshot, its backup policy or a configuration policy) or a snapshot inside its immutability window. Release the hold, or wait for the window to expire, before purging the device.';

export async function hasProtectedBackupSnapshots(tx: Tx, deviceId: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT id FROM backup_snapshots
     WHERE device_id = ${deviceId}
       AND (
         legal_hold = true
         OR (is_immutable = true AND immutable_until IS NOT NULL AND immutable_until > now())
       )
     LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  if (Array.isArray(rows) && rows.length > 0) return true;

  const [device] = (await tx.execute(sql`
    SELECT org_id FROM devices WHERE id = ${deviceId}
  `)) as unknown as Array<{ org_id: string }>;
  // No device row: the cascade has nothing to delete, so nothing to protect.
  if (!device?.org_id) return false;
  const policyHold = await findPolicyBackupLegalHoldInContext(device.org_id, { deviceId, lockForShare: true });
  return policyHold !== null;
}

/**
 * Permanently delete a removed device and everything referencing it.
 *
 * Refuses (`UNINSTALL_PENDING`) while a `device_remove` uninstall is still
 * collectable: `device_commands` is in the device cascade, so purging now
 * destroys the only thing that will ever remove the agent from the endpoint,
 * leaving a zombie agent nobody can see or reach.
 *
 * A defined site ceiling is re-applied to any sibling devices an implicit
 * dissolve would unlink. The check happens in this transaction; denial throws
 * so callers must translate it only after the transaction rolls back.
 */
export async function purgeRemovedDevice(
  tx: Tx,
  deviceId: string,
  allowedSiteIds?: readonly string[],
): Promise<PurgeResult> {
  const row = await lockDevice(tx, deviceId);

  // The route/producer checked this device before entering the system-scoped
  // transaction, but a concurrent site move can commit between that preflight
  // and this row lock. Re-check the locked value before any cascade statement.
  // Null is denied for a restricted caller even though the current schema is
  // NOT NULL, keeping this boundary fail-closed if legacy/drifted data exists.
  if (
    allowedSiteIds !== undefined
    && (typeof row.site_id !== 'string' || !allowedSiteIds.includes(row.site_id))
  ) {
    throw new DeviceLifecycleError(
      'SITE_ACCESS_DENIED',
      'The device moved to an inaccessible site before deletion',
    );
  }

  if (await hasPendingDeviceRemoveUninstall(tx, deviceId)) {
    throw new DeviceLifecycleError('UNINSTALL_PENDING', UNINSTALL_PENDING_MESSAGE);
  }

  if (await hasProtectedBackupSnapshots(tx, deviceId)) {
    throw new DeviceLifecycleError('BACKUP_PROTECTED', BACKUP_PROTECTED_MESSAGE);
  }

  const { removedTopologyAlerts } = await deleteDeviceCascade(tx, deviceId);

  // #2138/#2308 — the deleted device's link_group_id went with its row. If the
  // group now has a lone survivor, or a vm_host group was left headless,
  // dissolve it. Read from the LOCKED row, not from the caller's earlier
  // lookup: the caller's copy predates the lock and can be stale.
  let linkGroupDissolved = false;
  if (row.link_group_id) {
    try {
      // This path already holds the target row before locking the remaining
      // group members, whereas link-group PATCH locks the whole set in id
      // order. That can form bounded lock contention when the target is not
      // the lowest id. DEVICE_LIFECYCLE_LOCK_TIMEOUT_MS makes the loser abort
      // and roll back instead of hanging or partially mutating; pre-reading a
      // group id to reverse the order would authorize a stale membership.
      linkGroupDissolved = await dissolveLinkGroupIfBelowMinimum(
        tx,
        row.link_group_id,
        allowedSiteIds,
      );
    } catch (err) {
      if (err instanceof LinkGroupSiteAccessError) {
        // Keep the response deliberately opaque. The caller knows the target
        // device, but must not learn whether the conflicting linked member is
        // merely concurrent, null-site, or outside their site ceiling.
        throw new DeviceLifecycleError(
          'STATE_CHANGED',
          'Device access or linked state changed before deletion',
        );
      }
      throw err;
    }
  }

  return { linkGroupId: row.link_group_id, linkGroupDissolved, removedTopologyAlerts };
}
