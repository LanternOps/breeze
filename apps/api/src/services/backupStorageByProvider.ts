/**
 * "Storage by Provider" rows for the /backup overview (#2562 item 5).
 *
 * The web panel has always read `storageProviders` off /backup/dashboard, but
 * the route never sent it — so an org with a real destination and real usage
 * saw "No storage providers configured yet". A row exists for every provider
 * the org has a backup config for (usage 0 until the first snapshot), plus any
 * provider that still holds snapshot bytes, so the rows sum to Storage Used.
 *
 * No capacity figure: object stores have no meaningful "total", and inventing
 * one would be worse than showing usage alone.
 *
 * Runs on the ambient request transaction via the RLS-aware `db`; org is
 * filtered explicitly and the snapshot side takes the caller's site-scoped
 * device list, because RLS does not see the site axis.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { backupConfigs, backupSnapshots } from '../db/schema';

export type StorageProviderRow = {
  id: string;
  name: string;
  usedBytes: number;
  snapshots: number;
  configs: number;
};

const PROVIDER_LABELS: Record<string, string> = {
  local: 'Local',
  s3: 'S3',
  azure_blob: 'Azure Blob',
  google_cloud: 'Google Cloud',
  backblaze: 'Backblaze B2',
  unknown: 'Unknown',
};

type ConfigRow = { provider: string; configs: number };
type UsageRow = { provider: string | null; bytes: number | string | null; snapshots: number };

export function buildStorageProviders(configRows: ConfigRow[], usageRows: UsageRow[]): StorageProviderRow[] {
  const byProvider = new Map<string, StorageProviderRow>();
  const rowFor = (provider: string) => {
    let row = byProvider.get(provider);
    if (!row) {
      row = { id: provider, name: PROVIDER_LABELS[provider] ?? provider, usedBytes: 0, snapshots: 0, configs: 0 };
      byProvider.set(provider, row);
    }
    return row;
  };

  for (const { provider, configs } of configRows) {
    rowFor(provider).configs += Number(configs) || 0;
  }
  for (const { provider, bytes, snapshots } of usageRows) {
    const row = rowFor(provider ?? 'unknown');
    // sum() over bigint comes back from the driver as a string.
    row.usedBytes += Number(bytes ?? 0) || 0;
    row.snapshots += Number(snapshots) || 0;
  }

  return [...byProvider.values()].sort((a, b) => b.usedBytes - a.usedBytes || a.name.localeCompare(b.name));
}

/**
 * @param allowedDeviceIds site-scoped device list for a site-restricted caller,
 *   or null for an unrestricted one. An empty list means the caller can see no
 *   devices, so no snapshot usage — but the org's destinations still exist.
 */
export async function getStorageByProvider(
  orgId: string,
  allowedDeviceIds: string[] | null,
): Promise<StorageProviderRow[]> {
  const noVisibleDevices = allowedDeviceIds !== null && allowedDeviceIds.length === 0;
  const snapshotDeviceScope = allowedDeviceIds && allowedDeviceIds.length > 0
    ? inArray(backupSnapshots.deviceId, allowedDeviceIds)
    : undefined;

  const [configRows, usageRows] = await Promise.all([
    db
      .select({ provider: backupConfigs.provider, configs: sql<number>`count(*)::int` })
      .from(backupConfigs)
      .where(eq(backupConfigs.orgId, orgId))
      .groupBy(backupConfigs.provider),
    noVisibleDevices
      ? Promise.resolve([] as UsageRow[])
      : db
          .select({
            provider: backupConfigs.provider,
            bytes: sql<string>`coalesce(sum(${backupSnapshots.size}), 0)::bigint`,
            snapshots: sql<number>`count(*)::int`,
          })
          .from(backupSnapshots)
          .leftJoin(backupConfigs, eq(backupSnapshots.configId, backupConfigs.id))
          .where(and(eq(backupSnapshots.orgId, orgId), snapshotDeviceScope))
          .groupBy(backupConfigs.provider),
  ]);

  return buildStorageProviders(configRows, usageRows);
}
