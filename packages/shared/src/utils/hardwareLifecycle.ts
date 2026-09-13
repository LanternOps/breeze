/**
 * Hardware Lifecycle rules — single source of truth for the report's bands,
 * shared by the API generator (which persists the snapshot) and the PDF
 * renderer / web preview (which only display it).
 *
 * Ported from the LanternOps portal generator. The rules that matter:
 *  - The replace-by date is `replaceAgeYears` after purchase, OR the warranty
 *    end if ACTIVE coverage runs longer. A device under warranty is never
 *    "Replace now". An expired warranty proves nothing.
 *  - Bands are due-date based, never age based.
 *  - Future-dated purchases are data-entry problems → unknown, not healthy.
 *  - OS support is conservative: unrecognised → `unclassified`, never `ended`.
 *
 * All dates are YYYY-MM-DD strings (the `date` column type); arithmetic is
 * done in UTC on the calendar date so a report generated at 23:30 in Denver
 * does not change band overnight.
 */
import type {
  HardwareLifecycleDeviceRow,
  OsSupportStatus,
  ReplacementStatus,
} from '../types/hardwareLifecycleReport';

export const HARDWARE_LIFECYCLE_DEFAULT_REPLACE_AGE_YEARS = 4;

export const REPLACEMENT_STATUS_ORDER: readonly ReplacementStatus[] = ['supported', 'due_soon', 'replace', 'unknown'];

export const REPLACEMENT_LABELS: Readonly<Record<ReplacementStatus, string>> = {
  supported: 'On track',
  due_soon: 'Due soon',
  replace: 'Replace now',
  unknown: 'Unknown age',
};

export const REPLACEMENT_BAND_DESCRIPTIONS: Readonly<Record<ReplacementStatus, string>> = {
  supported: 'more than a year out',
  due_soon: 'due within a year',
  replace: 'past due',
  unknown: 'no purchase or warranty dates',
};

export const OS_SUPPORT_LABELS: Readonly<Record<OsSupportStatus, string>> = {
  supported: 'Supported',
  ending: 'Support ending',
  ended: 'Support ended',
  unclassified: 'Not classified',
  na: 'Not applicable',
};

// ---------------------------------------------------------------------------
// Date helpers (calendar-date, UTC)

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = ISO_DATE.exec(value);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return isNaN(d.getTime()) ? null : d;
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function todayIso(now: Date = new Date()): string {
  return toIso(now);
}

/** Add whole years to a YYYY-MM-DD date, clamping Feb 29 to Feb 28. */
export function addYears(iso: string, years: number): string {
  const d = parseDate(iso);
  if (!d) return iso;
  const y = d.getUTCFullYear() + years;
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const candidate = new Date(Date.UTC(y, m, day));
  if (candidate.getUTCMonth() !== m) {
    return toIso(new Date(Date.UTC(y, m, 28)));
  }
  return toIso(candidate);
}

/** Reject missing, unparseable, epoch-era, and far-future (>10y) dates. */
export function isPlausibleDate(iso: string | null | undefined, today: string): boolean {
  const d = parseDate(iso);
  if (!d) return false;
  if (d.getUTCFullYear() <= 1970) return false;
  const ceiling = parseDate(addYears(today, 10));
  if (ceiling && d.getTime() > ceiling.getTime()) return false;
  return true;
}

function daysBetween(fromIso: string, toIsoDate: string): number {
  const a = parseDate(fromIso);
  const b = parseDate(toIsoDate);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Replacement rules

export type ReplacementRuleOptions = {
  today?: string;
  replaceAgeYears?: number;
};

/**
 * The date we recommend planning a device's replacement. Returns null when
 * neither date gives a defensible answer.
 */
export function replacementDueDate(
  purchaseDate: string | null | undefined,
  warrantyEndDate: string | null | undefined,
  opts: ReplacementRuleOptions = {},
): string | null {
  const today = opts.today ?? todayIso();
  const years = opts.replaceAgeYears ?? HARDWARE_LIFECYCLE_DEFAULT_REPLACE_AGE_YEARS;

  let due: string | null = null;
  if (isPlausibleDate(purchaseDate, today) && (purchaseDate as string) <= today) {
    due = addYears(purchaseDate as string, years);
  }
  if (isPlausibleDate(warrantyEndDate, today) && (warrantyEndDate as string) > today) {
    const w = warrantyEndDate as string;
    due = due && due > w ? due : w;
  }
  return due;
}

/** Bucket a device by its replace-by date. */
export function classifyReplacement(dueDate: string | null, today: string = todayIso()): ReplacementStatus {
  if (!dueDate) return 'unknown';
  if (dueDate <= today) return 'replace';
  if (dueDate <= addYears(today, 1)) return 'due_soon';
  return 'supported';
}

/** Years since purchase, one decimal; null when unknown or not yet bought. */
export function ageYears(purchaseDate: string | null | undefined, today: string = todayIso()): number | null {
  if (!isPlausibleDate(purchaseDate, today)) return null;
  const days = daysBetween(purchaseDate as string, today);
  if (days <= 0) return null;
  return Math.round((days / 365.25) * 10) / 10;
}

/** Share of the purchase→due runway already used, clamped to [0, 1]. */
export function lifeUsedFraction(
  purchaseDate: string | null | undefined,
  dueDate: string | null | undefined,
  today: string = todayIso(),
): number | null {
  if (!purchaseDate || !dueDate) return null;
  if (!isPlausibleDate(purchaseDate, today) || purchaseDate >= dueDate || purchaseDate > today) return null;
  const total = daysBetween(purchaseDate, dueDate);
  if (total <= 0) return null;
  return Math.min(daysBetween(purchaseDate, today) / total, 1);
}

/** True when active warranty coverage is what sets the due date. */
export function warrantyExtendsLife(
  purchaseDate: string | null | undefined,
  warrantyEndDate: string | null | undefined,
  dueDate: string | null,
  opts: ReplacementRuleOptions = {},
): boolean {
  const today = opts.today ?? todayIso();
  const years = opts.replaceAgeYears ?? HARDWARE_LIFECYCLE_DEFAULT_REPLACE_AGE_YEARS;
  if (!dueDate || !isPlausibleDate(warrantyEndDate, today) || dueDate !== warrantyEndDate) return false;
  if (!isPlausibleDate(purchaseDate, today)) return true;
  return (warrantyEndDate as string) > addYears(purchaseDate as string, years);
}

// ---------------------------------------------------------------------------
// OS support

/**
 * Map a device's OS type + version string to a support status. Conservative:
 * we must not claim a device is end-of-life unless we know it is.
 */
export function classifyOsSupport(
  osType: string | null | undefined,
  osVersion: string | null | undefined,
): OsSupportStatus {
  const type = (osType ?? '').trim().toLowerCase();
  const s = (osVersion ?? '').trim().toLowerCase();
  if (!type && !s) return 'na';

  if (type === 'windows' || s.includes('windows')) {
    if (s.includes('server')) {
      if (/\b(2022|2025)\b/.test(s)) return 'supported';
      if (/\b(2016|2019)\b/.test(s)) return 'ending';
      if (/\b(2003|2008|2012)\b/.test(s)) return 'ended';
      return 'unclassified';
    }
    // LTSC / IoT releases follow their own long support timelines.
    if (s.includes('ltsc') || s.includes('iot')) return 'unclassified';
    if (s.includes('windows 11')) return 'supported';
    // Microsoft ended mainstream Windows 10 support in October 2025.
    if (s.includes('windows 10')) return 'ended';
    if (/windows (7|8|xp|vista)\b/.test(s)) return 'ended';
    return 'unclassified';
  }

  if (type === 'macos' || /mac ?os|os x/.test(s)) {
    // Apple supports roughly the three most recent major versions.
    const m = /(?:macos|mac os x|mac os|os x)?\s*(\d+)(?:\.\d+)*/.exec(s);
    if (m) {
      const major = Number(m[1]);
      return major >= 14 ? 'supported' : 'ended';
    }
    return 'unclassified';
  }

  return 'unclassified';
}

/** Clean an inventory OS string for non-technical readers. */
export function displayOs(osType: string | null | undefined, osVersion: string | null | undefined): string {
  let value = (osVersion ?? '').trim();
  value = value.replace(/\s*\(.*$/, '');
  value = value.replace('Microsoft Windows', 'Windows').replace('Professional', 'Pro');
  const type = (osType ?? '').toLowerCase();
  if (value && /^\d/.test(value)) {
    if (type === 'macos') value = `macOS ${value}`;
    else if (type === 'windows') value = `Windows ${value}`;
  }
  if (!value && type) return type === 'macos' ? 'macOS' : type.charAt(0).toUpperCase() + type.slice(1);
  return value;
}

// ---------------------------------------------------------------------------
// Presentation helpers (shared by PDF + web so both read identically)

export function quarterLabel(iso: string): string {
  const d = parseDate(iso);
  if (!d) return iso;
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}

export function replaceByLabel(dueDate: string | null, today: string = todayIso()): string {
  if (!dueDate) return 'Unknown';
  if (dueDate <= today) return 'Overdue';
  return quarterLabel(dueDate);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Apr 2019" */
export function monthYear(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return '';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "November 2026" */
export function monthYearLong(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return '';
  return `${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Join names the way a person would write them. */
export function humanJoin(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Most urgent first (earliest due date); devices with no dates last, by name. */
export function sortLifecycleRows<T extends Pick<HardwareLifecycleDeviceRow, 'replaceBy' | 'name'>>(rows: T[]): T[] {
  const withDue = rows.filter((r) => r.replaceBy).sort((a, b) => a.replaceBy!.localeCompare(b.replaceBy!));
  const withoutDue = rows.filter((r) => !r.replaceBy).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return [...withDue, ...withoutDue];
}

export function countByReplacement(rows: HardwareLifecycleDeviceRow[]): Record<ReplacementStatus, number> {
  const counts: Record<ReplacementStatus, number> = { supported: 0, due_soon: 0, replace: 0, unknown: 0 };
  for (const r of rows) counts[r.replacement] += 1;
  return counts;
}

export function countByOsSupport(rows: HardwareLifecycleDeviceRow[]): Record<Exclude<OsSupportStatus, 'na'>, number> {
  const counts: Record<Exclude<OsSupportStatus, 'na'>, number> = { supported: 0, ending: 0, ended: 0, unclassified: 0 };
  for (const r of rows) if (r.osSupport !== 'na') counts[r.osSupport] += 1;
  return counts;
}

function namesWithOsStatus(rows: HardwareLifecycleDeviceRow[], status: OsSupportStatus, limit = 3): string[] {
  const names = rows.filter((r) => r.osSupport === status).map((r) => r.name);
  return names.length > limit ? [...names.slice(0, limit), `${names.length - limit} more`] : names;
}

/** "4 of your 8 computers are past due for replacement. …" */
export function buildAtAGlanceProse(rows: HardwareLifecycleDeviceRow[], otherCount: number): string {
  const n = rows.length;
  const c = countByReplacement(rows);
  const sentences: string[] = [];
  if (n === 0) {
    sentences.push('We are not yet managing any computers for you.');
  } else if (c.replace > 0) {
    sentences.push(`${c.replace} of your ${n} computer${n === 1 ? '' : 's'} ${c.replace === 1 ? 'is' : 'are'} past due for replacement.`);
  } else {
    sentences.push(`All ${n} of your computer${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} within ${n === 1 ? 'its' : 'their'} expected service life.`);
  }
  if (c.due_soon > 0) {
    sentences.push(`${c.due_soon} more computer${c.due_soon === 1 ? ' comes' : 's come'} due within the year.`);
  }
  if (c.unknown > 0) {
    sentences.push(`${c.unknown} computer${c.unknown === 1 ? ' is' : 's are'} missing purchase records, which we are confirming.`);
  }
  if (otherCount > 0) {
    sentences.push(`We also manage ${otherCount} other device${otherCount === 1 ? '' : 's'} (network and print hardware), listed at the end.`);
  }
  return sentences.join(' ');
}

/** "Operating systems: 6 current; 1 ending support soon (LAW-SRV); …" */
export function buildOsProse(rows: HardwareLifecycleDeviceRow[]): string | null {
  const c = countByOsSupport(rows);
  const parts: string[] = [];
  if (c.supported) parts.push(`${c.supported} current`);
  if (c.ending) parts.push(`${c.ending} ending support soon (${humanJoin(namesWithOsStatus(rows, 'ending'))})`);
  if (c.ended) parts.push(`${c.ended} no longer receiving security updates (${humanJoin(namesWithOsStatus(rows, 'ended'))})`);
  if (c.unclassified) parts.push(`${c.unclassified} not yet classified`);
  if (parts.length === 0) return null;
  return `Operating systems: ${parts.join('; ')}.`;
}

/** A staged, plain-English plan derived from the bands. No pricing claims. */
export function buildHardwareLifecycleRecommendations(
  rows: HardwareLifecycleDeviceRow[],
  today: string = todayIso(),
): string[] {
  const lines: string[] = [];
  const sorted = sortLifecycleRows(rows);
  const replace = sorted.filter((r) => r.replacement === 'replace');
  const due = sorted.filter((r) => r.replacement === 'due_soon');
  const unknown = sorted.filter((r) => r.replacement === 'unknown');
  const osEnded = sorted.filter((r) => r.osSupport === 'ended');

  if (replace.length > 0) {
    const oldest = replace[0]!;
    const listed = replace.length <= 6
      ? humanJoin(replace.map((r) => r.name))
      : `the ${replace.length} computers marked Replace now`;
    const ageNote = oldest.ageYears
      ? `, starting with ${oldest.name} (${Math.round(oldest.ageYears)} years old)`
      : '';
    lines.push(`Plan replacements for ${listed} this quarter${ageNote}.`);
  }

  if (osEnded.length > 0) {
    const names = humanJoin(osEnded.slice(0, 4).map((r) => r.name));
    const verb = osEnded.length === 1 ? 'no longer receives' : 'no longer receive';
    const which = osEnded.length === 1 ? 'this one' : 'these';
    lines.push(`${names} ${verb} security updates on the current operating system; prioritize ${which} when scheduling.`);
  }

  for (const r of due.slice(0, 3)) {
    if (r.warrantyExtended && r.warrantyEndDate) {
      lines.push(`${r.name} is covered by warranty until ${monthYearLong(r.warrantyEndDate)}; budget to replace it when coverage ends.`);
    } else {
      lines.push(`Budget for ${r.name} around ${replaceByLabel(r.replaceBy, today)}; no action needed yet.`);
    }
  }

  if (unknown.length > 0) {
    const plural = unknown.length === 1 ? 'computer' : 'computers';
    lines.push(`We are confirming purchase records for ${unknown.length} ${plural}; their timelines will appear in an upcoming report.`);
  }

  if (lines.length === 0) {
    lines.push('Nothing needs your attention right now; we will flag the first computer to come due in a future report.');
  }
  return lines;
}
