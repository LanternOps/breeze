import { and, eq, sql } from 'drizzle-orm';
import { unifiCollectors, unifiSiteMappings, unifiDeviceTelemetry, unifiClients, discoveredAssets } from '../../db/schema';
import type { DbExecutor } from './unifiConnectionService';
import { upsertControllerSites } from './unifiControllerSiteService';

// Fields the wire schema marks optional are `T | null | undefined` here, matching
// what the zod validator infers (the agent omits zero-value fields via omitempty).
export interface TelemetryDeviceDto {
  unifiDeviceId: string; raw: unknown;
  unifiSiteId?: string | null; mac?: string | null; name?: string | null;
  uptimeSeconds?: number | null; cpuPct?: number | null; memPct?: number | null;
  txBytes?: number | null; rxBytes?: number | null; numClients?: number | null; poePorts?: unknown;
}
export interface TelemetryClientDto {
  mac: string; raw: unknown;
  unifiSiteId?: string | null; hostname?: string | null; ip?: string | null;
  connectedDeviceId?: string | null; uplinkPortIdx?: number | null; isWired?: boolean | null;
  ssid?: string | null; vlan?: number | null; signalDbm?: number | null;
  txBytes?: number | null; rxBytes?: number | null; uptimeSeconds?: number | null;
}
export interface TelemetryPayload {
  collectorId: string; polledAt: string; firmwareOk: boolean;
  devices: TelemetryDeviceDto[]; clients: TelemetryClientDto[]; error?: string;
  sites?: Array<{ id: string; name?: string | null }>;
  // Server-authoritative: the posting agent's token-resolved deviceId, stamped by
  // the ingest route. The worker rejects the payload unless it matches the
  // collector's collector_device_id, so an agent cannot write another org's
  // collector by guessing a collectorId (RLS is bypassed on the system path).
  deviceId?: string;
}
export interface ReconcileResult { devicesUpserted: number; devicesStaled: number; clientsUpserted: number; clientsStaled: number; }

// Canonical MAC form for cross-source matching: lowercase, colon-separated.
// discovered_assets stores colon-lowercase; UniFi may report uppercase/hyphenated,
// so we normalize both sides before comparing (and store the canonical form).
function normalizeMac(mac: string): string {
  return mac.trim().toLowerCase().replace(/-/g, ':');
}

// Extract IP from a telemetry device's raw payload.
// UniFi device JSON uses `ipAddress`; guard against other field names too.
function deviceIp(raw: unknown): string | null {
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const ip = r.ipAddress ?? r.ip;
    if (typeof ip === 'string' && ip.length > 0) return ip;
  }
  return null;
}

// Find-or-create a discovered_assets row for a telemetry device; return its id.
// Mirrors reconcileDiscoveredAsset in unifiSyncService.ts but uses the telemetry
// device DTO which exposes IP only inside `raw`.
async function linkTelemetryDeviceToAsset(
  db: DbExecutor,
  orgId: string,
  siteId: string,
  device: TelemetryDeviceDto,
): Promise<string | null> {
  const ip = deviceIp(device.raw);
  if (!ip) return null;

  const enrich = {
    macAddress: device.mac ?? undefined,
    hostname: device.name ?? undefined,
    manufacturer: 'Ubiquiti',
    isOnline: true,
    lastSeenAt: new Date(),
  };

  // 1. Match by (org_id, mac) first — the stable identifier.
  let existing: { id: string } | null = null;
  if (device.mac) {
    const byMac = await db.select({ id: discoveredAssets.id }).from(discoveredAssets)
      .where(and(eq(discoveredAssets.orgId, orgId), eq(discoveredAssets.macAddress, device.mac))).limit(1);
    existing = byMac[0] ?? null;
  }

  // 2. Fall back to the (org_id, ip_address) unique key.
  if (!existing) {
    const byIp = await db.select({ id: discoveredAssets.id }).from(discoveredAssets)
      .where(and(eq(discoveredAssets.orgId, orgId), eq(discoveredAssets.ipAddress, ip))).limit(1);
    existing = byIp[0] ?? null;
  }

  if (existing) {
    await db.update(discoveredAssets).set(enrich).where(eq(discoveredAssets.id, existing.id));
    return existing.id;
  }

  // Net-new: insert, absorbing a race with agent discovery via the (org,ip) unique key.
  const inserted = await db.insert(discoveredAssets)
    .values({ orgId, siteId, ipAddress: ip, ...enrich })
    .onConflictDoUpdate({ target: [discoveredAssets.orgId, discoveredAssets.ipAddress], set: enrich })
    .returning({ id: discoveredAssets.id });
  return inserted[0]?.id ?? null;
}

export async function reconcileTelemetry(
  db: DbExecutor,
  payload: TelemetryPayload,
  opts: { markStale?: boolean } = {},
): Promise<ReconcileResult> {
  // On a partial poll (some sites failed) the caller passes markStale=false so we
  // don't tombstone devices that merely belong to a momentarily-unreachable site.
  const markStale = opts.markStale ?? true;
  const result: ReconcileResult = { devicesUpserted: 0, devicesStaled: 0, clientsUpserted: 0, clientsStaled: 0 };

  const [collector] = await db.select({
    id: unifiCollectors.id, orgId: unifiCollectors.orgId, siteId: unifiCollectors.siteId,
    integrationId: unifiCollectors.integrationId,
  }).from(unifiCollectors).where(eq(unifiCollectors.id, payload.collectorId)).limit(1);
  if (!collector) throw new Error(`reconcileTelemetry: unknown collector ${payload.collectorId}`);

  if (payload.sites && payload.sites.length > 0) {
    await upsertControllerSites(db, collector.id, collector.orgId, payload.sites);
  }

  // Build unifiSiteId -> {orgId, siteId} from the Phase 1 mappings for this integration.
  const mappings = await db.select({
    unifiSiteId: unifiSiteMappings.unifiSiteId, siteId: unifiSiteMappings.siteId, orgId: unifiSiteMappings.orgId,
  }).from(unifiSiteMappings).where(eq(unifiSiteMappings.integrationId, collector.integrationId));
  const siteByUnifi = new Map<string, { orgId: string; siteId: string }>();
  for (const m of mappings) if (m.unifiSiteId) siteByUnifi.set(m.unifiSiteId, { orgId: m.orgId, siteId: m.siteId });
  // Fallback to the collector's own org/site when a device reports no/unknown unifi site.
  const resolveSite = (unifiSiteId: string | null | undefined) =>
    (unifiSiteId && siteByUnifi.get(unifiSiteId)) || { orgId: collector.orgId, siteId: collector.siteId };

  const now = new Date();
  // polledAt is the controller measurement time (agent clock); use it for
  // last_seen_at when parseable so the field isn't collected-but-ignored, and
  // fall back to ingest time otherwise. updated_at stays ingest-time.
  const parsedPolledAt = Date.parse(payload.polledAt);
  const seenAt = Number.isNaN(parsedPolledAt) ? now : new Date(parsedPolledAt);
  // raw is jsonb NOT NULL; the agent may emit JSON null (rawOf overflow/decode
  // failure) which z.unknown() lets through. Coalesce so the insert never nulls it.
  const rawOrEmpty = (v: unknown) => (v == null ? {} : v);

  // --- Devices ---
  const seenDeviceIds = new Set<string>();
  for (const d of payload.devices) {
    seenDeviceIds.add(d.unifiDeviceId);
    const { orgId, siteId } = resolveSite(d.unifiSiteId);
    const discoveredAssetId = await linkTelemetryDeviceToAsset(db, orgId, siteId, d);
    await db.insert(unifiDeviceTelemetry).values({
      collectorId: collector.id, orgId, siteId, unifiDeviceId: d.unifiDeviceId, mac: d.mac, name: d.name,
      uptimeSeconds: d.uptimeSeconds, cpuPct: d.cpuPct, memPct: d.memPct, txBytes: d.txBytes, rxBytes: d.rxBytes,
      numClients: d.numClients, discoveredAssetId, poePorts: d.poePorts ?? null, raw: rawOrEmpty(d.raw), isStale: false, lastSeenAt: seenAt,
      lastSyncedAt: now, updatedAt: now,
    }).onConflictDoUpdate({
      target: [unifiDeviceTelemetry.collectorId, unifiDeviceTelemetry.unifiDeviceId],
      set: {
        orgId, siteId, mac: d.mac, name: d.name, uptimeSeconds: d.uptimeSeconds, cpuPct: d.cpuPct, memPct: d.memPct,
        txBytes: d.txBytes, rxBytes: d.rxBytes, numClients: d.numClients, discoveredAssetId, poePorts: d.poePorts ?? null, raw: rawOrEmpty(d.raw),
        isStale: false, lastSeenAt: seenAt, lastSyncedAt: now, updatedAt: now,
      },
    });
    result.devicesUpserted++;
  }
  if (markStale) {
    const existingDevices = await db.select({ id: unifiDeviceTelemetry.id, unifiDeviceId: unifiDeviceTelemetry.unifiDeviceId })
      .from(unifiDeviceTelemetry).where(eq(unifiDeviceTelemetry.collectorId, collector.id));
    for (const row of existingDevices) {
      if (!seenDeviceIds.has(row.unifiDeviceId)) {
        await db.update(unifiDeviceTelemetry).set({ isStale: true, updatedAt: now }).where(eq(unifiDeviceTelemetry.id, row.id));
        result.devicesStaled++;
      }
    }
  }

  // --- Clients ---
  const seenMacs = new Set<string>();
  for (const cl of payload.clients) {
    const mac = normalizeMac(cl.mac);
    seenMacs.add(mac);
    const { orgId, siteId } = resolveSite(cl.unifiSiteId);
    // Enrich-only link to discovered_assets by (org_id, mac) — never create.
    // Normalize both sides so casing/separator differences don't miss the link.
    let discoveredAssetId: string | null = null;
    const [asset] = await db.select({ id: discoveredAssets.id }).from(discoveredAssets)
      .where(and(eq(discoveredAssets.orgId, orgId), eq(sql`lower(replace(${discoveredAssets.macAddress}, '-', ':'))`, mac))).limit(1);
    discoveredAssetId = asset?.id ?? null;

    await db.insert(unifiClients).values({
      collectorId: collector.id, orgId, siteId, mac, hostname: cl.hostname,
      ipAddress: cl.ip, connectedDeviceId: cl.connectedDeviceId, uplinkPortIdx: cl.uplinkPortIdx, isWired: cl.isWired,
      ssid: cl.ssid, vlan: cl.vlan, signalDbm: cl.signalDbm, txBytes: cl.txBytes, rxBytes: cl.rxBytes,
      uptimeSeconds: cl.uptimeSeconds, discoveredAssetId, raw: rawOrEmpty(cl.raw), isStale: false, lastSeenAt: seenAt, updatedAt: now,
    }).onConflictDoUpdate({
      target: [unifiClients.collectorId, unifiClients.mac],
      set: {
        orgId, siteId, hostname: cl.hostname, ipAddress: cl.ip, connectedDeviceId: cl.connectedDeviceId,
        uplinkPortIdx: cl.uplinkPortIdx, isWired: cl.isWired, ssid: cl.ssid, vlan: cl.vlan, signalDbm: cl.signalDbm,
        txBytes: cl.txBytes, rxBytes: cl.rxBytes, uptimeSeconds: cl.uptimeSeconds, discoveredAssetId,
        raw: rawOrEmpty(cl.raw), isStale: false, lastSeenAt: seenAt, updatedAt: now,
      },
    });
    result.clientsUpserted++;
  }
  if (markStale) {
    const existingClients = await db.select({ id: unifiClients.id, mac: unifiClients.mac })
      .from(unifiClients).where(eq(unifiClients.collectorId, collector.id));
    for (const row of existingClients) {
      if (!seenMacs.has(normalizeMac(row.mac))) {
        await db.update(unifiClients).set({ isStale: true, updatedAt: now }).where(eq(unifiClients.id, row.id));
        result.clientsStaled++;
      }
    }
  }

  return result;
}
