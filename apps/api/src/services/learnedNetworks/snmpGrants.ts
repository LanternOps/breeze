/**
 * Learned networks E11 (#12369, spec §8.3): saved SNMP secrets follow the fingerprints they were entered for.
 * W03a reads the grants; W03b adds the save-time rules to this file.
 */
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { ExpectedGateway } from '@breeze/shared';
import { db } from '../../db';
import { discoveryProfileSnmpGrants, learnedNetworkGateways, learnedNetworks } from '../../db/schema';

/**
 * The profile's granted fingerprints that belong to a network assigned to this site (and to `networkId` when
 * set), by network id then gateway id. Caller holds the shared site lock.
 */
export async function loadUsableGrantGateways(input: {
  orgId: string; profileId: string; siteId: string; networkId: string | null;
}): Promise<ExpectedGateway[]> {
  const conditions: SQL[] = [
    eq(discoveryProfileSnmpGrants.orgId, input.orgId),
    eq(discoveryProfileSnmpGrants.profileId, input.profileId),
    eq(learnedNetworks.siteId, input.siteId),
  ];
  if (input.networkId) conditions.push(eq(learnedNetworks.id, input.networkId));
  return db
    .select({
      networkId: learnedNetworks.id,
      gatewayId: learnedNetworkGateways.id,
      address: sql<string>`host(${learnedNetworkGateways.gatewayAddress})`,
      mac: sql<string>`lower(${learnedNetworkGateways.gatewayMac}::text)`,
    })
    .from(discoveryProfileSnmpGrants)
    .innerJoin(learnedNetworkGateways, and(
      eq(learnedNetworkGateways.id, discoveryProfileSnmpGrants.gatewayId),
      eq(learnedNetworkGateways.orgId, discoveryProfileSnmpGrants.orgId),
    ))
    .innerJoin(learnedNetworks, and(
      eq(learnedNetworks.id, learnedNetworkGateways.networkId),
      eq(learnedNetworks.orgId, learnedNetworkGateways.orgId),
    ))
    .where(and(...conditions))
    .orderBy(asc(learnedNetworks.id), asc(learnedNetworkGateways.id));
}
