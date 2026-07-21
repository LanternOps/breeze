import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import QuoteWorkspace from './QuoteWorkspace';
import { fetchWithAuth } from '../../../stores/auth';

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
// QuoteDocument (Preview tab) reads the org list off orgStore; stub it so the
// real module (which registers an org-id provider at import time) never pulls
// a partially-mocked auth store into scope.
vi.mock('../../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { organizations: { id: string; name: string }[] }) => unknown) =>
    selector({ organizations: [] }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

// A non-draft quote so the Editor tab (and QuoteEditor's own catalog/distributor
// probes) never mounts — this test only cares about the tab bar's labels.
const sentQuote = {
  quote: {
    id: 'q-1', quoteNumber: 'Q-2026-0001', partnerId: 'p-1', orgId: 'org-1', siteId: null,
    status: 'sent', currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '100.00',
    taxRate: null, taxTotal: '0.00', total: '100.00', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00',
    annualRecurringTotal: '0.00', billToName: 'Acme', introNotes: null, terms: null,
    termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
    convertedAt: null, convertedInvoiceId: null, sentAt: '2026-06-01T00:00:00Z', viewedAt: null,
    createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  blocks: [],
  lines: [],
};

describe('QuoteWorkspace tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/quotes/q-1') return json({ data: sentQuote });
      return json({ data: {} });
    });
  });

  it('labels the third tab "Details" (not the bare, easy-to-misread "Detail")', async () => {
    render(<QuoteWorkspace id="q-1" />);
    await waitFor(() => expect(screen.getByTestId('quote-workspace')).toBeInTheDocument());

    expect(screen.getByTestId('quote-tab-detail')).toHaveTextContent('Details');
    // The Editor tab only renders for drafts (this quote is 'sent') — Preview
    // is always present, confirming the tab bar itself rendered correctly.
    expect(screen.getByTestId('quote-tab-preview')).toHaveTextContent('Preview');
    expect(screen.queryByTestId('quote-tab-editor')).not.toBeInTheDocument();
  });
});
