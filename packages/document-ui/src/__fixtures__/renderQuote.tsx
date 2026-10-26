import { render } from '@testing-library/react';
import { buildQuoteDocumentModel, documentLabelsFor, QUOTE_DTO_FIXTURES, type QuoteFixtureName } from '@breeze/shared/documents';
import { QuoteDocumentView } from '../QuoteDocumentView';
import type { DocumentSlots } from '../hostComponents';
import { STAND_IN_COMPONENTS } from './testing';

export function renderQuote(name: QuoteFixtureName, slots?: DocumentSlots, components = STAND_IN_COMPONENTS) {
  const dto = QUOTE_DTO_FIXTURES[name];
  const model = buildQuoteDocumentModel(dto, documentLabelsFor(dto.documentLocale));
  return render(<QuoteDocumentView model={model} components={components} slots={slots} />);
}
