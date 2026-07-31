// Canonical timezone helpers shared by the API, workers, and web.
//
// Background (issue #1318): timezone (IANA tz string) fields are scattered
// across many features and each one previously defaulted independently —
// almost always to a hardcoded 'UTC'. This module centralizes two concerns:
//
//   1. IANA validation — the duplicated `Intl.DateTimeFormat` try/catch that
//      lived in orgs.ts, discovery.ts, backup/helpers.ts, discoveryWorker.ts,
//      and patchSchedulerWorker.ts.
//   2. Default resolution order — explicit -> site -> org -> partner -> UTC,
//      so the *partner* timezone becomes the base default instead of UTC.
//
// DST is handled correctly anywhere `Intl.DateTimeFormat` is used; never do
// manual offset math against these strings.

export const UTC_TIMEZONE = 'UTC';

// `Intl.supportedValuesOf('timeZone')` omits UTC, GMT, and the Etc/* zones, so
// a Set-membership check against that list would reject 'UTC' (the default).
// Constructing `Intl.DateTimeFormat` throws RangeError on unknown zones and
// accepts everything Intl recognizes, including those omissions.
export function isValidIanaTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Returns `tz` when it is a valid IANA zone, otherwise `fallback`. Use this to
// replace the scattered `tz || 'UTC'` / `tz ?? 'UTC'` fallbacks so an invalid
// stored value can never reach `Intl.DateTimeFormat` and throw at format time.
export function normalizeTimezone(
  tz: unknown,
  fallback: string = UTC_TIMEZONE,
): string {
  if (isValidIanaTimezone(tz)) return tz;
  return isValidIanaTimezone(fallback) ? fallback : UTC_TIMEZONE;
}

// Canonicalize a tz string on write. Intl treats UTC case-insensitively, so a
// caller can persist 'utc' / 'Utc' — but the 'UTC' sentinel logic elsewhere
// (e.g. `partnerTimezoneFrom`, which uses `column !== 'UTC'` to tell "still at
// the default" from "explicitly set") does an exact string compare and would
// mistake a stored 'utc' for a real, non-default candidate. Fold every casing
// of the UTC sentinel back to the canonical 'UTC' so that comparison holds.
// Returns null for a value that is not a valid IANA zone, so callers can reject
// or skip it rather than persisting garbage.
export function canonicalizeTimezone(tz: unknown): string | null {
  if (!isValidIanaTimezone(tz)) return null;
  return tz.toUpperCase() === UTC_TIMEZONE ? UTC_TIMEZONE : tz;
}

// Zones to fall back on when `Intl.supportedValuesOf` is unavailable (it is
// ES2022 — every browser we target ships it, but an old embedded WebView or a
// stripped-down JS runtime may not). Deliberately broader than the two
// hardcoded UI lists this replaced (issue #2856): the failure mode being fixed
// is "my zone isn't in the list", so a fallback that reproduces a 10-entry
// US-centric list would just reintroduce the bug on those runtimes. Every zone
// the old SiteForm/PartnerRegionalTab lists offered is included.
const FALLBACK_IANA_TIMEZONES = [
  'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Nairobi',
  'America/Anchorage', 'America/Argentina/Buenos_Aires', 'America/Bogota',
  'America/Chicago', 'America/Denver', 'America/Halifax', 'America/Los_Angeles',
  'America/Mexico_City', 'America/New_York', 'America/Phoenix',
  'America/Sao_Paulo', 'America/Toronto', 'America/Vancouver',
  'Asia/Dubai', 'Asia/Hong_Kong', 'Asia/Jakarta', 'Asia/Jerusalem',
  'Asia/Kolkata', 'Asia/Manila', 'Asia/Seoul', 'Asia/Shanghai',
  'Asia/Singapore', 'Asia/Tokyo',
  'Atlantic/Reykjavik',
  'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Melbourne',
  'Australia/Perth', 'Australia/Sydney',
  'Europe/Amsterdam', 'Europe/Athens', 'Europe/Berlin', 'Europe/Brussels',
  'Europe/Bucharest', 'Europe/Budapest', 'Europe/Copenhagen', 'Europe/Dublin',
  'Europe/Helsinki', 'Europe/Istanbul', 'Europe/Lisbon', 'Europe/London',
  'Europe/Madrid', 'Europe/Moscow', 'Europe/Oslo', 'Europe/Paris',
  'Europe/Prague', 'Europe/Rome', 'Europe/Stockholm', 'Europe/Vienna',
  'Europe/Warsaw', 'Europe/Zurich',
  'Pacific/Auckland', 'Pacific/Honolulu',
];

let cachedZones: string[] | null = null;

// The full IANA zone list for pickers: `Intl.supportedValuesOf('timeZone')`
// (~418 zones) with the 'UTC' sentinel prepended, since that call omits it (see
// the note on `isValidIanaTimezone`). Result is cached — the underlying list is
// constant for the life of the process and building it is not free.
//
// Returns a fresh copy each call so a caller sorting/splicing the array in
// place cannot corrupt the cache for everyone else.
export function listIanaTimezones(): string[] {
  if (cachedZones) return [...cachedZones];

  let supported: string[] = [];
  try {
    // `supportedValuesOf` is ES2022; guard rather than assume, and treat a
    // throwing or empty implementation the same as a missing one.
    if (typeof Intl.supportedValuesOf === 'function') {
      supported = [...Intl.supportedValuesOf('timeZone')];
    }
  } catch {
    supported = [];
  }

  const zones = supported.length > 0 ? supported : [...FALLBACK_IANA_TIMEZONES];
  // UTC first (it is the API default), everything else alphabetical.
  const rest = [...new Set(zones.filter((z) => z !== UTC_TIMEZONE))].sort((a, b) =>
    a.localeCompare(b),
  );
  cachedZones = [UTC_TIMEZONE, ...rest];
  return [...cachedZones];
}

export interface EffectiveTimezoneInput {
  /** A tz explicitly stored on the entity (maintenance window, automation, …). */
  explicit?: string | null;
  /** The device's site timezone (`sites.timezone`). */
  siteTz?: string | null;
  /** The organization timezone (today: `organizations.settings.timezone`). */
  orgTz?: string | null;
  /** The partner timezone (`partners.timezone`, falling back to its settings key). */
  partnerTz?: string | null;
}

// Resolution order: explicit -> site -> org -> partner -> UTC.
//
// The change from the historical behavior (which stopped at site -> org -> UTC)
// is inserting the partner timezone between org and the 'UTC' floor, making the
// partner tz the canonical default and 'UTC' only a true last resort. Each
// candidate is IANA-validated, so a garbage value at one level is skipped
// rather than short-circuiting to UTC.
export function resolveEffectiveTimezone(input: EffectiveTimezoneInput): string {
  const candidates = [input.explicit, input.siteTz, input.orgTz, input.partnerTz];
  for (const candidate of candidates) {
    if (isValidIanaTimezone(candidate)) return candidate;
  }
  return UTC_TIMEZONE;
}
