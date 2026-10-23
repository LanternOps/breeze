import {
  buildInvoiceDocumentModel,
  documentLabelsFor,
  type CustomerInvoiceDocument,
  type InvoiceDocumentModel,
} from '@breeze/shared/documents';
import type { CustomerDocumentBranding, PublicInvoiceDetail } from './api';

// The public payload's header type is the loosest (fields optional); the logged-in header is assignable to it.
type Envelope = Pick<PublicInvoiceDetail, 'invoice' | 'lines'> & {
  documentLocale?: string;
  branding?: CustomerDocumentBranding | PublicInvoiceDetail['branding'] | null;
};

const DEFAULT_BRANDING: CustomerDocumentBranding = {
  partnerName: null, contactEmail: null, logoUrl: null, primaryColor: null, theme: 'classic', pageSize: 'letter',
};

/**
 * The route envelope → the customer invoice DTO the shared builder takes. One
 * helper for both portal pages, so the two cannot read the payload differently.
 * Defaults only cover an API that predates a field (rolling deploy) or a payload
 * that omits it by design (the void payload never reaches this); current routes
 * send every field.
 */
export function toInvoiceDto(detail: Envelope, fallbackBranding?: CustomerDocumentBranding | null): CustomerInvoiceDocument {
  const i = detail.invoice;
  const status = i.status;
  const brand = detail.branding ?? fallbackBranding ?? DEFAULT_BRANDING;
  return {
    invoice: {
      id: i.id,
      invoiceNumber: i.invoiceNumber ?? null,
      status,
      displayStatus: i.displayStatus !== undefined ? i.displayStatus : (status === 'draft' ? null : status),
      currencyCode: i.currencyCode ?? 'USD',
      issueDate: i.issueDate ?? null,
      dueDate: i.dueDate ?? null,
      subtotal: i.subtotal ?? '0.00',
      taxRate: i.taxRate ?? null,
      taxTotal: i.taxTotal ?? '0.00',
      total: i.total ?? '0.00',
      amountPaid: i.amountPaid ?? '0.00',
      balance: i.balance ?? '0.00',
      depositDue: i.depositDue ?? null,
      billToName: i.billToName ?? null,
      billToAddress: i.billToAddress ?? null,
      billToTaxId: i.billToTaxId ?? null,
      terms: i.terms ?? null,
      notes: i.notes ?? null,
      sellerSnapshot: i.sellerSnapshot ?? null,
      termsAndConditions: i.termsAndConditions ?? null,
      lineGrouping: i.lineGrouping ?? 'entry',
    },
    lines: detail.lines.map((l, index) => ({
      id: l.id ?? `line-${index}`,
      ticketNumber: l.ticketNumber ?? null,
      ticketCategory: l.ticketCategory ?? null,
      name: l.name ?? null,
      description: l.description ?? '',
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxable: l.taxable,
      lineTotal: l.lineTotal,
      workedMinutes: l.workedMinutes ?? null,
      workDate: l.workDate ?? null,
    })),
    branding: {
      partnerName: brand.partnerName ?? null,
      contactEmail: ('contactEmail' in brand ? brand.contactEmail : null) ?? null,
      logoUrl: brand.logoUrl ?? null,
      primaryColor: brand.primaryColor ?? null,
      theme: brand.theme ?? 'classic',
      pageSize: brand.pageSize ?? 'letter',
    },
    documentLocale: detail.documentLocale ?? 'en',
  };
}

/** Envelope → view model, in the document's own locale. */
export function invoiceModelFor(detail: Envelope, fallbackBranding?: CustomerDocumentBranding | null): InvoiceDocumentModel {
  const dto = toInvoiceDto(detail, fallbackBranding);
  return buildInvoiceDocumentModel(dto, documentLabelsFor(dto.documentLocale));
}
