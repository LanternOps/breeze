// Device-class segment filter for the unified Devices list (#1424, #4622). The
// merged list carries `deviceClass` ('agent' | 'network' | 'manual') on every
// row; this module holds the pure filter/count logic plus the URL-hash
// persistence so a chosen segment is shareable. Hash state (never query
// params) per CLAUDE.md; a distinct `deviceClass=` key that cooperates with
// the `filtersV2=` writer in filterUrl.ts — each writer preserves the other's
// fragments.
import type { DeviceClass } from './DeviceList';

export type DeviceClassFilter = 'all' | 'agent' | 'network' | 'manual';

const VALID: readonly DeviceClassFilter[] = ['all', 'agent', 'network', 'manual'];
const HASH_KEY = 'deviceClass';

// A row with no explicit deviceClass is an agent (the default arm of the list).
function classOf(device: { deviceClass?: DeviceClass }): DeviceClass {
  return device.deviceClass ?? 'agent';
}

export function filterDevicesByClass<T extends { deviceClass?: DeviceClass }>(
  devices: T[],
  filter: DeviceClassFilter,
): T[] {
  if (filter === 'all') return devices;
  return devices.filter(d => classOf(d) === filter);
}

export function countDevicesByClass(
  devices: Array<{ deviceClass?: DeviceClass }>,
): { all: number; agent: number; network: number; manual: number } {
  let agent = 0;
  let network = 0;
  let manual = 0;
  for (const d of devices) {
    const cls = classOf(d);
    if (cls === 'network') network += 1;
    else if (cls === 'manual') manual += 1;
    else agent += 1;
  }
  return { all: devices.length, agent, network, manual };
}

// The page opens on Agent (#5874): techs mostly arrive for reactive support on
// managed endpoints, and the merged view buries them under discovered assets.
export const DEFAULT_DEVICE_CLASS: DeviceClassFilter = 'agent';

// Per-viewer convenience only: the last segment the user picked. The hash stays
// authoritative for the current view (deep links win); this only fills in when
// the hash says nothing.
export const DEVICE_CLASS_PREFERENCE_KEY = 'breeze.devices.deviceClass';

function isDeviceClassFilter(v: unknown): v is DeviceClassFilter {
  return typeof v === 'string' && (VALID as readonly string[]).includes(v);
}

/** The class named in the hash, or undefined when the hash doesn't name a valid one. */
export function readDeviceClassFromHash(hash: string): DeviceClassFilter | undefined {
  if (!hash) return undefined;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of raw.split('&')) {
    const [k, v] = part.split('=');
    if (k === HASH_KEY && isDeviceClassFilter(v)) return v;
  }
  return undefined;
}

export function readDeviceClassPreference(): DeviceClassFilter {
  try {
    const stored = window.localStorage.getItem(DEVICE_CLASS_PREFERENCE_KEY);
    if (isDeviceClassFilter(stored)) return stored;
  } catch {
    // Storage blocked (private window, disabled site data) — use the default.
  }
  return DEFAULT_DEVICE_CLASS;
}

export function saveDeviceClassPreference(filter: DeviceClassFilter): void {
  try {
    window.localStorage.setItem(DEVICE_CLASS_PREFERENCE_KEY, filter);
  } catch {
    // Best-effort convenience; the hash still carries the current choice.
  }
}

/** Hash deep link first, then the remembered choice, then the Agent default. */
export function resolveDeviceClass(hash: string): DeviceClassFilter {
  return readDeviceClassFromHash(hash) ?? readDeviceClassPreference();
}

export function writeDeviceClassToHash(filter: DeviceClassFilter): void {
  if (typeof window === 'undefined') return;
  const existing = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  // Preserve every fragment except our own key (mirrors writeFilterToHash).
  const others = existing
    .split('&')
    .filter(p => p && !p.startsWith(`${HASH_KEY}=`));
  // Always explicit: an absent key resolves to the viewer's remembered choice
  // (#5874), so a link must name its segment to mean the same thing to others.
  const next = [`${HASH_KEY}=${filter}`, ...others].join('&');
  const newHash = next ? `#${next}` : '';
  if (newHash !== window.location.hash) {
    // Replace, don't push, so the back button doesn't fill with segment toggles.
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}${newHash}`);
  }
}
