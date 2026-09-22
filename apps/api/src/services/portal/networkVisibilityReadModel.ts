import type { NetworkOverviewDto } from '@breeze/shared';
import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from '../../db';
import {
  discoveredAssets,
  networkMonitorResults,
  networkMonitors,
} from '../../db/schema';
import { MIN_NETWORK_CHECK_FRESHNESS_MS } from '../assetReachability';
import { loadReachability } from '../assetReachabilityLoader';

// `createMonitorSchema` accepts polling intervals up to 86,400 seconds.
// The SQL query uses twice that maximum as its absolute lookback so it never
// walks the full network_monitor_results history. Per-monitor freshness is
// still evaluated below from the monitor's actual polling interval.
const MAX_NETWORK_MONITOR_POLLING_INTERVAL_SECONDS = 86_400;
const NETWORK_MONITOR_RESULT_LOOKBACK_MS = Math.max(
  2 * MAX_NETWORK_MONITOR_POLLING_INTERVAL_SECONDS * 1000,
  MIN_NETWORK_CHECK_FRESHNESS_MS,
);

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
  const monitorResultLowerBound = new Date(
    now.getTime() - NETWORK_MONITOR_RESULT_LOOKBACK_MS,
  );

  const assetRows = await db
    .select({
      id: discoveredAssets.id,
    })
    .from(discoveredAssets)
    .where(eq(discoveredAssets.orgId, orgId));

  // The caller supplies an organization-scoped context with currentPartnerId
  // populated. This exposes the SELECT-only partner-wide monitor definitions
  // while network_monitor_results remains organization-scoped by RLS.
  const latestMonitorRows = await db
    .selectDistinctOn([networkMonitorResults.monitorId], {
      monitorId: networkMonitorResults.monitorId,
      status: networkMonitorResults.status,
      timestamp: networkMonitorResults.timestamp,
      pollingInterval: networkMonitors.pollingInterval,
    })
    .from(networkMonitorResults)
    .innerJoin(
      networkMonitors,
      eq(networkMonitorResults.monitorId, networkMonitors.id),
    )
    .where(
      and(
        eq(networkMonitorResults.orgId, orgId),
        eq(networkMonitors.isActive, true),
        gte(
          networkMonitorResults.timestamp,
          monitorResultLowerBound,
        ),
      ),
    )
    .orderBy(
      networkMonitorResults.monitorId,
      desc(networkMonitorResults.timestamp),
      desc(networkMonitorResults.id),
    );

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
    // as down. An offline result also has to remain inside the same freshness
    // rule used by network-check reachability:
    // max(2 * polling interval, 5 minutes).
    monitorsDown: latestMonitorRows.filter((row) => {
      if (row.status !== 'offline') return false;

      const freshnessMs = Math.max(
        2 * row.pollingInterval * 1000,
        MIN_NETWORK_CHECK_FRESHNESS_MS,
      );

      return now.getTime() - row.timestamp.getTime() <= freshnessMs;
    }).length,
  };
}
