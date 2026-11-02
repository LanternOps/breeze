/**
 * Serial + manufacturer match keys for the reinstall candidate search
 * (#8318 §7.3). Current agents drop placeholder serials and vendors before
 * sending them (agent/internal/collectors/hardware.go cleanHardwareIdentityValue,
 * on Linux only since this wave, F16); agents already in the field may still
 * report "To Be Filled By O.E.M." or "System Serial Number", which would match
 * every unbranded board in a partner. The server therefore refuses the same
 * placeholder set before it uses a value as a match key.
 *
 * The keys are the expressions device_hardware_serial_vendor_idx indexes:
 * upper(btrim(serial_number)) and lower(btrim(manufacturer)). Postgres btrim
 * trims spaces only, so the key does too.
 */

/** Mirrors the switch in cleanHardwareIdentityValue (Go). Keep both in step. */
const PLACEHOLDER_IDENTITY_VALUES: ReadonlySet<string> = new Set([
  '0',
  '00000000',
  '000000000000000',
  '123456789',
  'default string',
  'none',
  'null',
  'n/a',
  'na',
  'not applicable',
  'not available',
  'not specified',
  'o.e.m',
  'oem',
  'serial number',
  'system manufacturer',
  'system product name',
  'system serial number',
  'unknown',
]);

/** True when the value is empty or a firmware placeholder (the Go cleaner's rules). */
export function isPlaceholderHardwareIdentity(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  const normalized = trimmed.toLowerCase().split(/\s+/).join(' ').replace(/^\.+|\.+$/g, '');
  if (PLACEHOLDER_IDENTITY_VALUES.has(normalized)) return true;
  return normalized.includes('to be filled by');
}

function btrimSpaces(value: string): string {
  return value.replace(/^ +| +$/g, '');
}

/**
 * The (serial, manufacturer) match key, or null when either is missing or a
 * placeholder after cleaning.
 */
export function serialManufacturerKey(
  serialNumber: string | null | undefined,
  manufacturer: string | null | undefined,
): { serialKey: string; manufacturerKey: string } | null {
  if (isPlaceholderHardwareIdentity(serialNumber) || isPlaceholderHardwareIdentity(manufacturer)) return null;
  const serialKey = btrimSpaces(serialNumber!).toUpperCase();
  const manufacturerKey = btrimSpaces(manufacturer!).toLowerCase();
  if (!serialKey || !manufacturerKey) return null;
  return { serialKey, manufacturerKey };
}
