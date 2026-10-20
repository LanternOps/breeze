/**
 * `@breeze/shared/documents` — the customer-document contract (#9402): DTO,
 * view model, pure builders and document labels. React-free, so the PDF can use
 * it too. Deliberately NOT re-exported from the root barrel.
 */
export * from './model';
export * from './dto';
export { documentMoney } from './money';
export { documentDate } from './dates';
export { documentSellerLines } from './sellerLines';
export { DOCUMENT_LABELS_EN, documentLabelsFor, type DocumentLabels, type DocumentRichParts } from './labels';
