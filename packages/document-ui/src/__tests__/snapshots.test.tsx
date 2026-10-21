import { readFileSync, writeFileSync } from 'node:fs';
import { INVOICE_DTO_FIXTURES, QUOTE_DTO_FIXTURES, type InvoiceFixtureName, type QuoteFixtureName } from '@breeze/shared/documents';
import { normalizeDocumentRoot, invoiceSnapshotPath, quoteSnapshotPath } from '../__fixtures__/testing';
import { renderInvoice } from '../__fixtures__/renderInvoice';
import { renderQuote } from '../__fixtures__/renderQuote';

const FIXTURE_NAMES = Object.keys(INVOICE_DTO_FIXTURES) as InvoiceFixtureName[];

it.each(FIXTURE_NAMES)('%s matches its committed normalized snapshot', (name) => {
  const html = normalizeDocumentRoot(renderInvoice(name).container);
  // Local-only regeneration; never runs in CI. Review every snapshot by eye before committing.
  if (process.env.WRITE_SNAPSHOTS === '1' && !process.env.CI) {
    writeFileSync(invoiceSnapshotPath(name), html);
  }
  expect(html).toBe(readFileSync(invoiceSnapshotPath(name), 'utf8'));
});

const QUOTE_FIXTURE_NAMES = Object.keys(QUOTE_DTO_FIXTURES) as QuoteFixtureName[];

it.each(QUOTE_FIXTURE_NAMES)('quote %s matches its committed normalized snapshot', (name) => {
  const html = normalizeDocumentRoot(renderQuote(name).container);
  if (process.env.WRITE_SNAPSHOTS === '1' && !process.env.CI) {
    writeFileSync(quoteSnapshotPath(name), html);
  }
  expect(html).toBe(readFileSync(quoteSnapshotPath(name), 'utf8'));
});
