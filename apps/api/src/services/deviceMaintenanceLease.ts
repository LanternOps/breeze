import { eq } from 'drizzle-orm';
import { devices } from '../db/schema';
import { resolveLivenessStatus } from './deviceLiveness';

/**
 * Transactional writer for the manual maintenance lease (RMM-QA-176 D3, D6).
 *
 * Deliberately knows nothing about auth, Redis or HTTP: the route validates and
 * consumes the step-up grant and maps errors to status codes, and the BULK route
 * reuses these same two functions inside ONE transaction over many devices. Both
 * take the caller's `tx`, take a `FOR UPDATE` lock, RE-CHECK state under the
 * lock (the check the route did before the transaction is advisory — another
 * actor can change the row in between), and issue exactly one UPDATE.
 *
 * The single UPDATE is not just tidiness. `devices_maintenance_lease_chk`
 * (migration 2026-10-05-100000) is ALL-OR-NOTHING over
 * {maintenance_started_at, maintenance_until, maintenance_reason}: writing any
 * one of the three on its own raises SQLSTATE 23514. Entry and clear therefore
 * set or null those columns together, in one statement. `maintenance_started_by`
 * sits deliberately OUTSIDE the constraint, so a live window with a null actor
 * stays legal — that is what lets user erasure (ON DELETE SET NULL) null the
 * actor without breaking the lease.
 */

/**
 * Statuses a device may be in to ENTER or EXTEND maintenance. `decommissioned`
 * keeps its own 400. `quarantined`, `pending` and `updating` are refused
 * because enter-then-exit would launder them: exit derives status from
 * liveness, so a quarantined device could come back as plain 'online'.
 * ONE list rather than separate entry/extension lists, because entry-vs-
 * extension is decided by the LEASE, not by status — a device whose heartbeat
 * already overwrote 'maintenance' with 'online' must still be extendable.
 */
export const MAINTENANCE_ENTRY_ALLOWED_STATUSES = ['online', 'offline', 'maintenance'] as const;

export type MaintenanceLeaseErrorCode = 'not_found' | 'decommissioned' | 'state_conflict';

export class MaintenanceLeaseError extends Error {
  constructor(
    readonly code: MaintenanceLeaseErrorCode,
    readonly status: number,
    message: string,
    readonly deviceStatus?: string,
  ) {
    super(message);
    this.name = 'MaintenanceLeaseError';
  }
}

type DeviceRow = typeof devices.$inferSelect;

/**
 * Structural view of a Drizzle transaction — keeps this module free of the tx
 * type's import weight and lets the unit suite drive it with a recording stub.
 */
export type MaintenanceTx = {
  select: (...args: any[]) => any;
  update: (...args: any[]) => any;
};

export interface MaintenanceEntryResult {
  action: 'enable' | 'extend';
  previousUntil: Date | null;
  previousReason: string | null;
  until: Date;
  startedAt: Date;
  device: DeviceRow;
}

export interface MaintenanceClearResult {
  changed: boolean;
  previousUntil: Date | null;
  previousReason: string | null;
  resolvedStatus: string;
  device: DeviceRow;
}

async function lockDevice(tx: MaintenanceTx, deviceId: string): Promise<DeviceRow> {
  const rows = await tx.select().from(devices).where(eq(devices.id, deviceId)).limit(1).for('update');
  const row = rows[0] as DeviceRow | undefined;
  if (!row) {
    throw new MaintenanceLeaseError('not_found', 404, 'Device not found');
  }
  return row;
}

const leaseIsActive = (row: Pick<DeviceRow, 'maintenanceUntil'>, now: Date): boolean =>
  row.maintenanceUntil != null && row.maintenanceUntil.getTime() > now.getTime();

export async function applyMaintenanceEntry(
  tx: MaintenanceTx,
  input: { deviceId: string; reason: string; durationHours: number; actorUserId: string; now: Date },
): Promise<MaintenanceEntryResult> {
  const row = await lockDevice(tx, input.deviceId);

  if (row.status === 'decommissioned') {
    throw new MaintenanceLeaseError(
      'decommissioned', 400, 'Cannot change maintenance mode for a decommissioned device', row.status,
    );
  }
  if (!(MAINTENANCE_ENTRY_ALLOWED_STATUSES as readonly string[]).includes(row.status)) {
    throw new MaintenanceLeaseError(
      'state_conflict', 409,
      `Cannot enter maintenance mode while the device is "${row.status}"`,
      row.status,
    );
  }

  // Entry vs extension is decided by the LEASE, never by `status`: the
  // heartbeat rewrites status to 'online' on every beat (F14/217), so a status
  // read cannot tell an active window from a finished one.
  const active = leaseIsActive(row, input.now);
  const until = new Date(input.now.getTime() + input.durationHours * 3_600_000);

  // State-INDEPENDENT outcome (D6): `until = now + durationHours` whether or not
  // a lease is already active, so "extend by N" means "N more hours from now"
  // and a grant minted for {devices, reason, N} always produces exactly that.
  // Compounding would make the same grant mean different things depending on a
  // race, which is precisely the TOCTOU this shape removes.
  const values: Partial<DeviceRow> = {
    maintenanceUntil: until,
    maintenanceReason: input.reason,
    status: 'maintenance',
    updatedAt: new Date(),
  };
  // started_at / started_by are IMMUTABLE across extensions — the ORIGINAL
  // actor stays on the row; each extension's actor is on its audit event.
  // On entry all three CHECK-grouped columns are written in this one statement.
  if (!active) {
    values.maintenanceStartedAt = input.now;
    values.maintenanceStartedBy = input.actorUserId;
  }

  const [updated] = await tx.update(devices).set(values).where(eq(devices.id, input.deviceId)).returning();

  return {
    action: active ? 'extend' : 'enable',
    previousUntil: active ? row.maintenanceUntil : null,
    previousReason: active ? row.maintenanceReason : null,
    until,
    // An active lease implies a non-null started_at: the CHECK constraint
    // forbids an `until` without a `started_at`.
    startedAt: active ? (row.maintenanceStartedAt as Date) : input.now,
    device: updated as DeviceRow,
  };
}

export async function clearMaintenanceLease(
  tx: MaintenanceTx,
  input: { deviceId: string; now: Date },
): Promise<MaintenanceClearResult> {
  const row = await lockDevice(tx, input.deviceId);

  const hadLease = row.maintenanceUntil != null || row.maintenanceStartedAt != null || row.maintenanceReason != null;
  const wasLabelledMaintenance = row.status === 'maintenance';
  if (!hadLease && !wasLabelledMaintenance) {
    // Nothing to end. Returning changed:false (and writing NO audit row) is the
    // point: an audit event must not claim a transition that did not happen.
    return { changed: false, previousUntil: null, previousReason: null, resolvedStatus: row.status, device: row };
  }

  // Status comes from FRESH evidence, never from a stored pre-maintenance
  // value: a device that went offline during the window must not be resurrected
  // as 'online' until its next heartbeat. A status that is NOT 'maintenance'
  // (the heartbeat already moved it, or it is 'updating') is left alone.
  const resolvedStatus = wasLabelledMaintenance
    ? resolveLivenessStatus(row.lastSeenAt, input.now)
    : row.status;

  // All three CHECK-grouped columns nulled together, in one statement.
  const values: Partial<DeviceRow> = {
    maintenanceUntil: null,
    maintenanceReason: null,
    maintenanceStartedAt: null,
    maintenanceStartedBy: null,
    updatedAt: new Date(),
  };
  if (wasLabelledMaintenance) {
    values.status = resolvedStatus as DeviceRow['status'];
  }

  const [updated] = await tx.update(devices).set(values).where(eq(devices.id, input.deviceId)).returning();

  return {
    changed: true,
    previousUntil: row.maintenanceUntil,
    previousReason: row.maintenanceReason,
    resolvedStatus,
    device: updated as DeviceRow,
  };
}
