/**
 * Display name for a device's OS.
 *
 * `device.os` / `MobileDeviceRecord.osType` carries the raw backend enum
 * (`windows` / `macos` / `linux` — see OS_TYPES in packages/shared/src/constants)
 * rather than something a technician should read. Both device screens render it,
 * so the mapping lives here rather than in either screen: a helper imported from
 * a sibling *screen* makes the list screen depend on the detail screen's module
 * graph for one pure string function.
 *
 * Lives in lib/ (next to relativeTime.ts) and imports nothing, so it stays
 * node-testable without dragging react-native into the Vitest runner.
 */
export function osLabel(osType: string): string {
  switch (osType.toLowerCase()) {
    case 'windows':
      return 'Windows';
    case 'macos':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      // Unrecognized value (a future OS type, or bad data) — show it rather
      // than hide it, but at least capitalized so it doesn't read as a raw
      // enum slug.
      return osType.charAt(0).toUpperCase() + osType.slice(1);
  }
}
