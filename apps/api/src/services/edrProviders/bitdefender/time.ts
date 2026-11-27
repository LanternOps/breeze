import { zonedWallClockToUtc } from '../../zonedTime';

/*
 * GravityZone timestamps (#12821).
 *
 * The Network, Quarantine, Companies and General APIs send date-times with no
 * offset ("2026-11-27T17:17:34"), written in the timezone of the account that
 * owns the API key. A personal key therefore answers in its owner's timezone,
 * DST included; a service API key answers in UTC. The Incidents API sends an
 * explicit offset ("-05:00" for the same personal key, "+00:00" for a service
 * key), and the vendor reads the ISO `Z` instants Breeze sends as UTC. All
 * verified live 2026-11-27 with both key types against one endpoint.
 *
 * So an offset-less vendor time is only an instant once the account timezone
 * is known. When it is not, the value is null: a time off by an unknown offset
 * (up to 14 h either way) would mislead a technician deciding whether a device
 * is stale; "unknown" does not.
 */

const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
const NO_OFFSET = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/;

const validZones = new Map<string, boolean>();

/** True when `timeZone` names a zone the runtime's timezone database knows. */
export function isKnownTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  let ok = validZones.get(timeZone);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone });
      ok = true;
    } catch {
      ok = false;
    }
    validZones.set(timeZone, ok);
  }
  return ok;
}

/** True for a vendor date-time that needs the account timezone to become an instant. */
export function lacksOffset(raw: unknown): boolean {
  return typeof raw === 'string' && NO_OFFSET.test(raw.trim());
}

/**
 * The instant of a GravityZone date-time. An explicit offset (or `Z`) is used
 * as sent. An offset-less value is read as wall-clock time in `timeZone` (the
 * key owner's account timezone, `UTC` for a service key) using the runtime's
 * timezone database; with no known zone it is null. On a DST fall-back day the
 * repeated hour resolves to its first occurrence; a wall time skipped by a
 * spring-forward moves forward into the new offset.
 */
export function parseGzDate(raw: unknown, timeZone: string | null): Date | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  if (WITH_OFFSET.test(s)) {
    const d = new Date(s.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const m = NO_OFFSET.exec(s);
  if (!m || timeZone === null || !isKnownTimeZone(timeZone)) return null;
  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number) as [number, number, number, number, number];
  const second = m[6] ? Number(m[6]) : 0;
  const millis = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  // Reject a calendar date that does not exist (Date.UTC would roll 02-30 over to March).
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;

  // Offsets change on whole minutes, so seconds and milliseconds are added after the minute is placed.
  const atMinute = zonedWallClockToUtc({ year, month, day, hour, minute }, timeZone);
  return new Date(atMinute.getTime() + second * 1000 + millis);
}
