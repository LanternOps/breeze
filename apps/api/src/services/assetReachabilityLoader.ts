/**
 * Batched assembly of `ReachabilityInput` for a set of discovered assets
 * (spec §4.4). Three queries total, no matter how many assets — the devices
 * list asks for a whole page at once and an N+1 here would be three round trips
 * per row.
 *
 * Runs inside whatever DB context the caller already holds. Every call site is
 * a request route or an AI tool, so that is the request's own
 * `withDbAccessContext` transaction and RLS scopes the reads for us: an asset
 * id the caller cannot see simply returns no row, and its entry is absent from
 * the map. Do NOT add a system-context escalation here.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { discoveredAssets, discoveryJobs, discoveryProfiles, networkMonitors, snmpDevices } from '../db/schema';
import {
  deriveReachability,
  type Reachability,
  type ReachabilityInput,
  type ReachabilityMonitorInput,
  type ReachabilitySnmpInput,
} from './assetReachability';

type ProfileSchedule = { type?: string; intervalMinutes?: number } | null;

/**
 * Only an `interval` schedule states a cadence. A cron schedule would need a
 * parser to answer "how often", and the spec's fallback for an unknown cadence
 * is the 24 h default inside deriveReachability — so null is the honest answer.
 */
function scanIntervalSecondsFrom(schedule: ProfileSchedule): number | null {
  if (!schedule || schedule.type !== 'interval') return null;
  const minutes = schedule.intervalMinutes;
  return typeof minutes === 'number' && minutes > 0 ? minutes * 60 : null;
}

export async function loadReachabilityInputs(assetIds: string[]): Promise<Map<string, ReachabilityInput>> {
  const ids = Array.from(new Set(assetIds.filter(Boolean)));
  const out = new Map<string, ReachabilityInput>();
  if (ids.length === 0) return out;

  const assetRows = await db
    .select({
      id: discoveredAssets.id,
      isOnline: discoveredAssets.isOnline,
      statusObservedAt: discoveredAssets.statusObservedAt,
      statusSource: discoveredAssets.statusSource,
      lastSeenAt: discoveredAssets.lastSeenAt,
      lastProbeAt: discoveredAssets.lastProbeAt,
      lastProbeStatus: discoveredAssets.lastProbeStatus,
      lastProbeResponseMs: discoveredAssets.lastProbeResponseMs,
      profileSchedule: discoveryProfiles.schedule,
    })
    .from(discoveredAssets)
    .leftJoin(discoveryJobs, eq(discoveredAssets.lastJobId, discoveryJobs.id))
    .leftJoin(discoveryProfiles, eq(discoveryJobs.profileId, discoveryProfiles.id))
    .where(inArray(discoveredAssets.id, ids));

  if (assetRows.length === 0) return out;
  const presentIds = assetRows.map((row) => row.id);

  // One SNMP row per asset. Precedence mirrors routes/monitoring.ts:290-306
  // (active first, then newest) so the two surfaces never disagree about which
  // snmp_devices row "is" the device.
  const snmpRows = await db
    .select({
      assetId: snmpDevices.assetId,
      isActive: snmpDevices.isActive,
      lastStatus: snmpDevices.lastStatus,
      lastPolled: snmpDevices.lastPolled,
      lastPollAttemptedAt: snmpDevices.lastPollAttemptedAt,
      pollingInterval: snmpDevices.pollingInterval,
      consecutiveFailures: snmpDevices.consecutiveFailures,
    })
    .from(snmpDevices)
    .where(inArray(snmpDevices.assetId, presentIds))
    .orderBy(snmpDevices.assetId, desc(snmpDevices.isActive), desc(snmpDevices.createdAt));

  const snmpByAsset = new Map<string, ReachabilitySnmpInput>();
  for (const row of snmpRows) {
    if (!row.assetId || snmpByAsset.has(row.assetId)) continue; // first wins, ORDER BY did the ranking
    snmpByAsset.set(row.assetId, {
      isActive: row.isActive,
      lastStatus: row.lastStatus,
      lastPolled: row.lastPolled,
      lastPollAttemptedAt: row.lastPollAttemptedAt,
      pollingInterval: row.pollingInterval,
      consecutiveFailures: row.consecutiveFailures,
    });
  }

  // Host-class monitors only. http_check/dns_check are filtered in SQL rather
  // than in deriveReachability's loop so a 500-asset page does not carry rows
  // the rules will throw away.
  const monitorRows = await db
    .select({
      assetId: networkMonitors.assetId,
      id: networkMonitors.id,
      monitorType: networkMonitors.monitorType,
      isActive: networkMonitors.isActive,
      lastStatus: networkMonitors.lastStatus,
      lastChecked: networkMonitors.lastChecked,
      lastResponseMs: networkMonitors.lastResponseMs,
      pollingInterval: networkMonitors.pollingInterval,
    })
    .from(networkMonitors)
    .where(and(
      inArray(networkMonitors.assetId, presentIds),
      eq(networkMonitors.isActive, true),
      sql`${networkMonitors.monitorType} in ('icmp_ping','tcp_port')`,
    ));

  const monitorsByAsset = new Map<string, ReachabilityMonitorInput[]>();
  for (const row of monitorRows) {
    if (!row.assetId) continue;
    const list = monitorsByAsset.get(row.assetId) ?? [];
    list.push({
      id: row.id,
      monitorType: row.monitorType,
      isActive: row.isActive,
      lastStatus: row.lastStatus,
      lastChecked: row.lastChecked,
      lastResponseMs: row.lastResponseMs,
      pollingInterval: row.pollingInterval,
    });
    monitorsByAsset.set(row.assetId, list);
  }

  for (const row of assetRows) {
    out.set(row.id, {
      asset: {
        isOnline: row.isOnline,
        statusObservedAt: row.statusObservedAt,
        statusSource: row.statusSource,
        lastSeenAt: row.lastSeenAt,
        lastProbeAt: row.lastProbeAt,
        lastProbeStatus: row.lastProbeStatus,
        lastProbeResponseMs: row.lastProbeResponseMs,
      },
      snmpDevice: snmpByAsset.get(row.id) ?? null,
      networkMonitors: monitorsByAsset.get(row.id) ?? [],
      scanIntervalSeconds: scanIntervalSecondsFrom(row.profileSchedule as ProfileSchedule),
    });
  }

  return out;
}

/** Convenience wrapper: load and derive with ONE clock for the whole page. */
export async function loadReachability(assetIds: string[], now: Date = new Date()): Promise<Map<string, Reachability>> {
  const inputs = await loadReachabilityInputs(assetIds);
  const out = new Map<string, Reachability>();
  for (const [assetId, input] of inputs) out.set(assetId, deriveReachability(input, now));
  return out;
}
