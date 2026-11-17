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
 *     An unknown preset is logged: it means an unbounded report whose PDF
 *     claims a window, which is the #9562 symptom.
 *
 * An explicit bound that does not parse as a date throws, so the run fails
 * with a message naming the bad bound instead of a serializer RangeError.
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

function parseBound(bound: 'start' | 'end', value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid report date range: ${bound} ${JSON.stringify(value)} is not a date`);
  }
  return date;
}

/** Default length of an ad-hoc service-plan evidence window. */
const AD_HOC_EVIDENCE_DAYS = 30;

export type EvidenceWindow = { start: Date; end: Date; periodStart: string; periodEnd: string };

/** A `YYYY-MM-DD…` bound as the start or end of that whole UTC day; throws a
 *  message naming the bound, like `parseBound`, for anything else. */
function wholeDayBound(bound: 'start' | 'end', value: string): Date {
  const day = value.slice(0, 10);
  const date = new Date(`${day}T${bound === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid report date range: ${bound} ${JSON.stringify(value)} is not a date`);
  }
  return date;
}

/**
 * The window an ad-hoc service-plan evidence report covers when no deliverable
 * occurrence supplies one (#12048), in order:
 *  - start: an explicit `start` (the start of that UTC day); else `end` minus
 *    the rolling preset's length (last_7/30/90_days); else `end` minus 30 days.
 *  - end: an explicit `end` (the end of that UTC day); else the generation time.
 *
 * Shared by the threat detection and vulnerability management generators. Run
 * together on Nov 9 they printed 10-10→11-09 (trailing 30 days) and
 * 10-09→11-09 (one calendar month); a client reading both saw two periods.
 */
export function resolveAdHocEvidenceWindow(rawDateRange: unknown, generatedAt: string): EvidenceWindow {
  const range = asRange(rawDateRange) ?? {};
  const end = nonEmptyString(range.end) ? wholeDayBound('end', range.end) : new Date(generatedAt);
  const start = nonEmptyString(range.start)
    ? wholeDayBound('start', range.start)
    : new Date(end.getTime() - (reportDateRangePresetDays(range) ?? AD_HOC_EVIDENCE_DAYS) * DAY_MS);
  return {
    start,
    end,
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: end.toISOString().slice(0, 10),
  };
}

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
      start: nonEmptyString(range.start) ? parseBound('start', range.start) : null,
      end: nonEmptyString(range.end) ? parseBound('end', range.end) : null,
    };
  }

  const days = reportDateRangePresetDays(range);
  if (days === null) {
    if (range.preset !== undefined && range.preset !== 'custom') {
      console.warn(
        `[reportDateRange] Unknown dateRange preset ${JSON.stringify(range.preset)}; the report window is unbounded`,
      );
    }
    return { start: null, end: null };
  }
  return { start: new Date(now.getTime() - days * DAY_MS), end: new Date(now.getTime()) };
}
