import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { QuoteCustomerSwitcher } from './QuoteHeaderMeta';
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

/**
 * Records the customer trigger's committed `title` attribute (the selected
 * org's full name). A layout effect runs synchronously in the mutation phase
 * of the very commit that produced the DOM, so it reads what the trigger
 * actually showed at that commit without depending on when React's scheduler
 * gets around to passive effects — same technique used to pin down #4659
 * (AiBudgetThresholdsInput).
 */
function CommitProbe({ seen }: { seen: string[] }) {
  useLayoutEffect(() => {
    const el = document.querySelector('[data-testid="quote-customer-trigger"]');
    if (!el) throw new Error('CommitProbe: no element matching [data-testid="quote-customer-trigger"]');
    seen.push(el.getAttribute('title') ?? '');
  });
  return null;
}

describe('QuoteCustomerSwitcher customer reassignment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async () => json({ data: {} }));
  });

  /** The switcher is a typeahead combobox: open the trigger, click an option. */
  function pickCustomer(orgId: string) {
    fireEvent.click(screen.getByTestId('quote-customer-trigger'));
    fireEvent.click(screen.getByTestId(`quote-customer-option-${orgId}`));
  }

  // Reassignment clears site + bill-to and swaps the tax basis, so a pick
  // stages a confirm step — the PATCH only fires after the user confirms.
  it('changing the customer confirms, then PATCHes { orgId } and refreshes the detail', async () => {
    const onChanged = vi.fn();
    render(<QuoteCustomerSwitcher detail={detail()} onChanged={onChanged} />);

    const trigger = screen.getByTestId('quote-customer-trigger');
    expect(trigger).toHaveTextContent('Acme');
    pickCustomer('org-2');

    // Nothing saved yet — the trigger still shows the current customer.
    expect(customerPatchCalls()).toHaveLength(0);
    expect(trigger).toHaveTextContent('Acme');

    fireEvent.click(screen.getByTestId('quote-customer-confirm'));
    await waitFor(() => expect(customerPatchCalls()).toHaveLength(1));
    expect(JSON.parse(String((customerPatchCalls()[0]![1] as RequestInit).body))).toEqual({ orgId: 'org-2' });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('cancelling the confirm leaves the customer unchanged and PATCHes nothing', async () => {
    render(<QuoteCustomerSwitcher detail={detail()} onChanged={vi.fn()} />);

    pickCustomer('org-2');
    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => expect(screen.queryByTestId('quote-customer-confirm')).not.toBeInTheDocument());
    expect(customerPatchCalls()).toHaveLength(0);
    expect(screen.getByTestId('quote-customer-trigger')).toHaveTextContent('Acme');
  });

  it('re-selecting the current customer is a no-op', () => {
    render(<QuoteCustomerSwitcher detail={detail()} onChanged={vi.fn()} />);

    pickCustomer('org-1');

    expect(screen.queryByTestId('quote-customer-confirm')).not.toBeInTheDocument();
    expect(customerPatchCalls()).toHaveLength(0);
  });

  it('filters the option list by the typed query', () => {
    render(<QuoteCustomerSwitcher detail={detail()} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByTestId('quote-customer-trigger'));
    fireEvent.change(screen.getByTestId('quote-customer-search'), { target: { value: 'beta' } });

    expect(screen.getByTestId('quote-customer-option-org-2')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-customer-option-org-1')).not.toBeInTheDocument();
  });

  // The trigger truncates a long org name — `title` is the mouse-hover escape
  // hatch, so it must carry the actual selected name.
  it("the trigger's title carries the selected organization's full name", async () => {
    render(<QuoteCustomerSwitcher detail={detail()} onChanged={vi.fn()} />);

    const trigger = screen.getByTestId('quote-customer-trigger');
    expect(trigger).toHaveAttribute('title', 'Acme');

    pickCustomer('org-2');
    fireEvent.click(screen.getByTestId('quote-customer-confirm'));
    // The trigger snaps to the new value optimistically on confirm; its title
    // follows the same selection, not the stale one.
    await waitFor(() => expect(trigger).toHaveAttribute('title', 'Beta Corp'));
  });

  it('snaps the trigger back when the move fails', async () => {
    fetchMock.mockImplementation(async (path, init) => {
      if (path === '/quotes/q-1' && (init as RequestInit | undefined)?.method === 'PATCH') {
        return json({ error: 'Organization not found' }, false, 404);
      }
      return json({ data: {} });
    });
    render(<QuoteCustomerSwitcher detail={detail()} onChanged={vi.fn()} />);

    pickCustomer('org-2');
    fireEvent.click(screen.getByTestId('quote-customer-confirm'));

    await waitFor(() => expect(customerPatchCalls()).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('quote-customer-trigger')).toHaveTextContent('Acme'));
  });

  // #4807 (mirrors #4659/#4033): `customerOrgId` used to re-seed from
  // `quote.orgId` in a `useEffect`, i.e. in a commit AFTER the one that
  // delivered the new prop. Because a passive effect is deferred, an
  // optimistic `setCustomerOrgId` (from `saveCustomer`, or any local
  // selection) landing in that one-commit window would be reverted by the
  // stale org id the effect had captured. Mirroring during render (this fix)
  // leaves no such commit — assert the trigger already shows the new
  // customer in the very commit that delivers the new `orgId` prop, using
  // the same layout-effect probe technique as #4659.
  it('re-seeds a changed quote.orgId prop within the same commit, not a later one (#4807)', () => {
    const seen: string[] = [];
    const view = (orgId: string) => (
      <>
        <QuoteCustomerSwitcher detail={{ ...detail(), quote: { ...detail().quote, orgId } }} onChanged={vi.fn()} />
        <CommitProbe seen={seen} />
      </>
    );

    const { rerender } = render(view('org-1'));
    seen.length = 0;

    rerender(view('org-2'));

    // One commit, already showing the new customer's name. An earlier entry
    // still reading 'Acme' is the old effect-driven seed — the window that
    // made the selection clobberable by a stale local optimistic update.
    expect(seen).toEqual(['Beta Corp']);
  });
});
