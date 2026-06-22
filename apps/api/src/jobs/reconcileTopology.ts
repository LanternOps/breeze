import * as dbModule from '../db';
import { networkTopology, discoveredAssets } from '../db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DiscoveredHostResult, DeviceAdjacency } from './discoveryWorker';

const { db } = dbModule;

export const MEASURED_EDGE_AGEOUT_MS = 3 * 60 * 1000; // 3 scans × 60s scheduler (configurable later)

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
