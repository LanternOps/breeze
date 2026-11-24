/**
 * Learned networks (#12369, spec §8.2): the gate's reads of a site's flag, its assigned networks and their
 * fingerprints. Callers hold a DB context and the shared site lock.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { ExpectedGateway } from '@breeze/shared';
import { db } from '../../db';
import { learnedNetworkGateways, learnedNetworks, sites } from '../../db/schema';

/** The site's flag and assigned network ids (ascending). A missing site reads as gated with none (fails closed). */
export async function loadSiteGateState(
  orgId: string,
  siteId: string,
): Promise<{ gated: boolean; assignedNetworkIds: string[] }> {
  const [site] = await db
    .select({ gated: sites.discoveryNetworkRequired })
    .from(sites)
    .where(and(eq(sites.id, siteId), eq(sites.orgId, orgId)))
    .limit(1);
  if (!site) return { gated: true, assignedNetworkIds: [] };
  const networks = await db
    .select({ id: learnedNetworks.id })
    .from(learnedNetworks)
    .where(and(eq(learnedNetworks.orgId, orgId), eq(learnedNetworks.siteId, siteId)))
    .orderBy(asc(learnedNetworks.id));
  return { gated: site.gated, assignedNetworkIds: networks.map((n) => n.id) };
}

/** The site a network is assigned to; null when the network is missing or unassigned. */
export async function loadNetworkSiteId(orgId: string, networkId: string): Promise<string | null> {
  const [network] = await db
    .select({ siteId: learnedNetworks.siteId })
    .from(learnedNetworks)
    .where(and(eq(learnedNetworks.id, networkId), eq(learnedNetworks.orgId, orgId)))
    .limit(1);
  return network?.siteId ?? null;
}

/** The fingerprints of these networks: host address (no prefix), lower-case MAC; by network id, then gateway id. */
export async function loadNetworkGateways(orgId: string, networkIds: readonly string[]): Promise<ExpectedGateway[]> {
  if (networkIds.length === 0) return [];
  return db
    .select({
      networkId: learnedNetworkGateways.networkId,
      gatewayId: learnedNetworkGateways.id,
      address: sql<string>`host(${learnedNetworkGateways.gatewayAddress})`,
      mac: sql<string>`lower(${learnedNetworkGateways.gatewayMac}::text)`,
    })
    .from(learnedNetworkGateways)
    .where(and(eq(learnedNetworkGateways.orgId, orgId), inArray(learnedNetworkGateways.networkId, [...networkIds])))
    .orderBy(asc(learnedNetworkGateways.networkId), asc(learnedNetworkGateways.id));
}
