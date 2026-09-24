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
// shared documentThemes resolvers (→ 'classic' / 'a4').
//
// Invoice PDF theming is deliberately out of scope (#6227 quorum amendment 7):
// invoicePdf.ts still renders fixed A4/Helvetica. The stored values are
// shaped so a later wave can read them there without another migration.

import { resolvePageSize, resolveThemeId, type DocumentPageSize, type DocumentThemeId } from './documentThemes';

export interface InvoicePresentation {
  theme: DocumentThemeId;
  pageSize: DocumentPageSize;
}

/** Presentation-relevant subset of an invoice row. */
export interface InvoicePresentationSource {
  documentTheme: string | null;
  documentPageSize: string | null;
}

/** Presentation-relevant subset of a partner row (or a quote's frozen snapshot
 *  mapped to the same shape). */
export interface PartnerPresentationSource {
  documentTheme: string | null;
  documentPageSize: string | null;
}

export function resolveInvoicePresentation(
  invoice: InvoicePresentationSource,
  partner: PartnerPresentationSource | null | undefined,
): InvoicePresentation {
  return {
    theme: resolveThemeId(invoice.documentTheme ?? partner?.documentTheme),
    pageSize: resolvePageSize(invoice.documentPageSize ?? partner?.documentPageSize),
  };
}
