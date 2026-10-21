import type { DocumentHostComponents } from '@breeze/document-ui';

/** Portal host components: plain elements. Invoices carry URL logos only (the
 *  builder emits `{kind:'url'}`), so asset-backed images arrive with the quote
 *  document (W2b); until then both render nothing rather than a broken URL. */
export const portalHostComponents: DocumentHostComponents = {
  Image: () => null,
  AgreementFile: () => null,
};
