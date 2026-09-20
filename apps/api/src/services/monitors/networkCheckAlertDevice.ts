import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices, discoveredAssets } from '../../db/schema';

/**
 * THE device a network check's alert attaches to, for one running org (#6353).
 *
 * Lifted from `jobs/monitorWorker.ts` so the legacy network worker and the
 * `network_check` monitor path agree on the same device: a check is one probe
 * per org, so it raises ONE alert per org — on the asset's linked device when
 * it has one, else the most recently seen non-ephemeral device in the asset's
 * site, else in the org. Offline devices are eligible on purpose: the probe
 * runs from some other agent, so the alert device's own status says nothing
 * about the check.
 *
 * `orgId` is the RUNNING org (the device's), never the definition owner, which
 * is NULL for a partner-wide check.
 */
export async function resolveNetworkCheckAlertDevice(check: {
  orgId: string;
  assetId: string | null;
}): Promise<string | null> {
  let preferredSiteId: string | null = null;

  if (check.assetId) {
    const [asset] = await db
      .select({
        linkedDeviceId: discoveredAssets.linkedDeviceId,
        siteId: discoveredAssets.siteId,
      })
      .from(discoveredAssets)
      .where(and(eq(discoveredAssets.id, check.assetId), eq(discoveredAssets.orgId, check.orgId)))
      .limit(1);

    if (asset?.linkedDeviceId) {
      return asset.linkedDeviceId;
    }

    preferredSiteId = asset?.siteId ?? null;
  }

  if (preferredSiteId) {
    const [siteDevice] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(
        eq(devices.orgId, check.orgId),
        eq(devices.isEphemeral, false),
        eq(devices.siteId, preferredSiteId),
      ))
      .orderBy(desc(devices.lastSeenAt), desc(devices.enrolledAt))
      .limit(1);

    if (siteDevice?.id) {
      return siteDevice.id;
    }
  }

  const [orgDevice] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.orgId, check.orgId), eq(devices.isEphemeral, false)))
    .orderBy(desc(devices.lastSeenAt), desc(devices.enrolledAt))
    .limit(1);

  return orgDevice?.id ?? null;
}
