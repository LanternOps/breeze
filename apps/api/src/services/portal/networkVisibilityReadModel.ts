import type { NetworkOverviewDto, NetworkAssetsDto, NetworkAssetRowDto } from '@breeze/shared';
import { and, asc, desc, eq, gte, ne, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  discoveredAssets,
  networkMonitorResults,
  networkMonitors,
  sites,
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

export interface NetworkAssetsFilter {
  siteId?: string;
  assetType?: string;
  /** online = reachability 'responding'; offline = 'not_responding'; unverified = state resolves to neither. */
  status?: 'online' | 'offline' | 'unverified';
  page?: number;
  limit?: number;
}

/**
 * Stable sort for keyset-free offset pagination: hostname NULLS LAST, then
 * IP, then id as the final tiebreaker so page boundaries never repeat or
 * skip rows across requests.
 */
const STABLE_ASSET_ORDER = [
  sql`${discoveredAssets.hostname} NULLS LAST`,
  asc(discoveredAssets.ipAddress),
  asc(discoveredAssets.id),
];

export async function networkAssets(
  orgId: string,
  filter: NetworkAssetsFilter = {},
  now: Date = new Date(),
): Promise<NetworkAssetsDto> {
  const page = Math.max(1, filter.page ?? 1);
  const limit = Math.min(500, Math.max(1, filter.limit ?? 50));

  const conditions = [
    eq(discoveredAssets.orgId, orgId),
    // MSP-dismissed assets are deliberately hidden from technicians; the
    // customer-facing list must respect that, not just approved/pending ones.
    ne(discoveredAssets.approvalStatus, 'dismissed'),
  ];
  if (filter.siteId) conditions.push(eq(discoveredAssets.siteId, filter.siteId));
  if (filter.assetType) conditions.push(eq(discoveredAssets.assetType, filter.assetType as typeof discoveredAssets.assetType.enumValues[number]));

  const baseWhere = and(...conditions);

  // The org may have discovered assets even when a filter matches none of
  // them. no_data must mean "nothing in this org", not "nothing matched this
  // filter" — that second case is a legitimate ok/empty result.
  const [{ orgHasAnyAsset }] = await db
    .select({ orgHasAnyAsset: sql<boolean>`count(*) > 0` })
    .from(discoveredAssets)
    .where(and(eq(discoveredAssets.orgId, orgId), ne(discoveredAssets.approvalStatus, 'dismissed')));

  if (!orgHasAnyAsset) {
    return { dataStatus: 'no_data', data: [], pagination: { page, limit, total: 0 } };
  }

  // The status filter depends on reachability, computed in memory below, so
  // it cannot be pushed into this query. Without it, count + limit/offset
  // keeps this bounded for large orgs instead of loading every asset.
  if (!filter.status) {
    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(discoveredAssets)
      .where(baseWhere);

    if (total === 0) {
      return { dataStatus: 'ok', data: [], pagination: { page, limit, total: 0 } };
    }

    const rows = await db
      .select({
        id: discoveredAssets.id,
        hostname: discoveredAssets.hostname,
        label: discoveredAssets.label,
        ipAddress: discoveredAssets.ipAddress,
        macAddress: discoveredAssets.macAddress,
        assetType: discoveredAssets.assetType,
        lastSeenAt: discoveredAssets.lastSeenAt,
        firstSeenAt: discoveredAssets.firstSeenAt,
        manufacturer: discoveredAssets.manufacturer,
        model: discoveredAssets.model,
        siteName: sites.name,
      })
      .from(discoveredAssets)
      .innerJoin(sites, eq(discoveredAssets.siteId, sites.id))
      .where(baseWhere)
      .orderBy(...STABLE_ASSET_ORDER)
      .limit(limit)
      .offset((page - 1) * limit);

    const reachabilityByAsset = await loadReachability(rows.map((r) => r.id), now);

    return {
      dataStatus: 'ok',
      data: rows.map((row) => toAssetRow(row, reachabilityByAsset.get(row.id))),
      pagination: { page, limit, total },
    };
  }

  // With a status filter: load every matching asset (identity/site columns
  // only, no snmpData needed since identity is now read pre-resolved), derive
  // reachability, filter in memory, then paginate the filtered set.
  const rows = await db
    .select({
      id: discoveredAssets.id,
      hostname: discoveredAssets.hostname,
      label: discoveredAssets.label,
      ipAddress: discoveredAssets.ipAddress,
      macAddress: discoveredAssets.macAddress,
      assetType: discoveredAssets.assetType,
      lastSeenAt: discoveredAssets.lastSeenAt,
      firstSeenAt: discoveredAssets.firstSeenAt,
      manufacturer: discoveredAssets.manufacturer,
      model: discoveredAssets.model,
      siteName: sites.name,
    })
    .from(discoveredAssets)
    .innerJoin(sites, eq(discoveredAssets.siteId, sites.id))
    .where(baseWhere)
    .orderBy(...STABLE_ASSET_ORDER);

  const reachabilityByAsset = await loadReachability(rows.map((r) => r.id), now);
  const allRows = rows.map((row) => toAssetRow(row, reachabilityByAsset.get(row.id)));
  const filtered = allRows.filter((row) => row.onlineState === (filter.status === 'unverified' ? null : filter.status));

  const total = filtered.length;
  const offset = (page - 1) * limit;
  const pageData = filtered.slice(offset, offset + limit);

  return {
    dataStatus: 'ok',
    data: pageData,
    pagination: { page, limit, total },
  };
}

interface AssetQueryRow {
  id: string;
  hostname: string | null;
  label: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  assetType: string;
  lastSeenAt: Date | null;
  firstSeenAt: Date;
  manufacturer: string | null;
  model: string | null;
  siteName: string;
}

/**
 * Manufacturer/model are read as stored, not re-resolved here. Resolution
 * (resolveAssetIdentity) already runs at ingest and applies manual precedence
 * there — re-deriving from snmpData at read time could overwrite a value a
 * technician typed in, putting the portal out of sync with the technician UI.
 */
function toAssetRow(
  row: AssetQueryRow,
  reachability: Awaited<ReturnType<typeof loadReachability>> extends Map<string, infer V> ? V | undefined : never,
): NetworkAssetRowDto {
  const onlineState: NetworkAssetRowDto['onlineState'] =
    reachability?.state === 'responding'
      ? 'online'
      : reachability?.state === 'not_responding'
        ? 'offline'
        : null;

  return {
    id: row.id,
    hostname: row.hostname,
    label: row.label,
    ipAddress: row.ipAddress,
    macAddress: row.macAddress,
    assetType: row.assetType,
    onlineState,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    firstSeenAt: row.firstSeenAt.toISOString(),
    manufacturer: row.manufacturer,
    model: row.model,
    siteName: row.siteName,
  };
}
