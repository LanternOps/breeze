// Pure planning for the daily connection health digest (spec 2026-10-15 §4,
// W3 plan D2/D4/D5). No I/O: digest.ts loads rows and calls these.

/** Partner-local hours in which a partner is due (08:00 target, catch-up through 11:59; plan D2). */
export const DIGEST_FIRST_HOUR = 8;
export const DIGEST_LAST_HOUR = 11;
/** An incident appears daily for its first 7 local days open, then only on Mondays (§4 decay). */
export const DAILY_MENTION_DAYS = 7;
const MONDAY = 1;

export type LocalClock = { date: string; hour: number; weekday: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Partner-local calendar date (YYYY-MM-DD), hour (0–23) and weekday (0 = Sunday). An invalid zone reads as UTC. */
export function localClock(now: Date, timeZone: string): LocalClock {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatterFor(timeZone || 'UTC').formatToParts(now);
  } catch {
    parts = formatterFor('UTC').formatToParts(now);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number.parseInt(get('hour'), 10),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

export function isDigestHour(hour: number): boolean {
  return hour >= DIGEST_FIRST_HOUR && hour <= DIGEST_LAST_HOUR;
}

const dayNumber = (isoDate: string) => Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000);

/** Whole partner-local calendar days between opening and now (0 = opened today). */
export function localAgeDays(openedAt: Date, now: Date, timeZone: string): number {
  return Math.max(0, dayNumber(localClock(now, timeZone).date) - dayNumber(localClock(openedAt, timeZone).date));
}

export function includeOpenIncident(ageDays: number, weekday: number): boolean {
  return ageDays < DAILY_MENTION_DAYS || weekday === MONDAY;
}

export type DigestIncident = {
  id: string;
  orgId: string | null;
  orgName: string | null;
  displayName: string;
  condition: string;
  severity: string;
  /** Already sanitized at write time (spec §7); escaped again by the template. */
  detail: string | null;
  /** The link for THIS recipient (the owner's link for the grant owner). */
  fixHref: string;
  openedAt: Date;
  resolvedAt: Date | null;
  resolution: string | null;
};

/** Partner-wide (no org) first, then by org name, then by display name, id as the tiebreak. */
export function sortForDigest<T extends DigestIncident>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if ((a.orgId === null) !== (b.orgId === null)) return a.orgId === null ? -1 : 1;
    return (a.orgName ?? '').localeCompare(b.orgName ?? '')
      || a.displayName.localeCompare(b.displayName)
      || a.id.localeCompare(b.id);
  });
}

export type UserDigestPlan = { open: DigestIncident[]; restored: DigestIncident[] };

/**
 * What one user's digest says today, or null when it has nothing to say.
 *  - open: the user's open incidents that pass the decay rule;
 *  - restored: recovered incidents the user was told about in a sent digest
 *    (toldIncidentIds) that resolved after their last sent digest (plan D4).
 *    Retired incidents never get a restored line (spec §1.1).
 */
export function planUserDigest(input: {
  open: readonly DigestIncident[];
  resolved: readonly DigestIncident[];
  toldIncidentIds: ReadonlySet<string>;
  lastSentAt: Date | null;
  now: Date;
  timeZone: string;
}): UserDigestPlan | null {
  const { weekday } = localClock(input.now, input.timeZone);
  const open = input.open.filter(
    (i) => includeOpenIncident(localAgeDays(i.openedAt, input.now, input.timeZone), weekday),
  );
  const lastSentAt = input.lastSentAt;
  const restored = lastSentAt
    ? input.resolved.filter(
        (i) => i.resolution === 'recovered'
          && i.resolvedAt !== null
          && i.resolvedAt > lastSentAt
          && input.toldIncidentIds.has(i.id),
      )
    : [];
  if (open.length === 0 && restored.length === 0) return null;
  return { open: sortForDigest(open), restored: sortForDigest(restored) };
}
