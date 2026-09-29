import data from '../data/windowsZones.json';
const mapping: Readonly<Record<string, string>> = data.ianaToWindows;
export const WINDOWS_ZONE_IDS: readonly string[] = Object.freeze([
  ...data.windowsIds,
]);
const windowsIds = new Set(WINDOWS_ZONE_IDS);
export function ianaToWindowsZone(iana: string): string | null {
  return Object.hasOwn(mapping, iana) ? mapping[iana]! : null;
}
export function isKnownWindowsZone(windowsId: string): boolean {
  return windowsIds.has(windowsId);
}
