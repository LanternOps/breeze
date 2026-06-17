import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoiceEditor from './InvoiceEditor';
import type { InvoiceDetail } from './invoiceTypes';
import { fetchWithAuth } from '../../stores/auth';

type Perm = { resource: string; action: string };

// Mutable grant set the mocked auth store reads from. Covers the NEGATIVE gating
// branches the wildcard-positive sibling (InvoiceEditor.test.tsx) never touches:
// the editor draws a hard line between invoices:write (edit lines/notes) and
// invoices:send (issue / issue & send). A write-only operator must be able to
// build the draft but NOT issue or send it.
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const visibleLine: InvoiceDetail['lines'][number] = {
  id: 'line-1', invoiceId: 'inv-1', sourceType: 'manual', parentLineId: null, catalogItemId: null,
  description: 'Consulting', quantity: '2.00', unitPrice: '50.00', costBasis: null, revenueAllocation: null,
  taxable: false, customerVisible: true, lineTotal: '100.00', isUnapprovedTime: false, sortOrder: 1,
};

// Draft with a customer-visible line so issue/send buttons are *otherwise*
// enabled — only the permission gate keeps them hidden.
const draft: InvoiceDetail = {
  invoice: {
    id: 'inv-1', invoiceNumber: null, orgId: 'org-1', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, dueDate: null, sentAt: null, subtotal: '100.00', taxRate: null,
    taxTotal: '0.00', total: '100.00', amountPaid: '0.00', balance: '100.00', billToName: 'Acme',
    notes: '', createdAt: '2026-06-01T00:00:00Z',
  },
  lines: [visibleLine],
};

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [];
  fetchMock.mockImplementation(async (input: string) => {
    if (input.startsWith('/catalog')) return json({ data: [] });
    return json({ data: {} });
  });
});

describe('InvoiceEditor — permission gating', () => {
  it('read-only (invoices:read) hides the add-line form, per-line remove, and issue/send', async () => {
    state.permissions = [{ resource: 'invoices', action: 'read' }];
    render(<InvoiceEditor detail={draft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    expect(screen.queryByTestId('invoice-add-line')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-line-remove-line-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-issue')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-issue-send')).not.toBeInTheDocument();
    // Notes entry is disabled (gated on write) rather than removed.
    expect(screen.getByTestId('invoice-notes')).toBeDisabled();
  });

  it('invoices:write reveals editing controls but still hides Issue / Issue & Send', async () => {
    // The security-relevant line: write builds the draft; issuing/sending is a
    // separate grant (invoices:send).
    state.permissions = [{ resource: 'invoices', action: 'write' }];
    render(<InvoiceEditor detail={draft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    expect(screen.getByTestId('invoice-add-line')).toBeInTheDocument();
    expect(screen.getByTestId('invoice-line-remove-line-1')).toBeInTheDocument();
    expect(screen.getByTestId('invoice-notes')).not.toBeDisabled();
    // send-gated:
    expect(screen.queryByTestId('invoice-issue')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-issue-send')).not.toBeInTheDocument();
  });

  it('invoices:send reveals Issue / Issue & Send but NOT the editing controls', async () => {
    // Mirror image: send is not a license to edit lines. add-line and per-line
    // remove gate on invoices:write and must stay hidden.
    state.permissions = [{ resource: 'invoices', action: 'send' }];
    render(<InvoiceEditor detail={draft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    expect(screen.getByTestId('invoice-issue')).toBeInTheDocument();
    expect(screen.getByTestId('invoice-issue-send')).toBeInTheDocument();
    expect(screen.queryByTestId('invoice-add-line')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-line-remove-line-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('invoice-notes')).toBeDisabled();
  });
});
