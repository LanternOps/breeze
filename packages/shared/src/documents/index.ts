/**
 * `@breeze/shared/documents` — the customer-document contract (#9402): DTO,
 * view model, pure builders and document labels. React-free, so the PDF can use
 * it too. Deliberately NOT re-exported from the root barrel.
 */
export * from './model';
export * from './dto';
export { documentMoney } from './money';
export { documentDate } from './dates';
export { documentSellerLines, documentAddressLines } from './sellerLines';
export { DOCUMENT_LABELS_EN, DOCUMENT_LABELS_PT_BR, documentLabelsFor, type DocumentLabels, type DocumentRichParts } from './labels';
export { buildInvoiceDocumentModel, DocumentModelError } from './invoiceBuilder';
export { INVOICE_DTO_FIXTURES, type InvoiceFixtureName } from './fixtures/invoiceDtos';

// ---- W2a (#9418): quote document ----
export * from './quoteDto';
export * from './quoteModel';
export type { DocumentQuoteLabels } from './labels/types';
export { buildQuoteDocumentModel } from './quoteBuilder';
export { QUOTE_DTO_FIXTURES, QUOTE_FIXTURE_IDS, type QuoteFixtureName } from './fixtures/quoteDtos';
export { lineDescriptionProps, type StaffLineDescriptionInput, type StaffLineDescriptionLabels, type LineDescriptionProps } from './lineDescription';
