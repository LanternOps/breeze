/**
 * The customer-document view model (spec §3.2, #9402). Built only from the
 * customer DTO (`dto.ts`) by the pure builders in this folder; every surface
 * that presents a quote or an invoice for reading renders from it. It holds
 * display-ready values in the document's locale and currency plus booleans for
 * what to show, so components carry no business rules.
 *
 * Quote-only types (`QuoteBlockModel`, `QuoteDocumentModel`, …) land in W2a's
 * `quoteModel.ts`.
 */
import type { DocumentPageSize, DocumentThemeId } from '../types/publicQuote';

export type { DocumentPageSize, DocumentThemeId };

declare const sanitized: unique symbol;
/** HTML that passed the assembler's server-side sanitizer. Only the assembler casts to it;
 *  every dangerouslySetInnerHTML sink in the package accepts only this type. */
export type SanitizedHtml = string & { readonly [sanitized]: true };

export interface DocumentAssetRef {
  kind: 'logo' | 'cover' | 'block_image' | 'line_thumb' | 'agreement_file';
  /** line_thumb: the line's uploaded image id, else its catalog item id (quotePdf.ts:579-585). */
  id: string;
}

/** Money is the one non-string value: the PDF re-derives a glyph-safe string
 *  from the raw `amount` (`formatMoneyForPdf`), so both travel together. */
export interface DocumentMoney {
  text: string;             // screen form, document locale
  amount: string;           // decimal string, for the PDF's glyph-safe re-format
  currency: string;
  suffix: { text: string; srText: string } | null;   // "/mo" + "per month" (OD-11)
}

export interface DocumentDate { text: string; iso: string }   // <time dateTime={iso}>

export interface DocumentBranding {
  logo: { kind: 'asset'; ref: DocumentAssetRef } | { kind: 'url'; url: string } | null;
  logoAlt: string;
  wordmark: string | null;           // partner name, else seller name
  theme: DocumentThemeId;            // 'classic' | 'condensed'
  pageSize: DocumentPageSize;        // 'a4' | 'letter'; sets the cover aspect (OD-5)
  seller: { name: string | null; lines: string[]; phone: string | null; email: string | null; website: string | null } | null;
}

export interface DocumentHeaderModel {
  eyebrow: string;                   // "Invoice" / "Proposal"
  number: string;                    // "INV-0042", or the draft fallback label
  subtitle: string | null;           // a proposal's title
  status: { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' } | null;
  dates: { label: string; value: DocumentDate }[];
  billTo: { label: string; name: string; addressLines: string[]; taxId: string | null } | null;  // null when a cover carries "Prepared for"
}

export interface DocumentLineRow<Tax extends DocumentMoney | 'exempt' | null> {
  key: string;                       // server line id (§3.4 adds it to the invoice projection)
  title: string;                     // non-empty: '—' or the localised labor label (builder asserts)
  blurb: string | null;              // rendered with whitespace-pre-line (fixes D1 by construction)
  workDate: DocumentDate | null;
  qty: string;
  unit: DocumentMoney;
  tax: Tax;                          // 'exempt' renders '—' with srText `columns.notTaxable`
  amount: DocumentMoney;
  note: string | null;               // worked-vs-billed disclosure
  descriptor: string[];              // quote device-set lines
  ticketText: string | null;         // a per-line ticket label; null for invoices (W1 drops showLineTicket)
  thumbnail: DocumentAssetRef | null;
  isChild: boolean;                  // bundle component (D10, OD-9)
}

export type DocumentGroupHeader =
  | { kind: 'ticket'; title: string; category: string | null }   // invoices (D9, OD-9)
  | { kind: 'cadence'; label: string }                           // quotes: One-time / Monthly / Annual
  | null;

export interface DocumentLineGroup<Tax extends DocumentMoney | 'exempt' | null> {
  key: string;
  header: DocumentGroupHeader;
  days: { key: string; header: { date: DocumentDate; hours: string; total: DocumentMoney } | null; rows: DocumentLineRow<Tax>[] }[];
}

interface LineTableBase { label: string | null; subtotal: { label: string; parts: DocumentMoney[] } | null; emptyText: string | null }
/** The tax column is shown iff `columns.tax` is a string; rows are typed to match, so the two cannot disagree.
 *  Only the taxed variant can hold `'exempt'` cells, so only it carries their screen-reader text. */
export type DocumentLineTableModel =
  | (LineTableBase & { columns: { description: string; qty: string; unitPrice: string; tax: string; amount: string; notTaxable: string }; groups: DocumentLineGroup<DocumentMoney | 'exempt'>[] })
  | (LineTableBase & { columns: { description: string; qty: string; unitPrice: string; tax: null; amount: string }; groups: DocumentLineGroup<null>[] });

export interface DocumentTotalsRow {
  key: string;
  label: string;
  value: DocumentMoney | DocumentMoney[];        // a list renders joined with ' + ', stacked when too wide
  weight: 'muted' | 'regular' | 'strong' | 'hero';
  ruleAbove: 'none' | 'neutral' | 'accent';
  sign?: 'minus';                                 // "Paid −$100.00"
}
export interface DocumentTotalsModel {
  rows: DocumentTotalsRow[];
  aside: { rows: DocumentTotalsRow[]; note: string } | null;    // the quote's tinted first-period box
  depositStrip: { parts: (string | { strong: string })[] } | null;
}

export interface InvoiceDocumentModel {
  kind: 'invoice';
  locale: string;                    // resolved document locale (§3.7)
  branding: DocumentBranding;
  header: DocumentHeaderModel;
  notes: string | null;
  /** Headings for the notes block and the short terms line (document locale). */
  sectionLabels: { notes: string; terms: string };
  lines: DocumentLineTableModel;
  totals: DocumentTotalsModel;
  terms: { short: string | null; full: { label: string; text: string; meta: string } | null };
  footer: string | null;
}
