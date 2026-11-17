/**
 * One page size, one date format and one meta separator for every report PDF
 * (#12048). Four reports generated for one org in the same minute printed A4
 * for a US partner, "Nov 9, 2026, 12:06 PM" beside "2026-11-09", no timezone,
 * and "·", "|" and " - " between the same facts. Every renderer now formats
 * through these helpers.
 *
 * The conventions come from the partner's existing settings, never a new one:
 *  - page size  → `partners.document_page_size` (the page size its quotes and
 *                 invoices already print on);
 *  - date order → `partners.settings.dateFormat`;
 *  - hour cycle → `partners.settings.timeFormat`.
 * Absent (no partner context, an old caller), a report keeps A4 and a US-order
 * date — what it printed before.
 *
 * The month is always spelled out (except for an explicit ISO preference):
 * a client document is read across locales, and "11/09/2026" is a different
 * day in half of them. The words around dates stay English, matching the rest
 * of the PDF.
 */

export type ReportPageSize = 'a4' | 'letter';
export type ReportDateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD';
export type ReportTimeFormat = '12h' | '24h';

/** The partner's stored conventions, as loaded; any field may be missing or junk. */
export type ReportLocaleInput = {
  pageSize?: ReportPageSize | null;
  dateFormat?: ReportDateFormat | null;
  timeFormat?: ReportTimeFormat | null;
};

export type ReportLocale = {
  pageSize: ReportPageSize;
  dateFormat: ReportDateFormat;
  timeFormat: ReportTimeFormat;
  /** IANA zone every instant is printed in. */
  timeZone: string;
};

export type ReportDateLocale = Pick<ReportLocale, 'dateFormat' | 'timeZone'>;
export type ReportDateTimeLocale = Pick<ReportLocale, 'dateFormat' | 'timeFormat' | 'timeZone'>;

/** The date half of the design system every designed renderer receives on
 *  `chrome`, bound to the report's locale by `buildReportPdf`. */
export type ReportFormatChrome = {
  /** The report's one date format; null when there is no date. */
  formatDate: (value: string | Date | null | undefined) => string | null;
  /** A date and time with its timezone, in the same format. */
  formatDateTime: (value: string | Date | null | undefined) => string | null;
  /** "Oct 10, 2026 – Nov 9, 2026"; null unless both ends are known. */
  formatPeriod: (start: string | Date | null | undefined, end: string | Date | null | undefined) => string | null;
  /** The one separator between facts on a meta line. */
  metaSeparator: string;
};

/** Landscape page geometry in mm. `footY` is the footer rule. */
export type ReportPageGeometry = { w: number; h: number; mx: number; bandH: number; footY: number };

/** The single separator between facts on a title-block meta line. */
export const REPORT_META_SEPARATOR = '   ·   ';

const PAGE_DIMENSIONS_MM: Record<ReportPageSize, { w: number; h: number }> = {
  a4: { w: 297, h: 210 },
  letter: { w: 279.4, h: 215.9 },
};
const MARGIN_X = 14;
const BAND_H = 19;
/** Footer rule distance from the bottom edge — 11 mm on both sizes. */
const FOOTER_FROM_BOTTOM = 11;

const DATE_FORMATS: ReadonlySet<string> = new Set(['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD']);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function reportPageGeometry(size: ReportPageSize): ReportPageGeometry {
  const { w, h } = PAGE_DIMENSIONS_MM[size];
  return { w, h, mx: MARGIN_X, bandH: BAND_H, footY: h - FOOTER_FROM_BOTTOM };
}

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The report conventions stored on a partner row, with anything the renderer
 * does not know dropped to null. One mapping for the API loaders and the web
 * export, so a partner's report prints the same from every path.
 */
export function partnerReportConventions(partner: {
  documentPageSize?: unknown;
  settings?: unknown;
}): { pageSize: ReportPageSize | null; dateFormat: ReportDateFormat | null; timeFormat: ReportTimeFormat | null } {
  const settings = (partner.settings && typeof partner.settings === 'object' ? partner.settings : {}) as {
    dateFormat?: unknown;
    timeFormat?: unknown;
  };
  const size = partner.documentPageSize;
  return {
    pageSize: size === 'letter' || size === 'a4' ? size : null,
    dateFormat: typeof settings.dateFormat === 'string' && DATE_FORMATS.has(settings.dateFormat)
      ? (settings.dateFormat as ReportDateFormat)
      : null,
    timeFormat: settings.timeFormat === '12h' || settings.timeFormat === '24h' ? settings.timeFormat : null,
  };
}

/** Fill in defaults and drop junk, so the renderer never formats with an invalid value. */
export function resolveReportLocale(input: ReportLocaleInput | null | undefined, timeZone: string): ReportLocale {
  return {
    pageSize: input?.pageSize === 'letter' ? 'letter' : 'a4',
    dateFormat: input?.dateFormat && DATE_FORMATS.has(input.dateFormat) ? input.dateFormat : 'MM/DD/YYYY',
    timeFormat: input?.timeFormat === '24h' ? '24h' : '12h',
    // A Windows zone id ("Pacific Standard Time") makes Intl throw; one bad
    // value must not abort the whole PDF.
    timeZone: timeZone && isValidTimeZone(timeZone) ? timeZone : 'UTC',
  };
}

type Parts = { y: number; m: number; d: number; hour: number; minute: number; zone: string };

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Calendar parts of `value` in `timeZone`. A bare `YYYY-MM-DD` is a calendar
 *  day, not an instant: it is never shifted across a zone boundary. */
function partsOf(value: string | Date | null | undefined, timeZone: string): Parts | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const m = DATE_ONLY.exec(value.trim());
    if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), hour: 0, minute: 0, zone: '' };
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZoneName: 'short',
  });
  const get = (type: Intl.DateTimeFormatPartTypes) => fmt.formatToParts(date).find((p) => p.type === type)?.value ?? '';
  return {
    y: Number(get('year')), m: Number(get('month')), d: Number(get('day')),
    hour: Number(get('hour')) % 24, minute: Number(get('minute')), zone: get('timeZoneName'),
  };
}

function dateText(p: Parts, format: ReportDateFormat): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const month = MONTHS[p.m - 1] ?? String(p.m);
  switch (format) {
    case 'YYYY-MM-DD': return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
    case 'DD/MM/YYYY': return `${p.d} ${month} ${p.y}`;
    default: return `${month} ${p.d}, ${p.y}`;
  }
}

/** "Nov 9, 2026" / "9 Nov 2026" / "2026-11-09"; null when there is no date. */
export function formatReportDate(value: string | Date | null | undefined, locale: ReportDateLocale): string | null {
  const p = partsOf(value, locale.timeZone);
  return p ? dateText(p, locale.dateFormat) : null;
}

/** "Nov 9, 2026, 12:06 PM EST" — a generated or synced instant, with its zone. */
export function formatReportDateTime(value: string | Date | null | undefined, locale: ReportDateTimeLocale): string | null {
  // A bare date has no time to print.
  if (typeof value === 'string' && DATE_ONLY.test(value.trim())) return formatReportDate(value, locale);
  const p = partsOf(value, locale.timeZone);
  if (!p) return null;
  const mm = String(p.minute).padStart(2, '0');
  const time = locale.timeFormat === '24h'
    ? `${String(p.hour).padStart(2, '0')}:${mm}`
    : `${p.hour % 12 === 0 ? 12 : p.hour % 12}:${mm} ${p.hour < 12 ? 'AM' : 'PM'}`;
  return `${dateText(p, locale.dateFormat)}, ${time}${p.zone ? ` ${p.zone}` : ''}`;
}

/** "Oct 10, 2026 – Nov 9, 2026"; null unless both ends are known. */
export function formatReportPeriod(
  start: string | Date | null | undefined,
  end: string | Date | null | undefined,
  locale: ReportDateLocale,
): string | null {
  const s = formatReportDate(start, locale);
  const e = formatReportDate(end, locale);
  return s && e ? `${s} – ${e}` : null;
}
