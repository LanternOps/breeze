/**
 * The reporting window a legacy builder-driven report's `config.dateRange`
 * describes (#9562).
 *
 * Saved reports carry either explicit bounds (`{ start, end }`, written by API
 * callers and AI tools) or a rolling preset (`{ preset: 'last_30_days' }`,
 * written by every report template and the portal's self-service
 * definitions). Generators used to read only `start`/`end`, so a preset report
 * silently covered all time while its PDF claimed "the configured reporting
 * window".
 *
 * Resolution, in order:
 *  1. Any explicit bound present → the explicit bounds, exactly as given
 *     (`new Date(value)`, the semantics the generators always had). Explicit
 *     bounds win over a preset so configs that already worked keep their
 *     meaning.
 *  2. A rolling preset → `[now - N days, now]`, evaluated at generation time,
 *     so each scheduled run covers the N days before it.
 *  3. Otherwise (no range, `custom` without bounds, unknown preset) → open.
 */

const PRESET_DAYS = {
  last_7_days: 7,
  last_30_days: 30,
  last_90_days: 90,
} as const satisfies Record<string, number>;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ResolvedReportDateRange = { start: Date | null; end: Date | null };

type RawDateRange = { start?: unknown; end?: unknown; preset?: unknown };

function asRange(raw: unknown): RawDateRange | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as RawDateRange) : null;
}

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** The length in days of a rolling preset, or null for `custom`/absent/unknown. */
export function reportDateRangePresetDays(raw: unknown): number | null {
  const preset = asRange(raw)?.preset;
  return typeof preset === 'string' && Object.prototype.hasOwnProperty.call(PRESET_DAYS, preset)
    ? PRESET_DAYS[preset as keyof typeof PRESET_DAYS]
    : null;
}

export function resolveReportDateRange(raw: unknown, now: Date = new Date()): ResolvedReportDateRange {
  const range = asRange(raw);
  if (!range) return { start: null, end: null };

  if (nonEmptyString(range.start) || nonEmptyString(range.end)) {
    return {
      start: nonEmptyString(range.start) ? new Date(range.start) : null,
      end: nonEmptyString(range.end) ? new Date(range.end) : null,
    };
  }

  const days = reportDateRangePresetDays(range);
  if (days === null) return { start: null, end: null };
  return { start: new Date(now.getTime() - days * DAY_MS), end: new Date(now.getTime()) };
}
