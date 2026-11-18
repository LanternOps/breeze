// The ONE invoice presentation resolver (settings audit rules 5 + 6, #6227).
//
// An invoice's theme and page size are a snapshot, not a setting: the partner
// configures them once (Billing → Settings, `partners.document_theme` /
// `document_page_size`) and both issue writers freeze the resolved values onto
// `invoices.document_theme` / `document_page_size` at the moment the invoice
// becomes customer-visible. So:
//
//   - draft (columns NULL)  → the partner's LIVE values (preview of what issue will freeze)
//   - issued / paid / void  → the invoice's own frozen values
//
// Every consumer (public invoice route, in-app preview, the two issue writers
// that stamp the columns) goes through this function, so a partner changing its
// default can never reflow a document the customer has already been shown.
// Each field resolves independently; unknown values normalize through the
// shared documentThemes resolvers (theme → 'classic'; a partner with no page
// size choice → its region default, #12097 resolvePartnerPageSize).
//
// Invoice PDF theming is deliberately out of scope (#6227 quorum amendment 7):
// invoicePdf.ts still renders fixed A4/Helvetica. The stored values are
// shaped so a later wave can read them there without another migration.

import { resolvePageSize, resolvePartnerPageSize, resolveThemeId, type DocumentPageSize, type DocumentThemeId } from './documentThemes';

export interface InvoicePresentation {
  theme: DocumentThemeId;
  pageSize: DocumentPageSize;
}

/** Presentation-relevant subset of an invoice row. */
export interface InvoicePresentationSource {
  documentTheme: string | null;
  documentPageSize: string | null;
}

/** Presentation-relevant subset of a partner row. `billingAddressCountry` and
 *  `settings` are required so every caller carries the region signal the page
 *  size falls back to when the partner never chose one (#12097). */
export interface PartnerPresentationSource {
  documentTheme: string | null;
  documentPageSize: string | null;
  billingAddressCountry: string | null;
  settings: unknown;
}

export function resolveInvoicePresentation(
  invoice: InvoicePresentationSource,
  partner: PartnerPresentationSource | null | undefined,
): InvoicePresentation {
  return {
    theme: resolveThemeId(invoice.documentTheme ?? partner?.documentTheme),
    pageSize: resolvePageSize(invoice.documentPageSize ?? resolvePartnerPageSize(partner)),
  };
}

/** Map a quote's frozen `presentation_snapshot` jsonb ({ theme, pageSize },
 *  stamped at send — quoteLifecycle.ts) onto the invoice-source shape, so the
 *  quote-accept issue writer freezes what the customer signed. Anything that
 *  is not a string reads as absent (→ partner fallback in the resolver). */
export function quotePresentationAsInvoiceSource(snapshot: unknown): InvoicePresentationSource {
  const snap = (snapshot && typeof snapshot === 'object' ? snapshot : {}) as { theme?: unknown; pageSize?: unknown };
  return {
    documentTheme: typeof snap.theme === 'string' ? snap.theme : null,
    documentPageSize: typeof snap.pageSize === 'string' ? snap.pageSize : null,
  };
}

/** The column values an issue writer freezes: the resolved presentation in
 *  invoice-row shape. Always concrete (never NULL), so the CHECK constraints
 *  hold even when the partner row carries an unknown legacy value. */
export function stampedPresentation(
  invoice: InvoicePresentationSource,
  partner: PartnerPresentationSource | null | undefined,
): { documentTheme: DocumentThemeId; documentPageSize: DocumentPageSize } {
  const resolved = resolveInvoicePresentation(invoice, partner);
  return { documentTheme: resolved.theme, documentPageSize: resolved.pageSize };
}
