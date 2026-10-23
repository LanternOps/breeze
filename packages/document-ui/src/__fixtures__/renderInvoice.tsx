import { render } from '@testing-library/react';
import { buildInvoiceDocumentModel, documentLabelsFor, INVOICE_DTO_FIXTURES, type InvoiceFixtureName } from '@breeze/shared/documents';
import { InvoiceDocumentView, type DocumentSlots } from '../InvoiceDocumentView';
import { STAND_IN_COMPONENTS } from './testing';

export function renderInvoice(name: InvoiceFixtureName, slots?: DocumentSlots) {
  const dto = INVOICE_DTO_FIXTURES[name];
  const model = buildInvoiceDocumentModel(dto, documentLabelsFor(dto.documentLocale));
  return render(<InvoiceDocumentView model={model} components={STAND_IN_COMPONENTS} slots={slots} />);
}
