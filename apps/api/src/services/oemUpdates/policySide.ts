/**
 * What a device's policy contributes to its display state (#11065): one rule for the
 * device section, the fleet view and the overdue alerts, so they cannot disagree.
 *
 * "Managed" means a run could be sent if the night came: the link reaches the lane,
 * no kill switch has stopped it, and at least one requested category is open. With
 * none of that, a missed night is nobody's miss. Every gate closed, or a lane paused
 * by its kill switch, must read Not managed rather than turn a fleet Overdue and raise
 * an alert per device. An agent too old for a run is NOT in that list: that machine
 * really has stopped updating, and updating the agent is the tech's to do.
 *
 * Pure, given the gates. Touches no table.
 */
import { OEM_CATEGORIES, OEM_LANES, type OemLane, type OemOutcome, type OemUpdatesInlineSettings } from '@breeze/shared';
import type { OemApplicabilityState } from '../../db/schema/oemUpdates';
import { OEM_FLASH_CATEGORIES, resolveApplicability } from './applicability';
import { deriveOemDisplayState, type OemDisplayState } from './displayState';
import { laneDisabledByKillSwitch, oemUpdatesEnabled } from './flags';
import { computeOccurrence, type OemOccurrence } from './occurrence';
import type { ResolvedOemUpdatesLink } from './resolver';
import { openCategoriesForLane, SHIPPED_OEM_LANES } from './toolManifest';

export type OemPolicySide = {
  linkEnabled: boolean;
  rebootMode?: 'overnight' | 'never';
  occurrence: OemOccurrence | null;
  managedSince?: Date | null;
  /**
   * The policy still asks for this lane, but for now nothing can be sent: a kill switch,
   * a gate closed on a category it asks for, or stored settings that no longer parse.
   * Reads as not managed, but the device has not left management, so an open alert stays.
   */
  paused?: boolean;
};

/** A category the link asks for, open for this device, and allowed by its reboot mode. */
export function hasSendableCategory(settings: OemUpdatesInlineSettings, lane: OemLane, deviceId: string): boolean {
  const vendor = settings.vendors[lane];
  if (!vendor?.enabled) return false;
  const rebootControlled = settings.reboot === 'overnight';
  const open = new Set(openCategoriesForLane(lane, { deviceId }));
  return OEM_CATEGORIES.some((category) => vendor.categories[category] === true
    && open.has(category)
    && (rebootControlled || !OEM_FLASH_CATEGORIES.has(category)));
}

export function oemPolicySide(input: {
  deviceId: string;
  /** The lane a run would use. Null when none could reach this device, the flag off included. */
  lane: OemLane | null;
  link: ResolvedOemUpdatesLink | null;
  timezone: string;
  now: Date;
  enrolledAt?: Date | null;
  /** For a caller walking many devices: most of them share a link and a zone. */
  occurrenceOf?: (link: ResolvedOemUpdatesLink, timezone: string) => OemOccurrence;
}): OemPolicySide {
  const { deviceId, lane, link, timezone, now, enrolledAt, occurrenceOf } = input;
  if (lane && link?.invalidStoredSettings) return { linkEnabled: false, occurrence: null, paused: true };
  if (!lane || !link?.settings.enabled || !link.settings.vendors[lane]?.enabled) {
    return { linkEnabled: false, occurrence: null };
  }
  const rebootMode = link.settings.reboot;
  if (laneDisabledByKillSwitch(lane)) return { linkEnabled: false, rebootMode, occurrence: null, paused: true };
  if (!hasSendableCategory(link.settings, lane, deviceId)) {
    const open = new Set(openCategoriesForLane(lane, { deviceId }));
    const gateClosed = OEM_CATEGORIES.some((category) => link.settings.vendors[lane]?.categories[category] === true && !open.has(category));
    return { linkEnabled: false, rebootMode, occurrence: null, paused: gateClosed };
  }

  const { schedule, catchUpNights } = link.settings;
  const occurrence = occurrenceOf
    ? occurrenceOf(link, timezone)
    : computeOccurrence({ ...schedule, catchUpNights }, timezone, now);
  const managedSince = [link.armedAt, enrolledAt]
    .filter((at): at is Date => at instanceof Date)
    .reduce<Date | null>((latest, at) => (!latest || at > latest ? at : latest), null);
  return { linkEnabled: true, rebootMode, occurrence, managedSince };
}

/** One occurrence per link and zone. They are the costly pure step, and most devices share them. */
export function oemOccurrenceMemo(now: Date): (link: ResolvedOemUpdatesLink, timezone: string) => OemOccurrence {
  const occurrences = new Map<string, OemOccurrence>();
  return (link, timezone) => {
    const key = `${link.linkId}|${timezone}`;
    let occurrence = occurrences.get(key);
    if (!occurrence) {
      const { schedule, catchUpNights } = link.settings;
      occurrence = computeOccurrence({ ...schedule, catchUpNights }, timezone, now);
      occurrences.set(key, occurrence);
    }
    return occurrence;
  };
}

/** What a many-device caller has read per device, in place of the device section's single reads. */
export type OemDeviceFacts = {
  deviceId: string;
  partnerId: string;
  osType: string;
  isVirtual: boolean;
  deviceRole: string;
  enrolledAt: Date | null;
  manufacturer: string | null;
  model: string | null;
  /** All null for a device with no status row. */
  statusLane: OemLane | null;
  applicability: OemApplicabilityState | null;
  lastOutcome: OemOutcome | null;
  occurrenceKey: string | null;
  attempts: number | null;
  lastSuccessAt: Date | null;
  rebootPendingSince: Date | null;
};

/** The lane a run would use: the flag and partner allowlist, then the hardware. */
export function oemOfferedLane(facts: Pick<OemDeviceFacts, 'partnerId' | 'osType' | 'isVirtual' | 'deviceRole' | 'manufacturer' | 'model'>): OemLane | null {
  if (!oemUpdatesEnabled(facts.partnerId)) return null;
  const applicability = resolveApplicability({
    osType: facts.osType,
    isVirtual: facts.isVirtual,
    deviceRole: facts.deviceRole,
    manufacturer: facts.manufacturer,
    model: facts.model,
    enabledLanes: OEM_LANES,
    shippedLanes: SHIPPED_OEM_LANES,
  });
  return applicability.state === 'applicable' ? applicability.lane : null;
}

export type OemClassification = { side: OemPolicySide; state: OemDisplayState };

export function classifyOemDevice(input: {
  facts: OemDeviceFacts;
  lane: OemLane | null;
  link: ResolvedOemUpdatesLink | null;
  timezone: string;
  now: Date;
  occurrenceOf: (link: ResolvedOemUpdatesLink, timezone: string) => OemOccurrence;
}): OemClassification {
  const { facts, lane, link, timezone, now, occurrenceOf } = input;
  const side = oemPolicySide({ deviceId: facts.deviceId, lane, link, timezone, now, enrolledAt: facts.enrolledAt, occurrenceOf });
  const state = deriveOemDisplayState({
    status: facts.applicability === null
      ? null
      : {
          applicability: facts.applicability,
          lastOutcome: facts.lastOutcome,
          occurrenceKey: facts.occurrenceKey,
          lastSuccessAt: facts.lastSuccessAt,
          rebootPendingSince: facts.rebootPendingSince,
          attempts: facts.attempts ?? 0,
        },
    ...side,
    now,
  });
  return { side, state };
}
