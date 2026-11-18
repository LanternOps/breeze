/**
 * SMBIOS system UUID normalization and match forms (#8318 §7.1–§7.2).
 *
 * The agent normalizes the value before sending it
 * (agent/internal/collectors/hardware.go normalizeSystemUUID); the server
 * normalizes again, because an old or odd agent may send anything. Both sides
 * use the same rules and the same placeholder list, pinned by the shared
 * vectors in packages/shared/src/testing/system-uuid-normalization-v1.json.
 *
 * This lives in the API, not in @breeze/shared: the API is its only
 * TypeScript consumer, and the shared JSON fixture (read by the Go and the TS
 * tests) is what keeps the two implementations in step.
 */

/**
 * SMBIOS system UUIDs that firmware vendors ship unchanged on every board of
 * a model, so they identify nothing: the AMI Aptio default and its SMBIOS
 * < 2.6 byte-swapped reading (the values behind the Configuration Manager
 * "duplicate hardware identifiers" exclusion list and the duplicate-UUID
 * reports against MDT/WDS and osquery), a white-box fill pattern, and the
 * all-zero / all-F values. Any single repeated hex digit is rejected by rule.
 * Keep this a small, reviewed set and identical to the Go list.
 */
export const PLACEHOLDER_SYSTEM_UUIDS: ReadonlySet<string> = new Set([
  '03000200-0400-0500-0006-000700080009',
  '00020003-0004-0005-0006-000700080009',
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  '01234567-8901-2345-6789-012345678901',
]);

const HEX32 = /^[0-9a-f]{32}$/;
const DASHED = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The canonical lower-case 8-4-4-4-12 form of an SMBIOS system UUID, or null
 * when the value is not exactly 32 hex digits (with or without the dashes,
 * optionally in braces and surrounded by whitespace) or is a placeholder.
 */
export function normalizeSystemUuid(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  // Go's strings.TrimSpace and String.prototype.trim agree on every
  // whitespace character except U+FEFF (trimmed here only); no agent emits it.
  let s = raw.trim();
  if (s.startsWith('{')) s = s.slice(1);
  if (s.endsWith('}')) s = s.slice(0, -1);
  s = s.trim();
  if (s.length === 36) {
    if (!DASHED.test(s)) return null;
    s = s.replace(/-/g, '');
  } else if (s.length !== 32) {
    return null;
  }
  s = s.toLowerCase();
  if (!HEX32.test(s)) return null;
  if (s.split('').every((c) => c === s[0])) return null;
  const canonical = `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  return PLACEHOLDER_SYSTEM_UUIDS.has(canonical) ? null : canonical;
}

function reverseBytes(hex: string): string {
  const pairs = hex.match(/../g) ?? [];
  return pairs.reverse().join('');
}

/**
 * The SMBIOS < 2.6 mixed-endian reading of a canonical UUID: the first three
 * fields (Data1, 4 bytes; Data2, 2; Data3, 2) byte-reversed, the last eight
 * bytes as written. Applying it twice is the identity.
 */
export function byteSwapSystemUuid(canonical: string): string {
  const [d1, d2, d3, d4, d5] = canonical.split('-') as [string, string, string, string, string];
  return `${reverseBytes(d1)}-${reverseBytes(d2)}-${reverseBytes(d3)}-${d4}-${d5}`;
}

/**
 * Every stored form that may denote the same machine: the canonical value and
 * its byte-swapped reading (firmware that predates SMBIOS 2.6, or a reader that
 * decodes it the other way, reports the swapped form for the same board).
 * Deduplicated; empty for a value that does not normalize.
 */
export function systemUuidMatchForms(uuid: string | null | undefined): string[] {
  const canonical = normalizeSystemUuid(uuid);
  if (!canonical) return [];
  const swapped = byteSwapSystemUuid(canonical);
  return swapped === canonical ? [canonical] : [canonical, swapped];
}
