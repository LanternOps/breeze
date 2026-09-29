import { afterEach, expect, it, vi } from 'vitest';
import data from '../data/windowsZones.json';
import {
  ianaToWindowsZone,
  isKnownWindowsZone,
  WINDOWS_ZONE_IDS,
} from './windowsZones';
import { listIanaTimezones } from './timezone';

afterEach(() => vi.restoreAllMocks());
it.each([
  ['America/New_York', 'Eastern Standard Time'],
  ['America/Detroit', 'Eastern Standard Time'],
  ['Europe/London', 'GMT Standard Time'],
  ['Asia/Kolkata', 'India Standard Time'],
  ['UTC', 'UTC'],
  ['Etc/UTC', 'UTC'],
])('maps %s to %s', (iana, windows) => {
  expect(ianaToWindowsZone(iana)).toBe(windows);
  expect(isKnownWindowsZone(windows)).toBe(true);
});
it('preserves a version, unique Windows IDs, and strict unknown handling', () => {
  expect(data.cldrVersion).toBe('48.2');
  expect(new Set(WINDOWS_ZONE_IDS).size).toBe(WINDOWS_ZONE_IDS.length);
  expect(ianaToWindowsZone('Invalid/Zone')).toBeNull();
  expect(ianaToWindowsZone('toString')).toBeNull();
  expect(isKnownWindowsZone('eastern standard time')).toBe(false);
});
it('maps every CLDR-representable timezone offered by the live site picker', () => {
  const missing = listIanaTimezones().filter(
    (zone) => ianaToWindowsZone(zone) === null,
  );
  expect(
    missing,
    'Only the documented unrepresentable IANA zone is unmapped',
  ).toEqual(['Antarctica/Troll']);
});
it('maps the fallback picker when Intl enumeration is unavailable', async () => {
  vi.resetModules();
  vi.spyOn(Intl, 'supportedValuesOf').mockImplementation(() => []);
  const { listIanaTimezones: fallback } = await import('./timezone');
  expect(fallback().filter((zone) => ianaToWindowsZone(zone) === null)).toEqual(
    [],
  );
});
