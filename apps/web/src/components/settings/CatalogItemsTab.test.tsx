import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CatalogItemsTab from './CatalogItemsTab';
import { fetchWithAuth } from '../../stores/auth';
import { resetPartnerCurrencyCache } from '../../lib/usePartnerCurrency';
import type { CatalogItem } from '../../lib/api/catalog';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // orgStore (pulled in transitively via the editor drawer's useOrgStore)
  // registers an org-id provider at module load.
  registerOrgIdProvider: vi.fn(),
  // usePermissions() (billing-RBAC UI gating) reads grants off the store; grant
  // the admin wildcard so every gated control renders and these tests exercise
  // full functionality.
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('../../lib/authScope', () => ({
  getJwtClaims: () => ({ scope: 'partner' }),
  loginPathWithNext: () => '/login',
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

// Partner currency is EUR throughout: the deprecated `unitPrice` mirror is
// deliberately set to a DIFFERENT number than the EUR price-book row so any
// cell still reading the mirror fails loudly.
const PARTNER_CURRENCY = 'EUR';
const baseItem = {
  partnerId: 'p1', description: null, billingType: 'one_time' as const,
  markupPercent: null, unitOfMeasure: 'each', taxable: true, taxCategory: null,
  isActive: true, createdAt: '2026-01-01', updatedAt: '2026-01-01', costCurrency: 'EUR',
};
const WIDGET = { ...baseItem, id: 'w1', itemType: 'service' as const, name: 'Widget Service', sku: 'WID-1', unitPrice: '999.00', costBasis: '60.00', isBundle: false, prices: [{ currencyCode: 'EUR', unitPrice: '100.00' }] };
const LAPTOP = { ...baseItem, id: 'l1', itemType: 'hardware' as const, name: 'Laptop', sku: 'LAP-9', unitPrice: '1200.00', costBasis: null, isBundle: false, prices: [{ currencyCode: 'CAD', unitPrice: '1600.00' }, { currencyCode: 'EUR', unitPrice: '1200.00' }] };
const BUNDLE = { ...baseItem, id: 'b1', itemType: 'service' as const, name: 'Starter Bundle', sku: null, unitPrice: '1500.00', costBasis: null, isBundle: true, prices: [{ currencyCode: 'EUR', unitPrice: '1500.00' }] };
// Cost in CAD under a EUR partner → margin cannot be computed.
const CAD_COST = { ...baseItem, id: 'c1', itemType: 'hardware' as const, name: 'Cad Cost Item', sku: 'CAD-1', unitPrice: '10.00', costBasis: '5.00', costCurrency: 'CAD', isBundle: false, prices: [{ currencyCode: 'EUR', unitPrice: '10.00' }] };

const ECONOMICS = {
  currencyCode: 'EUR', headlinePrice: '1500.00', priceBookComplete: true, marginAvailable: true,
  totalCost: '600.00', margin: '900.00', marginPct: 60, allocationTotal: '0.00', allocationMatchesHeadline: true,
  missingPriceComponentIds: [] as string[],
};

function seed(active: CatalogItem[] = [WIDGET, LAPTOP, BUNDLE], economics: Record<string, unknown> = ECONOMICS) {
  fetchMock.mockImplementation(async (url, opts) => {
    const u = String(url);
    const method = (opts as RequestInit | undefined)?.method ?? 'GET';
    if (u === '/orgs/partners/me') return jsonResponse({ id: 'p1', currencyCode: PARTNER_CURRENCY });
    if (u.startsWith('/catalog?')) return jsonResponse({ data: active });
    if (u === '/catalog' && method === 'POST') return jsonResponse({ data: { ...baseItem, id: 'new-1', itemType: 'service', name: 'New', sku: null, unitPrice: '500.00', costBasis: null, isBundle: true, prices: [{ currencyCode: 'EUR', unitPrice: '500.00' }] } });
    if (/\/economics(\?|$)/.test(u)) return jsonResponse({ data: economics });
    if (u.endsWith('/components') && method === 'PUT') return jsonResponse({ data: {} });
    if (/^\/catalog\/[^/?]+$/.test(u)) {
      return jsonResponse({ data: { item: BUNDLE, prices: [{ id: 'pr1', itemId: 'b1', currencyCode: 'EUR', unitPrice: '1500.00' }], overrides: [], components: [{ id: 'bc1', partnerId: 'p1', bundleItemId: 'b1', componentItemId: 'w1', quantity: '3.00', showOnInvoice: true, revenueAllocation: null }] } });
    }
    return jsonResponse({});
  });
}

describe('CatalogItemsTab', () => {
  beforeEach(() => { vi.clearAllMocks(); resetPartnerCurrencyCache(); seed(); });

  it('renders items with type chips and computed margin', async () => {
    render(<CatalogItemsTab />);
    await screen.findByText('Widget Service');
    expect(screen.getByText('Laptop')).toBeInTheDocument();
    expect(screen.getByText('Starter Bundle')).toBeInTheDocument();
    // Widget: EUR price-book row 100 (NOT the 999 unitPrice mirror), cost 60 → 40%
    await waitFor(() => expect(screen.getByTestId('catalog-margin-w1')).toHaveTextContent('40.0%'));
    expect(screen.getByTestId('catalog-price-w1')).toHaveTextContent('100');
    expect(screen.getByTestId('catalog-price-w1')).not.toHaveTextContent('999');
    // Laptop: no cost basis → em-dash
    expect(screen.getByTestId('catalog-margin-l1')).toHaveTextContent('—');
    // Type chip in the Laptop row (the word also appears in the type filter).
    expect(within(screen.getByTestId('catalog-item-row-l1')).getByText('Hardware')).toBeInTheDocument();
  });

  it('filters rows by search across name and SKU', async () => {
    render(<CatalogItemsTab />);
    await screen.findByText('Widget Service');
    fireEvent.change(screen.getByTestId('catalog-search'), { target: { value: 'LAP-9' } });
    expect(screen.getByText('Laptop')).toBeInTheDocument();
    expect(screen.queryByText('Widget Service')).not.toBeInTheDocument();
  });

  it('expands a bundle to show its components and rolled-up economics', async () => {
    render(<CatalogItemsTab />);
    await screen.findByText('Starter Bundle');
    fireEvent.click(screen.getByTestId('catalog-bundle-toggle-b1'));
    const detail = await screen.findByTestId('catalog-bundle-detail-b1');
    // component line: 3× Widget Service, plus the economics rollup
    expect(detail).toHaveTextContent('Widget Service');
    expect(detail).toHaveTextContent('on invoice');
    await waitFor(() => expect(detail).toHaveTextContent('60.0%'));
    // Economics were requested in the partner currency.
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === '/catalog/b1/economics?currencyCode=EUR')).toBe(true);
  });

  it('price cell reads the partner-currency price-book row, badges extra currencies, and sorts nulls last', async () => {
    const NO_EUR = { ...LAPTOP, id: 'n1', name: 'No Euro Price', sku: null, prices: [{ currencyCode: 'CAD', unitPrice: '5.00' }] };
    seed([WIDGET, LAPTOP, NO_EUR]);
    render(<CatalogItemsTab />);
    await screen.findByText('Laptop');
    await waitFor(() => expect(screen.getByTestId('catalog-price-l1')).toHaveTextContent('1,200'));
    // Laptop has CAD + EUR → "+1 currency" badge; Widget (EUR only) has none.
    expect(screen.getByTestId('catalog-price-more-l1')).toHaveTextContent('+1 currency');
    expect(screen.queryByTestId('catalog-price-more-w1')).not.toBeInTheDocument();
    // No EUR row → em-dash, and its only (CAD) row still counts as "+1".
    expect(screen.getByTestId('catalog-price-n1')).toHaveTextContent('—');

    // Sort by price ascending: Widget (100) < Laptop (1200) < No Euro Price (null, last).
    fireEvent.click(screen.getByTestId('catalog-sort-unitPrice'));
    const names = screen.getAllByTestId(/^catalog-item-row-/).map((r) => r.textContent ?? '');
    expect(names.findIndex((n) => n.includes('Widget Service'))).toBeLessThan(names.findIndex((n) => n.includes('Laptop')));
    expect(names.findIndex((n) => n.includes('Laptop'))).toBeLessThan(names.findIndex((n) => n.includes('No Euro Price')));
    // Descending still keeps the null last.
    fireEvent.click(screen.getByTestId('catalog-sort-unitPrice'));
    const desc = screen.getAllByTestId(/^catalog-item-row-/).map((r) => r.textContent ?? '');
    expect(desc.findIndex((n) => n.includes('Laptop'))).toBeLessThan(desc.findIndex((n) => n.includes('Widget Service')));
    expect(desc[desc.length - 1]).toContain('No Euro Price');
  });

  it('margin is — with the "cost in X" title when the cost currency differs from the partner currency', async () => {
    seed([WIDGET, CAD_COST]);
    render(<CatalogItemsTab />);
    await screen.findByText('Cad Cost Item');
    await waitFor(() => expect(screen.getByTestId('catalog-margin-w1')).toHaveTextContent('40.0%'));
    const cell = screen.getByTestId('catalog-margin-c1');
    expect(cell).toHaveTextContent('—');
    expect(cell).toHaveAttribute('title', 'Cost in CAD — margin unavailable');
  });

  it('bundle economics report an incomplete price book / unavailable margin instead of partial totals', async () => {
    seed([WIDGET, BUNDLE], { ...ECONOMICS, priceBookComplete: false, totalCost: null, margin: null, marginPct: null, missingPriceComponentIds: ['w1'] });
    const { unmount } = render(<CatalogItemsTab />);
    await screen.findByText('Starter Bundle');
    fireEvent.click(screen.getByTestId('catalog-bundle-toggle-b1'));
    const econ = await screen.findByTestId('catalog-bundle-economics-b1');
    expect(econ).toHaveTextContent('Incomplete price book');
    expect(econ).not.toHaveTextContent('60.0%');
    unmount();

    seed([WIDGET, BUNDLE], { ...ECONOMICS, marginAvailable: false, totalCost: null, margin: null, marginPct: null });
    render(<CatalogItemsTab />);
    await screen.findByText('Starter Bundle');
    fireEvent.click(screen.getByTestId('catalog-bundle-toggle-b1'));
    const econ2 = await screen.findByTestId('catalog-bundle-economics-b1');
    expect(econ2).toHaveTextContent('Margin unavailable');
    expect(econ2).not.toHaveTextContent('60.0%');
  });

  it('archives an item from the row overflow (kebab) menu — after a confirm step (#1368)', async () => {
    render(<CatalogItemsTab />);
    await screen.findByText('Laptop');
    // Archive is hidden until the kebab is opened.
    expect(screen.queryByTestId('catalog-archive-l1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('catalog-actions-l1'));
    fireEvent.click(await screen.findByTestId('catalog-archive-l1'));

    // Archive no longer fires on the menu click — a confirm dialog gates it.
    const confirm = await screen.findByTestId('catalog-archive-confirm');
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === '/catalog/l1/archive')).toBe(false);

    fireEvent.click(confirm);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => String(c[0]) === '/catalog/l1/archive' && (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeTruthy();
    });
  });

  it('creates a bundle and PUTs components including showOnInvoice', async () => {
    render(<CatalogItemsTab />);
    await screen.findByText('Widget Service');

    fireEvent.click(screen.getByTestId('catalog-add-item'));
    const drawer = await screen.findByTestId('catalog-item-editor');
    fireEvent.change(within(drawer).getByTestId('catalog-form-name'), { target: { value: 'Bundle X' } });
    // The default price row is in the partner currency (EUR) from /orgs/partners/me.
    await within(drawer).findByTestId('catalog-form-price-row-EUR');
    fireEvent.change(within(drawer).getByTestId('catalog-form-price-0'), { target: { value: '500' } });
    fireEvent.click(within(drawer).getByTestId('catalog-form-bundle'));

    // Add one component → Widget, qty 2, show on invoice
    fireEvent.click(within(drawer).getByTestId('catalog-bundle-add'));
    fireEvent.change(within(drawer).getByTestId('catalog-bundle-item-0'), { target: { value: 'w1' } });
    fireEvent.change(within(drawer).getByTestId('catalog-bundle-qty-0'), { target: { value: '2' } });
    fireEvent.click(within(drawer).getByTestId('catalog-bundle-showoninvoice-0'));

    fireEvent.click(within(drawer).getByTestId('catalog-form-save'));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        (c) => String(c[0]).endsWith('/components') && (c[1] as RequestInit | undefined)?.method === 'PUT',
      );
      expect(put).toBeTruthy();
      expect(String(put![0])).toBe('/catalog/new-1/components');
      expect(JSON.parse((put![1] as RequestInit).body as string)).toEqual({
        components: [{ componentItemId: 'w1', quantity: 2, showOnInvoice: true }],
      });
    });

    // item POST happened before the components PUT
    const post = fetchMock.mock.calls.find((c) => String(c[0]) === '/catalog' && (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(post).toBeTruthy();
    const posted = JSON.parse((post![1] as RequestInit).body as string);
    expect(posted).toMatchObject({ name: 'Bundle X', prices: [{ currencyCode: 'EUR', unitPrice: 500 }], costCurrency: 'EUR', isBundle: true });
    expect(posted).not.toHaveProperty('unitPrice');
  });
});
