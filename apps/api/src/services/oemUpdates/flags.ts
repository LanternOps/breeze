import { envFlag } from '../../config/env';
import type { OemLane } from '@breeze/shared';

/**
 * Vendor updates activation (#11065): env-side locks. All closed by default.
 * The manifest gates in `toolManifest.ts` and the minimum agent version are the
 * other locks; a device is reached only when every one of them is open.
 */

function csv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function oemUpdatesFlagOn(): boolean {
  return envFlag('BREEZE_OEM_UPDATES_ENABLED', false);
}

export function oemPartnerAllowlistActive(): boolean {
  return csv('BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST').length > 0;
}

/** The master flag, and when `BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST` is set, that partner. */
export function oemUpdatesEnabled(partnerId: string): boolean {
  if (!oemUpdatesFlagOn()) return false;
  const allowlist = csv('BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST');
  return allowlist.length === 0 || allowlist.includes(partnerId.toLowerCase());
}

/**
 * No deploy needed: stops new dispatch and cancels unclaimed commands for the
 * lane. It never interrupts a run in flight.
 */
export function laneDisabledByKillSwitch(lane: OemLane): boolean {
  return csv('BREEZE_OEM_UPDATES_DISABLED_LANES').includes(lane);
}

/**
 * Lab override: opens closed manifest gates for the listed devices only.
 * `config/validate.ts` refuses to boot with it set under NODE_ENV=production;
 * this check keeps it inert there even if validation was skipped.
 */
export function isLabDevice(deviceId: string): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return csv('BREEZE_OEM_UPDATES_LAB_DEVICE_IDS').includes(deviceId.toLowerCase());
}
