import { OEM_OBSERVE_LANES, type OemCategory, type OemLane, type OemObserveLane } from '@breeze/shared';

/**
 * Which vendor lane a device belongs to, or why none applies (spec 4.3).
 *
 * A pure function. Deliberately not `normalizeManufacturer`
 * (warrantyProviders/index.ts): its `includes('hp')` is fine for a warranty
 * lookup and far too loose to authorize flashing a BIOS. `HPE`, `CHP Systems`
 * and `Dell EMC` must reach no lane, so every match here is exact on the whole
 * trimmed string.
 *
 * What it cannot decide is model support: the tool's own answer does that
 * (`not_supported`, sticky, stored on the status row).
 */

export type OemNotApplicableReason =
  | 'not_windows'
  | 'virtual'
  | 'server'
  | 'unknown_manufacturer'
  | 'lane_not_shipped'
  | 'vendor_disabled'
  /** The newest observation found no HP platform catalog: a consumer HP (observe-first O4b). */
  | 'platform_unsupported';

export type OemApplicability =
  | { state: 'applicable'; lane: OemLane }
  | { state: 'not_applicable'; reason: OemNotApplicableReason };

const DELL = /^dell(?: inc\.?)?$/i;
const HP = /^(?:hp(?: inc\.?)?|hewlett-packard)$/i;
const LENOVO = /^lenovo$/i;
const MICROSOFT = /^microsoft corporation$/i;
// A Surface model name starts with the word. `Virtual Machine` does not.
const SURFACE_MODEL = /^surface\s/i;

export function laneFor(manufacturer: string | null, model: string | null): OemLane | null {
  const maker = manufacturer?.trim() ?? '';
  if (DELL.test(maker)) return 'dell';
  if (HP.test(maker)) return 'hp';
  if (LENOVO.test(maker)) return 'lenovo';
  if (MICROSOFT.test(maker) && SURFACE_MODEL.test(model?.trim() ?? '')) return 'surface';
  return null;
}

/** They write the machine's firmware, so they need a reboot Breeze controls (spec 4.5). */
export const OEM_FLASH_CATEGORIES: ReadonlySet<OemCategory> = new Set(['bios', 'firmware']);

/** Sticky until the tool version or the model changes: each is a new question (spec 4.3). */
export function stillNotSupported(
  status: { applicability?: string | null; notSupportedToolVersion?: string | null; notSupportedModel?: string | null } | undefined,
  currentToolVersion: string | null,
  model: string | null,
): boolean {
  if (status?.applicability !== 'not_supported') return false;
  return status.notSupportedToolVersion === currentToolVersion && status.notSupportedModel === model;
}

export function resolveApplicability(input: {
  osType: string;
  isVirtual: boolean;
  deviceRole: string;
  manufacturer: string | null;
  model: string | null;
  enabledLanes: readonly OemLane[];
  shippedLanes: readonly OemLane[];
  /**
   * The newest observation of this device recorded a 404 from HP's platform
   * catalog (observe.ts `observedHpPlatformUnsupported`). Narrowing only: it can
   * stop an HP run, never start one, so HPIA is never fetched onto a consumer HP.
   */
  observedHpPlatformUnsupported?: boolean;
}): OemApplicability {
  if (input.osType !== 'windows') return { state: 'not_applicable', reason: 'not_windows' };
  if (input.isVirtual) return { state: 'not_applicable', reason: 'virtual' };
  if (input.deviceRole === 'server') return { state: 'not_applicable', reason: 'server' };

  const lane = laneFor(input.manufacturer, input.model);
  if (!lane) return { state: 'not_applicable', reason: 'unknown_manufacturer' };
  if (!input.shippedLanes.includes(lane)) return { state: 'not_applicable', reason: 'lane_not_shipped' };
  if (!input.enabledLanes.includes(lane)) return { state: 'not_applicable', reason: 'vendor_disabled' };
  if (lane === 'hp' && input.observedHpPlatformUnsupported) return { state: 'not_applicable', reason: 'platform_unsupported' };
  return { state: 'applicable', lane };
}

export type OemObserveApplicability =
  | { state: 'applicable'; lane: OemObserveLane }
  | { state: 'not_applicable'; reason: OemNotApplicableReason };

/**
 * Which lane a vendor observation may read (observe-first amendment §1.3 check 5). The
 * same anchored manufacturer and model matching as {@link resolveApplicability},
 * but no shipped-lane or policy narrowing: Lenovo is observed before its lane
 * exists, and a consumer HP is still `hp`, because observing it is the point.
 * Dell has no stage entry, so it is not observable.
 */
export function resolveObserveApplicability(input: {
  osType: string;
  isVirtual: boolean;
  deviceRole: string;
  manufacturer: string | null;
  model: string | null;
}): OemObserveApplicability {
  if (input.osType !== 'windows') return { state: 'not_applicable', reason: 'not_windows' };
  if (input.isVirtual) return { state: 'not_applicable', reason: 'virtual' };
  if (input.deviceRole === 'server') return { state: 'not_applicable', reason: 'server' };
  const lane = laneFor(input.manufacturer, input.model);
  if (!lane || !(OEM_OBSERVE_LANES as readonly string[]).includes(lane)) {
    return { state: 'not_applicable', reason: 'unknown_manufacturer' };
  }
  return { state: 'applicable', lane: lane as OemObserveLane };
}
