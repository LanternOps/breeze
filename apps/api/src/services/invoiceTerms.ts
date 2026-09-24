/**
 * Invoice payment terms — the ONE resolver (settings audit rule 5, #6229).
 *
 * Two levels, one direction (rule 3): partner default
 * (`partners.invoice_terms_days`, NOT NULL DEFAULT 30) → org override
 * (`organizations.invoice_terms_days`, NULL = inherit) → frozen onto the
 * invoice as `due_date` at issue (rule 6). Issued invoices are never restamped.
 *
 * Used by every issue writer: invoiceService.issueInvoice (manual + contract
 * auto-issue, which delegates to it) and quoteAcceptService's direct issue.
 * `invoiceTerms.test.ts` fails if any other file hand-rolls a terms fallback.
 */

export const DEFAULT_INVOICE_TERMS_DAYS = 30;

/** `org ?? partner ?? 30`. `??`, never `||`: 0 ("due on receipt") is a real value. */
export function resolveInvoiceTermsDays(
  orgTermsDays: number | null | undefined,
  partnerTermsDays: number | null | undefined,
): number {
  return orgTermsDays ?? partnerTermsDays ?? DEFAULT_INVOICE_TERMS_DAYS;
}

/** Issue date + terms, as the `YYYY-MM-DD` (UTC) the `due_date` column stores. */
export function computeDueDate(issueDate: Date, termsDays: number): string {
  return new Date(issueDate.getTime() + termsDays * 86_400_000).toISOString().slice(0, 10);
}
