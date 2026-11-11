import { Hono } from 'hono';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { OEM_LANES, type OemLane, type OemOutcome } from '@breeze/shared';
import { db } from '../../db';
import {
  deviceOemPolicySide,
  deviceOemUpdateStatus,
  devices,
  organizations,
  sites,
} from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { OEM_DISPLAY_STATES, type OemDisplayState } from '../../services/oemUpdates/displayState';
import { oemDisplayStateSql } from '../../services/oemUpdates/displayStateSql';
import { oemUpdatesFlagOn } from '../../services/oemUpdates/flags';
import { scheduleOemPolicySideRefresh, type OemPolicySideRefreshScope } from '../../services/oemUpdates/policySideRefreshTrigger';
import {
  oemFleetDeviceCondition,
  oemGatesFingerprint,
  oemPolicySideTrustedCondition,
  refreshOemPolicySide,
} from '../../services/oemUpdates/policySideStore';
import { OEM_RELEASE_GAVE_UP } from '../../services/oemUpdates/releaseSweep';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';

export const oemUpdatesFleetRoutes = new Hono();

oemUpdatesFleetRoutes.use('*', authMiddleware);

const fleetQuerySchema = z.object({
  state: z.enum(OEM_DISPLAY_STATES).optional(),
  orgId: z.string().uuid().optional(),
  lane: z.enum(OEM_LANES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Pending devices (no trusted policy side yet) a request refreshes itself before
 * answering. Above it, the refresh goes to the worker and the answer says so.
 */
export const OEM_FLEET_PENDING_REFRESH_LIMIT = 500;

/** Who may see which devices: what bounds the fleet read, in the list and the counts alike. */
export function fleetScopeCondition(scope: {
  orgCondition: SQL | undefined;
  orgId?: string;
  allowedSiteIds?: string[];
}): SQL | undefined {
  const { orgCondition, orgId, allowedSiteIds } = scope;
  return and(
    oemFleetDeviceCondition(),
    orgCondition,
    orgId ? eq(devices.orgId, orgId) : undefined,
    allowedSiteIds
      ? (allowedSiteIds.length > 0 ? inArray(devices.siteId, allowedSiteIds) : sql`false`)
      : undefined,
  );
}

/** One request's read: the same scope, clock and gates for every statement it runs. */
export type FleetRead = {
  where: SQL | undefined;
  now: Date;
  /** With the flag off, the policy side is left out: no lane is offered, nothing is managed. */
  flagOn: boolean;
  fingerprint: string;
};

/**
 * The device's policy side, only when it can be trusted at `now`: computed under this
 * process's gates and not past its rollover. Anything else does not join, so it reads
 * exactly like a device with no row (not managed) and counts as pending.
 */
function policySideJoin(read: FleetRead): SQL {
  return and(
    eq(deviceOemPolicySide.deviceId, devices.id),
    read.flagOn ? oemPolicySideTrustedCondition(read.now, read.fingerprint) : sql`false`,
  )!;
}

function stateOf(read: FleetRead): SQL<OemDisplayState> {
  return oemDisplayStateSql({
    applicability: deviceOemUpdateStatus.applicability,
    rebootPendingSince: deviceOemUpdateStatus.rebootPendingSince,
    lastOutcome: deviceOemUpdateStatus.lastOutcome,
    occurrenceKey: deviceOemUpdateStatus.occurrenceKey,
    attempts: deviceOemUpdateStatus.attempts,
    lastSuccessAt: deviceOemUpdateStatus.lastSuccessAt,
    policy: {
      linkEnabled: deviceOemPolicySide.linkEnabled,
      rebootMode: deviceOemPolicySide.rebootMode,
      occurrenceKey: deviceOemPolicySide.occurrenceKey,
      lastNightStart: deviceOemPolicySide.lastNightStart,
      pastLastNightAt: deviceOemPolicySide.pastLastNightAt,
      managedSince: deviceOemPolicySide.managedSince,
    },
  }, read.now);
}

/**
 * The lane the hardware offers, else a past run's: a device owing a reboot with the
 * flag since turned off still shows under its vendor.
 */
const laneOf = sql<OemLane | null>`COALESCE(${deviceOemPolicySide.offeredLane}, ${deviceOemUpdateStatus.lane})`;

export type FleetFilter = { lane?: OemLane; state?: OemDisplayState; limit: number; offset: number };

/**
 * Statement 1, one pass over the scope: per state, the devices in scope (and in the
 * lane, when one is asked for); how many have no trusted policy side, across the
 * whole scope; and which devices make up the requested page, by position in hostname
 * order. Exported for the integration test.
 *
 * One pass because every joined table costs an RLS check per row it reads under a
 * tenant context, and that, not the state rule, is what a large scope pays for: the
 * counts and the page (filtered by state or lane or not) share it.
 */
export function fleetSummaryStatement(read: FleetRead, filter: FleetFilter): SQL {
  const laneMatches = filter.lane ? sql`fleet.lane = ${filter.lane}` : sql`true`;
  const stateMatches = filter.state ? sql`fleet.state = ${filter.state}` : sql`true`;
  return sql`
    WITH fleet AS (
      SELECT ${devices.id} AS id,
             lower(${devices.hostname}) AS host_key,
             ${stateOf(read)} AS state,
             ${laneOf} AS lane,
             ${deviceOemPolicySide.deviceId} IS NULL AS pending
      FROM ${devices}
      LEFT JOIN ${deviceOemUpdateStatus} ON ${eq(deviceOemUpdateStatus.deviceId, devices.id)}
      LEFT JOIN ${deviceOemPolicySide} ON ${policySideJoin(read)}
      WHERE ${read.where ?? sql`true`}
    )
    SELECT fleet.state AS state,
           (count(*) FILTER (WHERE ${laneMatches}))::int AS count,
           (count(*) FILTER (WHERE fleet.pending))::int AS pending,
           NULL::uuid AS device_id,
           NULL::bigint AS position
    FROM fleet
    GROUP BY fleet.state
    UNION ALL
    SELECT NULL, NULL, NULL, page.id, page.position
    FROM (
      SELECT fleet.id, row_number() OVER (ORDER BY fleet.host_key, fleet.id) AS position
      FROM fleet
      WHERE ${laneMatches} AND ${stateMatches}
      ORDER BY fleet.host_key, fleet.id
      LIMIT ${filter.limit} OFFSET ${filter.offset}
    ) page`;
}

/** Statement 2: what the list shows for the page's devices. Exported for the integration test. */
export function fleetPageQuery(read: FleetRead, deviceIds: string[]) {
  return db
    .select({
      deviceId: devices.id,
      hostname: devices.hostname,
      orgId: devices.orgId,
      orgName: organizations.name,
      siteId: devices.siteId,
      siteName: sites.name,
      deviceStatus: devices.status,
      lane: laneOf,
      displayState: stateOf(read),
      lastOutcome: deviceOemUpdateStatus.lastOutcome,
      lastAttemptAt: deviceOemUpdateStatus.lastAttemptAt,
      lastSuccessAt: deviceOemUpdateStatus.lastSuccessAt,
      rebootPendingSince: deviceOemUpdateStatus.rebootPendingSince,
      reason: deviceOemUpdateStatus.reason,
    })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(sites, eq(sites.id, devices.siteId))
    .leftJoin(deviceOemUpdateStatus, eq(deviceOemUpdateStatus.deviceId, devices.id))
    .leftJoin(deviceOemPolicySide, policySideJoin(read))
    .where(inArray(devices.id, deviceIds));
}

type SummaryRow = {
  state: OemDisplayState | null;
  count: number | null;
  pending: number | null;
  device_id: string | null;
  position: number | string | null;
};

type Summary = { counts: Record<OemDisplayState, number>; pending: number; pageIds: string[] };

async function readSummary(read: FleetRead, filter: FleetFilter): Promise<Summary> {
  const counts = Object.fromEntries(OEM_DISPLAY_STATES.map((name) => [name, 0])) as Record<OemDisplayState, number>;
  let pending = 0;
  const page: Array<{ id: string; position: number }> = [];
  for (const row of await db.execute(fleetSummaryStatement(read, filter)) as unknown as SummaryRow[]) {
    if (row.device_id !== null) {
      page.push({ id: row.device_id, position: Number(row.position) });
    } else if (row.state !== null) {
      counts[row.state] += row.count ?? 0;
      pending += row.pending ?? 0;
    }
  }
  page.sort((a, b) => a.position - b.position);
  return { counts, pending: read.flagOn ? pending : 0, pageIds: page.map((entry) => entry.id) };
}

/** The devices in scope with no trusted policy side, up to the in-request limit. */
async function pendingDeviceIds(read: FleetRead): Promise<string[]> {
  const rows = await db
    .select({ id: devices.id })
    .from(devices)
    .leftJoin(deviceOemPolicySide, policySideJoin(read))
    .where(and(read.where, isNull(deviceOemPolicySide.deviceId)))
    .limit(OEM_FLEET_PENDING_REFRESH_LIMIT);
  return rows.map((row) => row.id);
}

/** Who the worker refreshes for a caller whose scope has too many pending devices. */
function refreshScopeFor(auth: AuthContext, orgId: string | undefined): OemPolicySideRefreshScope | null {
  if (orgId) return { orgId };
  if (auth.scope === 'organization' && auth.orgId) return { orgId: auth.orgId };
  if (auth.scope === 'partner' && auth.partnerId) return { partnerId: auth.partnerId };
  return null;
}

/**
 * GET /oem-updates/fleet — the Vendor updates tab (#11074, spec 4.8).
 *
 * `counts` covers the org and lane filters and not `state`, so the tab can show every
 * state while its list shows one. `total` is the list's length before paging.
 *
 * With no device pending, two statements per request whatever the size of the fleet
 * (#11242): one pass over the scope for the counts and the page's ids, then the page's
 * rows (none for an empty page). The scope is never shipped to or classified in this
 * process.
 *
 * A state is derived, not stored: it depends on the policy's schedule in the device's
 * zone, and that rule must stay the one `deriveOemDisplayState` holds. The policy-side
 * refresh materialises the part of it that is stable between known instants
 * (`device_oem_policy_side`) and the rest is evaluated in SQL against this request's
 * clock (`oemDisplayStateSql`, pinned to the TS rule by a parity test). Zones resolve in
 * system scope there, so an org-scoped caller sees a zone set only on its partner the
 * same way a partner caller and the overdue alerts do.
 *
 * A device with no trusted policy side (new, past its occurrence's rollover, or
 * computed under other gates) is pending. Up to 500 are refreshed here (computed in
 * this process, a bounded set) and the first statement runs again. Above that, or for
 * any the refresh could not compute, the worker is asked; the answer carries
 * `pendingRefresh` and those devices read as not managed until it lands.
 *
 * A system caller names an org, because the scope would otherwise be the platform.
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

    const flagOn = oemUpdatesFlagOn();
    const read: FleetRead = {
      where: fleetScopeCondition({
        orgCondition: auth.orgCondition(devices.orgId),
        orgId,
        allowedSiteIds: permissions.allowedSiteIds,
      }),
      now: new Date(),
      flagOn,
      fingerprint: flagOn ? oemGatesFingerprint() : '',
    };

    const filter: FleetFilter = { lane, state, limit, offset };
    let summary = await readSummary(read, filter);
    let handToWorker = summary.pending > OEM_FLEET_PENDING_REFRESH_LIMIT;
    if (summary.pending > 0 && !handToWorker) {
      // Ids the caller's own RLS-scoped statement returned: the refresh never widens past them.
      const refreshed = await refreshOemPolicySide({
        now: read.now,
        scope: { deviceIds: await pendingDeviceIds(read) },
        source: 'fleet-request',
      });
      summary = await readSummary(read, filter);
      // What this request could not compute goes to the worker rather than waiting for the tick.
      handToWorker = refreshed.failedPages > 0 && summary.pending > 0;
    }
    if (handToWorker) {
      const scope = refreshScopeFor(auth, orgId);
      if (scope) scheduleOemPolicySideRefresh(scope, 'fleet-pending');
    }

    const { counts, pending, pageIds } = summary;
    const total = state
      ? counts[state]
      : OEM_DISPLAY_STATES.reduce((sum, name) => sum + counts[name], 0);
    const position = new Map(pageIds.map((id, index) => [id, index]));
    const rows = pageIds.length > 0
      ? (await fleetPageQuery(read, pageIds)).sort((a, b) => position.get(a.deviceId)! - position.get(b.deviceId)!)
      : [];

    return c.json({
      counts,
      total,
      ...(pending > 0 ? { pendingRefresh: pending } : {}),
      devices: rows.map((row) => ({
        deviceId: row.deviceId,
        hostname: row.hostname,
        orgId: row.orgId,
        orgName: row.orgName,
        siteId: row.siteId,
        siteName: row.siteName,
        deviceStatus: row.deviceStatus,
        lane: row.lane,
        displayState: row.displayState,
        lastOutcome: row.lastOutcome as OemOutcome | null,
        lastAttemptAt: row.lastAttemptAt,
        lastSuccessAt: row.lastSuccessAt,
        rebootPendingSince: row.rebootPendingSince,
        scheduleNotHandedBack: row.reason === OEM_RELEASE_GAVE_UP,
      })),
    });
  },
);
