/**
 * The customer invoice DTO (spec §3.4, #9402): exactly what
 * `apps/api/src/services/customerDocument.ts` sends to a customer surface (the
 * public link, the logged-in portal) and to the staff Preview
 * (`GET /invoices/:id/customer-view`). Every field here leaves the server for a
 * customer, so adding one is a visibility decision.
 */
import type { InvoiceStatus } from '../types/billing-enums';
import type { DocumentPageSize, DocumentThemeId, PublicQuoteSellerSnapshot } from '../types/publicQuote';

/** Who the document is assembled for. Controls draft acceptance and line-detail
 *  resolution only; eligibility stays in the routes. */
export type CustomerDocumentMode = 'public' | 'portal' | 'staff';

/** Same structure as the quote seller snapshot; reused rather than copied. */
export type DocumentSellerSnapshot = PublicQuoteSellerSnapshot;

/** The line keyset every surface receives. `toCustomerInvoiceLine` (the #8604
 *  boundary) produces exactly this — never the OD-9 keys. */
export interface CustomerInvoiceLineCore {
  /** The invoice_lines id: an opaque row key, not customer content. */
  id: string;
  ticketNumber: string | null;
  ticketCategory: string | null;
  name: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  taxable: boolean;
  lineTotal: string;
  workedMinutes: number | null;
  workDate: string | null;
}

/** OD-9 (#9402) keys: present only when the assembler's per-surface projection
 *  switch enables them; omitted (never `undefined`) otherwise. */
export interface CustomerInvoiceLineOd9 {
  ticketSubject?: string | null;
  isChild?: boolean;
}

export type CustomerInvoiceLineDto = CustomerInvoiceLineCore & CustomerInvoiceLineOd9;

/** The bill-to postal address, the same shape as the seller's. The emailed PDF
 *  has always printed it, so it is not new to the customer (W3a). */
export type DocumentBillToAddress = NonNullable<DocumentSellerSnapshot['address']>;

export interface CustomerInvoiceHeaderDto {
  id: string;
  invoiceNumber: string | null;
  status: InvoiceStatus;
  /** The pill the customer sees: the status, or null for a draft (staff Preview only). */
  displayStatus: Exclude<InvoiceStatus, 'draft'> | null;
  currencyCode: string;
  issueDate: string | null;
  dueDate: string | null;
  subtotal: string;
  taxRate: string | null;
  taxTotal: string;
  total: string;
  amountPaid: string;
  balance: string;
  depositDue: string | null;
  billToName: string | null;
  /** W3a: printed under the bill-to name by the PDF today. */
  billToAddress: DocumentBillToAddress | null;
  billToTaxId: string | null;
  /** W3a: the short document terms / footer line the PDF prints (invoices.terms). */
  terms: string | null;
  notes: string | null;
  sellerSnapshot: DocumentSellerSnapshot | null;
  termsAndConditions: string | null;
  lineGrouping: 'entry' | 'day';
}

export interface CustomerDocumentBrandingDto {
  partnerName: string | null;
  contactEmail: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  theme: DocumentThemeId;
  pageSize: DocumentPageSize;
}

export interface CustomerInvoiceDocument {
  invoice: CustomerInvoiceHeaderDto;
  lines: CustomerInvoiceLineDto[];
  branding: CustomerDocumentBrandingDto;
  /** `invoice.documentLocale ?? partner locale ?? 'en'` (spec §3.7). */
  documentLocale: string;
}
