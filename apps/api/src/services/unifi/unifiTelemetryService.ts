import { and, eq, sql } from 'drizzle-orm';
import { unifiCollectors, unifiSiteMappings, unifiDeviceTelemetry, unifiClients, discoveredAssets } from '../../db/schema';
import type { DbExecutor } from './unifiConnectionService';

export interface TelemetryDeviceDto {
  unifiDeviceId: string; unifiSiteId: string | null; mac: string | null; name: string | null;
  uptimeSeconds: number | null; cpuPct: number | null; memPct: number | null;
  txBytes: number | null; rxBytes: number | null; numClients: number | null; poePorts: unknown; raw: unknown;
}
export interface TelemetryClientDto {
  mac: string; unifiSiteId: string | null; hostname: string | null; ip: string | null;
  connectedDeviceId: string | null; uplinkPortIdx: number | null; isWired: boolean | null;
  ssid: string | null; vlan: number | null; signalDbm: number | null;
  txBytes: number | null; rxBytes: number | null; uptimeSeconds: number | null; raw: unknown;
}
export interface TelemetryPayload {
  collectorId: string; polledAt: string; firmwareOk: boolean;
  devices: TelemetryDeviceDto[]; clients: TelemetryClientDto[]; error?: string;
}
export interface ReconcileResult { devicesUpserted: number; devicesStaled: number; clientsUpserted: number; clientsStaled: number; }

export async function reconcileTelemetry(db: DbExecutor, payload: TelemetryPayload): Promise<ReconcileResult> {
  const result: ReconcileResult = { devicesUpserted: 0, devicesStaled: 0, clientsUpserted: 0, clientsStaled: 0 };

  const [collector] = await db.select({
    id: unifiCollectors.id, orgId: unifiCollectors.orgId, siteId: unifiCollectors.siteId,
    integrationId: unifiCollectors.integrationId,
  }).from(unifiCollectors).where(eq(unifiCollectors.id, payload.collectorId)).limit(1);
  if (!collector) throw new Error(`reconcileTelemetry: unknown collector ${payload.collectorId}`);

  // Build unifiSiteId -> {orgId, siteId} from the Phase 1 mappings for this integration.
  const mappings = await db.select({
    unifiSiteId: unifiSiteMappings.unifiSiteId, siteId: unifiSiteMappings.siteId, orgId: unifiSiteMappings.orgId,
  }).from(unifiSiteMappings).where(eq(unifiSiteMappings.integrationId, collector.integrationId));
  const siteByUnifi = new Map<string, { orgId: string; siteId: string }>();
  for (const m of mappings) if (m.unifiSiteId) siteByUnifi.set(m.unifiSiteId, { orgId: m.orgId, siteId: m.siteId });
  // Fallback to the collector's own org/site when a device reports no/unknown unifi site.
  const resolveSite = (unifiSiteId: string | null) =>
    (unifiSiteId && siteByUnifi.get(unifiSiteId)) || { orgId: collector.orgId, siteId: collector.siteId };

  const now = new Date();

  // --- Devices ---
  const seenDeviceIds = new Set<string>();
  for (const d of payload.devices) {
    seenDeviceIds.add(d.unifiDeviceId);
    const { orgId, siteId } = resolveSite(d.unifiSiteId);
    await db.insert(unifiDeviceTelemetry).values({
      collectorId: collector.id, orgId, siteId, unifiDeviceId: d.unifiDeviceId, mac: d.mac, name: d.name,
      uptimeSeconds: d.uptimeSeconds, cpuPct: d.cpuPct, memPct: d.memPct, txBytes: d.txBytes, rxBytes: d.rxBytes,
      numClients: d.numClients, poePorts: d.poePorts ?? null, raw: d.raw, isStale: false, lastSeenAt: now,
      lastSyncedAt: now, updatedAt: now,
    }).onConflictDoUpdate({
      target: [unifiDeviceTelemetry.collectorId, unifiDeviceTelemetry.unifiDeviceId],
      set: {
        orgId, siteId, mac: d.mac, name: d.name, uptimeSeconds: d.uptimeSeconds, cpuPct: d.cpuPct, memPct: d.memPct,
        txBytes: d.txBytes, rxBytes: d.rxBytes, numClients: d.numClients, poePorts: d.poePorts ?? null, raw: d.raw,
        isStale: false, lastSeenAt: now, lastSyncedAt: now, updatedAt: now,
      },
    });
    result.devicesUpserted++;
  }
  const existingDevices = await db.select({ id: unifiDeviceTelemetry.id, unifiDeviceId: unifiDeviceTelemetry.unifiDeviceId })
    .from(unifiDeviceTelemetry).where(eq(unifiDeviceTelemetry.collectorId, collector.id));
  for (const row of existingDevices) {
    if (!seenDeviceIds.has(row.unifiDeviceId)) {
      await db.update(unifiDeviceTelemetry).set({ isStale: true, updatedAt: now }).where(eq(unifiDeviceTelemetry.id, row.id));
      result.devicesStaled++;
    }
  }

  // --- Clients ---
  const seenMacs = new Set<string>();
  for (const cl of payload.clients) {
    seenMacs.add(cl.mac);
    const { orgId, siteId } = resolveSite(cl.unifiSiteId);
    // Enrich-only link to discovered_assets by (org_id, mac) — never create.
    let discoveredAssetId: string | null = null;
    const [asset] = await db.select({ id: discoveredAssets.id }).from(discoveredAssets)
      .where(and(eq(discoveredAssets.orgId, orgId), eq(discoveredAssets.macAddress, cl.mac))).limit(1);
    discoveredAssetId = asset?.id ?? null;

    await db.insert(unifiClients).values({
      collectorId: collector.id, orgId, siteId, mac: cl.mac, hostname: cl.hostname,
      ipAddress: cl.ip, connectedDeviceId: cl.connectedDeviceId, uplinkPortIdx: cl.uplinkPortIdx, isWired: cl.isWired,
      ssid: cl.ssid, vlan: cl.vlan, signalDbm: cl.signalDbm, txBytes: cl.txBytes, rxBytes: cl.rxBytes,
      uptimeSeconds: cl.uptimeSeconds, discoveredAssetId, raw: cl.raw, isStale: false, lastSeenAt: now, updatedAt: now,
    }).onConflictDoUpdate({
      target: [unifiClients.collectorId, unifiClients.mac],
      set: {
        orgId, siteId, hostname: cl.hostname, ipAddress: cl.ip, connectedDeviceId: cl.connectedDeviceId,
        uplinkPortIdx: cl.uplinkPortIdx, isWired: cl.isWired, ssid: cl.ssid, vlan: cl.vlan, signalDbm: cl.signalDbm,
        txBytes: cl.txBytes, rxBytes: cl.rxBytes, uptimeSeconds: cl.uptimeSeconds, discoveredAssetId,
        raw: cl.raw, isStale: false, lastSeenAt: now, updatedAt: now,
      },
    });
    result.clientsUpserted++;
  }
  const existingClients = await db.select({ id: unifiClients.id, mac: unifiClients.mac })
    .from(unifiClients).where(eq(unifiClients.collectorId, collector.id));
  for (const row of existingClients) {
    if (!seenMacs.has(row.mac)) {
      await db.update(unifiClients).set({ isStale: true, updatedAt: now }).where(eq(unifiClients.id, row.id));
      result.clientsStaled++;
    }
  }

  return result;
}
