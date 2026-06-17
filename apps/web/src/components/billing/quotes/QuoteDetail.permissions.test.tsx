import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteDetail from './QuoteDetail';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

type Perm = { resource: string; action: string };

// Mutable grant set the mocked auth store reads from. This file pins the read vs
// send distinction on the detail view's two action affordances: the PDF download
// is a read affordance (quotes has no `export` action, so it gates on
// quotes:read), and the Send placeholder gates on quotes:send. A read-only
// operator must see the PDF but NOT the send affordance; a writer (without send)
// still must not see send; granting send reveals it.
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

const detail: QuoteDetailData = {
  quote: {
    id: 'q-1', quoteNumber: 'Q-0001', partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'sent',
    currencyCode: 'USD', issueDate: '2026-06-01', expiryDate: null, subtotal: '50.00', taxRate: null,
    taxTotal: '0.00', total: '50.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '50.00',
    annualRecurringTotal: '0.00', billToName: 'Acme', introNotes: null, terms: null, acceptedAt: null,
    declinedAt: null, convertedAt: null, convertedInvoiceId: null, sentAt: '2026-06-02T00:00:00Z',
    viewedAt: null, createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  blocks: [],
  lines: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [];
});

describe('QuoteDetail — permission gating', () => {
  it('read-only (quotes:read) shows Download PDF but hides the Send affordance', async () => {
    state.permissions = [{ resource: 'quotes', action: 'read' }];
    render(<QuoteDetail detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    // PDF is a read affordance → visible to a viewer.
    expect(screen.getByTestId('quote-download-pdf')).toBeInTheDocument();
    // Send is gated on quotes:send → hidden.
    expect(screen.queryByTestId('quote-send-disabled')).not.toBeInTheDocument();
  });

  it('quotes:write WITHOUT quotes:send still hides the Send affordance (and shows no PDF without read)', async () => {
    // write alone does not grant read or send: the PDF (read) and Send (send)
    // affordances both stay hidden. Proves the gates are independent.
    state.permissions = [{ resource: 'quotes', action: 'write' }];
    render(<QuoteDetail detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    expect(screen.queryByTestId('quote-download-pdf')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-send-disabled')).not.toBeInTheDocument();
  });

  it('quotes:send reveals the Send affordance (positive control)', async () => {
    // A user with both read and send sees both affordances — discriminates the
    // negative cases above.
    state.permissions = [
      { resource: 'quotes', action: 'read' },
      { resource: 'quotes', action: 'send' },
    ];
    render(<QuoteDetail detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    expect(screen.getByTestId('quote-download-pdf')).toBeInTheDocument();
    expect(screen.getByTestId('quote-send-disabled')).toBeInTheDocument();
  });
});
