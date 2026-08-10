import { and, eq, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { unifiSiteMappings, unifiDevices, unifiSyncRuns, discoveredAssets } from '../../db/schema';
import { buildClassificationWrite, type ClassificationWrite } from '../discoveredAssetClassification';
import type { DbExecutor } from './unifiConnectionService';
import type { UnifiClient, UnifiDeviceDto, UnifiIspMetrics } from './unifiClient';

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

// Column-checked write set. `DbExecutor` is deliberately loosely typed, and
// drizzle silently DROPS set keys that don't name a column — so a typo in a
// bare object literal would compile, pass the mocked tests, and no-op at
// runtime. Naming the type restores that check.
//
// The check only holds for keys assigned DIRECTLY (`set.foo = …`) or written as
// a literal. `Object.assign(set, obj)` is typed `(target: T, source: U) => T & U`
// and does NOT constrain U's keys to T's, so spreading a helper's return through
// it compiles even when a key names no column — which is why the classification
// columns below are assigned one at a time rather than merged.
type AssetWriteSet = PgUpdateSetSource<typeof discoveredAssets>;

// Apply the guarded classification columns to a write set, one property at a
// time so each is checked against AssetWriteSet's real column keys.
function applyClassification(target: AssetWriteSet, write: ClassificationWrite): void {
  target.assetType = write.assetType;
  target.detectedAssetType = write.detectedAssetType;
  target.detectedTypeSource = write.detectedTypeSource;
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

  // `assetType()` only recognises UniFi *network* gear (switch / AP / gateway /
  // firewall). For anything else — Protect cameras, doorbells — it returns
  // 'unknown', which means "this sync has no opinion", not "the device really is
  // of unknown type". Writing that back would erase a better classification made
  // by another source, so leave both type columns alone unless we recognised it.
  const classified = aType === 'unknown' ? null : aType;

  // Precedence is enforced in SQL, not JS, on BOTH write paths — see
  // buildClassificationWrite. A type a user set by hand outranks every
  // classifier (#3011), and among classifiers the controller is authoritative:
  // it knows the exact model, so it outranks the agent scan's OUI vendor guess
  // that used to rewrite UniFi switches to access_point (#3187).

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

  // asset_type is deliberately NOT in here — it is applied per-branch below so a
  // manual override survives the sync (#3011).
  const enrich = {
    macAddress: device.mac ?? undefined,
    hostname: device.name ?? undefined,
    manufacturer: 'Ubiquiti',
    model: device.model ?? undefined,
    isOnline: device.adoptionState === 'CONNECTED',
    lastSeenAt: new Date(),
  };

  if (existing) {
    const updateSet: AssetWriteSet = { ...enrich };
    if (classified) {
      applyClassification(updateSet, buildClassificationWrite('unifi_controller', {
        assetType: sql`${classified}`,
        detectedAssetType: sql`${classified}`,
      }));
    }
    await db
      .update(discoveredAssets)
      .set(updateSet)
      .where(eq(discoveredAssets.id, existing.id));
    return existing.id;
  }

  // Net-new: insert, absorbing a race with agent discovery via the (org,ip) unique key.
  const conflictSet: AssetWriteSet = { ...enrich };
  if (classified) {
    applyClassification(conflictSet, buildClassificationWrite('unifi_controller', {
      assetType: sql.raw(`excluded.${discoveredAssets.assetType.name}`),
      detectedAssetType: sql.raw(`excluded.${discoveredAssets.detectedAssetType.name}`),
    }));
  }

  const inserted = await db
    .insert(discoveredAssets)
    .values({
      orgId: mapping.orgId,
      siteId: mapping.siteId,
      ipAddress: device.ip,
      ...enrich,
      // typeSource is set only on the INSERT side; the conflict branch must
      // never reset an existing row's type_source back to 'auto'.
      typeSource: 'auto',
      ...(classified
        ? {
            assetType: classified,
            detectedAssetType: classified,
            detectedTypeSource: 'unifi_controller' as const,
          }
        : {}),
    })
    .onConflictDoUpdate({
      target: [discoveredAssets.orgId, discoveredAssets.ipAddress],
      set: conflictSet,
    })
    .returning({ id: discoveredAssets.id });
  return inserted[0]?.id ?? null;
}

// Per-mapping result of the network-only collection phase.
interface MappingFetch {
  mappingId: string;
  devices?: UnifiDeviceDto[];
  metrics?: UnifiIspMetrics | null;
  error?: string;
}
export interface CollectedSync {
  hostsSeen: number;
  fatalError?: string; // listHosts failed → the whole sync is a failure
  byMapping: Map<string, MappingFetch>;
}

// Phase 1 — network only, NO database access. Pulled out of the DB context so the
// worker doesn't pin a pooled connection idle-in-transaction across UniFi HTTP
// (which can sleep up to ~30s on a 429). See unifiWorker.processSyncIntegration.
export async function collectSyncData(
  client: UnifiClient,
  mappings: Array<{ id: string; unifiHostId: string; unifiSiteId: string }>,
): Promise<CollectedSync> {
  const byMapping = new Map<string, MappingFetch>();
  let hosts: Awaited<ReturnType<UnifiClient['listHosts']>>;
  try {
    hosts = await client.listHosts();
  } catch (err) {
    return { hostsSeen: 0, fatalError: (err as Error).message, byMapping };
  }
  for (const m of mappings) {
    try {
      const devices = await client.listDevices(m.unifiHostId);
      const metrics = await client.getIspMetrics(m.unifiSiteId);
      byMapping.set(m.id, { mappingId: m.id, devices, metrics });
    } catch (err) {
      byMapping.set(m.id, { mappingId: m.id, error: `site ${m.unifiSiteId}: ${(err as Error).message}` });
    }
  }
  return { hostsSeen: hosts.length, byMapping };
}

// Phase 2 — database only. Persists the run ledger, reconciles devices/assets,
// and stale-sweeps. Takes the already-collected network data so it can run inside
// a short-lived DB context.
export async function applySyncData(
  db: DbExecutor,
  integration: { id: string; partnerId: string },
  trigger: 'scheduled' | 'manual',
  mappings: any[],
  collected: CollectedSync,
): Promise<SyncRunResult> {
  const result: SyncRunResult = {
    hostsSeen: collected.hostsSeen,
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

  if (!run) throw new Error('Failed to create unifi_sync_runs ledger entry');

  if (collected.fatalError) {
    result.status = 'failed';
    result.error = collected.fatalError;
  } else {
    try {
      const seenDeviceIds = new Set<string>();
      const failedMappingIds = new Set<string>();
      let anySiteFailed = false;

      for (const mapping of mappings) {
        const fetched = collected.byMapping.get(mapping.id);
        if (!fetched || fetched.error) {
          // Network fetch failed for this site — record and skip its writes so a
          // transient per-site error doesn't stale still-online devices.
          failedMappingIds.add(mapping.id);
          anySiteFailed = true;
          if (fetched?.error) result.error = fetched.error;
          continue;
        }

        try {
          await db
            .update(unifiSiteMappings)
            .set({
              wanMetrics: fetched.metrics?.raw ?? null,
              wanMetricsAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(unifiSiteMappings.id, mapping.id));

          for (const d of fetched.devices ?? []) {
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
          failedMappingIds.add(mapping.id);
          anySiteFailed = true;
          result.error = `site ${mapping.unifiSiteId}: ${(siteErr as Error).message}`;
        }
      }

      // Mark devices that disappeared this run as stale and unlink them.
      // Only stale devices whose mapping succeeded this run — a transient per-site
      // error must not unlink still-online devices on that site.
      const allForIntegration = await db
        .select({
          id: unifiDevices.id,
          unifiDeviceId: unifiDevices.unifiDeviceId,
          mappingId: unifiDevices.mappingId,
        })
        .from(unifiDevices)
        .where(eq(unifiDevices.integrationId, integration.id));

      for (const row of allForIntegration) {
        if (!seenDeviceIds.has(row.unifiDeviceId) && !failedMappingIds.has(row.mappingId)) {
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

// Convenience wrapper that runs both phases against a single db/client. Used by
// unit tests; the worker calls collectSyncData / applySyncData separately so the
// network phase runs OUTSIDE the DB context.
export async function syncIntegration(
  deps: { db: DbExecutor; client: UnifiClient },
  integration: { id: string; partnerId: string },
  trigger: 'scheduled' | 'manual',
): Promise<SyncRunResult> {
  const { db, client } = deps;
  const mappings = await db
    .select()
    .from(unifiSiteMappings)
    .where(eq(unifiSiteMappings.integrationId, integration.id));
  const collected = await collectSyncData(client, mappings);
  return applySyncData(db, integration, trigger, mappings, collected);
}
