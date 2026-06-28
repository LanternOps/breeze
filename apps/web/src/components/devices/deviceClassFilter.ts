// Device-class segment filter for the unified Devices list (#1424). The merged
// list carries `deviceClass` ('agent' | 'network') on every row; this module
// holds the pure filter/count logic plus the URL-hash persistence so a chosen
// segment is shareable. Hash state (never query params) per CLAUDE.md; a
// distinct `deviceClass=` key that cooperates with the `filtersV2=` writer in
// filterUrl.ts — each writer preserves the other's fragments.
import type { DeviceClass } from './DeviceList';

export type DeviceClassFilter = 'all' | 'agent' | 'network';

const VALID: readonly DeviceClassFilter[] = ['all', 'agent', 'network'];
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
): { all: number; agent: number; network: number } {
  let agent = 0;
  let network = 0;
  for (const d of devices) {
    if (classOf(d) === 'network') network += 1;
    else agent += 1;
  }
  return { all: devices.length, agent, network };
}

export function readDeviceClassFromHash(hash: string): DeviceClassFilter {
  if (!hash) return 'all';
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of raw.split('&')) {
    const [k, v] = part.split('=');
    if (k === HASH_KEY && v && (VALID as readonly string[]).includes(v)) {
      return v as DeviceClassFilter;
    }
  }
  return 'all';
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
  // 'all' is the default — drop the key entirely to keep the URL clean.
  const next = filter === 'all'
    ? others.join('&')
    : [`${HASH_KEY}=${filter}`, ...others].join('&');
  const newHash = next ? `#${next}` : '';
  if (newHash !== window.location.hash) {
    // Replace, don't push, so the back button doesn't fill with segment toggles.
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}${newHash}`);
  }
}
