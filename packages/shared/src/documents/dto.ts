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

export interface CustomerInvoiceLineDto {
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
  /** Present only when `OD9_CUSTOMER_PROJECTION[surface].ticketSubject` is on. */
  ticketSubject?: string | null;
  /** Present only when `OD9_CUSTOMER_PROJECTION[surface].bundleNesting` is on. */
  isChild?: boolean;
}

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
