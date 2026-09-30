import { and, eq, ne, sql, type SQL } from 'drizzle-orm';
import type { db } from '../db';
import { lockTimeoutWasChanged, tightenLockTimeout } from '../db/lockTimeout';
import { devices, organizations, partners } from '../db/schema';
import { UNASSIGNED_POOL_ORG_TYPE } from './unassignedPool/orgType';

export type PartnerDeviceCapacityTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const PARTNER_DEVICE_CAPACITY_LOCK_TIMEOUT_MS = 3_000;

export type PartnerDeviceCapacityResult =
  | { allowed: true; partnerId: string; maxDevices: number | null; activeCount: number | null }
  | { allowed: false; partnerId: string; maxDevices: number; activeCount: number };

export class PartnerDeviceCapacityError extends Error {
  constructor(
    public readonly code: 'ORG_PARTNER_CHANGED' | 'PARTNER_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'PartnerDeviceCapacityError';
  }
}

/**
 * Serialize every licensed-device creation path on the owning partner row.
 *
 * The caller must already be inside a system-scoped transaction and must keep
 * that transaction open through the device INSERT. A successful result is an
 * admission, not a reservation that survives the transaction by itself.
 */
export async function admitPartnerDeviceCapacity(
  tx: PartnerDeviceCapacityTx,
  input: {
    orgId: string;
    expectedPartnerId: string;
    /**
     * A device this transaction has ALREADY placed in a counted org (parked
     * assignment moves the device first and admits last, so the partner row
     * lock is held only from here to commit). Left out of the count, so the
     * answer is still "may one more device be added".
     */
    excludeDeviceId?: string;
  },
): Promise<PartnerDeviceCapacityResult> {
  const priorLockTimeout = await tightenLockTimeout(tx, PARTNER_DEVICE_CAPACITY_LOCK_TIMEOUT_MS);

  // Pin the org-to-partner mapping in the same transaction. The expected id
  // came from an earlier caller-authorized read; a mismatch must not redirect
  // a system-context insert onto a different partner's entitlement.
  const [org] = await tx
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, input.orgId))
    .limit(1)
    .for('share');
  if (!org || org.partnerId !== input.expectedPartnerId) {
    throw new PartnerDeviceCapacityError(
      'ORG_PARTNER_CHANGED',
      'Organization partner changed during device admission',
    );
  }

  const [partner] = await tx
    .select({ maxDevices: partners.maxDevices })
    .from(partners)
    .where(eq(partners.id, input.expectedPartnerId))
    .limit(1)
    .for('update');
  if (!partner) {
    throw new PartnerDeviceCapacityError('PARTNER_NOT_FOUND', 'Partner not found during device admission');
  }
  if (lockTimeoutWasChanged(priorLockTimeout, PARTNER_DEVICE_CAPACITY_LOCK_TIMEOUT_MS)) {
    await tx.execute(sql`select set_config('lock_timeout', ${`${priorLockTimeout}ms`}, true)`);
  }

  return decideCapacity(tx, input, partner.maxDevices);
}

/**
 * Same answer as admitPartnerDeviceCapacity, WITHOUT row locks: an early,
 * advisory read so a caller can refuse before spending anything (a step-up
 * grant). Never an admission — the caller must still run
 * admitPartnerDeviceCapacity before its device write commits.
 */
export async function previewPartnerDeviceCapacity(
  tx: PartnerDeviceCapacityTx,
  input: { orgId: string; expectedPartnerId: string },
): Promise<PartnerDeviceCapacityResult> {
  const [org] = await tx
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, input.orgId))
    .limit(1);
  if (!org || org.partnerId !== input.expectedPartnerId) {
    throw new PartnerDeviceCapacityError('ORG_PARTNER_CHANGED', 'Organization partner changed during device admission');
  }
  const [partner] = await tx
    .select({ maxDevices: partners.maxDevices })
    .from(partners)
    .where(eq(partners.id, input.expectedPartnerId))
    .limit(1);
  if (!partner) {
    throw new PartnerDeviceCapacityError('PARTNER_NOT_FOUND', 'Partner not found during device admission');
  }
  return decideCapacity(tx, input, partner.maxDevices);
}

/**
 * Whether a device would take a licensed slot once it is active again, by the
 * same rule the admission count uses. A path that brings an existing device
 * back into service (restoring a decommissioned device) admits only when this
 * is true: restoring an ephemeral or parked device adds nothing to the count.
 * Unlocked, and deliberately independent of which partner owns the org, so a
 * concurrent org move cannot turn "admit" into "skip"; the caller pins the
 * device row itself before acting on the answer.
 */
export async function deviceTakesLicensedSlot(
  tx: PartnerDeviceCapacityTx,
  deviceId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.id, deviceId), ...licensedDeviceConditions(tx)))
    .limit(1);
  return row !== undefined;
}

/**
 * The devices that take a licensed slot while they are not decommissioned:
 * non-ephemeral devices outside a holding org, counted per partner. Devices
 * parked in the partner's holding org never consume licensed capacity (their
 * number is bounded separately, per partner); a parked device starts counting
 * when it is assigned, which calls this admission.
 */
function licensedDeviceConditions(tx: PartnerDeviceCapacityTx, partnerId?: string): SQL[] {
  const licensedOrgIds = tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(
      ...(partnerId ? [eq(organizations.partnerId, partnerId)] : []),
      ne(organizations.type, UNASSIGNED_POOL_ORG_TYPE),
    ));
  return [
    sql`${devices.orgId} IN (${licensedOrgIds})`,
    eq(devices.isEphemeral, false),
  ];
}

async function decideCapacity(
  tx: PartnerDeviceCapacityTx,
  input: { expectedPartnerId: string; excludeDeviceId?: string },
  maxDevices: number | null,
): Promise<PartnerDeviceCapacityResult> {
  if (maxDevices == null) {
    return { allowed: true, partnerId: input.expectedPartnerId, maxDevices: null, activeCount: null };
  }

  const licensed = licensedDeviceConditions(tx, input.expectedPartnerId);
  const [countResult] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(devices)
    .where(and(
      ...licensed,
      ne(devices.status, 'decommissioned'),
      ...(input.excludeDeviceId ? [ne(devices.id, input.excludeDeviceId)] : []),
    ));
  const activeCount = Number(countResult?.count ?? 0);
  if (activeCount >= maxDevices) {
    return { allowed: false, partnerId: input.expectedPartnerId, maxDevices, activeCount };
  }
  return { allowed: true, partnerId: input.expectedPartnerId, maxDevices, activeCount };
}
