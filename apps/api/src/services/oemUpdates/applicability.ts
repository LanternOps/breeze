import type { OemCategory, OemLane } from '@breeze/shared';

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
  | 'vendor_disabled';

export type OemApplicability =
  | { state: 'applicable'; lane: OemLane }
  | { state: 'not_applicable'; reason: OemNotApplicableReason };

const DELL = /^dell(?: inc\.?)?$/i;
const HP = /^(?:hp(?: inc\.?)?|hewlett-packard)$/i;
const LENOVO = /^lenovo$/i;
const MICROSOFT = /^microsoft corporation$/i;
// A Surface model name starts with the word. `Virtual Machine` does not.
const SURFACE_MODEL = /^surface\s/i;

function laneFor(manufacturer: string | null, model: string | null): OemLane | null {
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
}): OemApplicability {
  if (input.osType !== 'windows') return { state: 'not_applicable', reason: 'not_windows' };
  if (input.isVirtual) return { state: 'not_applicable', reason: 'virtual' };
  if (input.deviceRole === 'server') return { state: 'not_applicable', reason: 'server' };

  const lane = laneFor(input.manufacturer, input.model);
  if (!lane) return { state: 'not_applicable', reason: 'unknown_manufacturer' };
  if (!input.shippedLanes.includes(lane)) return { state: 'not_applicable', reason: 'lane_not_shipped' };
  if (!input.enabledLanes.includes(lane)) return { state: 'not_applicable', reason: 'vendor_disabled' };
  return { state: 'applicable', lane };
}
