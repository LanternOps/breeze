// Cron structural validation, shared by the API's `scheduleRegistry.ts`
// (operator env-var cron overrides) and the P2-2 scheduled-sweeps DTOs
// (`AiAgentScheduleDto.cron`). Moved verbatim from
// `apps/api/src/jobs/scheduleRegistry.ts` (P2-2 task 2) so the shared
// validator package can enforce the same structural rule the API's job
// scheduler already relied on — see `scheduleRegistry.ts`'s re-export for
// why this lives in `@breeze/shared` and not just the API.

const CRON_FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (7 == Sunday)
];

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function isValidCronField(field: string, index: number): boolean {
  const [min, max] = CRON_FIELD_RANGES[index]!;
  const names = index === 3 ? MONTH_NAMES : index === 4 ? DAY_NAMES : [];

  const readValue = (token: string): number | null => {
    const named = names.indexOf(token.toLowerCase());
    if (named >= 0) return index === 3 ? named + 1 : named;
    if (!/^\d+$/.test(token)) return null;
    const value = Number(token);
    return value >= min && value <= max ? value : null;
  };

  return field.split(',').every((listItem) => {
    if (listItem === '') return false;
    const [rangePart, stepPart, ...extra] = listItem.split('/');
    if (extra.length > 0) return false;
    if (stepPart !== undefined && !/^[1-9]\d*$/.test(stepPart)) return false;
    if (rangePart === '*') return true;
    const bounds = rangePart!.split('-');
    if (bounds.length > 2) return false;
    const parsed = bounds.map(readValue);
    if (parsed.some((value) => value === null)) return false;
    if (parsed.length === 2 && parsed[0]! > parsed[1]!) return false;
    return true;
  });
}

/**
 * Structural validation of an operator-supplied cron pattern.
 *
 * Deliberately does NOT use `cron-parser` — that is a devDependency, and this
 * module is loaded by the production API. This checks field count and per-field
 * token/range validity, which is what catches the realistic operator mistake
 * (a two-field value such as star-slash-five, which looks fine and is not).
 * `scheduleRegistry.contract.test.ts`
 * cross-checks this function against the real parser over a corpus.
 */
export function isStructurallyValidCron(pattern: string): boolean {
  const fields = pattern.trim().split(/\s+/);
  // 6 fields = the optional leading seconds field BullMQ also accepts.
  if (fields.length !== 5 && fields.length !== 6) return false;
  const fiveFields = fields.length === 6 ? fields.slice(1) : fields;
  if (fields.length === 6 && !isValidCronField(fields[0]!, 0)) return false;
  return fiveFields.every((field, index) => isValidCronField(field, index));
}

// ---------------------------------------------------------------------------
// Next-occurrence evaluation
//
// AI patch agent W01 (#5747). Moved here from
// `apps/web/src/components/settings/AiAgentSchedulesSection.tsx`, unchanged in
// behaviour, because the agents LIST ROUTE now reports `nextOccurrenceAt` on
// every agent card: the card and the schedules drawer must evaluate ONE
// implementation or they will disagree about when an agent next fires.
//
// Deliberately still does NOT use `cron-parser` (an API devDependency, and
// this module ships to the browser). It evaluates exactly the grammar
// `isValidCronField` above accepts.
//
// TIMEZONE. The search runs on the schedule's OWN wall clock: "now" is read
// into that zone once, then a plain calendar walk finds the first matching
// minute. A DST transition is not modelled — an occurrence one hour off twice
// a year is the accepted cost of not shipping a tz library. The scheduler, not
// this function, decides when a run actually fires.
// ---------------------------------------------------------------------------

/** Every value one cron field matches, or null when the field does not parse. */
function expandCronField(
  field: string,
  min: number,
  max: number,
  names: readonly string[],
): Set<number> | null {
  const readValue = (token: string): number | null => {
    const named = names.indexOf(token.toLowerCase());
    // Month names are 1-based, day names 0-based — the same asymmetry
    // `isValidCronField` encodes.
    if (named >= 0) return names === MONTH_NAMES ? named + 1 : named;
    if (!/^\d+$/.test(token)) return null;
    const value = Number(token);
    return value >= min && value <= max ? value : null;
  };

  const values = new Set<number>();
  for (const listItem of field.split(',')) {
    if (listItem === '') return null;
    const [rangePart, stepPart, ...extra] = listItem.split('/');
    if (extra.length > 0) return null;
    if (stepPart !== undefined && !/^[1-9]\d*$/.test(stepPart)) return null;
    const step = stepPart === undefined ? 1 : Number(stepPart);
    let from: number;
    let to: number;
    if (rangePart === '*') {
      from = min;
      to = max;
    } else {
      const bounds = (rangePart ?? '').split('-');
      if (bounds.length > 2) return null;
      const parsed = bounds.map(readValue);
      if (parsed.some((value) => value === null)) return null;
      from = parsed[0] as number;
      // A bare `5/15` means "from 5 to the end of the range, every 15" —
      // a lone value with no step is just itself.
      to = parsed.length === 2 ? (parsed[1] as number) : stepPart === undefined ? from : max;
      if (from > to) return null;
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values.size === 0 ? null : values;
}

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export function parseFiveFieldCron(cron: string): CronFields | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = expandCronField(parts[0]!, 0, 59, []);
  const hours = expandCronField(parts[1]!, 0, 23, []);
  const daysOfMonth = expandCronField(parts[2]!, 1, 31, []);
  const months = expandCronField(parts[3]!, 1, 12, MONTH_NAMES);
  const rawDaysOfWeek = expandCronField(parts[4]!, 0, 7, DAY_NAMES);
  if (!minutes || !hours || !daysOfMonth || !months || !rawDaysOfWeek) return null;
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    // 7 and 0 are both Sunday.
    daysOfWeek: new Set([...rawDaysOfWeek].map((day) => (day === 7 ? 0 : day))),
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

/**
 * First matching wall-clock minute strictly after `fromMs`, expressed as a
 * floating instant (the Y-M-D H:M read as if it were UTC). Null when nothing
 * matches inside a year — `0 0 30 2 *` is structurally valid and never fires.
 */
export function nextCronOccurrence(fields: CronFields, fromMs: number): Date | null {
  const cursor = new Date(Math.floor(fromMs / 60000) * 60000 + 60000);
  for (let day = 0; day < 400; day += 1) {
    if (fields.months.has(cursor.getUTCMonth() + 1)) {
      const domHit = fields.daysOfMonth.has(cursor.getUTCDate());
      const dowHit = fields.daysOfWeek.has(cursor.getUTCDay());
      // Vixie cron: when BOTH day fields are restricted the day matches if
      // EITHER does; otherwise the unrestricted one is a no-op `*`.
      const dayHit = fields.domRestricted && fields.dowRestricted ? domHit || dowHit : domHit && dowHit;
      if (dayHit) {
        const fromHour = cursor.getUTCHours();
        for (let hour = fromHour; hour < 24; hour += 1) {
          if (!fields.hours.has(hour)) continue;
          const fromMinute = hour === fromHour ? cursor.getUTCMinutes() : 0;
          for (let minute = fromMinute; minute < 60; minute += 1) {
            if (!fields.minutes.has(minute)) continue;
            return new Date(Date.UTC(
              cursor.getUTCFullYear(),
              cursor.getUTCMonth(),
              cursor.getUTCDate(),
              hour,
              minute,
            ));
          }
        }
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursor.setUTCHours(0, 0, 0, 0);
  }
  return null;
}

/** "Now" as a floating instant on `timezone`'s wall clock. */
export function wallClockNow(timezone: string, now: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(now);
    const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const year = read('year');
    if (!Number.isFinite(year)) throw new Error('unreadable parts');
    // `hour12: false` renders midnight as 24 in some ICU versions.
    return Date.UTC(year, read('month') - 1, read('day'), read('hour') % 24, read('minute'));
  } catch {
    // An unknown zone must not blank the whole row — fall back to UTC and
    // keep the label, which names the zone the schedule actually stores.
    return Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(),
    );
  }
}

/**
 * The next firing of `cron` in `timezone` as a REAL ISO-8601 instant, or null
 * when the pattern does not parse or never fires.
 *
 * `nextCronOccurrence` returns a floating wall-clock instant; this converts it
 * back to an absolute time by measuring the zone's offset at that wall clock,
 * which is what an API response needs (the drawer renders the floating value
 * directly beside the zone's name instead).
 */
export function nextCronOccurrenceAt(cron: string, timezone: string, now: Date = new Date()): string | null {
  const fields = parseFiveFieldCron(cron);
  if (!fields) return null;
  const floating = nextCronOccurrence(fields, wallClockNow(timezone, now));
  if (!floating) return null;
  // Offset at the target wall clock: read the floating instant back out of the
  // zone and take the difference. One pass is enough for every non-DST-boundary
  // case, which is the same accuracy bound the drawer accepts.
  const offsetMs = floating.getTime() - wallClockNow(timezone, floating);
  return new Date(floating.getTime() + offsetMs).toISOString();
}
