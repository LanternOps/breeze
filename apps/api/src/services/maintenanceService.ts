import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices, deviceGroupMemberships, maintenanceWindows, organizations } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import {
  resolveMaintenanceConfigForDevice,
  isInMaintenanceWindow,
} from './featureConfigResolver';

// ============================================
// Types
// ============================================

export interface DeviceMaintenanceStatus {
  active: boolean;
  source: 'config_policy' | 'standalone' | 'none';
  suppressAlerts: boolean;
  suppressPatching: boolean;
  suppressAutomations: boolean;
  suppressScripts: boolean;
}

// ============================================
// Unified Maintenance Check
// ============================================

/**
 * Determines whether a device is currently in a maintenance window.
 *
 * Resolution order:
 *   1. Configuration Policy maintenance settings (hierarchy-resolved)
 *   2. Standalone maintenance windows (legacy `maintenance_windows` table)
 *
 * The first source that yields an active window wins.
 *
 * Runs its reads in a SHORT system-context block: callers include org-scoped
 * request paths (GET /maintenance/device/:deviceId/status), whose RLS context
 * cannot see partner-wide windows/config policies (org_id NULL, #2131) — the
 * answer would silently be wrong for them. The lookup is anchored to a
 * deviceId the ROUTE has already authorized, so there is no tenant pivot;
 * same pattern as the agent heartbeat probe config and commands.ts.
 */
export async function isDeviceInMaintenance(
  deviceId: string
): Promise<DeviceMaintenanceStatus> {
  const inactive: DeviceMaintenanceStatus = {
    active: false,
    source: 'none',
    suppressAlerts: false,
    suppressPatching: false,
    suppressAutomations: false,
    suppressScripts: false,
  };

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      // ---- 1. Try config policy path ----
      const cpSettings = await resolveMaintenanceConfigForDevice(deviceId);
      if (cpSettings) {
        const status = isInMaintenanceWindow(cpSettings);
        if (status.active) {
          return {
            active: true,
            source: 'config_policy' as const,
            suppressAlerts: status.suppressAlerts,
            suppressPatching: status.suppressPatching,
            suppressAutomations: status.suppressAutomations,
            suppressScripts: status.suppressScripts,
          };
        }
        // Config policy exists but window is not currently active — still fall
        // through to check standalone windows for backward compatibility.
      }

      // ---- 2. Fall back to standalone maintenance windows ----
      const standaloneStatus = await checkStandaloneMaintenanceWindows(deviceId);
      if (standaloneStatus) {
        return standaloneStatus;
      }

      return inactive;
    })
  );
}

// ============================================
// Standalone Maintenance Window Check
// ============================================

/**
 * Checks the legacy `maintenance_windows` table to see if the device is
 * currently covered by an active or scheduled-and-in-range window.
 *
 * Returns a DeviceMaintenanceStatus if an active window is found, or null.
 */
async function checkStandaloneMaintenanceWindows(
  deviceId: string
): Promise<DeviceMaintenanceStatus | null> {
  // Bound as an ISO string: raw sql`` params skip Drizzle's column-type
  // mapping, and postgres.js cannot serialize a bare Date instance there.
  const now = new Date().toISOString();

  // Load device org/site
  const [device] = await db
    .select({
      orgId: devices.orgId,
      siteId: devices.siteId,
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return null;
  }

  // Load device group memberships
  const deviceGroupIds = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));

  const groupIds = deviceGroupIds.map((g) => g.groupId);

  // Ownership is dual-axis (#2131): the device's own org's windows OR
  // partner-wide windows (org_id NULL) owned by the device org's partner.
  // The partner id is resolved in a separate query and bound as a plain
  // value — a parameterized scalar subquery trips the postgres.js
  // ParameterDescription bug (same class as the nested-EXISTS RLS issue).
  const [orgRow] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, device.orgId))
    .limit(1);
  const ownershipPredicate = orgRow?.partnerId
    ? sql`(${maintenanceWindows.orgId} = ${device.orgId} OR (${maintenanceWindows.orgId} IS NULL AND ${maintenanceWindows.partnerId} = ${orgRow.partnerId}))`
    : sql`${maintenanceWindows.orgId} = ${device.orgId}`;

  // Query for active standalone windows matching this device
  const activeWindows = await db
    .select({
      id: maintenanceWindows.id,
      suppressAlerts: maintenanceWindows.suppressAlerts,
      suppressPatching: maintenanceWindows.suppressPatching,
      suppressAutomations: maintenanceWindows.suppressAutomations,
      suppressScripts: maintenanceWindows.suppressScripts,
      targetType: maintenanceWindows.targetType,
    })
    .from(maintenanceWindows)
    .where(
      sql`${ownershipPredicate}
        AND ${maintenanceWindows.status} IN ('scheduled', 'active')
        AND ${maintenanceWindows.startTime} <= ${now}
        AND ${maintenanceWindows.endTime} >= ${now}
        AND (
          ${maintenanceWindows.targetType} = 'all'
          OR ${maintenanceWindows.deviceIds} && ARRAY[${deviceId}]::uuid[]
          OR ${maintenanceWindows.siteIds} && ARRAY[${device.siteId}]::uuid[]
          OR ${maintenanceWindows.groupIds} && ${
        groupIds.length > 0
          ? sql`ARRAY[${sql.join(
              groupIds.map((id) => sql`${id}`),
              sql`, `
            )}]::uuid[]`
          : sql`'{}'::uuid[]`
      }
        )`
    )
    .limit(1);

  if (activeWindows.length === 0) {
    return null;
  }

  const win = activeWindows[0]!;
  return {
    active: true,
    source: 'standalone',
    suppressAlerts: win.suppressAlerts,
    suppressPatching: win.suppressPatching,
    suppressAutomations: win.suppressAutomations,
    suppressScripts: win.suppressScripts,
  };
}
