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
/** Matches `serverReplaceAgeYears`'s `.default(5)` in
 *  `apps/api/src/routes/reports/schemas.ts` — the fallback a legacy snapshot
 *  (persisted before that field existed) must use, never the workstation age. */
export const HARDWARE_LIFECYCLE_DEFAULT_SERVER_REPLACE_AGE_YEARS = 5;

export const REPLACEMENT_STATUS_ORDER: readonly ReplacementStatus[] = ['supported', 'due_soon', 'replace', 'unknown'];

export const REPLACEMENT_LABELS: Readonly<Record<ReplacementStatus, string>> = {
  supported: 'On track',
  due_soon: 'Due soon',
  replace: 'Replace now',
  unknown: 'Purchase date unknown',
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

  // A future-dated purchase is a data-entry problem, not a healthy device:
  // it makes the row `unknown` even when an active warranty could have set
  // a date on its own, so the bad record gets confirmed rather than hidden.
  if (parseDate(purchaseDate) && (purchaseDate as string) > today) return null;

  let due: string | null = null;
  if (isPlausibleDate(purchaseDate, today)) {
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
// Customer-facing identity. The reader is an office manager, not a
// technician: "Priya's ThinkPad" beats "branch-lt-12.corp.local".

const SERVICE_ACCOUNTS = new Set(['system', 'root', 'administrator', 'admin', 'localsystem', 'defaultaccount', 'guest', 'wdagutilityaccount', '_mbsetupuser', 'local service', 'network service']);

/** Strip "DOMAIN\\", "@domain" and known service accounts from a last-user value. */
export function cleanUserName(raw: string | null | undefined): string | null {
  let v = (raw ?? '').trim();
  if (!v) return null;
  const slash = v.lastIndexOf('\\');
  if (slash >= 0) v = v.slice(slash + 1);
  v = v.replace(/@.*$/, '').trim();
  if (!v || SERVICE_ACCOUNTS.has(v.toLowerCase())) return null;
  return v;
}

/** "branch-lt-12.corp.local" → "branch-lt-12"; leaves non-hostnames alone. */
export function shortHostname(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  if (!v || /\s/.test(v)) return v;
  const dot = v.indexOf('.');
  return dot > 0 ? v.slice(0, dot) : v;
}

type Identity = Pick<HardwareLifecycleDeviceRow, 'name' | 'hostname' | 'user' | 'model' | 'manufacturer'>;

/** "lena.k" → "Lena K", "marcus_o" → "Marcus O", "Dan Reyes" → unchanged. */
export function displayPersonName(raw: string | null | undefined): string | null {
  const user = cleanUserName(raw);
  if (!user) return null;
  if (/\s/.test(user)) return user;
  return user
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Table identity: the person, else the short device name. */
export function rowLabel(row: Identity): string {
  return displayPersonName(row.user) ?? shortHostname(row.name);
}

/** Sentence identity: "Priya N's Latitude 7410", else the short device name. */
export function rowMention(row: Identity): string {
  const user = displayPersonName(row.user);
  if (user) return `${user}'s ${row.model ?? 'computer'}`;
  return shortHostname(row.name);
}

/** Cap a name list the way the prose does: four names, then "and N more". */
export function capNames(names: string[], limit = 4): string {
  if (names.length <= limit) return humanJoin(names);
  return `${names.slice(0, limit).join(', ')} and ${names.length - limit} more`;
}

export type ScheduleGroup = {
  /** "Now", "Q4 2026", "Later", "Purchase date unknown". */
  label: string;
  rows: HardwareLifecycleDeviceRow[];
  /** Later / unknown groups carry a count only. */
  countOnly: boolean;
};

/**
 * The plan grouped the way a budget is approved: what is due now, then each
 * of the next four quarters, then everything later, then the undated.
 */
export function buildReplacementSchedule(rows: HardwareLifecycleDeviceRow[], today: string = todayIso()): ScheduleGroup[] {
  const sorted = sortLifecycleRows(rows);
  const now = sorted.filter((r) => r.replaceBy && r.replaceBy <= today);
  const future = sorted.filter((r) => r.replaceBy && r.replaceBy > today);
  const unknown = sorted.filter((r) => !r.replaceBy);
  const groups: ScheduleGroup[] = [];
  if (now.length) groups.push({ label: 'Now', rows: now, countOnly: false });
  const horizon = addYears(today, 1);
  const byQuarter = new Map<string, HardwareLifecycleDeviceRow[]>();
  const later: HardwareLifecycleDeviceRow[] = [];
  for (const r of future) {
    if (r.replaceBy! <= horizon) {
      const q = quarterLabel(r.replaceBy!);
      byQuarter.set(q, [...(byQuarter.get(q) ?? []), r]);
    } else {
      later.push(r);
    }
  }
  for (const [label, qRows] of byQuarter) groups.push({ label, rows: qRows, countOnly: false });
  if (later.length) groups.push({ label: `After ${monthYear(horizon)}`, rows: later, countOnly: true });
  if (unknown.length) groups.push({ label: 'Purchase date unknown', rows: unknown, countOnly: true });
  return groups;
}

/** Subline under the label: hostname (when it adds information) and make + model. */
export function rowSecondary(row: Identity): string | null {
  const host = shortHostname(row.hostname);
  const machine = [row.manufacturer, row.model].filter(Boolean).join(' ');
  const parts = [host && host !== rowLabel(row) ? host : null, machine || null].filter(Boolean) as string[];
  return parts.length ? parts.join('  ·  ') : null;
}

/**
 * The at-a-glance paragraph for a page that already shows the counts: only
 * what the numbers cannot say. Empty string when there is nothing to add.
 */
export function buildAtAGlanceFacts(rows: HardwareLifecycleDeviceRow[]): string {
  const n = rows.length;
  if (n === 0) return 'We are not yet managing any computers for you.';
  const c = countByReplacement(rows);
  const sentences: string[] = [];
  const replace = rows.filter((r) => r.replacement === 'replace');
  const oldest = Math.max(0, ...replace.map((r) => r.ageYears ?? 0));
  const ended = rows.filter((r) => r.osSupport === 'ended').length;
  const frame: string[] = [];
  if (oldest >= 1) frame.push(`the oldest computer due for replacement is ${Math.floor(oldest)} years old`);
  if (ended > 0) frame.push(`${ended} no longer receive${ended === 1 ? 's' : ''} security updates`);
  if (frame.length) {
    const text = frame.join(', and ');
    sentences.push(text.charAt(0).toUpperCase() + text.slice(1) + '.');
  }
  if (c.unknown > 0) {
    sentences.push(c.unknown === n
      ? `We are still confirming purchase dates for ${n === 1 ? 'your computer' : `all ${n} computers`}, so no replacement dates are available yet.`
      : `We are confirming purchase dates for ${c.unknown} computer${c.unknown === 1 ? '' : 's'}.`);
  }
  return sentences.join(' ');
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
  const names = rows.filter((r) => r.osSupport === status).map(rowMention);
  return names.length > limit ? [...names.slice(0, limit), `${names.length - limit} more`] : names;
}

/** "4 of your 8 computers are past due for replacement. …" */
export function buildAtAGlanceProse(rows: HardwareLifecycleDeviceRow[], otherCount: number): string {
  const n = rows.length;
  const c = countByReplacement(rows);
  const sentences: string[] = [];
  const known = n - c.unknown;
  if (n === 0) {
    sentences.push('We are not yet managing any computers for you.');
  } else if (c.replace > 0) {
    // Lead with the ask, then frame it: how old, how exposed, and what is fine.
    const replace = rows.filter((r) => r.replacement === 'replace');
    const oldest = Math.max(...replace.map((r) => r.ageYears ?? 0));
    const ended = replace.filter((r) => r.osSupport === 'ended').length;
    const frame: string[] = [];
    if (oldest >= 1) frame.push(`the oldest is ${Math.round(oldest)} years old`);
    if (ended > 0) frame.push(`${ended} no longer receive${ended === 1 ? 's' : ''} security updates`);
    sentences.push(
      `${c.replace} of your ${n} computer${n === 1 ? '' : 's'} ${c.replace === 1 ? 'is' : 'are'} past due for replacement${frame.length ? `; ${frame.join(' and ')}` : ''}.`,
    );
  } else if (known === 0) {
    // Nothing is dated: say so instead of asserting health we cannot prove.
    sentences.push(`We are still confirming purchase records for ${n === 1 ? 'your computer' : `all ${n} of your computers`}, so no replacement dates are available yet.`);
  } else if (c.unknown > 0) {
    sentences.push(`All ${known} of your computer${known === 1 ? '' : 's'} with known dates ${known === 1 ? 'is' : 'are'} within ${known === 1 ? 'its' : 'their'} expected service life.`);
  } else {
    sentences.push(`All ${n} of your computer${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} within ${n === 1 ? 'its' : 'their'} expected service life.`);
  }
  if (c.due_soon > 0) {
    sentences.push(`${c.due_soon} more computer${c.due_soon === 1 ? ' comes' : 's come'} due within the year.`);
  }
  if (c.replace > 0 && c.supported > 0) {
    sentences.push(`The other ${c.supported} ${c.supported === 1 ? 'is' : 'are'} within ${c.supported === 1 ? 'its' : 'their'} expected service life.`);
  }
  if (c.unknown > 0 && known > 0) {
    sentences.push(`${c.unknown} computer${c.unknown === 1 ? ' is' : 's are'} missing purchase records, which we are confirming.`);
  }
  if (otherCount > 0) {
    sentences.push(`We also manage ${otherCount} other device${otherCount === 1 ? '' : 's'} (network and print hardware), listed at the end.`);
  }
  return sentences.join(' ');
}

/** "Operating systems: 6 current; 1 ending support soon (LAW-SRV); …" */
export function buildOsProse(rows: HardwareLifecycleDeviceRow[], opts: { names?: boolean } = {}): string | null {
  const names = opts.names ?? true;
  const c = countByOsSupport(rows);
  const parts: string[] = [];
  if (c.supported) parts.push(`${c.supported} current`);
  if (c.ending) parts.push(`${c.ending} ending support soon${names ? ` (${humanJoin(namesWithOsStatus(rows, 'ending'))})` : ''}`);
  if (c.ended) parts.push(`${c.ended} no longer receiving security updates${names ? ` (${humanJoin(namesWithOsStatus(rows, 'ended'))})` : ''}`);
  // "Not yet classified" is our state, not the customer's; only the named
  // (verbose) form carries it.
  if (c.unclassified && names) parts.push(`${c.unclassified} not yet classified`);
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
  // Servers are planned separately (business-hours windows), so the
  // workstation asks never lead with a server.
  const servers = sorted.filter((r) => r.deviceKind === 'server');
  const workstations = sorted.filter((r) => r.deviceKind !== 'server');
  const replace = workstations.filter((r) => r.replacement === 'replace');
  const due = workstations.filter((r) => r.replacement === 'due_soon');
  const unknown = sorted.filter((r) => r.replacement === 'unknown');
  const osEnded = workstations.filter((r) => r.osSupport === 'ended');

  if (replace.length > 0) {
    const oldest = replace[0]!;
    const listed = replace.length <= 4
      ? humanJoin(replace.map(rowMention))
      : `the ${replace.length} computers marked Replace now`;
    const ageNote = oldest.ageYears
      ? `, starting with ${rowMention(oldest)} (${Math.floor(oldest.ageYears)} years old)`
      : '';
    lines.push(`This quarter, plan replacements for ${listed}${ageNote}.`);
  }

  const serverAsks = servers.filter((r) => r.replacement === 'replace' || (r.replacement === 'due_soon' && r.replaceBy));
  if (serverAsks.length <= 3) {
    for (const srv of serverAsks) {
      const name = rowMention(srv);
      if (srv.replacement === 'replace') {
        const age = srv.ageYears ? ` is ${Math.floor(srv.ageYears)} years old and` : '';
        lines.push(`Your server ${name}${age} is past its planned life; we will propose a replacement window outside business hours.`);
      } else {
        lines.push(`Your server ${name} comes due ${quarterLabel(srv.replaceBy!)}; we will plan its replacement outside business hours.`);
      }
    }
  } else {
    const past = serverAsks.filter((r) => r.replacement === 'replace').length;
    const soon = serverAsks.length - past;
    const parts: string[] = [];
    if (past) parts.push(`${past} ${past === 1 ? 'is' : 'are'} past planned life`);
    if (soon) parts.push(`${soon} come${soon === 1 ? 's' : ''} due within the year`);
    lines.push(`Of your ${servers.length} servers, ${parts.join(' and ')}; we will propose replacement windows outside business hours.`);
  }

  // OS support and hardware age are separate axes. A machine already marked
  // for replacement is scheduled first; a machine whose hardware is fine needs
  // an operating-system upgrade, not a purchase.
  const osEndedReplace = osEnded.filter((r) => r.replacement === 'replace');
  const osEndedKeep = osEnded.filter((r) => r.replacement !== 'replace');
  if (osEndedReplace.length > 0) {
    const names = capNames(osEndedReplace.map(rowMention));
    const verb = osEndedReplace.length === 1 ? 'no longer receives' : 'no longer receive';
    const which = osEndedReplace.length === 1 ? 'this one' : 'these';
    lines.push(`${names} ${verb} security updates on the current operating system; prioritize ${which} when scheduling.`);
  }
  if (osEndedKeep.length > 0) {
    const names = capNames(osEndedKeep.map(rowMention));
    const single = osEndedKeep.length === 1;
    lines.push(`Upgrade the operating system on ${names}; the hardware ${single ? 'itself is' : 'is'} fine for now and ${single ? 'does' : 'these do'} not need replacing yet.`);
  }

  const dueShown = due.slice(0, 3);
  for (const r of dueShown) {
    if (r.warrantyExtended && r.warrantyEndDate) {
      lines.push(`${rowMention(r)} is covered by warranty until ${monthYearLong(r.warrantyEndDate)}; budget to replace it when coverage ends.`);
    } else if (r.replaceBy && daysBetween(today, r.replaceBy) <= 183) {
      // Inside six months "no action needed yet" would contradict the runway
      // beside the row; ask for the order now.
      lines.push(`Order a replacement for ${rowMention(r)} this quarter; it comes due ${replaceByLabel(r.replaceBy, today)}.`);
    } else {
      lines.push(`Budget for ${rowMention(r)} around ${replaceByLabel(r.replaceBy, today)}; no action needed yet.`);
    }
  }

  if (due.length > dueShown.length) {
    const rest = due.length - dueShown.length;
    lines.push(`${rest} more computer${rest === 1 ? ' comes' : 's come'} due within the year; see the schedule above.`);
  }

  if (unknown.length > 0) {
    const plural = unknown.length === 1 ? 'computer' : 'computers';
    lines.push(`We are confirming purchase records for ${unknown.length} ${plural}; their timelines will appear in an upcoming report.`);
  }

  if (lines.length === 0) {
    const next = sorted.find((r) => r.replacement === 'supported' && r.replaceBy);
    lines.push(
      next
        ? `Nothing needs your attention right now. The first computer to come due is ${rowMention(next)}, around ${quarterLabel(next.replaceBy!)}; we will flag it in the report before then.`
        : 'Nothing needs your attention right now; we will flag the first computer to come due in a future report.',
    );
  }
  return lines;
}
