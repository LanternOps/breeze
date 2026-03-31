import type { BackupPolicySchedule } from './types';

export function toDateOrNull(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime();
}

type LocalTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

function parseTime(time: string | undefined, fallback = '02:00'): [number, number] {
  const [hourRaw, minuteRaw] = (time || fallback).split(':');
  return [
    Number.parseInt(hourRaw ?? '2', 10) || 0,
    Number.parseInt(minuteRaw ?? '0', 10) || 0,
  ];
}

function parseWindowTime(value?: string): number | null {
  if (!value) return null;
  const [hour, minute] = parseTime(value, '00:00');
  return (hour * 60) + minute;
}

function parseWeekday(value: string): number {
  switch (value.toLowerCase()) {
    case 'sun':
      return 0;
    case 'mon':
      return 1;
    case 'tue':
      return 2;
    case 'wed':
      return 3;
    case 'thu':
      return 4;
    case 'fri':
      return 5;
    case 'sat':
      return 6;
    default:
      return 0;
  }
}

export function resolveScheduleTimeZone(value?: string, fallbackTimezone?: string): string {
  const candidate = value?.trim() || fallbackTimezone?.trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return 'UTC';
  }
}

function getOffsetMs(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '0';
  const utcTime = Date.UTC(
    Number.parseInt(get('year'), 10),
    Number.parseInt(get('month'), 10) - 1,
    Number.parseInt(get('day'), 10),
    Number.parseInt(get('hour'), 10),
    Number.parseInt(get('minute'), 10),
    Number.parseInt(get('second'), 10),
  );
  return utcTime - date.getTime();
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstDate = new Date(utcGuess);
  const firstOffset = getOffsetMs(firstDate, timeZone);
  let resolved = utcGuess - firstOffset;
  const secondDate = new Date(resolved);
  const secondOffset = getOffsetMs(secondDate, timeZone);
  if (secondOffset !== firstOffset) {
    resolved = utcGuess - secondOffset;
  }
  return new Date(resolved);
}

export function getLocalTimeParts(now: Date, timeZone: string): LocalTimeParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '0';

  return {
    year: Number.parseInt(get('year'), 10),
    month: Number.parseInt(get('month'), 10),
    day: Number.parseInt(get('day'), 10),
    hour: Number.parseInt(get('hour'), 10),
    minute: Number.parseInt(get('minute'), 10),
    second: Number.parseInt(get('second'), 10),
    weekday: parseWeekday(get('weekday')),
  };
}

function addDays(year: number, month: number, day: number, delta: number): { year: number; month: number; day: number } {
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + delta);
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

function addMonths(year: number, month: number, day: number, delta: number): { year: number; month: number; day: number } {
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCMonth(value.getUTCMonth() + delta);
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

function isScheduledCalendarMatch(schedule: BackupPolicySchedule, parts: LocalTimeParts): boolean {
  if (schedule.frequency === 'weekly' && typeof schedule.dayOfWeek === 'number') {
    return parts.weekday === schedule.dayOfWeek;
  }
  if (schedule.frequency === 'monthly' && typeof schedule.dayOfMonth === 'number') {
    return parts.day === schedule.dayOfMonth;
  }
  return true;
}

function isScheduledTimeWithinWindow(schedule: BackupPolicySchedule): boolean {
  const scheduledMinutes = (() => {
    const [hour, minute] = parseTime(schedule.time);
    return (hour * 60) + minute;
  })();
  const windowStart = parseWindowTime(schedule.windowStart);
  const windowEnd = parseWindowTime(schedule.windowEnd);

  if (windowStart === null || windowEnd === null) return true;
  if (windowStart === windowEnd) return true;
  if (windowStart < windowEnd) {
    return scheduledMinutes >= windowStart && scheduledMinutes < windowEnd;
  }
  return scheduledMinutes >= windowStart || scheduledMinutes < windowEnd;
}

export function isWithinBackupWindow(
  schedule: BackupPolicySchedule,
  now: Date,
  fallbackTimezone?: string,
): boolean {
  const windowStart = parseWindowTime(schedule.windowStart);
  const windowEnd = parseWindowTime(schedule.windowEnd);
  if (windowStart === null || windowEnd === null) return true;
  if (windowStart === windowEnd) return true;

  const timezone = resolveScheduleTimeZone(schedule.timezone, fallbackTimezone);
  const local = getLocalTimeParts(now, timezone);
  const currentMinutes = (local.hour * 60) + local.minute;

  if (windowStart < windowEnd) {
    return currentMinutes >= windowStart && currentMinutes < windowEnd;
  }
  return currentMinutes >= windowStart || currentMinutes < windowEnd;
}

export function getDueOccurrenceKey(
  schedule: BackupPolicySchedule,
  now: Date,
  fallbackTimezone?: string,
  lookbackMinutes = 0,
): string | null {
  const timezone = resolveScheduleTimeZone(schedule.timezone, fallbackTimezone);
  const local = getLocalTimeParts(now, timezone);
  const [targetHour, targetMinute] = parseTime(schedule.time);

  if (!isScheduledTimeWithinWindow(schedule)) return null;
  const lookbackMs = lookbackMinutes > 0 ? lookbackMinutes * 60_000 : 60_000;
  const lookbackStart = now.getTime() - lookbackMs;

  const buildOccurrenceKey = (year: number, month: number, day: number) => {
    const yyyy = String(year).padStart(4, '0');
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    const hh = String(targetHour).padStart(2, '0');
    const min = String(targetMinute).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
  };

  const candidates: Array<{ year: number; month: number; day: number }> = [];

  if (schedule.frequency === 'daily') {
    candidates.push(
      { year: local.year, month: local.month, day: local.day },
      addDays(local.year, local.month, local.day, -1),
    );
  } else if (schedule.frequency === 'weekly' && typeof schedule.dayOfWeek === 'number') {
    const currentDelta = schedule.dayOfWeek - local.weekday;
    const currentCandidate = addDays(local.year, local.month, local.day, currentDelta);
    const previousCandidate = addDays(currentCandidate.year, currentCandidate.month, currentCandidate.day, -7);
    candidates.push(currentCandidate, previousCandidate);
  } else if (schedule.frequency === 'monthly' && typeof schedule.dayOfMonth === 'number') {
    candidates.push(
      { year: local.year, month: local.month, day: schedule.dayOfMonth },
      (() => {
        const previous = addMonths(local.year, local.month, local.day, -1);
        return {
          year: previous.year,
          month: previous.month,
          day: schedule.dayOfMonth,
        };
      })(),
    );
  } else {
    candidates.push({ year: local.year, month: local.month, day: local.day });
  }

  for (const candidate of candidates) {
    const candidateUtc = zonedDateTimeToUtc(
      candidate.year,
      candidate.month,
      candidate.day,
      targetHour,
      targetMinute,
      0,
      timezone,
    );
    const candidateLocal = getLocalTimeParts(candidateUtc, timezone);

    if (!isScheduledCalendarMatch(schedule, candidateLocal)) continue;
    if (candidateUtc.getTime() > now.getTime()) continue;
    if (candidateUtc.getTime() < lookbackStart) continue;

    return buildOccurrenceKey(candidateLocal.year, candidateLocal.month, candidateLocal.day);
  }

  return null;
}

export function getNextRun(schedule: BackupPolicySchedule, fallbackTimezone?: string): string | null {
  if (!isScheduledTimeWithinWindow(schedule)) return null;

  const timezone = resolveScheduleTimeZone(schedule.timezone, fallbackTimezone);
  const localNow = getLocalTimeParts(new Date(), timezone);
  const [targetHour, targetMinute] = parseTime(schedule.time);

  let candidate = zonedDateTimeToUtc(
    localNow.year,
    localNow.month,
    schedule.frequency === 'monthly' && typeof schedule.dayOfMonth === 'number'
      ? schedule.dayOfMonth
      : localNow.day,
    targetHour,
    targetMinute,
    0,
    timezone,
  );

  if (schedule.frequency === 'weekly' && typeof schedule.dayOfWeek === 'number') {
    const deltaDays = (schedule.dayOfWeek - localNow.weekday + 7) % 7;
    const next = addDays(localNow.year, localNow.month, localNow.day, deltaDays);
    candidate = zonedDateTimeToUtc(next.year, next.month, next.day, targetHour, targetMinute, 0, timezone);
  } else if (schedule.frequency === 'monthly' && typeof schedule.dayOfMonth === 'number') {
    candidate = zonedDateTimeToUtc(
      localNow.year,
      localNow.month,
      schedule.dayOfMonth,
      targetHour,
      targetMinute,
      0,
      timezone,
    );
  }

  if (candidate <= new Date()) {
    if (schedule.frequency === 'daily') {
      const next = addDays(localNow.year, localNow.month, localNow.day, 1);
      candidate = zonedDateTimeToUtc(next.year, next.month, next.day, targetHour, targetMinute, 0, timezone);
    } else if (schedule.frequency === 'weekly') {
      const deltaDays = (schedule.dayOfWeek ?? localNow.weekday) - localNow.weekday;
      const normalizedDelta = deltaDays <= 0 ? deltaDays + 7 : deltaDays;
      const next = addDays(localNow.year, localNow.month, localNow.day, normalizedDelta);
      candidate = zonedDateTimeToUtc(next.year, next.month, next.day, targetHour, targetMinute, 0, timezone);
    } else {
      const next = addMonths(localNow.year, localNow.month, 1, 1);
      candidate = zonedDateTimeToUtc(next.year, next.month, schedule.dayOfMonth ?? 1, targetHour, targetMinute, 0, timezone);
    }
  }

  return candidate.toISOString();
}

export function resolveScopedOrgId(
  auth: {
    scope: 'system' | 'partner' | 'organization';
    orgId?: string | null;
    accessibleOrgIds?: string[] | null;
  }
) {
  if (auth.orgId) {
    return auth.orgId;
  }

  if (auth.scope === 'partner' && Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return auth.accessibleOrgIds[0] ?? null;
  }

  return null;
}
