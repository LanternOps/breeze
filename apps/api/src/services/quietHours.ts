/**
 * Quiet-hours evaluation, extracted from services/notifications.ts (W07, #3901).
 *
 * Lives on its own so callers that must not pull in firebase-admin (the ticket
 * push fan-out) can use it. `notifications.ts` re-exports both symbols so every
 * existing importer keeps working.
 */
export interface QuietHoursConfig {
  start: string;
  end: string;
  timezone?: string;
  enabled?: boolean;
}

/** Pure: no DB, no Firebase. `now` is injectable for tests. */
export function isInQuietHours(quietHours?: QuietHoursConfig | null, now: Date = new Date()): boolean {
  if (!quietHours || quietHours.enabled === false) {
    return false;
  }

  const startMinutes = parseMinutes(quietHours.start);
  const endMinutes = parseMinutes(quietHours.end);

  if (startMinutes === null || endMinutes === null) {
    return false;
  }

  const nowMinutes = getMinutesInTimezone(now, quietHours.timezone);

  if (startMinutes === endMinutes) {
    return true;
  }

  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }

  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

function parseMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return null;
  }

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
}

function getMinutesInTimezone(date: Date, timezone?: string): number {
  if (!timezone) {
    return date.getHours() * 60 + date.getMinutes();
  }

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit'
    }).formatToParts(date);

    const hour = Number(parts.find(part => part.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find(part => part.type === 'minute')?.value ?? '0');

    return hour * 60 + minute;
  } catch {
    return date.getHours() * 60 + date.getMinutes();
  }
}
