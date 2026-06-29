import { and, eq } from 'drizzle-orm';
import { unifiSiteMappings, unifiDevices, unifiSyncRuns, discoveredAssets } from '../../db/schema';
import type { DbExecutor } from './unifiConnectionService';
import type { UnifiClient, UnifiDeviceDto } from './unifiClient';

export interface SyncRunResult {
  hostsSeen: number;
  devicesCreated: number;
  devicesUpdated: number;
  devicesUnchanged: number;
  devicesRemoved: number;
  status: 'success' | 'partial' | 'failed';
  error?: string;
}

// Map UniFi device.type -> discovered_asset_type enum value.
// discoveredAssetTypeEnum values: workstation, server, printer, router, switch,
// firewall, access_point, phone, iot, camera, nas, unknown
function assetType(
  deviceType: string | null,
): 'switch' | 'access_point' | 'router' | 'firewall' | 'unknown' {
  switch ((deviceType ?? '').toLowerCase()) {
    case 'usw':
    case 'switch':
      return 'switch';
    case 'uap':
    case 'ap':
      return 'access_point';
    case 'ugw':
    case 'usg':
    case 'udm':
    case 'gateway':
      return 'router';
    case 'ufg':
    case 'firewall':
      return 'firewall';
    default:
      return 'unknown';
  }
}

// Map UniFi device.type -> unifi_devices.device_type varchar value.
function unifiToBreezeDeviceType(
  deviceType: string | null,
): 'gateway' | 'switch' | 'ap' | 'other' {
  switch ((deviceType ?? '').toLowerCase()) {
    case 'usw':
    case 'switch':
      return 'switch';
    case 'uap':
    case 'ap':
      return 'ap';
    case 'ugw':
    case 'usg':
    case 'udm':
    case 'gateway':
      return 'gateway';
    default:
      return 'other';
  }
}

// Find-or-create a discovered_assets row for a UniFi device; return its id.
async function reconcileDiscoveredAsset(
  db: DbExecutor,
  device: UnifiDeviceDto,
  mapping: { orgId: string; siteId: string },
): Promise<string | null> {
  // discovered_assets.ip_address is inet NOT NULL — cannot create without an IP.
  if (!device.ip) return null;

  const aType = assetType(device.deviceType);

  // 1. Match by (org_id, mac) first — the stable identifier.
  let existing: { id: string } | null = null;
  if (device.mac) {
    const byMac = await db
      .select({ id: discoveredAssets.id })
      .from(discoveredAssets)
      .where(
        and(
          eq(discoveredAssets.orgId, mapping.orgId),
          eq(discoveredAssets.macAddress, device.mac),
        ),
      )
      .limit(1);
    existing = byMac[0] ?? null;
  }

  // 2. Fall back to the (org_id, ip_address) unique key.
  if (!existing) {
    const byIp = await db
      .select({ id: discoveredAssets.id })
      .from(discoveredAssets)
      .where(
        and(
          eq(discoveredAssets.orgId, mapping.orgId),
          eq(discoveredAssets.ipAddress, device.ip),
        ),
      )
      .limit(1);
    existing = byIp[0] ?? null;
  }

  const enrich = {
    macAddress: device.mac ?? undefined,
    hostname: device.name ?? undefined,
    manufacturer: 'Ubiquiti',
    model: device.model ?? undefined,
    assetType: aType,
    isOnline: device.adoptionState === 'CONNECTED',
    lastSeenAt: new Date(),
  };

  if (existing) {
    await db
      .update(discoveredAssets)
      .set(enrich)
      .where(eq(discoveredAssets.id, existing.id));
    return existing.id;
  }

  // Net-new: insert, absorbing a race with agent discovery via the (org,ip) unique key.
  const inserted = await db
    .insert(discoveredAssets)
    .values({ orgId: mapping.orgId, siteId: mapping.siteId, ipAddress: device.ip, ...enrich })
    .onConflictDoUpdate({
      target: [discoveredAssets.orgId, discoveredAssets.ipAddress],
      set: enrich,
    })
    .returning({ id: discoveredAssets.id });
  return inserted[0]?.id ?? null;
}

export async function syncIntegration(
  deps: { db: DbExecutor; client: UnifiClient },
  integration: { id: string; partnerId: string },
  trigger: 'scheduled' | 'manual',
): Promise<SyncRunResult> {
  const { db, client } = deps;
  const result: SyncRunResult = {
    hostsSeen: 0,
    devicesCreated: 0,
    devicesUpdated: 0,
    devicesUnchanged: 0,
    devicesRemoved: 0,
    status: 'success',
  };

  const [run] = await db
    .insert(unifiSyncRuns)
    .values({
      integrationId: integration.id,
      partnerId: integration.partnerId,
      trigger,
      status: 'running',
    })
    .returning({ id: unifiSyncRuns.id });

  try {
    const mappings = await db
      .select()
      .from(unifiSiteMappings)
      .where(eq(unifiSiteMappings.integrationId, integration.id));

    const hosts = await client.listHosts();
    result.hostsSeen = hosts.length;

    const seenDeviceIds = new Set<string>();
    let anySiteFailed = false;

    for (const mapping of mappings) {
      try {
        const devices = await client.listDevices(mapping.unifiHostId);
        const metrics = await client.getIspMetrics(mapping.unifiSiteId);

        await db
          .update(unifiSiteMappings)
          .set({
            wanMetrics: metrics?.raw ?? null,
            wanMetricsAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(unifiSiteMappings.id, mapping.id));

        for (const d of devices) {
          seenDeviceIds.add(d.unifiDeviceId);
          const discoveredAssetId = await reconcileDiscoveredAsset(db, d, mapping);

          const existing = await db
            .select({ id: unifiDevices.id, raw: unifiDevices.raw })
            .from(unifiDevices)
            .where(
              and(
                eq(unifiDevices.integrationId, integration.id),
                eq(unifiDevices.unifiDeviceId, d.unifiDeviceId),
              ),
            )
            .limit(1);

          const fields = {
            orgId: mapping.orgId,
            siteId: mapping.siteId,
            integrationId: integration.id,
            mappingId: mapping.id,
            discoveredAssetId,
            unifiDeviceId: d.unifiDeviceId,
            mac: d.mac,
            name: d.name,
            model: d.model,
            deviceType: unifiToBreezeDeviceType(d.deviceType),
            ipAddress: d.ip,
            firmwareVersion: d.firmwareVersion,
            firmwareUpdatable: d.firmwareUpdatable,
            adoptionState: d.adoptionState,
            uptimeSeconds: d.uptimeSeconds,
            isStale: false,
            lastSeenAt: new Date(),
            raw: d.raw,
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
          };

          if (existing[0]) {
            const changed = JSON.stringify(existing[0].raw) !== JSON.stringify(d.raw);
            await db
              .update(unifiDevices)
              .set(fields)
              .where(eq(unifiDevices.id, existing[0].id));
            if (changed) {
              result.devicesUpdated++;
            } else {
              result.devicesUnchanged++;
            }
          } else {
            await db.insert(unifiDevices).values(fields);
            result.devicesCreated++;
          }
        }
      } catch (siteErr) {
        anySiteFailed = true;
        result.error = `site ${mapping.unifiSiteId}: ${(siteErr as Error).message}`;
      }
    }

    // Mark devices that disappeared this run as stale and unlink them.
    const allForIntegration = await db
      .select({ id: unifiDevices.id, unifiDeviceId: unifiDevices.unifiDeviceId })
      .from(unifiDevices)
      .where(eq(unifiDevices.integrationId, integration.id));

    for (const row of allForIntegration) {
      if (!seenDeviceIds.has(row.unifiDeviceId)) {
        await db
          .update(unifiDevices)
          .set({ isStale: true, discoveredAssetId: null, updatedAt: new Date() })
          .where(eq(unifiDevices.id, row.id));
        result.devicesRemoved++;
      }
    }

    result.status = anySiteFailed ? 'partial' : 'success';
  } catch (err) {
    result.status = 'failed';
    result.error = (err as Error).message;
  }

  await db
    .update(unifiSyncRuns)
    .set({
      status: result.status,
      finishedAt: new Date(),
      hostsSeen: result.hostsSeen,
      devicesCreated: result.devicesCreated,
      devicesUpdated: result.devicesUpdated,
      devicesUnchanged: result.devicesUnchanged,
      devicesRemoved: result.devicesRemoved,
      error: result.error ?? null,
    })
    .where(eq(unifiSyncRuns.id, run.id));

  return result;
}
