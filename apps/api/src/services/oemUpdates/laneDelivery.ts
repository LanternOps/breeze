/**
 * Which update classes a vendor lane is really delivering on a device (#11065,
 * spec 4.6). Breeze patch jobs leave those to the lane and keep installing the rest
 * from Windows Update, so every doubt here answers "not delivering": a device
 * wrongly left to a lane stops getting drivers and firmware, and nothing says so.
 *
 * Read live at job execution and never stored, so a lane that starts failing hands
 * the class back to Windows Update on the next job.
 *
 * These go past the spec's list, because the category being on does not mean the
 * lane delivers it:
 *
 * - The last run has to be a finished, scheduled one that asked for the class and did
 *   not skip it. A status row's success says only that the tool ran: a Surface run that
 *   installed drivers and refused firmware reports `success`, and a Run Now can leave
 *   out bios and firmware. A run still in flight has no result, so it proves nothing.
 *   A Run Now hands the class back until the next scheduled run, which is the safe way.
 * - Firmware needs a reboot Breeze controls. Without one the seam drops bios and
 *   firmware from every run, so a `never` policy delivers neither.
 * - Firmware needs BIOS on as well, on a lane where BIOS is its own category.
 *   Windows Update files a system BIOS capsule as firmware and nothing on the update
 *   tells them apart, so firmware alone could strand a BIOS. Surface has no separate
 *   BIOS: its lane flashes everything as firmware.
 * - A reboot still owed does not hide the rest. `deriveOemDisplayState` answers a
 *   pending reboot first, and under `never` that wait has no end, so the state is
 *   read twice: as it stands, and as if no reboot were owed.
 *
 * Classes are not the whole answer: a lane only delivers its own vendor's updates, so
 * callers compare `lane` with the update's reported owner.
 *
 * Runs in the caller's RLS context. Like `policySide` on the status route, a caller
 * that cannot see the partner row falls through to UTC for the zone, which moves the
 * Overdue edge by a few hours on a read-only view. The job executor runs as system.
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  agentSupportsOemUpdates,
  OEM_LANES,
  type OemCategory,
  type OemLane,
  type OemOutcome,
} from '@breeze/shared';
import { db } from '../../db';
import {
  deviceCommands,
  deviceHardware,
  deviceOemUpdateStatus,
  devices,
  organizations,
  partners,
  sites,
} from '../../db/schema';
import { notParkedDeviceCondition } from '../unassignedPool/selectorPredicate';
import { resolveApplicability } from './applicability';
import { effectiveTimezoneFrom, type DeviceTimezoneFields } from './candidates';
import { deriveOemDisplayState, FINISHED_OUTCOMES, type OemDisplayState } from './displayState';
import { laneDisabledByKillSwitch, oemUpdatesEnabled, oemUpdatesFlagOn } from './flags';
import { computeOccurrence } from './occurrence';
import { resolveOemUpdatesLinksForDevices, type ResolvedOemUpdatesLink } from './resolver';
import { parseStoredOemResult } from './storedResult';
import { isCategoryOpen, isLaneOpen, SHIPPED_OEM_LANES } from './toolManifest';

export type VendorManagedClass = 'driver' | 'firmware';

/** Which lane delivers on a device, and what. `lane` is null when it delivers nothing. */
export type VendorLaneDelivery = { lane: OemLane | null; classes: Set<VendorManagedClass> };

const NO_DELIVERY = (): VendorLaneDelivery => ({ lane: null, classes: new Set() });

const CHUNK = 500;

/**
 * The states that show the lane is keeping up. An allowlist, so a state added later
 * reads as not delivering until someone decides otherwise.
 */
const DELIVERING_STATES: ReadonlySet<OemDisplayState> = new Set(['up_to_date', 'waiting_for_reboot']);

/** Lanes whose BIOS is not its own category. */
const LANES_WITHOUT_SEPARATE_BIOS: ReadonlySet<OemLane> = new Set(['surface']);

type LaneDeliveryRow = DeviceTimezoneFields & {
  deviceId: string;
  partnerId: string;
  osType: string;
  isVirtual: boolean;
  deviceRole: string;
  agentVersion: string | null;
  manufacturer: string | null;
  model: string | null;
  statusLane: OemLane | null;
  applicability: string;
  occurrenceKey: string | null;
  attempts: number;
  lastOutcome: OemOutcome | null;
  lastSuccessAt: Date | null;
  firstCompletedAt: Date | null;
  rebootPendingSince: Date | null;
  commandPayload: unknown;
  commandResult: unknown;
};

/** The categories the row's last run really ran, or null when it proves nothing. */
function categoriesLastRunDelivered(row: LaneDeliveryRow): Set<string> | null {
  const { trigger, categories } = (row.commandPayload ?? {}) as { trigger?: unknown; categories?: unknown };
  if (trigger !== 'scheduled' || !Array.isArray(categories)) return null;
  const result = parseStoredOemResult(row.commandResult);
  // A run that stopped short (a pending reboot, retry later) reports no skips, because
  // it never reached the categories.
  if (!result || !FINISHED_OUTCOMES.has(result.outcome)) return null;
  const skipped = new Set<string>(result.skippedCategories.map((skip) => skip.category));
  return new Set(categories.filter((category): category is string => typeof category === 'string' && !skipped.has(category)));
}

function deliveredClasses(row: LaneDeliveryRow, link: ResolvedOemUpdatesLink | undefined, now: Date): VendorLaneDelivery {
  const delivered = NO_DELIVERY();
  const { deviceId } = row;

  if (!oemUpdatesEnabled(row.partnerId)) return delivered;
  if (!link || link.invalidStoredSettings || !link.settings.enabled) return delivered;

  const applicability = resolveApplicability({
    osType: row.osType,
    isVirtual: row.isVirtual,
    deviceRole: row.deviceRole,
    manufacturer: row.manufacturer,
    model: row.model,
    enabledLanes: OEM_LANES,
    shippedLanes: SHIPPED_OEM_LANES,
  });
  if (applicability.state !== 'applicable') return delivered;
  const { lane } = applicability;

  const vendor = link.settings.vendors[lane];
  if (!vendor?.enabled) return delivered;
  if (laneDisabledByKillSwitch(lane) || !isLaneOpen(lane, { deviceId })) return delivered;
  if (!agentSupportsOemUpdates(row.agentVersion)) return delivered;

  // What the row says about the run has to be about this lane on this device.
  if (row.applicability !== 'applicable' || row.statusLane !== lane) return delivered;
  if (!row.firstCompletedAt) return delivered;

  const lastRun = categoriesLastRunDelivered(row);
  if (!lastRun) return delivered;

  const { schedule, catchUpNights, reboot } = link.settings;
  const occurrence = computeOccurrence({ ...schedule, catchUpNights }, effectiveTimezoneFrom(row), now);
  const stateWith = (rebootPendingSince: Date | null) => deriveOemDisplayState({
    status: {
      applicability: 'applicable',
      lastOutcome: row.lastOutcome,
      occurrenceKey: row.occurrenceKey,
      lastSuccessAt: row.lastSuccessAt,
      rebootPendingSince,
      attempts: row.attempts,
    },
    linkEnabled: true,
    rebootMode: reboot,
    occurrence,
    now,
  });
  if (!DELIVERING_STATES.has(stateWith(row.rebootPendingSince)) || !DELIVERING_STATES.has(stateWith(null))) {
    return delivered;
  }

  const categoryDelivered = (category: OemCategory) =>
    vendor.categories[category] === true && isCategoryOpen(lane, category, { deviceId }) && lastRun.has(category);

  if (categoryDelivered('driver')) delivered.classes.add('driver');
  if (
    reboot === 'overnight'
    && categoryDelivered('firmware')
    && (LANES_WITHOUT_SEPARATE_BIOS.has(lane) || categoryDelivered('bios'))
  ) {
    delivered.classes.add('firmware');
  }
  if (delivered.classes.size > 0) delivered.lane = lane;
  return delivered;
}

async function loadRows(deviceIds: string[]): Promise<LaneDeliveryRow[]> {
  return db
    .select({
      deviceId: devices.id,
      partnerId: organizations.partnerId,
      osType: devices.osType,
      isVirtual: devices.isVirtual,
      deviceRole: devices.deviceRole,
      agentVersion: devices.agentVersion,
      manufacturer: deviceHardware.manufacturer,
      model: deviceHardware.model,
      siteTimezone: sites.timezone,
      orgSettings: organizations.settings,
      partnerTimezone: partners.timezone,
      partnerSettings: partners.settings,
      statusLane: deviceOemUpdateStatus.lane,
      applicability: deviceOemUpdateStatus.applicability,
      occurrenceKey: deviceOemUpdateStatus.occurrenceKey,
      attempts: deviceOemUpdateStatus.attempts,
      lastOutcome: deviceOemUpdateStatus.lastOutcome,
      lastSuccessAt: deviceOemUpdateStatus.lastSuccessAt,
      firstCompletedAt: deviceOemUpdateStatus.firstCompletedAt,
      rebootPendingSince: deviceOemUpdateStatus.rebootPendingSince,
      commandPayload: deviceCommands.payload,
      commandResult: deviceCommands.result,
    })
    .from(devices)
    // Inner: a device with no status row has never had a lane, so it stops here.
    .innerJoin(deviceOemUpdateStatus, eq(deviceOemUpdateStatus.deviceId, devices.id))
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(partners, eq(partners.id, organizations.partnerId))
    .leftJoin(sites, eq(sites.id, devices.siteId))
    .leftJoin(deviceHardware, eq(deviceHardware.deviceId, devices.id))
    // Left: a row retention has removed is no evidence, not no device.
    .leftJoin(deviceCommands, eq(deviceCommands.id, deviceOemUpdateStatus.lastCommandId))
    .where(and(
      inArray(devices.id, deviceIds),
      eq(devices.isEphemeral, false),
      notParkedDeviceCondition(),
    )) as Promise<LaneDeliveryRow[]>;
}

async function loadDeliveries(
  deviceIds: readonly string[],
  now: Date,
): Promise<Map<string, VendorLaneDelivery>> {
  const unique = Array.from(new Set(deviceIds));
  const result = new Map<string, VendorLaneDelivery>(unique.map((deviceId) => [deviceId, NO_DELIVERY()]));
  // The common case on every install until a lab wave: nothing to read.
  if (unique.length === 0 || !oemUpdatesFlagOn()) return result;

  for (let i = 0; i < unique.length; i += CHUNK) {
    const rows = await loadRows(unique.slice(i, i + CHUNK));
    if (rows.length === 0) continue;
    const links = await resolveOemUpdatesLinksForDevices(rows.map((row) => row.deviceId));
    for (const row of rows) {
      result.set(row.deviceId, deliveredClasses(row, links.get(row.deviceId), now));
    }
  }
  return result;
}

/**
 * The classes a lane delivers on each device, with a fixed number of queries per
 * chunk of 500. Every asked device has an entry, empty when no lane delivers there.
 */
export async function getVendorManagedClassesForDevices(
  deviceIds: readonly string[],
  options: { now?: Date } = {},
): Promise<Map<string, Set<VendorManagedClass>>> {
  const deliveries = await loadDeliveries(deviceIds, options.now ?? new Date());
  return new Map(Array.from(deliveries, ([deviceId, delivery]) => [deviceId, delivery.classes]));
}

export async function getVendorLaneDelivery(
  deviceId: string,
  options: { now?: Date } = {},
): Promise<VendorLaneDelivery> {
  const deliveries = await loadDeliveries([deviceId], options.now ?? new Date());
  return deliveries.get(deviceId) ?? NO_DELIVERY();
}

export async function getVendorManagedClasses(
  deviceId: string,
  options: { now?: Date } = {},
): Promise<Set<VendorManagedClass>> {
  return (await getVendorLaneDelivery(deviceId, options)).classes;
}
