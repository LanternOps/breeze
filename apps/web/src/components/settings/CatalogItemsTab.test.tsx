import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CatalogItemsTab from './CatalogItemsTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
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

const baseItem = {
  partnerId: 'p1', description: null, billingType: 'one_time' as const,
  markupPercent: null, unitOfMeasure: 'each', taxable: true, taxCategory: null,
  isActive: true, createdAt: '2026-01-01', updatedAt: '2026-01-01',
};
const WIDGET = { ...baseItem, id: 'w1', itemType: 'service' as const, name: 'Widget Service', sku: 'WID-1', unitPrice: '100.00', costBasis: '60.00', isBundle: false };
const LAPTOP = { ...baseItem, id: 'l1', itemType: 'hardware' as const, name: 'Laptop', sku: 'LAP-9', unitPrice: '1200.00', costBasis: null, isBundle: false };
const BUNDLE = { ...baseItem, id: 'b1', itemType: 'service' as const, name: 'Starter Bundle', sku: null, unitPrice: '1500.00', costBasis: null, isBundle: true };

function seed(active = [WIDGET, LAPTOP, BUNDLE]) {
  fetchMock.mockImplementation(async (url, opts) => {
    const u = String(url);
    const method = (opts as RequestInit | undefined)?.method ?? 'GET';
    if (u.startsWith('/catalog?')) return jsonResponse({ data: active });
    if (u === '/catalog' && method === 'POST') return jsonResponse({ data: { ...baseItem, id: 'new-1', itemType: 'service', name: 'New', sku: null, unitPrice: '500.00', costBasis: null, isBundle: true } });
    if (u.endsWith('/economics')) return jsonResponse({ data: { headlinePrice: '1500.00', totalCost: '600.00', margin: '900.00', marginPct: 60, allocationTotal: '0.00', allocationMatchesHeadline: true } });
    if (u.endsWith('/components') && method === 'PUT') return jsonResponse({ data: {} });
    if (/^\/catalog\/[^/?]+$/.test(u)) {
      return jsonResponse({ data: { item: BUNDLE, overrides: [], components: [{ id: 'bc1', partnerId: 'p1', bundleItemId: 'b1', componentItemId: 'w1', quantity: '3.00', showOnInvoice: true, revenueAllocation: null }] } });
    }
    return jsonResponse({});
  });
}

describe('CatalogItemsTab', () => {
  beforeEach(() => { vi.clearAllMocks(); seed(); });

  it('renders items with type chips and computed margin', async () => {
    render(<CatalogItemsTab />);
    await screen.findByText('Widget Service');
    expect(screen.getByText('Laptop')).toBeInTheDocument();
    expect(screen.getByText('Starter Bundle')).toBeInTheDocument();
    // Widget: (100-60)/100 = 40%
    expect(screen.getByTestId('catalog-margin-w1')).toHaveTextContent('40.0%');
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
  });

  it('archives an item from the row overflow (kebab) menu', async () => {
    render(<CatalogItemsTab />);
    await screen.findByText('Laptop');
    // Archive is hidden until the kebab is opened.
    expect(screen.queryByTestId('catalog-archive-l1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('catalog-actions-l1'));
    fireEvent.click(await screen.findByTestId('catalog-archive-l1'));
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
    fireEvent.change(within(drawer).getByTestId('catalog-form-price'), { target: { value: '500' } });
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
    expect(JSON.parse((post![1] as RequestInit).body as string)).toMatchObject({ name: 'Bundle X', unitPrice: 500, isBundle: true });
  });
});
