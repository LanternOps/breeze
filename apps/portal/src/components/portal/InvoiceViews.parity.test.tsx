// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { INVOICE_DTO_FIXTURES, type InvoiceFixtureName } from '@breeze/shared/documents';
import { invoiceSnapshotPath, normalizeDocumentRoot } from '@breeze/document-ui/testing';
import type { InvoiceDetail, PublicInvoiceDetail } from '@/lib/api';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { PublicInvoiceView } from './PublicInvoiceView';
import { InvoiceDetailView } from './InvoiceDetailView';

afterEach(() => cleanup());

const FIXTURES = Object.keys(INVOICE_DTO_FIXTURES) as InvoiceFixtureName[];
const snapshot = (name: InvoiceFixtureName) => readFileSync(invoiceSnapshotPath(name), 'utf8');

// The route envelopes the assembler produces, rebuilt from the same DTO fixtures the
// shared snapshots were generated from.
function publicEnvelope(name: InvoiceFixtureName): PublicInvoiceDetail {
  const dto = INVOICE_DTO_FIXTURES[name];
  return { invoice: dto.invoice, lines: dto.lines, documentLocale: dto.documentLocale, branding: dto.branding, chargeNow: null, payable: false } as unknown as PublicInvoiceDetail;
}
function portalEnvelope(name: InvoiceFixtureName): InvoiceDetail {
  const dto = INVOICE_DTO_FIXTURES[name];
  return { invoice: dto.invoice, lines: dto.lines, documentLocale: dto.documentLocale, branding: dto.branding } as unknown as InvoiceDetail;
}

describe('portal invoice pages DOM parity with the shared snapshot set', () => {
  // The public page replaces a void invoice with its host-policy no-amounts state.
  it.each(FIXTURES.filter((n) => n !== 'void'))('public %s equals the committed snapshot', (name) => {
    const { container } = render(<PublicInvoiceView token="t" initial={publicEnvelope(name)} />);
    expect(normalizeDocumentRoot(container)).toBe(snapshot(name));
  });

  it.each(FIXTURES)('logged-in %s equals the committed snapshot', (name) => {
    const { container } = render(<InvoiceDetailView detail={portalEnvelope(name)} />);
    expect(normalizeDocumentRoot(container)).toBe(snapshot(name));
  });
});
