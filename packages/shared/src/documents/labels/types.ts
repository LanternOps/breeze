import type { InvoiceStatus } from '../../types/billing-enums';

/** A sentence with emphasised fragments: plain strings and `{ strong }` runs. */
export type DocumentRichParts = (string | { strong: string })[];

/**
 * Every string a customer document prints (spec §3.7). One map per document
 * locale; the document's locale picks the map, never the viewer's UI language.
 * Interpolated strings are small functions so word order can differ by locale.
 */
export interface DocumentLabels {
  invoiceEyebrow: string;
  /** The number shown on a draft, which has no invoice number yet. */
  draftNumber: string;
  issued: string;
  due: string;
  billTo: string;
  notes: string;
  terms: string;
  termsFull: string;
  columns: { description: string; qty: string; unitPrice: string; tax: string; amount: string };
  empty: string;
  /** Title of a time-entry line whose note is withheld (#8604). */
  laborLine: string;
  ticketHeader(n: string): string;
  ticketTitle(n: string, subject: string): string;
  workedVsBilled(worked: string, billed: string): string;
  /** Screen-reader text for a tax cell on a non-taxable line. */
  notTaxable: string;
  totals: {
    subtotal: string;
    tax(pct: string | null): string;
    total: string;
    paid: string;
    balance: string;
    balanceDue: string;
  };
  deposit: {
    due(deposit: string, paid: string, total: string): DocumentRichParts;
    paid(remaining: string): DocumentRichParts;
  };
  status: Record<InvoiceStatus, string>;
  /** OD-11 recurrence suffixes (used by W2 quotes). */
  perMonth: { text: string; srText: string };
  perYear: { text: string; srText: string };
}
