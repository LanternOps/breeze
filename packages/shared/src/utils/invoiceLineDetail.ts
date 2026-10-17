// #8604 (invoice labor line detail W03): pure, surface-agnostic helpers that
// decide WHAT a customer invoice line shows — the work date, the technician's
// note, the worked-vs-billed figures, and per-day grouping. Every renderer
// (API PDF + email HTML, web document, portal page, public link) calls these,
// then localises its own strings. Nothing here touches amounts: grouping is
// presentation over the stored one-line-per-time-entry rows.

export const INVOICE_LINE_GROUPINGS = ['entry', 'day'] as const;
export type InvoiceLineGrouping = (typeof INVOICE_LINE_GROUPINGS)[number];

/** The resolved itemization a document renders with. */
export interface InvoiceLineDetail {
  grouping: InvoiceLineGrouping;
  /** Print the day each time-entry line was worked. */
  showDate: boolean;
  /** Print the technician's note (the time entry's description) on time-entry lines. */
  showNote: boolean;
  /** Print "x h worked · y h billed" when worked and billed time differ. */
  showWorkedTime: boolean;
}

/** Defaults reproduce the document as it was before #8604: the note and the
 *  worked-vs-billed disclosure always printed; no date; one row per entry. */
export const DEFAULT_INVOICE_LINE_DETAIL: Readonly<InvoiceLineDetail> = Object.freeze({
  grouping: 'entry',
  showDate: false,
  showNote: true,
  showWorkedTime: true,
});

/** Per-invoice override columns (`invoices.line_*`). NULL = inherit on a draft. */
export interface InvoiceLineDetailOverrides {
  lineGrouping?: string | null;
  lineShowDate?: boolean | null;
  lineShowNote?: boolean | null;
  lineShowWorkedTime?: boolean | null;
}

/** Partner default columns (`partners.invoice_line_*`). */
export interface PartnerInvoiceLineDetailDefaults {
  invoiceLineGrouping?: string | null;
  invoiceLineShowDate?: boolean | null;
  invoiceLineShowNote?: boolean | null;
  invoiceLineShowWorkedTime?: boolean | null;
}

function asGrouping(v: string | null | undefined): InvoiceLineGrouping | null {
  return v === 'entry' || v === 'day' ? v : null;
}

function normalise(d: InvoiceLineDetail): InvoiceLineDetail {
  // Per-day sub-headers ARE dates; with dates off the document stays per entry.
  return d.showDate ? d : { ...d, grouping: 'entry' };
}

function resolveLive(
  inv: InvoiceLineDetailOverrides,
  partner: PartnerInvoiceLineDetailDefaults | null | undefined,
): InvoiceLineDetail {
  const D = DEFAULT_INVOICE_LINE_DETAIL;
  return normalise({
    grouping: asGrouping(inv.lineGrouping) ?? asGrouping(partner?.invoiceLineGrouping) ?? D.grouping,
    showDate: inv.lineShowDate ?? partner?.invoiceLineShowDate ?? D.showDate,
    showNote: inv.lineShowNote ?? partner?.invoiceLineShowNote ?? D.showNote,
    showWorkedTime: inv.lineShowWorkedTime ?? partner?.invoiceLineShowWorkedTime ?? D.showWorkedTime,
  });
}

/**
 * The itemization a document renders with.
 *  - draft: the per-invoice override, else the partner default, else the default.
 *  - anything issued: ONLY the columns frozen at issue. A row issued before the
 *    columns existed (all NULL) renders with the defaults (= the document it
 *    was issued as), never with the partner's current setting.
 */
export function resolveInvoiceLineDetail(
  invoice: InvoiceLineDetailOverrides & { status: string },
  partner: PartnerInvoiceLineDetailDefaults | null | undefined,
): InvoiceLineDetail {
  return resolveLive(invoice, invoice.status === 'draft' ? partner : null);
}

/** The concrete values to freeze onto `invoices` at issue (both issue writers). */
export function stampInvoiceLineDetail(
  invoice: InvoiceLineDetailOverrides,
  partner: PartnerInvoiceLineDetailDefaults | null | undefined,
): { lineGrouping: InvoiceLineGrouping; lineShowDate: boolean; lineShowNote: boolean; lineShowWorkedTime: boolean } {
  const d = resolveLive(invoice, partner);
  return { lineGrouping: d.grouping, lineShowDate: d.showDate, lineShowNote: d.showNote, lineShowWorkedTime: d.showWorkedTime };
}

/** #6467 worked-vs-billed figures from structured data. Null for a non-time
 *  line (no workedMinutes) or when the two agree at 2dp. */
export function lineWorkedVsBilled(l: { quantity: string; workedMinutes?: number | null }): { worked: string; billed: string } | null {
  if (l.workedMinutes == null) return null;
  const worked = (l.workedMinutes / 60).toFixed(2);
  const billed = Number(l.quantity).toFixed(2);
  return worked === billed ? null : { worked, billed };
}

/** A stored `YYYY-MM-DD` work date for display. The value is already the
 *  partner-local day (#8603), so it is formatted at UTC midnight in UTC — no
 *  instant conversion, so the host or viewer timezone can never shift it. */
export function formatWorkDate(isoDate: string, locale: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate;
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  try {
    return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  } catch {
    return d.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
}

/**
 * A line's title and blurb under the note toggle. The title falls back to the
 * description for lines with no name (every assembled time-entry line). With
 * the note OFF a time-entry line's note is withheld: `title: null` tells the
 * surface to print its own localised generic labor label, and a blurb under a
 * named time-entry line is dropped. Non-time lines are never affected.
 */
export function invoiceLineText(
  l: { sourceType?: string | null; name?: string | null; description?: string | null },
  detail: Pick<InvoiceLineDetail, 'showNote'>,
): { title: string | null; blurb: string } {
  const hideNote = !detail.showNote && l.sourceType === 'time_entry';
  // `!= null`, not truthiness, for the title: an empty-string name prints '—'
  // exactly as the pre-#8604 `name ?? description` fallback did.
  if (l.name != null) return { title: l.name.trim() || '—', blurb: l.name && !hideNote ? (l.description ?? '').trim() : '' };
  if (hideNote) return { title: null, blurb: '' };
  return { title: (l.description ?? '').trim() || '—', blurb: '' };
}

/** The work date to print under a line, or null. Per-day documents carry the
 *  date on the day header instead, so the line does not repeat it. */
export function lineWorkDateToShow(l: { workDate?: string | null }, detail: InvoiceLineDetail): string | null {
  if (!detail.showDate || detail.grouping !== 'entry') return null;
  return l.workDate ?? null;
}

export interface InvoiceLineDay<L> {
  /** NULL bucket = lines with no work date (parts, manual, overage); it has no header. */
  workDate: string | null;
  lines: L[];
  /** Sum of the bucket's billed quantities, 2dp. */
  hours: string;
  /** Sum of the bucket's line totals, 2dp (the stored numeric(_,2) scale). */
  total: string;
}

const hundredths = (v: string | number | null | undefined) => {
  const n = Math.round(Number(v ?? 0) * 100);
  return Number.isFinite(n) ? n : 0;
};

/** Per-day presentation of one group's lines: dated buckets ascending, the
 *  undated bucket last, stored order kept inside each bucket. The line objects
 *  are returned as-is; the per-day sums are exact (integer hundredths). */
export function groupLinesByDay<L extends { workDate?: string | null; quantity: string; lineTotal: string }>(
  lines: L[],
): InvoiceLineDay<L>[] {
  const byDate = new Map<string, L[]>();
  const undated: L[] = [];
  for (const l of lines) {
    if (!l.workDate) { undated.push(l); continue; }
    const bucket = byDate.get(l.workDate);
    if (bucket) bucket.push(l); else byDate.set(l.workDate, [l]);
  }
  const make = (workDate: string | null, ls: L[]): InvoiceLineDay<L> => ({
    workDate,
    lines: ls,
    hours: (ls.reduce((s, l) => s + hundredths(l.quantity), 0) / 100).toFixed(2),
    total: (ls.reduce((s, l) => s + hundredths(l.lineTotal), 0) / 100).toFixed(2),
  });
  const days = [...byDate.keys()].sort().map((d) => make(d, byDate.get(d)!));
  if (undated.length > 0) days.push(make(null, undated));
  return days;
}
