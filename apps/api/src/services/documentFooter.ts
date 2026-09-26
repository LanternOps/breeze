/**
 * The ONE footer/terms resolver for customer documents — invoices AND quotes
 * (settings audit rule 5, finding 22; #6232 brought quotes onto it).
 *
 * Precedence, most specific first:
 *   1. `documentTerms` — the document's own `terms` column (the per-document
 *      footer line; frozen at issue/send, see invoiceService.issueInvoice and
 *      quoteLifecycle.freezeQuoteSentSnapshot)
 *   2. `partnerFooter` — `partners.invoiceFooter`
 *   3. `brandingFooter` — `portal_branding.footerText` for the document's org
 *
 * Every path that stamps or renders a document footer goes through this, so
 * the value frozen at issue/send is the value the live render would have shown
 * at that moment — and a later partner/portal footer edit cannot move it.
 *
 * Pure — no DB access — so callers running inside their own locked
 * transaction can share it without opening a transaction on each other's
 * behalf.
 */
export function resolveDocumentFooter(input: {
  documentTerms: string | null;
  partnerFooter: string | null;
  brandingFooter: string | null;
}): string | null {
  return input.documentTerms ?? input.partnerFooter ?? input.brandingFooter ?? null;
}
