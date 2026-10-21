// Pure/SQL helpers shared by the invoice PDF, the customer-document assembler
// and invoiceService. Split out of invoicePdf.ts (W3a, #9414) so invoicePdf can
// import the assembler/service without an import cycle; invoicePdf re-exports
// every name, so existing importers are unchanged.
import { sql } from 'drizzle-orm';
import { invoiceLines, tickets, ticketCategories } from '../db/schema';

/** Pull an email address out of the organizations.billing_contact JSONB blob. */
export function resolveBillingEmail(billingContact: unknown): string | null {
  if (billingContact && typeof billingContact === 'object') {
    const email = (billingContact as { email?: unknown }).email;
    if (typeof email === 'string' && email.includes('@')) return email;
  }
  return null;
}

/**
 * DRAFT-ONLY bill-to display fallback (sweep paper cut #16). A draft invoice
 * has no bill-to snapshot yet — billToName/billToAddress/billToTaxId are
 * stamped only at issue (invoiceService.issueInvoice) — so before issue the
 * BILL TO block would otherwise render completely blank, not even the
 * organization name (which the quote PDF's equivalent draft fallback prints —
 * see quoteService's draft billTo resolution). This resolves a DISPLAY-only
 * name + email for that case; it never writes anything back to the invoices
 * row, and an already-issued invoice's own frozen billToName (even when null)
 * is always returned untouched — the "one snapshot moment" rule.
 *
 * Pure — no DB access — so loadInvoiceForRender (which does the org read) can
 * be exercised without a database, mirroring resolveDocumentFooter (documentFooter.ts).
 */
export function resolveDraftBillTo(input: {
  status: string;
  billToName: string | null;
  orgName: string | null;
  orgBillingContact: unknown;
}): { billToName: string | null; billToEmail: string | null } {
  if (input.status !== 'draft' || input.billToName?.trim()) {
    return { billToName: input.billToName, billToEmail: null };
  }
  return { billToName: input.orgName ?? null, billToEmail: resolveBillingEmail(input.orgBillingContact) };
}

/** The LIVE ticket label ("Ticket #…"): the human number the ticket UI and
 *  customer emails use (`tickets.internal_number`, T-2026-0001), falling back
 *  to the legacy random `ticket_number` for tickets created before internal
 *  numbering (sweep C4: the order was reversed, and ticket_number is NOT NULL,
 *  so the legacy id always won). Used for drafts and by issueInvoice to stamp
 *  `invoice_lines.ticket_label`. Requires `tickets` in the FROM/JOIN. */
export function invoiceTicketNumberSql() {
  return sql<string | null>`COALESCE(${tickets.internalNumber}, ${tickets.ticketNumber})`;
}

/** What an invoice line prints as its ticket label, for every invoice reader
 *  (PDF, web, portal). Settings audit rule 6: a draft previews the live number;
 *  once issued the document shows only the label frozen at issue. */
export function invoiceLineTicketNumberSql(invoiceStatus: string) {
  return invoiceStatus === 'draft'
    ? invoiceTicketNumberSql()
    : sql<string | null>`${invoiceLines.ticketLabel}`;
}

/** The LIVE category name a ticket's invoice group prints: the partner's
 *  category row, falling back to the legacy free-text `tickets.category`.
 *  A correlated subquery (not a join) so issueInvoice can use it inside its
 *  UPDATE … FROM tickets. ticket_categories is partner-axis RLS — under an
 *  org-scoped context (the portal) the subquery is blind, which is why issued
 *  documents render the stamp instead (#6674). Requires `tickets` in the
 *  FROM/JOIN. */
export function invoiceTicketCategorySql() {
  return sql<string | null>`COALESCE((SELECT ${ticketCategories.name} FROM ${ticketCategories} WHERE ${ticketCategories.id} = ${tickets.categoryId}), ${tickets.category})`;
}

/** What an invoice line's group header prints as the ticket subject / category,
 *  for every invoice reader (PDF, web, portal, public). Same rule 6 contract as
 *  invoiceLineTicketNumberSql (#6955): a draft previews the live ticket; once
 *  issued the document shows only what issueInvoice froze onto the line. */
export function invoiceLineTicketSubjectSql(invoiceStatus: string) {
  return invoiceStatus === 'draft'
    ? sql<string | null>`${tickets.subject}`
    : sql<string | null>`${invoiceLines.ticketSubject}`;
}
export function invoiceLineTicketCategorySql(invoiceStatus: string) {
  return invoiceStatus === 'draft'
    ? invoiceTicketCategorySql()
    : sql<string | null>`${invoiceLines.ticketCategory}`;
}
