import * as dbModule from '../db';
import { networkTopology, discoveredAssets } from '../db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DiscoveredHostResult, DeviceAdjacency, FdbEntry } from './discoveryWorker';

const { db } = dbModule;

export const MEASURED_EDGE_AGEOUT_MS = 3 * 60 * 1000; // 3 scans × 60s scheduler (configurable later)

// Ports carrying more than this many MACs are treated as latent (undetected)
// uplinks and excluded from FDB host attachment. Logged, not silent (spec §8.3).
export const MAX_MACS_PER_ACCESS_PORT = 16;

export type AssetMatchIndex = {
  byMac: Map<string, string>;
  byIp: Map<string, string>;
  bySysName: Map<string, string>;
};

export type InfraEdgeUpsert = {
  orgId: string;
  siteId: string;
  sourceType: 'discovered_asset';
  sourceId: string;
  targetType: 'discovered_asset';
  targetId: string;
  connectionType: 'infra';
  method: 'lldp' | 'cdp';
  confidence: 'high';
  interfaceName: string | null;
  vlan: number | null;
};

function normMac(v: string | undefined | null): string {
  return (v ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
}

export function buildInfraEdges(
  orgId: string,
  siteId: string,
  adjacency: DeviceAdjacency[],
  assetIndex: AssetMatchIndex,
): InfraEdgeUpsert[] {
  const out: InfraEdgeUpsert[] = [];
  const seen = new Set<string>();

  const push = (sourceId: string, targetId: string, method: 'lldp' | 'cdp', iface: string | null) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const key = `${sourceId}|${targetId}|${method}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      orgId, siteId,
      sourceType: 'discovered_asset', sourceId,
      targetType: 'discovered_asset', targetId,
      connectionType: 'infra', method, confidence: 'high',
      interfaceName: iface, vlan: null,
    });
  };

  for (const block of adjacency) {
    const sourceId = assetIndex.byIp.get(block.sourceDeviceIp);
    if (!sourceId) continue;

    for (const n of block.lldp ?? []) {
      const targetId =
        assetIndex.byMac.get(normMac(n.remoteChassisId)) ??
        (n.remoteSysName ? assetIndex.bySysName.get(n.remoteSysName) : undefined);
      if (!targetId) continue;
      push(sourceId, targetId, 'lldp', n.localIfName ?? n.localPort ?? null);
    }

    for (const n of block.cdp ?? []) {
      const targetId =
        (n.remoteAddress ? assetIndex.byIp.get(n.remoteAddress) : undefined) ??
        (n.remoteDeviceId ? assetIndex.bySysName.get(n.remoteDeviceId) : undefined);
      if (!targetId) continue;
      push(sourceId, targetId, 'cdp', n.localPort ?? null);
    }
  }
  return out;
}

// ── Phase 2: FDB host attachment ────────────────────────────────────────────

export interface FdbAttachment {
  switchAssetId: string; // discovered_assets.id of the switch (source)
  hostAssetId: string; // discovered_assets.id matched by MAC (target)
  interfaceName: string | null;
  vlan: number | null;
}

export interface FdbReconcileResult {
  attachments: FdbAttachment[];
  skippedUnknownMac: number; // MAC not in discovered_assets
  skippedUplinkPort: number; // port is an LLDP/CDP neighbor
  skippedOverThreshold: number; // port MAC count > maxMacsPerPort
}

/**
 * Pure: no DB. Given one device's adjacency, the resolved switch asset id, and
 * a site-scoped MAC→asset id map, decide which hosts attach to which access
 * (non-uplink) switch ports. Uplink ports (those appearing as an LLDP/CDP
 * neighbor) and over-threshold ports (likely undetected uplinks) are excluded.
 */
export function computeFdbAttachments(
  deviceAdj: DeviceAdjacency,
  switchAssetId: string | null,
  macToAssetId: Map<string, string>,
  maxMacsPerPort: number = MAX_MACS_PER_ACCESS_PORT,
): FdbReconcileResult {
  const result: FdbReconcileResult = {
    attachments: [],
    skippedUnknownMac: 0,
    skippedUplinkPort: 0,
    skippedOverThreshold: 0,
  };
  if (!switchAssetId || !deviceAdj.fdb || deviceAdj.fdb.length === 0) return result;

  // A switch port is an uplink iff it appears as the localPort/localIfName of
  // any LLDP neighbor, or the localPort of any CDP neighbor, on this device.
  const uplinkPorts = new Set<string>();
  for (const n of deviceAdj.lldp ?? []) {
    if (n.localPort) uplinkPorts.add(n.localPort);
    if (n.localIfName) uplinkPorts.add(n.localIfName);
  }
  for (const n of deviceAdj.cdp ?? []) {
    if (n.localPort) uplinkPorts.add(n.localPort);
  }

  const portKey = (e: FdbEntry): string => e.ifName ?? String(e.bridgePort);
  const isUplink = (e: FdbEntry): boolean =>
    (e.ifName !== undefined && uplinkPorts.has(e.ifName)) || uplinkPorts.has(String(e.bridgePort));

  // Group surviving (non-uplink) FDB rows by port.
  const accessByPort = new Map<string, FdbEntry[]>();
  for (const e of deviceAdj.fdb) {
    if (isUplink(e)) {
      result.skippedUplinkPort++;
      continue;
    }
    const key = portKey(e);
    const group = accessByPort.get(key);
    if (group) {
      group.push(e);
    } else {
      accessByPort.set(key, [e]);
    }
  }

  for (const entries of accessByPort.values()) {
    if (entries.length > maxMacsPerPort) {
      result.skippedOverThreshold++;
      continue;
    }
    for (const e of entries) {
      const mac = normMac(e.mac);
      const hostAssetId = mac ? macToAssetId.get(mac) : undefined;
      if (!hostAssetId) {
        result.skippedUnknownMac++;
        continue;
      }
      if (hostAssetId === switchAssetId) continue; // self-edge guard
      result.attachments.push({
        switchAssetId,
        hostAssetId,
        interfaceName: e.ifName ?? null,
        vlan: e.vlan ?? null,
      });
    }
  }
  return result;
}

async function buildAssetIndex(orgId: string, siteId: string): Promise<AssetMatchIndex> {
  const rows = await db
    .select({
      id: discoveredAssets.id,
      ip: discoveredAssets.ipAddress,
      mac: discoveredAssets.macAddress,
      sysName: discoveredAssets.hostname,
      snmp: discoveredAssets.snmpData,
    })
    .from(discoveredAssets)
    .where(and(eq(discoveredAssets.orgId, orgId), eq(discoveredAssets.siteId, siteId)));

  const byMac = new Map<string, string>();
  const byIp = new Map<string, string>();
  const bySysName = new Map<string, string>();
  for (const r of rows) {
    if (r.mac) byMac.set(normMac(r.mac), r.id);
    if (r.ip) byIp.set(r.ip, r.id);
    const snmpName = (r.snmp as { sysName?: string } | null)?.sysName;
    if (r.sysName) bySysName.set(r.sysName, r.id);
    if (snmpName) bySysName.set(snmpName, r.id);
  }
  return { byMac, byIp, bySysName };
}

export async function reconcileTopology(
  orgId: string,
  siteId: string,
  _hosts: DiscoveredHostResult[],
  adjacency: DeviceAdjacency[],
): Promise<void> {
  if (!adjacency || adjacency.length === 0) {
    // No measured evidence this scan — age out only, do not delete recent edges.
    await ageOutMeasuredEdges(orgId, siteId, []);
    return;
  }

  const assetIndex = await buildAssetIndex(orgId, siteId);
  const edges = buildInfraEdges(orgId, siteId, adjacency, assetIndex);

  for (const e of edges) {
    await db
      .insert(networkTopology)
      .values({
        orgId: e.orgId,
        siteId: e.siteId,
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        targetType: e.targetType,
        targetId: e.targetId,
        connectionType: e.connectionType,
        method: e.method,
        confidence: e.confidence,
        interfaceName: e.interfaceName,
        vlan: e.vlan,
        lastVerifiedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          networkTopology.orgId, networkTopology.siteId,
          networkTopology.sourceType, networkTopology.sourceId,
          networkTopology.targetType, networkTopology.targetId,
          networkTopology.method,
        ],
        set: {
          interfaceName: e.interfaceName,
          confidence: e.confidence,
          lastVerifiedAt: new Date(),
          updatedAt: new Date(),
        },
      });
  }

  // ── Phase 2: FDB host attachment ──────────────────────────────────────────
  // For each switch's bridge-FDB rows, attach known hosts to access (non-uplink)
  // ports. INSERT/upsert-only on the provenance index — never reads or mutates
  // method='manual' edges. assetIndex.byMac is keyed by normMac (hex-only), the
  // same normalization computeFdbAttachments applies to each fdb row MAC.
  let totUnknownMac = 0;
  let totUplink = 0;
  let totOverThreshold = 0;
  let totAttached = 0;
  for (const deviceAdj of adjacency) {
    const switchAssetId =
      assetIndex.byIp.get(deviceAdj.sourceDeviceIp) ??
      (deviceAdj.sourceChassisId
        ? assetIndex.byMac.get(normMac(deviceAdj.sourceChassisId))
        : undefined) ??
      null;
    const r = computeFdbAttachments(deviceAdj, switchAssetId, assetIndex.byMac);
    totUnknownMac += r.skippedUnknownMac;
    totUplink += r.skippedUplinkPort;
    totOverThreshold += r.skippedOverThreshold;
    for (const att of r.attachments) {
      await db
        .insert(networkTopology)
        .values({
          orgId,
          siteId,
          sourceType: 'discovered_asset',
          sourceId: att.switchAssetId,
          targetType: 'discovered_asset',
          targetId: att.hostAssetId,
          connectionType: 'access',
          method: 'fdb',
          confidence: 'medium',
          interfaceName: att.interfaceName,
          vlan: att.vlan,
          lastVerifiedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            networkTopology.orgId, networkTopology.siteId,
            networkTopology.sourceType, networkTopology.sourceId,
            networkTopology.targetType, networkTopology.targetId,
            networkTopology.method,
          ],
          set: {
            connectionType: 'access',
            confidence: 'medium',
            interfaceName: att.interfaceName,
            vlan: att.vlan,
            lastVerifiedAt: new Date(),
            updatedAt: new Date(),
          },
        });
      totAttached++;
    }
  }
  if (totUnknownMac || totUplink || totOverThreshold) {
    console.log(
      `[DiscoveryWorker] FDB reconcile org=${orgId} site=${siteId}: attached=${totAttached} ` +
        `skipped_unknown_mac=${totUnknownMac} skipped_uplink=${totUplink} skipped_over_threshold=${totOverThreshold}`,
    );
  }

  await ageOutMeasuredEdges(orgId, siteId, edges);
}

async function ageOutMeasuredEdges(orgId: string, siteId: string, upserted: InfraEdgeUpsert[]): Promise<void> {
  const cutoff = new Date(Date.now() - MEASURED_EDGE_AGEOUT_MS);
  const keepIds = upserted.length > 0
    ? await db
        .select({ id: networkTopology.id })
        .from(networkTopology)
        .where(and(
          eq(networkTopology.orgId, orgId),
          eq(networkTopology.siteId, siteId),
          inArray(networkTopology.method, ['lldp', 'cdp']),
          sql`${networkTopology.lastVerifiedAt} >= ${cutoff.toISOString()}::timestamptz`,
        ))
    : [];
  const keep = new Set(keepIds.map((r) => r.id));

  const stale = await db
    .select({ id: networkTopology.id })
    .from(networkTopology)
    .where(and(
      eq(networkTopology.orgId, orgId),
      eq(networkTopology.siteId, siteId),
      inArray(networkTopology.method, ['lldp', 'cdp']),
      sql`(${networkTopology.lastVerifiedAt} IS NULL OR ${networkTopology.lastVerifiedAt} < ${cutoff.toISOString()}::timestamptz)`,
    ));

  const toDelete = stale.map((r) => r.id).filter((id) => !keep.has(id));
  if (toDelete.length > 0) {
    await db.delete(networkTopology).where(inArray(networkTopology.id, toDelete));
  }
}
