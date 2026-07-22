import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { QuoteHeaderMeta } from './QuoteHeaderMeta';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { fetchWithAuth } from '../../../stores/auth';

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../../stores/orgStore', () => ({
  useOrgStore: (sel: (s: { organizations: unknown[] }) => unknown) => sel({
    organizations: [
      { id: 'org-2', name: 'Beta Corp' },
      { id: 'org-1', name: 'Acme' },
    ],
  }),
}));
vi.mock('../../../lib/api/catalog', () => ({
  listCatalog: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: [] }) } as unknown as Response,
  ),
  createCatalogItem: vi.fn(),
  catalogItemImagePath: vi.fn().mockReturnValue('/catalog/img'),
}));
vi.mock('../../../lib/api/quotes', () => ({
  addBlock: vi.fn(), deleteBlock: vi.fn(), addManualLine: vi.fn(), addCatalogLine: vi.fn(),
  updateLine: vi.fn(), removeLine: vi.fn(), moveLine: vi.fn(), reorderBlocks: vi.fn(), reorderLines: vi.fn(),
  uploadQuoteImage: vi.fn(), quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
  updateBlock: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function detail(): QuoteDetailData {
  return {
    quote: {
      id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
      annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '0.00', depositType: 'none', depositPercent: null,
      billToName: null, introNotes: null, terms: null, termsAndConditions: null, sellerSnapshot: null,
      acceptedAt: null, declinedAt: null, convertedAt: null, convertedInvoiceId: null,
      sentAt: null, viewedAt: null, createdBy: null,
      createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
    },
    blocks: [],
    lines: [],
  };
}

const customerPatchCalls = () =>
  fetchMock.mock.calls.filter((c) => c[0] === '/quotes/q-1' && (c[1] as RequestInit | undefined)?.method === 'PATCH'
    && String((c[1] as RequestInit).body).includes('orgId'));

describe('QuoteHeaderMeta customer reassignment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async () => json({ data: {} }));
  });

  // Reassignment clears site + bill-to and swaps the tax basis, so a select
  // change stages a confirm step — the PATCH only fires after the user confirms.
  it('changing the customer confirms, then PATCHes { orgId } and refreshes the detail', async () => {
    const onChanged = vi.fn();
    render(<QuoteHeaderMeta detail={detail()} onChanged={onChanged} />);

    const select = screen.getByTestId('quote-customer');
    expect(select).toHaveValue('org-1');
    fireEvent.change(select, { target: { value: 'org-2' } });

    // Nothing saved yet — the select still shows the current customer.
    expect(customerPatchCalls()).toHaveLength(0);
    expect(select).toHaveValue('org-1');

    fireEvent.click(screen.getByTestId('quote-customer-confirm'));
    await waitFor(() => expect(customerPatchCalls()).toHaveLength(1));
    expect(JSON.parse(String((customerPatchCalls()[0]![1] as RequestInit).body))).toEqual({ orgId: 'org-2' });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('cancelling the confirm leaves the customer unchanged and PATCHes nothing', async () => {
    render(<QuoteHeaderMeta detail={detail()} onChanged={vi.fn()} />);

    const select = screen.getByTestId('quote-customer');
    fireEvent.change(select, { target: { value: 'org-2' } });
    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => expect(screen.queryByTestId('quote-customer-confirm')).not.toBeInTheDocument());
    expect(customerPatchCalls()).toHaveLength(0);
    expect(select).toHaveValue('org-1');
  });

  it('re-selecting the current customer is a no-op', () => {
    render(<QuoteHeaderMeta detail={detail()} onChanged={vi.fn()} />);

    fireEvent.change(screen.getByTestId('quote-customer'), { target: { value: 'org-1' } });

    expect(screen.queryByTestId('quote-customer-confirm')).not.toBeInTheDocument();
    expect(customerPatchCalls()).toHaveLength(0);
  });

  // The select clips a long org name at max-w-56 with no other way to read it —
  // `title` is the mouse-hover escape hatch, so it must carry the actual
  // selected name rather than generic static help copy.
  it("the select's title carries the selected organization's full name", () => {
    render(<QuoteHeaderMeta detail={detail()} onChanged={vi.fn()} />);

    const select = screen.getByTestId('quote-customer');
    expect(select).toHaveAttribute('title', 'Acme');

    fireEvent.change(select, { target: { value: 'org-2' } });
    fireEvent.click(screen.getByTestId('quote-customer-confirm'));
    // The select snaps to the new value optimistically on confirm; its title
    // follows the same selection, not the stale one.
    return waitFor(() => expect(select).toHaveAttribute('title', 'Beta Corp'));
  });

  it('snaps the select back when the move fails', async () => {
    fetchMock.mockImplementation(async (path, init) => {
      if (path === '/quotes/q-1' && (init as RequestInit | undefined)?.method === 'PATCH') {
        return json({ error: 'Organization not found' }, false, 404);
      }
      return json({ data: {} });
    });
    render(<QuoteHeaderMeta detail={detail()} onChanged={vi.fn()} />);

    const select = screen.getByTestId('quote-customer');
    fireEvent.change(select, { target: { value: 'org-2' } });
    fireEvent.click(screen.getByTestId('quote-customer-confirm'));

    await waitFor(() => expect(customerPatchCalls()).toHaveLength(1));
    await waitFor(() => expect(select).toHaveValue('org-1'));
  });
});
