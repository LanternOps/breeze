/**
 * The one site-safe `local_vaults` update, shared by PATCH and DELETE /backup/vault/:id
 * and the `configure_vault` AI tool (W03-D12, #6757). Moved from
 * routes/backup/vault.ts unchanged except that the last parameter is now the
 * site allowlist (it was the permissions object), so the tool can no longer
 * check a device's site and then write after a concurrent site move.
 *
 * `allowedSiteIds`: `undefined` = unrestricted caller (plain org-bound
 * update); an empty list = no site access (nothing is written); otherwise the
 * vault's device is row-locked inside those sites for the write.
 */
import { and, eq, inArray } from 'drizzle-orm';

import { db } from '../db';
import { devices, localVaults } from '../db/schema';

export async function updateVaultWithinCurrentSite(
  orgId: string,
  vaultId: string,
  updateData: Record<string, unknown>,
  allowedSiteIds: readonly string[] | undefined,
) {
  if (allowedSiteIds === undefined) {
    const [row] = await db
      .update(localVaults)
      .set(updateData)
      .where(and(eq(localVaults.id, vaultId), eq(localVaults.orgId, orgId)))
      .returning();
    return row;
  }
  if (!Array.isArray(allowedSiteIds) || allowedSiteIds.length === 0) return undefined;

  // Device-first locking is shared with device-move paths. If the move wins,
  // this re-read observes the new site and denies; if this lock wins, the move
  // waits until the authorized vault mutation commits. The deviceId equality
  // on the UPDATE is a final CAS against unsupported direct reassignment.
  return db.transaction(async (tx) => {
    const [vault] = await tx
      .select({ deviceId: localVaults.deviceId })
      .from(localVaults)
      .where(and(eq(localVaults.id, vaultId), eq(localVaults.orgId, orgId)))
      .limit(1);
    if (!vault) return undefined;

    const [device] = await tx
      .select({ id: devices.id })
      .from(devices)
      .where(and(
        eq(devices.id, vault.deviceId),
        eq(devices.orgId, orgId),
        inArray(devices.siteId, [...allowedSiteIds]),
      ))
      .limit(1)
      .for('update');
    if (!device) return undefined;

    const [row] = await tx
      .update(localVaults)
      .set(updateData)
      .where(and(
        eq(localVaults.id, vaultId),
        eq(localVaults.orgId, orgId),
        eq(localVaults.deviceId, vault.deviceId),
      ))
      .returning();
    return row;
  });
}
