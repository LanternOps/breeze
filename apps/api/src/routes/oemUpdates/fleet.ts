import { Hono } from 'hono';
import { and, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { OEM_LANES, type OemLane } from '@breeze/shared';
import { db } from '../../db';
import {
  deviceGroupMemberships,
  deviceHardware,
  deviceOemUpdateStatus,
  devices,
  organizations,
  partners,
  sites,
} from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { effectiveTimezoneFrom } from '../../services/oemUpdates/candidates';
import { OEM_DISPLAY_STATES, type OemDisplayState } from '../../services/oemUpdates/displayState';
import { oemUpdatesFlagOn } from '../../services/oemUpdates/flags';
import { classifyOemDevice, oemOccurrenceMemo, oemOfferedLane, type OemDeviceFacts } from '../../services/oemUpdates/policySide';
import { OEM_RELEASE_GAVE_UP } from '../../services/oemUpdates/releaseSweep';
import { loadOemLinkCandidates, pickOemLink, type OemLinkCandidate } from '../../services/oemUpdates/resolver';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { notParkedDeviceCondition } from '../../services/unassignedPool/selectorPredicate';

export const oemUpdatesFleetRoutes = new Hono();

oemUpdatesFleetRoutes.use('*', authMiddleware);

const fleetQuerySchema = z.object({
  state: z.enum(OEM_DISPLAY_STATES).optional(),
  orgId: z.string().uuid().optional(),
  lane: z.enum(OEM_LANES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

type FleetRow = OemDeviceFacts & {
  hostname: string;
  orgId: string;
  orgName: string;
  siteId: string;
  siteName: string | null;
  deviceStatus: string;
  siteTimezone: string | null;
  orgTimezone: string | null;
  partnerTimezone: string | null;
  partnerSettingsTimezone: string | null;
  groupIds?: string[] | null;
  reason: string | null;
  lastAttemptAt: Date | null;
};

/**
 * One row per device with everything a state needs, so the pass below never goes
 * back to the database. The org and partner zones are read out of their settings
 * rather than carrying a whole settings blob per device. Memberships are inline, off
 * the membership primary key, and only when a group assignment could use them.
 */
function loadFleetRows(where: SQL | undefined, withGroups: boolean): Promise<FleetRow[]> {
  return db
    .select({
      deviceId: devices.id,
      hostname: devices.hostname,
      orgId: devices.orgId,
      orgName: organizations.name,
      partnerId: organizations.partnerId,
      siteId: devices.siteId,
      siteName: sites.name,
      deviceStatus: devices.status,
      osType: devices.osType,
      isVirtual: devices.isVirtual,
      deviceRole: devices.deviceRole,
      enrolledAt: devices.enrolledAt,
      manufacturer: deviceHardware.manufacturer,
      model: deviceHardware.model,
      siteTimezone: sites.timezone,
      orgTimezone: sql<string | null>`${organizations.settings} ->> 'timezone'`,
      partnerTimezone: partners.timezone,
      partnerSettingsTimezone: sql<string | null>`${partners.settings} ->> 'timezone'`,
      ...(withGroups
        ? {
            groupIds: sql<string[] | null>`(
              SELECT json_agg(${deviceGroupMemberships.groupId}) FROM ${deviceGroupMemberships}
              WHERE ${deviceGroupMemberships.deviceId} = ${devices.id}
            )`,
          }
        : {}),
      statusLane: deviceOemUpdateStatus.lane,
      applicability: deviceOemUpdateStatus.applicability,
      reason: deviceOemUpdateStatus.reason,
      lastOutcome: deviceOemUpdateStatus.lastOutcome,
      occurrenceKey: deviceOemUpdateStatus.occurrenceKey,
      attempts: deviceOemUpdateStatus.attempts,
      lastAttemptAt: deviceOemUpdateStatus.lastAttemptAt,
      lastSuccessAt: deviceOemUpdateStatus.lastSuccessAt,
      rebootPendingSince: deviceOemUpdateStatus.rebootPendingSince,
    })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(partners, eq(partners.id, organizations.partnerId))
    .leftJoin(sites, eq(sites.id, devices.siteId))
    .leftJoin(deviceHardware, eq(deviceHardware.deviceId, devices.id))
    .leftJoin(deviceOemUpdateStatus, eq(deviceOemUpdateStatus.deviceId, devices.id))
    .where(where)
    .orderBy(sql`lower(${devices.hostname})`, devices.id) as Promise<FleetRow[]>;
}

type Classified = { row: FleetRow; lane: OemLane | null; state: OemDisplayState };

/** One pass over the rows, in memory, with the rules the device section uses. */
function classify(rows: FleetRow[], candidates: OemLinkCandidate[], now: Date): Classified[] {
  const zones = new Map<string, string>();
  const occurrenceOf = oemOccurrenceMemo(now);

  return rows.map((row) => {
    const offered = oemOfferedLane(row);
    const link = offered && candidates.length > 0
      ? pickOemLink(
          candidates,
          { id: row.deviceId, orgId: row.orgId, siteId: row.siteId, deviceRole: row.deviceRole, osType: row.osType },
          row.partnerId,
          row.groupIds ?? [],
        )
      : null;

    const zoneKey = `${row.siteTimezone}|${row.orgTimezone}|${row.partnerTimezone}|${row.partnerSettingsTimezone}`;
    let timezone = zones.get(zoneKey);
    if (!timezone) {
      timezone = effectiveTimezoneFrom({
        siteTimezone: row.siteTimezone,
        orgSettings: { timezone: row.orgTimezone },
        partnerTimezone: row.partnerTimezone,
        partnerSettings: { timezone: row.partnerSettingsTimezone },
      });
      zones.set(zoneKey, timezone);
    }

    const { state } = classifyOemDevice({ facts: row, lane: offered, link, timezone, now, occurrenceOf });
    // A past run's lane still says something once the hardware no longer offers one:
    // a device owing a reboot with the flag since turned off, say.
    return { row, lane: offered ?? row.statusLane, state };
  });
}

/**
 * GET /oem-updates/fleet — the Vendor updates tab (#11074, spec 4.8).
 *
 * `counts` covers the org and lane filters and not `state`, so the tab can show every
 * state while its list shows one. `total` is the list's length before paging.
 *
 * A state is derived, not stored: it depends on the policy's schedule in the device's
 * zone, and that rule must stay the one `deriveOemDisplayState` holds. So a request
 * reads the caller's whole scope once and classifies it in one pass: at most two
 * queries whatever the size of the fleet (the links, then the devices, whose plan
 * starts from the org scope), and one with the flag off. A system caller names an org,
 * because the scope would otherwise be the platform.
 */
oemUpdatesFleetRoutes.get(
  '/fleet',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', fleetQuerySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { state, orgId, lane, limit, offset } = c.req.valid('query');

    // Fail closed: no permissions context means requirePermission did not run.
    const permissions = c.get('permissions') as UserPermissions | undefined;
    if (!permissions) return c.json({ error: 'Access to this site denied' }, 403);

    if (orgId && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }
    if (!orgId && auth.scope === 'system') {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const allowedSiteIds = permissions.allowedSiteIds;
    const where = and(
      // Quick Support devices sit in an org the caller can reach; nothing else drops them.
      eq(devices.isEphemeral, false),
      notParkedDeviceCondition(),
      ne(devices.status, 'decommissioned'),
      auth.orgCondition(devices.orgId),
      orgId ? eq(devices.orgId, orgId) : undefined,
      allowedSiteIds
        ? (allowedSiteIds.length > 0 ? inArray(devices.siteId, allowedSiteIds) : sql`false`)
        : undefined,
    );

    // No flag, no lane, so no policy is ever consulted.
    const candidates = oemUpdatesFlagOn() ? await loadOemLinkCandidates() : [];
    const withGroups = candidates.some((candidate) => candidate.assignmentLevel === 'device_group');
    const rows = await loadFleetRows(where, withGroups);

    const classified = classify(rows, candidates, new Date());
    const inLane = lane ? classified.filter((entry) => entry.lane === lane) : classified;

    const counts = Object.fromEntries(OEM_DISPLAY_STATES.map((name) => [name, 0])) as Record<OemDisplayState, number>;
    for (const entry of inLane) counts[entry.state] += 1;

    const listed = state ? inLane.filter((entry) => entry.state === state) : inLane;

    return c.json({
      counts,
      total: listed.length,
      devices: listed.slice(offset, offset + limit).map(({ row, lane: rowLane, state: displayState }) => ({
        deviceId: row.deviceId,
        hostname: row.hostname,
        orgId: row.orgId,
        orgName: row.orgName,
        siteId: row.siteId,
        siteName: row.siteName,
        deviceStatus: row.deviceStatus,
        lane: rowLane,
        displayState,
        lastOutcome: row.lastOutcome,
        lastAttemptAt: row.lastAttemptAt,
        lastSuccessAt: row.lastSuccessAt,
        rebootPendingSince: row.rebootPendingSince,
        scheduleNotHandedBack: row.reason === OEM_RELEASE_GAVE_UP,
      })),
    });
  },
);
