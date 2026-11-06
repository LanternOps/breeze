/**
 * Which update classes a vendor lane is really delivering on a device (#11065,
 * spec 4.6). Breeze patch jobs leave those to the lane and keep installing the rest
 * from Windows Update, so every doubt here answers "not delivering": a device
 * wrongly left to a lane stops getting drivers and firmware, and nothing says so.
 *
 * Read live at job execution and never stored, so a lane that starts failing hands
 * the class back to Windows Update on the next job.
 *
 * Two rules go past the spec's list, both because the category being on does not
 * mean the lane delivers it:
 *
 * - Firmware needs a reboot Breeze controls. Without one the seam drops bios and
 *   firmware from every run, so a `never` policy delivers neither.
 * - Firmware needs BIOS on as well, on a lane where BIOS is its own category.
 *   Windows Update files a system BIOS capsule as firmware and nothing on the update
 *   tells them apart, so firmware alone could strand a BIOS. Surface has no separate
 *   BIOS: its lane flashes everything as firmware.
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
import { deriveOemDisplayState, type OemDisplayState } from './displayState';
import { laneDisabledByKillSwitch, oemUpdatesEnabled, oemUpdatesFlagOn } from './flags';
import { computeOccurrence } from './occurrence';
import { resolveOemUpdatesLinksForDevices, type ResolvedOemUpdatesLink } from './resolver';
import { isCategoryOpen, isLaneOpen, SHIPPED_OEM_LANES } from './toolManifest';

export type VendorManagedClass = 'driver' | 'firmware';

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
};

function deliveredClasses(row: LaneDeliveryRow, link: ResolvedOemUpdatesLink | undefined, now: Date): Set<VendorManagedClass> {
  const delivered = new Set<VendorManagedClass>();
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

  const { schedule, catchUpNights, reboot } = link.settings;
  const displayState = deriveOemDisplayState({
    status: {
      applicability: 'applicable',
      lastOutcome: row.lastOutcome,
      occurrenceKey: row.occurrenceKey,
      lastSuccessAt: row.lastSuccessAt,
      rebootPendingSince: row.rebootPendingSince,
      attempts: row.attempts,
    },
    linkEnabled: true,
    rebootMode: reboot,
    occurrence: computeOccurrence({ ...schedule, catchUpNights }, effectiveTimezoneFrom(row), now),
    now,
  });
  if (!DELIVERING_STATES.has(displayState)) return delivered;

  const categoryDelivered = (category: OemCategory) =>
    vendor.categories[category] === true && isCategoryOpen(lane, category, { deviceId });

  if (categoryDelivered('driver')) delivered.add('driver');
  if (
    reboot === 'overnight'
    && categoryDelivered('firmware')
    && (LANES_WITHOUT_SEPARATE_BIOS.has(lane) || categoryDelivered('bios'))
  ) {
    delivered.add('firmware');
  }
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
    })
    .from(devices)
    // Inner: a device with no status row has never had a lane, so it stops here.
    .innerJoin(deviceOemUpdateStatus, eq(deviceOemUpdateStatus.deviceId, devices.id))
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(partners, eq(partners.id, organizations.partnerId))
    .leftJoin(sites, eq(sites.id, devices.siteId))
    .leftJoin(deviceHardware, eq(deviceHardware.deviceId, devices.id))
    .where(and(
      inArray(devices.id, deviceIds),
      eq(devices.isEphemeral, false),
      notParkedDeviceCondition(),
    )) as Promise<LaneDeliveryRow[]>;
}

/**
 * The classes a lane delivers on each device, with a fixed number of queries per
 * chunk of 500. Every asked device has an entry, empty when no lane delivers there.
 */
export async function getVendorManagedClassesForDevices(
  deviceIds: readonly string[],
  options: { now?: Date } = {},
): Promise<Map<string, Set<VendorManagedClass>>> {
  const unique = Array.from(new Set(deviceIds));
  const result = new Map<string, Set<VendorManagedClass>>(
    unique.map((deviceId) => [deviceId, new Set<VendorManagedClass>()]),
  );
  // The common case on every install until a lab wave: nothing to read.
  if (unique.length === 0 || !oemUpdatesFlagOn()) return result;

  const now = options.now ?? new Date();
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

export async function getVendorManagedClasses(
  deviceId: string,
  options: { now?: Date } = {},
): Promise<Set<VendorManagedClass>> {
  const result = await getVendorManagedClassesForDevices([deviceId], options);
  return result.get(deviceId) ?? new Set();
}
