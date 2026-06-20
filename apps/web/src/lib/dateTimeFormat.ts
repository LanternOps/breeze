import type { TimeFormat } from '@breeze/shared';
import { normalizeTimeFormat, readTimeFormatPreference } from './appearance';

type DateInput = string | number | Date | null | undefined;
type FormatMode = 'date' | 'time' | 'dateTime';

export type UserDateTimeFormatOptions = Intl.DateTimeFormatOptions & {
  fallback?: string;
  locale?: Intl.LocalesArgument;
  timeFormat?: TimeFormat | null;
};

const TIME_OPTION_KEYS: Array<keyof Intl.DateTimeFormatOptions> = [
  'hour',
  'minute',
  'second',
  'fractionalSecondDigits',
  'timeStyle',
];

const DATE_OPTION_KEYS: Array<keyof Intl.DateTimeFormatOptions> = [
  'weekday',
  'era',
  'year',
  'month',
  'day',
  'dateStyle',
];

function parseDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fallbackFor(value: DateInput, fallback?: string): string {
  if (fallback !== undefined) return fallback;
  return typeof value === 'string' ? value : '';
}

export function getEffectiveTimeFormat(explicit?: TimeFormat | null): TimeFormat | undefined {
  return normalizeTimeFormat(explicit) ?? readTimeFormatPreference();
}

function formatIncludesTime(options: Intl.DateTimeFormatOptions, mode: FormatMode): boolean {
  if (mode === 'time') return true;
  if (mode === 'date') return false;
  if (TIME_OPTION_KEYS.some((key) => options[key] !== undefined)) return true;
  if (DATE_OPTION_KEYS.some((key) => options[key] !== undefined)) return false;
  return true;
}

export function withUserTimeFormatOptions(
  options: Intl.DateTimeFormatOptions,
  timeFormat: TimeFormat | undefined,
  mode: FormatMode
): Intl.DateTimeFormatOptions {
  if (!timeFormat || !formatIncludesTime(options, mode)) return options;
  const next: Intl.DateTimeFormatOptions = { ...options };
  delete next.hour12;
  delete next.hourCycle;
  next.hourCycle = timeFormat === '24h' ? 'h23' : 'h12';
  return next;
}

function splitFormatOptions({ fallback, locale, timeFormat, ...intlOptions }: UserDateTimeFormatOptions) {
  return {
    fallback,
    locale,
    timeFormat: getEffectiveTimeFormat(timeFormat),
    intlOptions,
  };
}

export function formatDateTime(value: DateInput, options: UserDateTimeFormatOptions = {}): string {
  const date = parseDate(value);
  const { fallback, locale, timeFormat, intlOptions } = splitFormatOptions(options);
  if (!date) return fallbackFor(value, fallback);
  return date.toLocaleString(locale, withUserTimeFormatOptions(intlOptions, timeFormat, 'dateTime'));
}

export function formatTime(value: DateInput, options: UserDateTimeFormatOptions = {}): string {
  const date = parseDate(value);
  const { fallback, locale, timeFormat, intlOptions } = splitFormatOptions(options);
  if (!date) return fallbackFor(value, fallback);
  return date.toLocaleTimeString(locale, withUserTimeFormatOptions(intlOptions, timeFormat, 'time'));
}

export function formatDate(value: DateInput, options: UserDateTimeFormatOptions = {}): string {
  const date = parseDate(value);
  const { fallback, locale, intlOptions } = splitFormatOptions(options);
  if (!date) return fallbackFor(value, fallback);
  return date.toLocaleDateString(locale, intlOptions);
}
