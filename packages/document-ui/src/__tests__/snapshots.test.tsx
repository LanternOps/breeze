import { readFileSync, writeFileSync } from 'node:fs';
import { INVOICE_DTO_FIXTURES, type InvoiceFixtureName } from '@breeze/shared/documents';
import { normalizeDocumentRoot, invoiceSnapshotPath } from '../__fixtures__/testing';
import { renderInvoice } from '../__fixtures__/renderInvoice';

const FIXTURE_NAMES = Object.keys(INVOICE_DTO_FIXTURES) as InvoiceFixtureName[];

it.each(FIXTURE_NAMES)('%s matches its committed normalized snapshot', (name) => {
  const html = normalizeDocumentRoot(renderInvoice(name).container);
  // Local-only regeneration; never runs in CI. Review every snapshot by eye before committing.
  if (process.env.WRITE_SNAPSHOTS === '1' && !process.env.CI) {
    writeFileSync(invoiceSnapshotPath(name), html);
  }
  expect(html).toBe(readFileSync(invoiceSnapshotPath(name), 'utf8'));
});
