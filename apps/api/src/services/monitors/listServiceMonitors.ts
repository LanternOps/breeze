import { and, asc, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { devices, monitorDefinitions } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { deviceScopeCondition, deviceSiteDenied, siteScopeCondition } from '../aiToolsSiteScope';
import { resolveMonitorsForDevice, type EffectiveMonitor } from './monitorResolver';

/**
 * Upper bound on devices resolved per call. Resolution is per device (several
 * indexed queries each), so an unbounded partner-wide listing would issue tens
 * of thousands of queries from one AI tool call. The result says when it was cut.
 */
export const SERVICE_MONITOR_LIST_DEVICE_CAP = 250;

export interface EffectiveServiceMonitorRow {
  deviceId: string;
  monitorId: string;
  name: string;
  kind: 'service' | 'process';
  sourcePolicyId: string;
  enabled: boolean;
  condition: Record<string, unknown>;
}

/**
 * Effective service/process monitors per accessible device, as the monitor
 * resolver decides them (W05c2 Task 14). `configPolicyId` filters on the
 * WINNING source policy, so a policy whose attachment lost to a closer one is
 * not reported for that device. Unassigned definitions never appear; a disabled
 * winning attachment is reported with `enabled: false`; per-device overrides
 * are merged over the definition's condition.
 */
export async function listEffectiveServiceMonitors(
  auth: AuthContext,
  configPolicyId?: string,
): Promise<{ monitors: EffectiveServiceMonitorRow[]; truncated: boolean }> {
  const candidates = await db
    .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(and(
      auth.orgCondition(devices.orgId),
      siteScopeCondition(auth, devices.siteId),
      deviceScopeCondition(auth, devices.id),
    ))
    .orderBy(asc(devices.id))
    .limit(SERVICE_MONITOR_LIST_DEVICE_CAP + 1);
  const truncated = candidates.length > SERVICE_MONITOR_LIST_DEVICE_CAP;

  const effectiveByDevice: Array<{ deviceId: string; monitors: EffectiveMonitor[] }> = [];
  for (const device of candidates.slice(0, SERVICE_MONITOR_LIST_DEVICE_CAP)) {
    // App-layer re-check on top of the SQL narrowing (and RLS): never resolve a
    // device the caller cannot reach.
    if (!auth.canAccessOrg(device.orgId) || deviceSiteDenied(auth, device.siteId, device.id)) continue;
    const resolution = await resolveMonitorsForDevice(device.id);
    if (resolution.kind === 'device_missing') {
      throw new Error('Device disappeared while resolving monitors; retry the list.');
    }
    const monitors = resolution.monitors.filter((m) => !configPolicyId || m.sourcePolicyId === configPolicyId);
    if (monitors.length) effectiveByDevice.push({ deviceId: device.id, monitors });
  }

  const monitorIds = [...new Set(effectiveByDevice.flatMap((d) => d.monitors.map((m) => m.monitorId)))];
  if (!monitorIds.length) return { monitors: [], truncated };

  const definitions = await db.select().from(monitorDefinitions).where(and(
    inArray(monitorDefinitions.id, monitorIds),
    inArray(monitorDefinitions.kind, ['service', 'process']),
  ));
  const byId = new Map(definitions.map((d) => [d.id, d]));

  const rows: EffectiveServiceMonitorRow[] = [];
  for (const { deviceId, monitors } of effectiveByDevice) {
    for (const effective of monitors) {
      const definition = byId.get(effective.monitorId);
      if (!definition || (definition.kind !== 'service' && definition.kind !== 'process')) continue;
      rows.push({
        deviceId,
        monitorId: definition.id,
        name: definition.name,
        kind: definition.kind,
        sourcePolicyId: effective.sourcePolicyId,
        enabled: definition.enabled && effective.enabled,
        condition: { ...(definition.condition as Record<string, unknown>), ...(effective.overrides ?? {}) },
      });
    }
  }
  return { monitors: rows, truncated };
}
