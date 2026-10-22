import type { InvoiceStatus } from '../../types/billing-enums';
import type { CustomerQuoteDisplayStatus, CustomerQuoteLineDto } from '../quoteDto'; // W2a (#9418)

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

  // ---- W3a: strings only the PDF prints (appended section; W2a appends its own below/above) ----
  pdf: {
    from: string;
    taxId(id: string): string;
    payOnline: string;
    category(name: string): string;
  };
  // ---- W2a (#9418): quote document ----
  /** Every string a quote document prints (portal `quoteBlocks.tsx`,
   *  `PublicQuoteView`/`QuoteDetailView` totals, `documentShell.tsx` cover,
   *  `quoteAgreements.tsx`). */
  quote: DocumentQuoteLabels;
}

// ---- W2a (#9418): quote document ----
export interface DocumentQuoteLabels {
  eyebrow: string;
  /** The number shown when a proposal has no number yet. */
  draftNumber: string;
  issued: string;
  validUntil: string;
  preparedFor: string;
  preparedBy: string;
  columns: { description: string; qty: string; unitPrice: string; tax: string; amount: string };
  /** A line_items block's label when the author gave none, and the trailing default table's. */
  pricing: string;
  /** Keyed by the line recurrence, so a new recurrence value fails the build until labelled. */
  cadence: Record<CustomerQuoteLineDto['recurrence'], string>;
  tableSubtotal: string;
  imageAlt: string;
  imageUnavailable: string;
  deviceSet: {
    devices: string;
    seats: string;
    /** The plural noun for a billable device role ('server' → 'servers'). */
    role(role: string): string;
    inGroup(name: string): string;
    atSite(set: string, site: string): string;
    estimated(set: string): string;
    includesBilled(included: string, price: string): string;
    includesFlagged(included: string): string;
  };
  /** A category subtotal's row label. */
  category(category: string): string;
  totals: {
    firstPeriodSubtotal: string;
    subtotal: string;
    tax(pct: string | null): string;
    monthlyRecurring: string;
    annualRecurring: string;
    dueOnAcceptance: string;
    depositDueNow: string;
    remainingBalance: string;
    total: string;
    firstPeriodTotal: string;
    recurringNote: string;
  };
  terms: string;
  agreement: {
    fallbackTitle: string;
    termsTitle: string;
    pdfMeta: string;
    unavailableMeta: string;
    readMinutes(minutes: number): string;
    termsMeta(sections: number, minutes: number): string;
    footer(templateName: string, version: number): string;
    contentUnavailable: string;
    fileUnavailable: string;
    download: string;
    /** The list heading (shown from two rows up) and the row toggle words. */
    heading: string;
    read: string;
    hide: string;
  };
  status: Record<CustomerQuoteDisplayStatus, string>;
}
