/**
 * Learned networks W03b (#12369, spec §8.3): the lock order for profile writers, in one place.
 *
 * Shared site locks for every site the save touches (both sites on a move), ascending; then the profile row
 * FOR UPDATE. A save reads retained secrets only from the row this returns. Dispatch takes the same shared site lock
 * and then reads the row FOR SHARE (`loadProfileForDispatch`), so one save's secrets are never paired with another
 * save's grants.
 */
import { and, eq } from 'drizzle-orm';
import { assertInTransaction, db } from '../../db';
import { discoveryProfiles } from '../../db/schema';
import { lockSitesForNetworkGate } from './siteLock';

export type LockedProfileForSave = {
  id: string; orgId: string; siteId: string; networkId: string | null; snmpGrantMode: 'unrestricted' | 'bound';
  subnets: string[] | null; excludeIps: string[] | null; snmpCommunities: string[] | null; snmpCredentials: unknown;
  deepScan: boolean | null; pinnedDeviceId: string | null;
};

/**
 * Shared site locks for every id in siteIds (deduplicated, ascending), then
 * SELECT … FROM discovery_profiles WHERE id = $profileId AND org_id = $orgId FOR UPDATE.
 * Null when the row is gone. Must run inside the request transaction.
 */
export async function lockProfileForSave(input: {
  orgId: string; profileId: string; siteIds: readonly string[];
}): Promise<LockedProfileForSave | null> {
  assertInTransaction('lockProfileForSave');
  await lockSitesForNetworkGate(input.siteIds, 'shared');
  const [row] = await db
    .select({
      id: discoveryProfiles.id,
      orgId: discoveryProfiles.orgId,
      siteId: discoveryProfiles.siteId,
      networkId: discoveryProfiles.networkId,
      snmpGrantMode: discoveryProfiles.snmpGrantMode,
      subnets: discoveryProfiles.subnets,
      excludeIps: discoveryProfiles.excludeIps,
      snmpCommunities: discoveryProfiles.snmpCommunities,
      snmpCredentials: discoveryProfiles.snmpCredentials,
      deepScan: discoveryProfiles.deepScan,
      pinnedDeviceId: discoveryProfiles.pinnedDeviceId,
    })
    .from(discoveryProfiles)
    .where(and(eq(discoveryProfiles.id, input.profileId), eq(discoveryProfiles.orgId, input.orgId)))
    .limit(1)
    .for('update');
  if (!row) return null;
  return { ...row, snmpGrantMode: row.snmpGrantMode === 'bound' ? 'bound' : 'unrestricted' };
}
