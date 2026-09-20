import { and, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { monitorDeviceState, networkMonitors, organizations } from '../../db/schema';
import { evaluateNetworkCheckAlertsForDevice } from '../alertService';
import { detachMonitorFromDevice } from './episodeService';
import { resolveNetworkCheckAlertDevice } from './networkCheckAlertDevice';
import { captureException } from '../sentry';

/**
 * #6353 — the device-independent `network_check` alert sweep.
 *
 * A `network_check` monitor compiles to ONE managed `network_monitors` row that
 * `monitorWorker` probes once per running org and writes back to
 * `network_monitor_results`. Its verdict is therefore the ORG's, not any
 * device's, and the per-device alert sweep (`jobs/alertWorker.ts`
 * `evaluate-device`) is the wrong shape for it twice over: it visits every
 * ONLINE device the policy reaches (N alerts for N devices), and it never
 * visits an offline one (no alert at all when the check's alert device is
 * down).
 *
 * This sweep runs once per org per `evaluate-all` tick instead:
 *   1. every active managed check that runs for the org — its own rows plus
 *      its partner's partner-wide rows (`org_id NULL`), fanned out by the
 *      DEVICE org's partner exactly as `monitorWorker.selectDueMonitorJobs`
 *      fans the probe itself;
 *   2. ONE alert device per check, chosen by the legacy network worker's rule
 *      (`resolveNetworkCheckAlertDevice`; offline devices eligible);
 *   3. one `evaluateNetworkCheckAlertsForDevice` pass per distinct alert
 *      device, which runs the ordinary monitor pipeline (resolution through
 *      the device's configuration policies, episode seam, cooldown, dedupe)
 *      for just those checks;
 *   4. any open episode a check still holds on a device that is no longer its
 *      alert device is closed as `monitor_detached`, so the alert device can
 *      move (a newer device enrolls) without a stranded episode.
 *
 * Runs under the same system DB context the alert worker already uses for
 * `evaluate-device`; nothing here escalates further.
 */

/**
 * The orgs that have at least one active managed network check running for
 * them: each org-owned check's own org, plus every org under the partner of a
 * partner-wide check. Only active, non-quick-support orgs — the same set the
 * per-device sweep visits. Pure read; the caller owns the DB context.
 */
export async function selectNetworkCheckOrgIds(): Promise<string[]> {
  const managed = await db
    .select({ orgId: networkMonitors.orgId, partnerId: networkMonitors.partnerId })
    .from(networkMonitors)
    .where(and(isNotNull(networkMonitors.managedByMonitorId), eq(networkMonitors.isActive, true)));

  if (managed.length === 0) return [];

  const ownOrgIds = [...new Set(managed.map((m) => m.orgId).filter((id): id is string => !!id))];
  const partnerIds = [...new Set(
    managed.filter((m) => m.orgId === null && m.partnerId).map((m) => m.partnerId as string),
  )];

  const membership = [];
  if (ownOrgIds.length > 0) membership.push(inArray(organizations.id, ownOrgIds));
  if (partnerIds.length > 0) membership.push(inArray(organizations.partnerId, partnerIds));
  if (membership.length === 0) return [];

  const orgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(
      or(...membership),
      eq(organizations.status, 'active'),
      ne(organizations.type, 'quick_support'),
    ));

  return orgs.map((o) => o.id);
}

export interface NetworkCheckOrgSweepResult {
  orgId: string;
  /** Managed checks that run for this org. */
  checks: number;
  /** Distinct alert devices evaluated. */
  devicesEvaluated: number;
  /** Checks with no eligible alert device in the org (nothing to attach an alert to). */
  checksWithoutDevice: number;
  /** Stale open episodes closed because the alert device moved. */
  staleEpisodesDetached: number;
  alertIds: string[];
}

/**
 * Evaluate every managed network check that runs for `orgId`, once each, on
 * its alert device. Must be called inside the alert worker's system DB
 * context (`jobs/alertWorker.ts` wraps the job the same way as
 * `evaluate-device`).
 */
export async function evaluateNetworkCheckAlertsForOrg(orgId: string): Promise<NetworkCheckOrgSweepResult> {
  const result: NetworkCheckOrgSweepResult = {
    orgId,
    checks: 0,
    devicesEvaluated: 0,
    checksWithoutDevice: 0,
    staleEpisodesDetached: 0,
    alertIds: [],
  };

  const [org] = await db
    .select({ id: organizations.id, partnerId: organizations.partnerId, status: organizations.status, type: organizations.type })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  // A miss is a deny, and an org that stopped qualifying between enqueue and
  // run (deactivated, or a quick-support org) is skipped like the per-device
  // sweep skips it.
  if (!org || org.status !== 'active' || org.type === 'quick_support') return result;

  // Own checks OR the partner's partner-wide checks — never `eq(orgId)` alone,
  // which silently matches nothing for an `org_id NULL` definition.
  const ownership = org.partnerId
    ? sql`(${networkMonitors.orgId} = ${orgId} OR (${networkMonitors.orgId} IS NULL AND ${networkMonitors.partnerId} = ${org.partnerId}))`
    : eq(networkMonitors.orgId, orgId);

  const checks = await db
    .select({
      id: networkMonitors.id,
      assetId: networkMonitors.assetId,
      monitorId: networkMonitors.managedByMonitorId,
    })
    .from(networkMonitors)
    .where(and(
      isNotNull(networkMonitors.managedByMonitorId),
      eq(networkMonitors.isActive, true),
      ownership,
    ));

  result.checks = checks.length;
  if (checks.length === 0) return result;

  // ONE alert device per check. Group by device so an org whose checks all
  // land on the same device (the common case: no asset binding) costs one
  // resolution pass, not one per check.
  const alertDeviceByMonitor = new Map<string, string>();
  const monitorsByDevice = new Map<string, Set<string>>();
  for (const check of checks) {
    const monitorId = check.monitorId as string;
    const deviceId = await resolveNetworkCheckAlertDevice({ orgId, assetId: check.assetId });
    if (!deviceId) {
      result.checksWithoutDevice++;
      continue;
    }
    alertDeviceByMonitor.set(monitorId, deviceId);
    const set = monitorsByDevice.get(deviceId) ?? new Set<string>();
    set.add(monitorId);
    monitorsByDevice.set(deviceId, set);
  }

  for (const [deviceId, monitorIds] of monitorsByDevice) {
    try {
      const created = await evaluateNetworkCheckAlertsForDevice(deviceId, monitorIds);
      result.devicesEvaluated++;
      result.alertIds.push(...created);
    } catch (error) {
      // One device's failure must not cost the org's other checks their alert.
      console.error(`[NetworkCheckSweep] Error evaluating network checks for device ${deviceId} (org ${orgId}):`, error);
      captureException(error, undefined, {
        area: 'monitors',
        issue: 'network_check_sweep_device_failed',
        orgId,
        deviceId,
      });
    }
  }

  // The alert device can move (a newer device enrolls, an asset gets linked).
  // Close the episode the check still holds on the OLD device, or it stays
  // open forever: the per-device sweep deliberately never detaches
  // network_check episodes (it does not evaluate them), and the old device is
  // never evaluated by this sweep again.
  const monitorIds = [...alertDeviceByMonitor.keys()];
  if (monitorIds.length > 0) {
    try {
      const open = await db
        .select({ monitorId: monitorDeviceState.monitorId, deviceId: monitorDeviceState.deviceId })
        .from(monitorDeviceState)
        .where(and(
          eq(monitorDeviceState.orgId, orgId),
          inArray(monitorDeviceState.monitorId, monitorIds),
          isNotNull(monitorDeviceState.currentEpisodeId),
        ));
      for (const row of open) {
        if (alertDeviceByMonitor.get(row.monitorId) === row.deviceId) continue;
        await detachMonitorFromDevice(row.monitorId, row.deviceId);
        result.staleEpisodesDetached++;
      }
    } catch (error) {
      console.error(`[NetworkCheckSweep] Failed to detach stale network check episodes for org ${orgId}:`, error);
      captureException(error, undefined, {
        area: 'monitors',
        issue: 'network_check_sweep_detach_failed',
        orgId,
      });
    }
  }

  return result;
}
