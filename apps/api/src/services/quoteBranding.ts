// Resolves a quote's document branding — partner identity, portal logo/accent,
// footer, currency, and the seller "From" snapshot. Shared by the PDF renderer
// route and the quote-detail route so the downloadable PDF and the in-app /
// customer web preview brand identically (one source of truth).
//
// Call only from a `partner`- or `system`-scoped route (the staff quotes API).
// `partners` is a partner-axis RLS table: under an ORG-scoped context (e.g. a
// portal route) `breeze_has_partner_access` is false and the read silently
// returns 0 rows (#1375 class), degrading branding to the "Proposal" fallback.
// Portal routes that need branding read `partners` themselves under
// withSystemDbAccessContext — do NOT wire this helper into them as-is.

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { partners } from '../db/schema/orgs';
import { portalBranding } from '../db/schema/portal';
import { buildSellerSnapshot, type SellerSnapshot } from './sellerSnapshot';
import { resolveThemeId, resolvePageSize, type DocumentThemeId, type DocumentPageSize } from './documentThemes';

export interface QuoteBranding {
  /** Partner display name; falls back to "Proposal" when the partner is absent. */
  partnerName: string;
  /** Portal logo URL (data: or hosted) rendered directly in an <img>, or null. */
  logoUrl: string | null;
  /** Partner brand accent (hex), or null to use the app's default accent. */
  primaryColor: string | null;
  /** Footer / terms line. Precedence: quote.terms → partner footer → portal footer. */
  footer: string | null;
  /** Resolved currency for money formatting. */
  currencyCode: string;
  /** Seller "From" block — the quote's frozen snapshot, or synthesized live for drafts. */
  seller: SellerSnapshot | null;
  /** Document theme. Precedence: quote.presentationSnapshot → partner.documentTheme → 'classic'. */
  theme: DocumentThemeId;
  /** Document page size. Precedence: quote.presentationSnapshot → partner.documentPageSize → 'a4'. */
  pageSize: DocumentPageSize;
}

/** Branding-relevant subset of a quote row (keeps the helper decoupled from the
 *  full Drizzle row type so both routes can pass their already-loaded quote).
 *  `sellerSnapshot` is the raw jsonb column (typed `unknown` by Drizzle); it's
 *  narrowed to SellerSnapshot internally. */
export interface QuoteBrandingSource {
  partnerId: string;
  orgId: string;
  currencyCode: string | null;
  terms: string | null;
  sellerSnapshot: unknown;
  /** Raw jsonb column, non-null only once a quote has been sent (Task 5) —
   *  frozen once at send and never overwritten, so it takes precedence over
   *  the partner's live theme/pageSize columns for any already-sent quote
   *  (a partner changing its default theme later must not reflow a document
   *  the customer has already been shown). Null on drafts, which fall through
   *  to the partner columns below. */
  presentationSnapshot: unknown;
}

export async function resolveQuoteBranding(quote: QuoteBrandingSource): Promise<QuoteBranding> {
  const [partner] = await db
    .select()
    .from(partners)
    .where(eq(partners.id, quote.partnerId))
    .limit(1);
  const [brand] = await db
    .select({
      logoUrl: portalBranding.logoUrl,
      primaryColor: portalBranding.primaryColor,
      footerText: portalBranding.footerText,
    })
    .from(portalBranding)
    .where(eq(portalBranding.orgId, quote.orgId))
    .limit(1);

  const snap = quote.presentationSnapshot as { theme?: string; pageSize?: string } | null;

  return {
    partnerName: partner?.name ?? 'Proposal',
    logoUrl: brand?.logoUrl ?? null,
    primaryColor: brand?.primaryColor ?? null,
    footer: quote.terms ?? partner?.invoiceFooter ?? brand?.footerText ?? null,
    currencyCode: quote.currencyCode ?? partner?.currencyCode ?? 'USD',
    seller: (quote.sellerSnapshot as SellerSnapshot | null) ?? (partner ? buildSellerSnapshot(partner) : null),
    theme: resolveThemeId(snap?.theme ?? partner?.documentTheme),
    pageSize: resolvePageSize(snap?.pageSize ?? partner?.documentPageSize),
  };
}
