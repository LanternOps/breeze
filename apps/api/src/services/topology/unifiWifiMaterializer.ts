import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { TopologyScope, UnifiResourceV2, WirelessRadioOverview, WirelessRadioStatistics } from '@breeze/shared';
import { assertInTransaction, db } from '../../db';
import { unifiDeviceTelemetry } from '../../db/schema';
import { canonicalMac } from '../unifi/unifiMac';
import { loadTopologyFlags } from './flags';
import type { UnifiCollectorAuthority } from './unifiAuthority';

/**
 * UniFi Wi-Fi current-state materializer (topology v2; Wi-Fi spec sections 7, 8 and 13).
 *
 * The topology v2 companion is the validated transport. The operator-facing current
 * state is the EXISTING `unifi_device_telemetry` row: this module upserts the typed
 * Wi-Fi fields into it, in ONE batched statement per poll (never one per AP), because
 * it runs inside the agent's synchronous request transaction.
 *
 * Pattern copied from `ingestUnifiInterfaceTelemetry` (unifiInterfaceMetrics.ts): it
 * consumes only resources that received an accepted topology receipt, runs in its own
 * savepoint, and is gated by `topologyFeatureFlags.interfaceHealth` — the same gate
 * that function checks (unifiInterfaceMetrics.ts, `interface_health_disabled`).
 *
 * Writer ownership: when a request carries `topologyV2`, this module is the sole writer
 * of uptime_seconds / cpu_pct / mem_pct / num_clients and every Wi-Fi column; the legacy
 * reconcile leaves them alone (unifiTelemetryService, `topologyV2Present`).
 *
 * Semantics per family (every family has its own `*_observed_at`):
 * - row PRESENT in an accepted resource: every field of that family is written; an
 *   explicit null clears the previous value; a measured zero stays zero;
 * - row OMITTED (rotation, request budget, deadline): the previous values AND the
 *   family timestamp are preserved. This is encoded in SQL: a family's columns are only
 *   replaced when the proposed row carries that family's `*_observed_at`.
 * - rates are bits per second and never touch tx_bytes / rx_bytes.
 */
export const UNIFI_WIFI_UPSERT_CHUNK = 1000;

type RowsOf<K extends UnifiResourceV2['kind']> = Extract<UnifiResourceV2, { kind: K }>['rows'];
export type AcceptedUnifiV2Resource = { resource: UnifiResourceV2; scope: TopologyScope; authorityKey: string };

/** `true` from a positive documented signal, `false` only when both sets are present and carry none, else `null`. Never model-name inference. */
export function deriveWifiCapable(features: readonly string[] | null, interfaces: readonly string[] | null): boolean | null {
  if ((interfaces?.includes('radios') ?? false) || (features?.includes('accessPoint') ?? false)) return true;
  if (features !== null && interfaces !== null) return false;
  return null;
}

/** WIRELESS clients grouped by non-null uplinkDeviceId. WIRED / VPN / TELEPORT / unknown never count, even with an uplink. */
export function deriveWirelessClientCounts(clients: readonly { clientType: string; uplinkDeviceId: string | null }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const client of clients) {
    if (client.clientType !== 'WIRELESS' || client.uplinkDeviceId === null) continue;
    counts.set(client.uplinkDeviceId, (counts.get(client.uplinkDeviceId) ?? 0) + 1);
  }
  return counts;
}

export type UnifiWifiRow = {
  orgId: string; siteId: string; unifiDeviceId: string; mac: string | null; name: string | null;
  inventoryObservedAt: Date | null; controllerState: string | null; wifiCapable: boolean | null;
  detailObservedAt: Date | null; radioOverview: WirelessRadioOverview[] | null;
  statisticsObservedAt: Date | null; uptimeSeconds: number | null; cpuPct: number | null; memPct: number | null;
  uplinkRxRateBps: number | null; uplinkTxRateBps: number | null; radioStatistics: WirelessRadioStatistics[] | null;
  lastHeartbeatAt: Date | null; nextHeartbeatAt: Date | null;
  clientsObservedAt: Date | null; numClients: number | null;
};

const usable = (outcome: string) => outcome === 'complete' || outcome === 'partial';

/** Pure: accepted v2 resources of ONE controller site -> one row per controller device, only for the families actually present. */
export function buildUnifiWifiRows(input: { scope: TopologyScope; capturedAt: Date; resources: readonly UnifiResourceV2[] }): UnifiWifiRow[] {
  const rows = new Map<string, UnifiWifiRow>();
  const rowFor = (unifiDeviceId: string): UnifiWifiRow => {
    let row = rows.get(unifiDeviceId);
    if (!row) {
      row = { orgId: input.scope.orgId, siteId: input.scope.siteId, unifiDeviceId, mac: null, name: null,
        inventoryObservedAt: null, controllerState: null, wifiCapable: null, detailObservedAt: null, radioOverview: null,
        statisticsObservedAt: null, uptimeSeconds: null, cpuPct: null, memPct: null, uplinkRxRateBps: null, uplinkTxRateBps: null,
        radioStatistics: null, lastHeartbeatAt: null, nextHeartbeatAt: null, clientsObservedAt: null, numClients: null };
      rows.set(unifiDeviceId, row);
    }
    return row;
  };
  const toDate = (value: string | null) => (value === null ? null : new Date(value));
  const byKind = <K extends UnifiResourceV2['kind']>(kind: K) => input.resources.find(r => r.kind === kind && usable(r.outcome)) as Extract<UnifiResourceV2, { kind: K }> | undefined;

  const deviceList = byKind('device_list');
  const capable = new Set<string>();
  for (const device of (deviceList?.rows ?? []) as RowsOf<'device_list'>) {
    const row = rowFor(device.deviceId);
    row.mac = canonicalMac(device.mac);
    row.name = device.name;
    row.inventoryObservedAt = input.capturedAt;
    row.controllerState = device.state;
    row.wifiCapable = deriveWifiCapable(device.features, device.interfaces);
    if (row.wifiCapable === true) capable.add(device.deviceId);
  }
  for (const detail of (byKind('device_details')?.rows ?? []) as RowsOf<'device_details'>) {
    const row = rowFor(detail.deviceId);
    row.detailObservedAt = input.capturedAt;
    row.radioOverview = detail.radios;
  }
  for (const stats of (byKind('statistics')?.rows ?? []) as RowsOf<'statistics'>) {
    const row = rowFor(stats.deviceId);
    row.statisticsObservedAt = input.capturedAt;
    row.uptimeSeconds = stats.uptimeSeconds;
    row.cpuPct = stats.cpuUtilizationPct;
    row.memPct = stats.memoryUtilizationPct;
    row.uplinkRxRateBps = stats.uplinkRxRateBps;
    row.uplinkTxRateBps = stats.uplinkTxRateBps;
    row.radioStatistics = stats.radios;
    row.lastHeartbeatAt = toDate(stats.lastHeartbeatAt);
    row.nextHeartbeatAt = toDate(stats.nextHeartbeatAt);
  }
  // Wireless counts need a COMPLETE client list. A partial list is a lower bound, never a count: keep the last count and its timestamp.
  const clientList = input.resources.find(r => r.kind === 'client_list' && r.outcome === 'complete') as Extract<UnifiResourceV2, { kind: 'client_list' }> | undefined;
  if (clientList) {
    const counts = deriveWirelessClientCounts(clientList.rows as RowsOf<'client_list'>);
    for (const deviceId of capable) {
      const row = rowFor(deviceId);
      row.clientsObservedAt = input.capturedAt;
      row.numClients = counts.get(deviceId) ?? 0;
    }
  }
  return [...rows.values()];
}

const col = (column: PgColumn) => sql.raw(`"${column.name}"`);
/** Replace a family's columns only when the proposed row carries that family's observed-at; otherwise keep what is stored. */
const family = (gate: PgColumn, column: PgColumn): SQL => sql`CASE WHEN excluded.${col(gate)} IS NOT NULL THEN excluded.${col(column)} ELSE ${column} END`;

export type UnifiWifiMaterializationReceipt = { rows: number; statements: number; skipped?: 'interface_health_disabled' | 'no_rows' };

/**
 * Upsert the Wi-Fi current state of one accepted v2 poll. The caller owns the transaction and the
 * system DB context. Runs in its own savepoint; a failure is reported by throwing so the adapter can
 * log it WITHOUT changing the structural receipt.
 */
export async function materializeUnifiWifiCurrentState(input: {
  collector: UnifiCollectorAuthority; report: { capturedAt: string }; accepted: readonly AcceptedUnifiV2Resource[];
}): Promise<UnifiWifiMaterializationReceipt> {
  assertInTransaction('materializeUnifiWifiCurrentState');
  const capturedAt = new Date(input.report.capturedAt);
  const groups = new Map<string, { scope: TopologyScope; resources: UnifiResourceV2[] }>();
  for (const item of input.accepted) {
    const key = `${item.scope.orgId}:${item.scope.siteId}:${item.resource.controllerSiteId}`;
    const group = groups.get(key) ?? { scope: item.scope, resources: [] };
    group.resources.push(item.resource);
    groups.set(key, group);
  }
  const rows: UnifiWifiRow[] = [];
  let gated = false;
  for (const group of groups.values()) {
    if (!(await loadTopologyFlags({ scope: group.scope })).interfaceHealth) { gated = true; continue; }
    rows.push(...buildUnifiWifiRows({ scope: group.scope, capturedAt, resources: group.resources }));
  }
  if (rows.length === 0) return { rows: 0, statements: 0, skipped: gated ? 'interface_health_disabled' : 'no_rows' };

  const t = unifiDeviceTelemetry;
  const now = new Date();
  let statements = 0;
  await db.transaction(async () => {
    for (let start = 0; start < rows.length; start += UNIFI_WIFI_UPSERT_CHUNK) {
      const chunk = rows.slice(start, start + UNIFI_WIFI_UPSERT_CHUNK);
      await db.insert(t).values(chunk.map(row => ({
        collectorId: input.collector.id, orgId: row.orgId, siteId: row.siteId, unifiDeviceId: row.unifiDeviceId, mac: row.mac, name: row.name,
        // A row created here is identity-light on purpose; the legacy reconcile (enqueued right after) owns identity and `raw`.
        raw: {},
        controllerState: row.controllerState, wifiCapable: row.wifiCapable, deviceInventoryObservedAt: row.inventoryObservedAt,
        wifiRadioOverview: row.radioOverview, wifiDetailObservedAt: row.detailObservedAt,
        uptimeSeconds: row.uptimeSeconds, cpuPct: row.cpuPct, memPct: row.memPct,
        uplinkRxRateBps: row.uplinkRxRateBps, uplinkTxRateBps: row.uplinkTxRateBps, wifiRadioStatistics: row.radioStatistics,
        statisticsLastHeartbeatAt: row.lastHeartbeatAt, statisticsNextHeartbeatAt: row.nextHeartbeatAt, wifiStatisticsObservedAt: row.statisticsObservedAt,
        numClients: row.numClients, wifiClientsObservedAt: row.clientsObservedAt,
        updatedAt: now,
      }))).onConflictDoUpdate({
        target: [t.collectorId, t.unifiDeviceId],
        set: {
          controllerState: family(t.deviceInventoryObservedAt, t.controllerState),
          wifiCapable: family(t.deviceInventoryObservedAt, t.wifiCapable),
          deviceInventoryObservedAt: sql`COALESCE(excluded.${col(t.deviceInventoryObservedAt)}, ${t.deviceInventoryObservedAt})`,
          wifiRadioOverview: family(t.wifiDetailObservedAt, t.wifiRadioOverview),
          wifiDetailObservedAt: sql`COALESCE(excluded.${col(t.wifiDetailObservedAt)}, ${t.wifiDetailObservedAt})`,
          uptimeSeconds: family(t.wifiStatisticsObservedAt, t.uptimeSeconds),
          cpuPct: family(t.wifiStatisticsObservedAt, t.cpuPct),
          memPct: family(t.wifiStatisticsObservedAt, t.memPct),
          uplinkRxRateBps: family(t.wifiStatisticsObservedAt, t.uplinkRxRateBps),
          uplinkTxRateBps: family(t.wifiStatisticsObservedAt, t.uplinkTxRateBps),
          wifiRadioStatistics: family(t.wifiStatisticsObservedAt, t.wifiRadioStatistics),
          statisticsLastHeartbeatAt: family(t.wifiStatisticsObservedAt, t.statisticsLastHeartbeatAt),
          statisticsNextHeartbeatAt: family(t.wifiStatisticsObservedAt, t.statisticsNextHeartbeatAt),
          wifiStatisticsObservedAt: sql`COALESCE(excluded.${col(t.wifiStatisticsObservedAt)}, ${t.wifiStatisticsObservedAt})`,
          numClients: family(t.wifiClientsObservedAt, t.numClients),
          wifiClientsObservedAt: sql`COALESCE(excluded.${col(t.wifiClientsObservedAt)}, ${t.wifiClientsObservedAt})`,
          updatedAt: now,
        },
        // Tenancy: never write Wi-Fi state into a row that currently belongs to another org/site. The legacy
        // reconcile re-homes it first; the next poll then applies the v2 fields.
        setWhere: and(eq(t.orgId, sql`excluded.${col(t.orgId)}`), eq(t.siteId, sql`excluded.${col(t.siteId)}`)),
      });
      statements += 1;
    }
  });
  return { rows: rows.length, statements };
}
