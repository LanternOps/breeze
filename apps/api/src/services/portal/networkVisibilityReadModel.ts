import type { NetworkOverviewDto } from '@breeze/shared';
import { desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  discoveredAssets,
  networkMonitorResults,
} from '../../db/schema';
import { loadReachability } from '../assetReachabilityLoader';

const NO_DATA_OVERVIEW: NetworkOverviewDto = {
  dataStatus: 'no_data',
  totalAssets: null,
  onlineAssets: null,
  offlineAssets: null,
  snmpDevicesPolling: null,
  monitorsDown: null,
};

/**
 * Customer-safe, organization-scoped Network Visibility foundation (#5861).
 *
 * Asset availability is derived through the same reachability service used by
 * the technician-facing network-device surfaces. Raw discovered_assets.isOnline
 * is therefore not treated as authoritative by this read model.
 *
 * Partner-wide network_monitors rows are definitions shared across
 * organizations. Their shared lastStatus is not customer-specific.
 * `network_monitor_results.org_id` is the authoritative execution result for
 * the organization being read.
 */
export async function networkOverview(
  orgId: string,
  now: Date = new Date(),
): Promise<NetworkOverviewDto> {
  const [assetRows, latestMonitorRows] = await Promise.all([
    db
      .select({
        id: discoveredAssets.id,
      })
      .from(discoveredAssets)
      .where(eq(discoveredAssets.orgId, orgId)),

    // One latest execution result per monitor for THIS organization.
    //
    // There is intentionally no join to network_monitors.lastStatus here:
    // partner-wide definitions are shared while these result rows are
    // organization-scoped.
    db
      .selectDistinctOn([networkMonitorResults.monitorId], {
        monitorId: networkMonitorResults.monitorId,
        status: networkMonitorResults.status,
      })
      .from(networkMonitorResults)
      .where(eq(networkMonitorResults.orgId, orgId))
      .orderBy(
        networkMonitorResults.monitorId,
        desc(networkMonitorResults.timestamp),
        desc(networkMonitorResults.id),
      ),
  ]);

  const assetIds = assetRows.map((row) => row.id);

  if (assetIds.length === 0 && latestMonitorRows.length === 0) {
    return NO_DATA_OVERVIEW;
  }

  const reachabilityByAsset = await loadReachability(assetIds, now);

  let onlineAssets = 0;
  let offlineAssets = 0;
  let snmpDevicesPolling = 0;

  for (const reachability of reachabilityByAsset.values()) {
    if (reachability.state === 'responding') {
      onlineAssets += 1;
    } else if (reachability.state === 'not_responding') {
      offlineAssets += 1;
    }

    // `unverified` is deliberately excluded from both online and offline.
    // SNMP is considered successfully polling only when the shared
    // reachability derivation reports the SNMP detail state as `ok`.
    if (reachability.detail.snmp?.state === 'ok') {
      snmpDevicesPolling += 1;
    }
  }

  return {
    dataStatus: 'ok',
    totalAssets: assetRows.length,
    onlineAssets,
    offlineAssets,
    snmpDevicesPolling,
    // Keep the contract literal: degraded/unknown are not silently classified
    // as down.
    monitorsDown: latestMonitorRows.filter(
      (row) => row.status === 'offline',
    ).length,
  };
}
