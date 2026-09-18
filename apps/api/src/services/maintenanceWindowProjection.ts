/**
 * AI patch agent W04 (#5750) — the next-occurrence projector for maintenance
 * windows.
 *
 * "Is this device in a window now" has always existed
 * (`isInMaintenanceWindow`, `maintenanceService.isDeviceInMaintenance`); "when
 * is its NEXT window" did not. `deploymentEngine.getNextMaintenanceWindow`
 * reads only the legacy standalone table and omits group targets, so it is
 * not reused. This module projects forward using the SAME recurrence helpers
 * `isInMaintenanceWindow` evaluates with (`maintenanceWallClock`,
 * `maintenanceOccurrenceStart`, `maintenanceNextOccurrenceStart`), so the two
 * answers can never disagree at a boundary — the integration suite asserts
 * exactly that.
 *
 * Resolution order per device, mirroring `isDeviceInMaintenance`:
 *   1. the config-policy maintenance settings the device resolves to
 *      (`resolveMaintenanceConfigForDevice`, partner-wide visible), projected;
 *   2. otherwise the earliest legacy standalone `maintenance_windows` row that
 *      targets the device (all / device / site / group — the same predicate
 *      `checkStandaloneMaintenanceWindows` uses, including groups).
 *
 * `windowId` grammar (stable across runs; W05 / Operator P4-3 parse it):
 *   config policy — `<config_policy_maintenance_settings.id>@<startsAt ISO>`
 *   standalone    — `<maintenance_windows.id>@<startsAt ISO>`
 * The left side is a UUID, the right side `Date#toISOString()` of the
 * occurrence start, joined by a single `@`.
 *
 * `horizonDays` is a HARD bound (default 30) — never an unbounded search.
 *
 * DST rule for a config-policy window (documented, tested): the occurrence
 * start is computed as wall-clock time in the window's zone and converted to
 * an instant by `wallClockToInstant`; a wall time that does not exist (spring
 * forward) resolves to the transition instant that closes the gap (02:30 on
 * a 02:00→03:00 night opens at 03:00, the moment the wall clock first reads
 * past 02:30), and one that occurs twice (fall back) resolves to its first
 * occurrence. The window's END is the
 * wall-clock start plus `durationHours`, converted the same way — which is
 * what `isInMaintenanceWindow` compares against too.
 *
 * This module reads nothing without an org pin: every statement carries
 * `org_id = $org` (standalone windows: the org's own rows or partner-wide
 * rows of the org's partner, exactly like `checkStandaloneMaintenanceWindows`).
 */
import { sql } from 'drizzle-orm';
import { db } from '../db';
import type { configPolicyMaintenanceSettings } from '../db/schema';
import {
  maintenanceNextOccurrenceStart,
  maintenanceOccurrenceStart,
  maintenanceWallClock,
  resolveMaintenanceConfigForDevice,
} from './featureConfigResolver';

export const MAINTENANCE_WINDOW_HORIZON_DAYS = 30;

export interface NextMaintenanceWindow {
  /** See the header for the grammar. */
  windowId: string;
  source: 'config_policy' | 'standalone';
  startsAt: Date;
  endsAt: Date;
  rebootIfPending: boolean;
}

type MaintenanceSettingsRow = typeof configPolicyMaintenanceSettings.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Minutes east of UTC for `tz` at `instant`, via the same Intl rendering `maintenanceWallClock` uses. */
function zoneOffsetMs(instant: Date, tz: string): number {
  // `maintenanceWallClock` renders in UTC field space, so its epoch value IS
  // the wall digits read as UTC.
  return maintenanceWallClock(instant, tz).getTime() - instant.getTime();
}

/**
 * Converts a wall-clock Date (the `maintenanceWallClock` space: UTC fields
 * carry the digits) in `tz` back to a real instant. Two offset iterations
 * settle every regular time; for a DST gap the candidates disagree and the
 * LATER instant wins (shift forward); for an overlap the first candidate
 * already round-trips and wins (first occurrence).
 */
export function wallClockToInstant(wall: Date, timezone: string | null | undefined): Date {
  const tz = timezone || 'UTC';
  const digitsAsUtc = wall.getTime();
  const first = new Date(digitsAsUtc - zoneOffsetMs(new Date(digitsAsUtc), tz));
  if (zoneOffsetMs(first, tz) === digitsAsUtc - first.getTime()) return first;
  const second = new Date(digitsAsUtc - zoneOffsetMs(first, tz));
  if (zoneOffsetMs(second, tz) === digitsAsUtc - second.getTime()) return second;
  // Neither round-trips: the wall time is inside a DST gap. The window opens
  // at the transition itself — the first instant whose wall clock is at or
  // past the requested digits — which is exactly when `isInMaintenanceWindow`
  // starts answering "active". The transition lies strictly between the two
  // candidates (one uses the pre-transition offset, one the post), so a
  // binary search over that interval on "has the offset flipped yet" finds
  // it to the millisecond in ~22 Intl calls.
  let lo = Math.min(first.getTime(), second.getTime());
  let hi = Math.max(first.getTime(), second.getTime());
  const offsetAfter = zoneOffsetMs(new Date(hi), tz);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (zoneOffsetMs(new Date(mid), tz) === offsetAfter) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

/**
 * Pure: the window (current or next) a config-policy maintenance settings
 * row yields at or after `from`, or null when none starts within the horizon.
 */
export function projectNextConfigPolicyWindow(
  settings: MaintenanceSettingsRow,
  from: Date,
  horizonDays: number = MAINTENANCE_WINDOW_HORIZON_DAYS,
): NextMaintenanceWindow | null {
  const localFrom = maintenanceWallClock(from, settings.timezone);
  const durationMs = settings.durationHours * 60 * 60 * 1000;
  const horizonMs = horizonDays * DAY_MS;

  // The occurrence governing `from` — the same one isInMaintenanceWindow evaluates.
  let start = maintenanceOccurrenceStart(settings, localFrom);
  if (start === null) return null;

  // Already closed? Advance ONE step (the governing occurrence is by
  // construction the most recent one, so its successor is the next).
  if (localFrom.getTime() >= start.getTime() + durationMs) {
    const next = maintenanceNextOccurrenceStart(settings.recurrence, start);
    if (next === null) return null; // `once`, in the past
    start = next;
  }

  const startsAt = wallClockToInstant(start, settings.timezone);
  if (startsAt.getTime() - from.getTime() > horizonMs) return null;
  const endsAt = wallClockToInstant(new Date(start.getTime() + durationMs), settings.timezone);

  return {
    windowId: `${settings.id}@${startsAt.toISOString()}`,
    source: 'config_policy',
    startsAt,
    endsAt,
    rebootIfPending: settings.rebootIfPending,
  };
}

type DeviceRow = { id: string; site_id: string | null };
type MembershipRow = { device_id: string; group_id: string };
type StandaloneRow = {
  id: string;
  start_time: Date | string;
  end_time: Date | string;
  target_type: string;
  device_ids: string[] | null;
  site_ids: string[] | null;
  group_ids: string[] | null;
};

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function standaloneTargets(row: StandaloneRow, device: DeviceRow, groupIds: ReadonlySet<string>): boolean {
  if (row.target_type === 'all') return true;
  if (row.device_ids?.includes(device.id)) return true;
  if (device.site_id !== null && row.site_ids?.includes(device.site_id)) return true;
  if (row.group_ids?.some((g) => groupIds.has(g))) return true;
  return false;
}

/**
 * Batched: one config-policy resolution per device (the existing hierarchy
 * walk, reused rather than re-implemented), then ONE device read, ONE group
 * membership read and ONE standalone-window read for every device that did
 * not resolve a config-policy window. Devices with no window in the horizon
 * are absent from the map.
 */
export async function resolveNextMaintenanceWindows(
  deviceIds: readonly string[],
  orgId: string,
  from: Date = new Date(),
  horizonDays: number = MAINTENANCE_WINDOW_HORIZON_DAYS,
): Promise<Map<string, NextMaintenanceWindow>> {
  const out = new Map<string, NextMaintenanceWindow>();
  const unique = [...new Set(deviceIds)];
  if (unique.length === 0) return out;

  const unresolved: string[] = [];
  for (const deviceId of unique) {
    const settings = await resolveMaintenanceConfigForDevice(deviceId);
    const window = settings ? projectNextConfigPolicyWindow(settings, from, horizonDays) : null;
    if (window) out.set(deviceId, window);
    else unresolved.push(deviceId);
  }
  if (unresolved.length === 0) return out;

  const inList = sql.join(unresolved.map((id) => sql`${id}::uuid`), sql`, `);
  const devicesRows = [...await db.execute<DeviceRow>(sql`
    SELECT d.id, d.site_id FROM devices d
    WHERE d.org_id = ${orgId} AND d.id IN (${inList})
  `)];
  if (devicesRows.length === 0) return out;

  const memberships = [...await db.execute<MembershipRow>(sql`
    SELECT m.device_id, m.group_id
    FROM device_group_memberships m
    JOIN devices d ON d.id = m.device_id AND d.org_id = ${orgId}
    WHERE m.device_id IN (${inList})
  `)];
  const groupsByDevice = new Map<string, Set<string>>();
  for (const m of memberships) {
    const set = groupsByDevice.get(m.device_id) ?? new Set<string>();
    set.add(m.group_id);
    groupsByDevice.set(m.device_id, set);
  }

  // Bound as ISO strings: raw sql`` params skip Drizzle's column-type mapping
  // and postgres.js throws at bind for a bare Date.
  const fromIso = from.toISOString();
  const untilIso = new Date(from.getTime() + horizonDays * DAY_MS).toISOString();
  const windows = [...await db.execute<StandaloneRow>(sql`
    SELECT w.id, w.start_time, w.end_time, w.target_type, w.device_ids, w.site_ids, w.group_ids
    FROM maintenance_windows w
    WHERE (
        w.org_id = ${orgId}
        OR (w.org_id IS NULL AND w.partner_id = (SELECT o.partner_id FROM organizations o WHERE o.id = ${orgId}))
      )
      AND w.status IN ('scheduled', 'active')
      AND w.end_time > ${fromIso}::timestamp
      AND w.start_time <= ${untilIso}::timestamp
    ORDER BY w.start_time ASC
  `)];

  for (const device of devicesRows) {
    const groups = groupsByDevice.get(device.id) ?? new Set<string>();
    const match = windows.find((w) => standaloneTargets(w, device, groups));
    if (!match) continue;
    const startsAt = asDate(match.start_time);
    out.set(device.id, {
      windowId: `${match.id}@${startsAt.toISOString()}`,
      source: 'standalone',
      startsAt,
      endsAt: asDate(match.end_time),
      rebootIfPending: false,
    });
  }
  return out;
}

/** Single-device convenience over `resolveNextMaintenanceWindows`. */
export async function resolveNextMaintenanceWindow(
  deviceId: string,
  orgId: string,
  from: Date = new Date(),
  horizonDays: number = MAINTENANCE_WINDOW_HORIZON_DAYS,
): Promise<NextMaintenanceWindow | null> {
  return (await resolveNextMaintenanceWindows([deviceId], orgId, from, horizonDays)).get(deviceId) ?? null;
}
