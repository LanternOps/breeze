/**
 * The in-transaction reads and writes of parked-device assignment, one
 * function per step so the orchestration in ./assignParkedDevice.ts can be
 * unit-tested with these mocked. Every function takes the caller's
 * transaction and runs under the system DB context that transaction was
 * opened in (the holding org is never in a human caller's accessibleOrgIds,
 * and the ledger's RLS is system-only).
 *
 * The SQL itself is proved against real Postgres in
 * __tests__/integration/parkedAssignment.integration.test.ts.
 */
import { and, asc, eq } from 'drizzle-orm';
import { devices, organizations, refreshTokenFamilies, sites } from '../../db/schema';
import type { DeviceOrgMoveTx } from '../deviceOrgMove/moveDeviceOrgInTransaction';

export type AssignTx = DeviceOrgMoveTx;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The per-partner holding-area lock (./holdingAreaLock.ts), re-exported so
// the assignment orchestration reaches every step through this module.
export { lockPartnerHoldingArea } from './holdingAreaLock';

export interface LockedParkedDevice {
  id: string;
  agentId: string;
  hostname: string;
  status: string;
  createdAt: Date;
  orgId: string;
  siteId: string;
  linkGroupId: string | null;
  orgType: string;
  orgPartnerId: string;
}

/** Locks the device row FOR UPDATE and reads its org's type and partner. */
export async function lockDeviceForAssignment(tx: AssignTx, deviceId: string): Promise<LockedParkedDevice | null> {
  const [row] = await tx
    .select({
      id: devices.id,
      agentId: devices.agentId,
      hostname: devices.hostname,
      status: devices.status,
      createdAt: devices.createdAt,
      orgId: devices.orgId,
      siteId: devices.siteId,
      linkGroupId: devices.linkGroupId,
      orgType: organizations.type,
      orgPartnerId: organizations.partnerId,
    })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .where(eq(devices.id, deviceId))
    .limit(1)
    .for('update', { of: devices });
  return row ?? null;
}

export interface LockedTargetOrg {
  id: string;
  name: string;
  partnerId: string;
  type: string;
  status: string;
  deletedAt: Date | null;
}

/** Locks the destination org FOR SHARE (held to commit). */
export async function lockTargetOrg(tx: AssignTx, orgId: string): Promise<LockedTargetOrg | null> {
  const [row] = await tx
    .select({
      id: organizations.id,
      name: organizations.name,
      partnerId: organizations.partnerId,
      type: organizations.type,
      status: organizations.status,
      deletedAt: organizations.deletedAt,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
    .for('share');
  return row ?? null;
}

export async function siteBelongsToOrg(tx: AssignTx, siteId: string, orgId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.id, siteId), eq(sites.orgId, orgId)))
    .limit(1);
  return Boolean(row);
}

export interface IdentityCollision {
  id: string;
  status: string;
}

/**
 * Devices in the destination org + site that already carry this hostname,
 * oldest first — the same identity rule enrollment applies
 * (routes/agents/enrollment.ts), ephemeral rows excluded.
 */
export async function findIdentityCollisions(
  tx: AssignTx,
  input: { hostname: string; orgId: string; siteId: string },
): Promise<IdentityCollision[]> {
  return tx
    .select({ id: devices.id, status: devices.status })
    .from(devices)
    .where(and(
      eq(devices.hostname, input.hostname),
      eq(devices.orgId, input.orgId),
      eq(devices.siteId, input.siteId),
      eq(devices.isEphemeral, false),
    ))
    .orderBy(asc(devices.createdAt));
}

/**
 * Locks the caller's sign-in session (its refresh-token family) FOR SHARE and
 * reports whether it is still live: present, owned by this user, not revoked,
 * not past its absolute expiry. Held to commit, so a logout that revokes the
 * session waits for this assignment and the next one sees it revoked.
 */
export async function lockLiveUserSession(
  tx: AssignTx,
  input: { userId: string; sid: string },
): Promise<boolean> {
  // Session ids are refresh-family UUIDs; anything else cannot be live.
  if (!UUID_PATTERN.test(input.sid)) return false;
  const [row] = await tx
    .select({
      userId: refreshTokenFamilies.userId,
      revokedAt: refreshTokenFamilies.revokedAt,
      absoluteExpiresAt: refreshTokenFamilies.absoluteExpiresAt,
    })
    .from(refreshTokenFamilies)
    .where(eq(refreshTokenFamilies.familyId, input.sid))
    .limit(1)
    .for('share');
  return Boolean(row)
    && row!.userId === input.userId
    && row!.revokedAt === null
    && row!.absoluteExpiresAt.getTime() > Date.now();
}
