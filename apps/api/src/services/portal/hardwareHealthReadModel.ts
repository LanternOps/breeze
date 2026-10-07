import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  deviceDisks,
  deviceHardwareComponents,
  deviceHardwareEvents,
  deviceHardwareHealth,
  devices,
} from '../../db/schema';

// Customer-portal read model for the `enableHardwareHealth` family
// (Portal Advanced Visibility W01, #7731).
//
// Safety rules, enforced here and covered by the contract test:
//   - The organization always comes from the portal session, never the request.
//   - Every select names its columns explicitly (no row spreading), so a column
//     added to a table later is never exposed by accident.
//   - Operational internals stay out: serials, firmware, raw attributes, source
//     tool, streak counters, alert exemption, per-source reports, agent version,
//     event detail, and the OS device path of a disk.
//   - BMC and collector components, and stale components, are not customer
//     data. Counts and overall health are computed from the filtered set; the
//     console view (services/hardwareHealth/view.ts) is deliberately not reused
//     because its counts include them.

export type PortalHardwareHealth = 'ok' | 'warning' | 'critical' | 'unknown';

const EXCLUDED_COMPONENT_TYPES = ['bmc', 'collector'] as const;
const EVENT_LIMIT = 50;

const RANK_TO_HEALTH: PortalHardwareHealth[] = ['ok', 'unknown', 'warning', 'critical'];
const HEALTH_TO_RANK: Record<PortalHardwareHealth, number> = {
  ok: 0, unknown: 1, warning: 2, critical: 3,
};

const worstRankSql = sql<number>`max(case ${deviceHardwareComponents.health}
  when 'critical' then 3 when 'warning' then 2 when 'unknown' then 1 else 0 end)::int`;

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

function emptyCounts(): Record<PortalHardwareHealth, number> {
  return { ok: 0, warning: 0, critical: 0, unknown: 0 };
}

function isCustomerComponent(row: { componentType: string; stale?: boolean }) {
  return !(EXCLUDED_COMPONENT_TYPES as readonly string[]).includes(row.componentType)
    && row.stale !== true;
}

async function deviceAggregates(orgId: string, deviceIds?: string[]) {
  return db
    .select({
      deviceId: deviceHardwareComponents.deviceId,
      worstRank: worstRankSql,
      componentCount: sql<number>`count(*)::int`,
    })
    .from(deviceHardwareComponents)
    .innerJoin(devices, eq(devices.id, deviceHardwareComponents.deviceId))
    .where(and(
      eq(deviceHardwareComponents.orgId, orgId),
      eq(devices.isEphemeral, false),
      eq(deviceHardwareComponents.stale, false),
      notInArray(deviceHardwareComponents.componentType, [...EXCLUDED_COMPONENT_TYPES]),
      ...(deviceIds ? [inArray(deviceHardwareComponents.deviceId, deviceIds)] : []),
    ))
    .groupBy(deviceHardwareComponents.deviceId);
}

// Devices of the whole organization that report at least one customer-visible
// component. The list's dataStatus uses it so it does not depend on which page
// was requested.
async function reportingDevices(orgId: string): Promise<number> {
  const rows = await db
    .select({ reporting: sql<number>`count(distinct ${deviceHardwareComponents.deviceId})::int` })
    .from(deviceHardwareComponents)
    .innerJoin(devices, eq(devices.id, deviceHardwareComponents.deviceId))
    .where(and(
      eq(deviceHardwareComponents.orgId, orgId),
      eq(devices.isEphemeral, false),
      eq(deviceHardwareComponents.stale, false),
      notInArray(deviceHardwareComponents.componentType, [...EXCLUDED_COMPONENT_TYPES]),
    ));
  return rows[0]?.reporting ?? 0;
}

async function deviceTotal(orgId: string): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(devices)
    .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false)));
  return rows[0]?.total ?? 0;
}

export async function hardwareHealthOverview(orgId: string, now: Date) {
  const [total, aggregates] = await Promise.all([
    deviceTotal(orgId),
    deviceAggregates(orgId),
  ]);
  const byHealth = emptyCounts();
  for (const row of aggregates) {
    byHealth[RANK_TO_HEALTH[row.worstRank] ?? 'unknown'] += 1;
  }
  return {
    asOf: now.toISOString(),
    dataStatus: aggregates.length > 0 ? ('ok' as const) : ('no_data' as const),
    devices: { total, reporting: aggregates.length, byHealth },
  };
}

export async function hardwareHealthDevicesPage(
  orgId: string,
  args: { page: number; limit: number; now: Date },
) {
  const offset = (args.page - 1) * args.limit;
  const [total, reporting, pageRows] = await Promise.all([
    deviceTotal(orgId),
    reportingDevices(orgId),
    db
      .select({
        id: devices.id,
        hostname: devices.hostname,
        displayName: devices.displayName,
        osType: devices.osType,
      })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false)))
      .orderBy(asc(sql`coalesce(${devices.displayName}, ${devices.hostname})`), asc(devices.id))
      .limit(args.limit)
      .offset(offset),
  ]);

  const ids = pageRows.map((row) => row.id);
  const [aggregates, collected] = ids.length === 0
    ? [[], []]
    : await Promise.all([
      deviceAggregates(orgId, ids),
      db
        .select({
          deviceId: deviceHardwareHealth.deviceId,
          lastCollectedAt: deviceHardwareHealth.lastCollectedAt,
        })
        .from(deviceHardwareHealth)
        .where(and(
          eq(deviceHardwareHealth.orgId, orgId),
          inArray(deviceHardwareHealth.deviceId, ids),
        )),
    ]);

  const aggByDevice = new Map(aggregates.map((row) => [row.deviceId, row]));
  const collectedByDevice = new Map(collected.map((row) => [row.deviceId, row.lastCollectedAt]));

  const data = pageRows.map((row) => {
    const agg = aggByDevice.get(row.id);
    return {
      id: row.id,
      hostname: row.hostname,
      displayName: row.displayName,
      osType: row.osType,
      health: agg ? (RANK_TO_HEALTH[agg.worstRank] ?? 'unknown') : ('unknown' as PortalHardwareHealth),
      componentCount: agg?.componentCount ?? 0,
      lastCollectedAt: iso(collectedByDevice.get(row.id)),
    };
  });

  return {
    asOf: args.now.toISOString(),
    dataStatus: reporting > 0 ? ('ok' as const) : ('no_data' as const),
    data,
    pagination: { page: args.page, limit: args.limit, total },
  };
}

export async function hardwareHealthDeviceDetail(orgId: string, deviceId: string, now: Date) {
  const deviceRows = await db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      displayName: devices.displayName,
      osType: devices.osType,
      batteryStatus: devices.batteryStatus,
    })
    .from(devices)
    .where(and(
      eq(devices.id, deviceId),
      eq(devices.orgId, orgId),
      eq(devices.isEphemeral, false),
    ))
    .limit(1);
  const device = deviceRows[0];
  if (!device) return null;

  const [componentRows, eventRows, diskRows, collectedRows] = await Promise.all([
    db
      .select({
        componentKey: deviceHardwareComponents.componentKey,
        componentType: deviceHardwareComponents.componentType,
        name: deviceHardwareComponents.name,
        model: deviceHardwareComponents.model,
        sizeBytes: deviceHardwareComponents.sizeBytes,
        health: deviceHardwareComponents.health,
        state: deviceHardwareComponents.state,
        progressPercent: deviceHardwareComponents.progressPercent,
        temperatureC: deviceHardwareComponents.temperatureC,
        predictiveFailure: deviceHardwareComponents.predictiveFailure,
        // Read only to drop stale rows in code (defense in depth); never emitted.
        stale: deviceHardwareComponents.stale,
      })
      .from(deviceHardwareComponents)
      .where(and(
        eq(deviceHardwareComponents.orgId, orgId),
        eq(deviceHardwareComponents.deviceId, deviceId),
        eq(deviceHardwareComponents.stale, false),
        notInArray(deviceHardwareComponents.componentType, [...EXCLUDED_COMPONENT_TYPES]),
      ))
      .orderBy(asc(deviceHardwareComponents.componentType), asc(deviceHardwareComponents.name)),
    db
      .select({
        componentType: deviceHardwareEvents.componentType,
        eventType: deviceHardwareEvents.eventType,
        fromHealth: deviceHardwareEvents.fromHealth,
        toHealth: deviceHardwareEvents.toHealth,
        fromState: deviceHardwareEvents.fromState,
        toState: deviceHardwareEvents.toState,
        occurredAt: deviceHardwareEvents.occurredAt,
      })
      .from(deviceHardwareEvents)
      .where(and(
        eq(deviceHardwareEvents.orgId, orgId),
        eq(deviceHardwareEvents.deviceId, deviceId),
        notInArray(deviceHardwareEvents.componentType, [...EXCLUDED_COMPONENT_TYPES]),
      ))
      .orderBy(desc(deviceHardwareEvents.occurredAt))
      .limit(EVENT_LIMIT),
    db
      .select({
        mountPoint: deviceDisks.mountPoint,
        fsType: deviceDisks.fsType,
        totalGb: deviceDisks.totalGb,
        usedGb: deviceDisks.usedGb,
        freeGb: deviceDisks.freeGb,
        usedPercent: deviceDisks.usedPercent,
        health: deviceDisks.health,
      })
      .from(deviceDisks)
      .where(and(eq(deviceDisks.orgId, orgId), eq(deviceDisks.deviceId, deviceId)))
      .orderBy(asc(deviceDisks.mountPoint)),
    db
      .select({ lastCollectedAt: deviceHardwareHealth.lastCollectedAt })
      .from(deviceHardwareHealth)
      .where(and(
        eq(deviceHardwareHealth.orgId, orgId),
        eq(deviceHardwareHealth.deviceId, deviceId),
      ))
      .limit(1),
  ]);

  const components = componentRows.filter(isCustomerComponent);
  const counts = emptyCounts();
  let worst = 0;
  for (const row of components) {
    counts[row.health] += 1;
    worst = Math.max(worst, HEALTH_TO_RANK[row.health]);
  }
  const battery = device.batteryStatus;

  return {
    asOf: now.toISOString(),
    dataStatus: components.length > 0 ? ('ok' as const) : ('no_data' as const),
    device: {
      id: device.id,
      hostname: device.hostname,
      displayName: device.displayName,
      osType: device.osType,
    },
    health: components.length > 0 ? RANK_TO_HEALTH[worst]! : ('unknown' as PortalHardwareHealth),
    counts,
    lastCollectedAt: iso(collectedRows[0]?.lastCollectedAt),
    components: components.map((row) => ({
      componentType: row.componentType,
      // The agent falls back to the component key (it embeds the disk serial and the
      // collector prefix) when a component has no name; never show it.
      name: row.name === row.componentKey ? null : row.name,
      model: row.model,
      sizeBytes: row.sizeBytes,
      health: row.health,
      state: row.state,
      progressPercent: row.progressPercent,
      temperatureC: row.temperatureC,
      predictiveFailure: row.predictiveFailure,
    })),
    events: eventRows
      .filter(isCustomerComponent)
      .map((row) => ({
        componentType: row.componentType,
        eventType: row.eventType,
        fromHealth: row.fromHealth,
        toHealth: row.toHealth,
        fromState: row.fromState,
        toState: row.toState,
        occurredAt: iso(row.occurredAt),
      })),
    disks: diskRows.map((row) => ({
      mountPoint: row.mountPoint,
      fsType: row.fsType,
      totalGb: row.totalGb,
      usedGb: row.usedGb,
      freeGb: row.freeGb,
      usedPercent: row.usedPercent,
      health: row.health,
    })),
    battery: battery
      ? {
        present: battery.present,
        percent: battery.percent,
        chargingState: battery.chargingState,
        pluggedIn: battery.pluggedIn,
        timeRemainingMinutes: battery.timeRemainingMinutes,
        timeToFullMinutes: battery.timeToFullMinutes,
        reportedAt: battery.reportedAt,
      }
      : null,
  };
}
