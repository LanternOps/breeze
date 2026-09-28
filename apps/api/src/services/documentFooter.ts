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
 * `documentTerms` has three states, and `??` (never `||`) keeps them apart:
 *   - NULL     — not frozen: a draft, or a document stamped before #7216 froze
 *                "no footer". Resolves live through levels 2 and 3.
 *   - ''       — frozen "no footer" (#7216): the document became
 *                customer-visible while no level set a footer, so it prints
 *                none, even after a footer is configured later.
 *   - any text — that footer, verbatim.
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

/**
 * The value to STAMP into a document's `terms` column at the moment it becomes
 * customer-visible (invoice issue, quote send — settings rule 6). Same chain as
 * {@link resolveDocumentFooter}, but never NULL: "no footer at any level" is
 * frozen as `''` so the render path can tell it apart from "not frozen yet"
 * (#7216). A NULL stamp re-resolves live, so a footer added after the customer
 * already had the document would print on it.
 */
export function freezeDocumentFooter(input: {
  documentTerms: string | null;
  partnerFooter: string | null;
  brandingFooter: string | null;
}): string {
  return resolveDocumentFooter(input) ?? '';
}
