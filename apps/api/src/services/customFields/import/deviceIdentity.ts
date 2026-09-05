/**
 * Device identity normalisation for the RMM custom-field importer (#3257 W06).
 *
 * Junk hardware-identity values, ported VERBATIM from the Go agent's
 * cleanHardwareIdentityValue (agent/internal/collectors/hardware.go:156-190).
 *
 * The agent applies it only on Windows (hardware_windows.go:136); Linux reads
 * raw DMI (hardware_linux.go:35) and macOS shells out to system_profiler
 * (hardware_darwin.go:36), and both write the raw value through. So these
 * values are ALREADY in device_hardware.serial_number and must be filtered on
 * BOTH sides of an import join — otherwise every Linux box reporting
 * "Default string" collapses into one giant ambiguous group.
 *
 * It is an EXACT list, not a general all-zeros pattern: a zero run of a
 * different length passes straight through, in Go and here. Do not "improve" it
 * into a regex — divergence from the agent is worse than the gap.
 */
export const JUNK_HARDWARE_IDENTITY_VALUES: ReadonlySet<string> = new Set([
  '0', '00000000', '000000000000000', '123456789', 'default string', 'none',
  'null', 'n/a', 'na', 'not applicable', 'not available', 'not specified',
  'o.e.m', 'oem', 'serial number', 'system manufacturer',
  'system product name', 'system serial number', 'unknown',
]);

/**
 * Normalise exactly as the Go collector does before comparing:
 * `strings.ToLower(strings.Join(strings.Fields(v), " "))` then
 * `strings.Trim(v, ".")`.
 */
function normalizeIdentityForComparison(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part !== '')
    .join(' ')
    .replace(/^\.+|\.+$/g, '');
}

/**
 * True when a reported hardware identity carries no information — a BIOS
 * placeholder, a filler string, or nothing at all. Such a value must never
 * participate in a device match on either side of the join.
 */
export function isJunkHardwareIdentity(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (value.trim() === '') return true;
  const normalized = normalizeIdentityForComparison(value);
  // A value that normalises away entirely (". . .") identifies nothing. Go
  // returns it unchanged because its switch has no empty arm, but the collector
  // only ever compares non-empty output, so refusing it here is the port of the
  // INTENT rather than a divergence from the list.
  if (normalized === '') return true;
  if (JUNK_HARDWARE_IDENTITY_VALUES.has(normalized)) return true;
  return normalized.includes('to be filled by');
}

/**
 * The comparison form of a serial number: `upper(btrim(...))`, matching the
 * `device_hardware_org_serial_idx` expression index exactly. Deliberately does
 * NOT collapse internal whitespace — `btrim` does not either, and the two sides
 * of the join have to agree. Returns null for junk or empty input, so a caller
 * can treat "no usable serial" and "no serial supplied" identically.
 */
export function normalizeSerial(value: string | null | undefined): string | null {
  if (isJunkHardwareIdentity(value)) return null;
  return value!.trim().toUpperCase();
}

/**
 * The comparison form of a hostname: `lower(btrim(...))`, matching the
 * `devices_org_hostname_lower_idx` expression index. The junk denylist does NOT
 * apply — "unknown" is an unhelpful but perfectly legal hostname, and a machine
 * really named that should still be matchable.
 */
export function normalizeHostname(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed.toLowerCase();
}
