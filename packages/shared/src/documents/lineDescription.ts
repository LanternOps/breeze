import { lineWorkedVsBilled } from '../utils/invoiceLineDetail';
import { documentDate } from './dates';
import type { DocumentDate } from './model';

/** A STAFF row (dashboard Detail view). Deliberately not a customer DTO row:
 *  staff rows include internal-only lines, and the two sets are never zipped by
 *  position (spec OD-4). */
export interface StaffLineDescriptionInput {
  name: string | null;
  description: string | null;
  quantity?: string;
  workedMinutes?: number | null;
  /** Stored `YYYY-MM-DD` work date; shown only when `labels.locale` is given. */
  workDate?: string | null;
  ticketText?: string | null;
}

export interface StaffLineDescriptionLabels {
  workedVsBilled?: (worked: string, billed: string) => string;
  locale?: string;
}

/** Same shape as `@breeze/document-ui`'s `DocumentLineDescriptionProps` (structural,
 *  so this package stays React-free). The hidden-line marker is left to the host. */
export interface LineDescriptionProps {
  title: string;
  blurb: string | null;
  workDate: DocumentDate | null;
  note: string | null;
  descriptor: string[];
  ticketText: string | null;
  qtyFold: string | null;
}

/** Title falls back to the description for legacy lines created before the
 *  name/description split; the blurb only exists when a distinct name does. */
export function lineDescriptionProps(
  line: StaffLineDescriptionInput,
  labels: StaffLineDescriptionLabels,
): LineDescriptionProps {
  const title = (line.name ?? line.description ?? '').trim();
  const blurb = line.name ? (line.description ?? '').trim() : '';
  const wb = line.quantity !== undefined ? lineWorkedVsBilled({ quantity: line.quantity, workedMinutes: line.workedMinutes }) : null;
  return {
    title,
    blurb: blurb || null,
    workDate: line.workDate && labels.locale ? documentDate(line.workDate, labels.locale) : null,
    note: wb && labels.workedVsBilled ? labels.workedVsBilled(wb.worked, wb.billed) : null,
    descriptor: [],
    ticketText: line.ticketText ?? null,
    qtyFold: null,
  };
}
