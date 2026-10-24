import { readFileSync } from 'node:fs';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOICE_DTO_FIXTURES, type InvoiceFixtureName } from '@breeze/shared/documents';
import { STAND_IN_COMPONENTS, invoiceSnapshotPath, normalizeDocumentRoot } from '@breeze/document-ui/testing';

import InvoiceDocumentPreview from './InvoiceDocument';
import type { InvoiceDetail as InvoiceDetailData } from './invoiceTypes';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const FIXTURES = Object.keys(INVOICE_DTO_FIXTURES) as InvoiceFixtureName[];

// The Preview refetches from the staff detail's id only; the body is the customer DTO.
const staffDetail = { invoice: { id: 'inv-parity', invoiceNumber: 'X' }, lines: [], autopay: null } as unknown as InvoiceDetailData;

describe('web Preview DOM parity with the shared snapshot set', () => {
  beforeEach(() => fetchWithAuth.mockReset());

  it.each(FIXTURES)('%s equals the committed snapshot', async (name) => {
    fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: INVOICE_DTO_FIXTURES[name] }) });
    const { container } = render(<InvoiceDocumentPreview detail={staffDetail} components={STAND_IN_COMPONENTS} />);
    await waitFor(() => expect(container.querySelector('[data-document-root]')).not.toBeNull());
    expect(normalizeDocumentRoot(container)).toBe(readFileSync(invoiceSnapshotPath(name), 'utf8'));
  });
});
