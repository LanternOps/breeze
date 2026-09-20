import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices, discoveredAssets } from '../../db/schema';
import { resolveMonitorsForDevice } from './monitorResolver';

/**
 * How many of an org's devices (most recently seen first) the monitor-aware
 * fallback below will test against the policy resolver before giving up. Only
 * paid when the legacy pick is outside the monitor's attachment scope.
 */
export const NETWORK_CHECK_ALERT_DEVICE_FALLBACK_SCAN = 100;

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

/**
 * Whether `monitorId` is attached — through some configuration policy — and
 * enabled for `deviceId`. `device_missing` and a disabled winner are both "no".
 */
async function monitorResolvesForDevice(monitorId: string, deviceId: string): Promise<boolean> {
  const resolution = await resolveMonitorsForDevice(deviceId);
  if (resolution.kind !== 'resolved') return false;
  return resolution.monitors.some((m) => m.monitorId === monitorId && m.enabled);
}

/**
 * The alert device for a MONITOR-managed network check (#6353): the legacy
 * pick above, unless the monitor's configuration-policy attachment does not
 * reach that device — then the most recently seen non-ephemeral device in
 * the org that the monitor DOES resolve for.
 *
 * Why the extra step: the legacy rule predates policies and only knows the
 * org, the asset and recency. A `network_check` attached at site, device-group
 * or device level reaches a subset of the org, and `getApplicableRules` only
 * evaluates a monitor rule for a device the resolver says it is enabled for.
 * Without this, an org-wide recency pick outside that subset would evaluate
 * nothing — the same silent no-alert the issue was filed for. Both the sweep
 * (which chooses where to evaluate) and the handler gate (which refuses every
 * other device) call THIS function, so they cannot disagree by construction.
 *
 * Cost: one policy resolution for the legacy pick (the common, org-level case
 * stops there); the fallback scan runs one resolution per candidate device,
 * most recent first, bounded by NETWORK_CHECK_ALERT_DEVICE_FALLBACK_SCAN.
 */
export async function resolveNetworkCheckAlertDeviceForMonitor(check: {
  orgId: string;
  assetId: string | null;
  monitorId: string;
}): Promise<string | null> {
  const legacyPick = await resolveNetworkCheckAlertDevice({ orgId: check.orgId, assetId: check.assetId });
  if (!legacyPick) return null;
  if (await monitorResolvesForDevice(check.monitorId, legacyPick)) return legacyPick;

  const candidates = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.orgId, check.orgId), eq(devices.isEphemeral, false)))
    .orderBy(desc(devices.lastSeenAt), desc(devices.enrolledAt))
    .limit(NETWORK_CHECK_ALERT_DEVICE_FALLBACK_SCAN);

  for (const candidate of candidates) {
    if (candidate.id === legacyPick) continue;
    if (await monitorResolvesForDevice(check.monitorId, candidate.id)) return candidate.id;
  }
  return null;
}
