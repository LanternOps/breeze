export interface PublicQuoteHeader {
  id: string;
  quoteNumber: string | null;
  title: string | null;
  status: 'viewed' | 'accepted' | 'declined' | 'expired' | 'converted';
  currencyCode: string;
  issueDate: string | null;
  expiryDate: string | null;
  subtotal: string;
  taxRate: string | null;
  taxTotal: string;
  total: string;
  oneTimeTotal: string;
  monthlyRecurringTotal: string;
  annualRecurringTotal: string;
  depositType: 'none' | 'percent' | 'selected_lines';
  depositAmount: string | null;
  dueOnAcceptanceTotal: string;
  depositDueTotal: string | null;
  categoryBreakdown: Array<{
    category: string;
    oneTimeTotal: string;
    monthlyTotal: string;
    annualTotal: string;
  }>;
  billToName: string | null;
  introNotes: string | null;
  terms: string | null;
  sellerSnapshot: PublicQuoteSellerSnapshot | null;
  coverPage: PublicQuoteCoverPage | null;
  termsAndConditions: string | null;
}

export interface PublicQuoteSellerSnapshot {
  name: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
  } | null;
  phone: string | null;
  email: string | null;
  website: string | null;
}

export interface PublicQuoteCoverPage {
  enabled: boolean;
  title: string | null;
  coverImageId: string | null;
  preparedForName: string | null;
  showPreparedBy: boolean;
}

/** Document theme/page-size identifiers — mirrors
 *  apps/api/src/services/documentThemes.ts's DocumentThemeId/DocumentPageSize
 *  (server-side source of truth; kept in sync manually, same as every other
 *  type in this file). */
export type DocumentThemeId = 'classic' | 'condensed';
export type DocumentPageSize = 'letter' | 'a4';

/** Resolved document presentation, sibling of `branding` on every quote-detail
 *  DTO (staff, authed portal, public token). Precedence is resolved
 *  server-side (quote.presentationSnapshot → partner defaults → 'classic'/
 *  'a4') — see quoteBranding.ts's resolveQuoteBranding for the canonical
 *  precedence this mirrors. Drives `data-doc-theme` on the rendered document
 *  shell so a 'condensed' quote loads its themed fonts. */
export interface QuotePresentation {
  theme: DocumentThemeId;
  pageSize: DocumentPageSize;
}
