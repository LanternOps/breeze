import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPartnerCurrencyCache } from '../../lib/usePartnerCurrency';

import CatalogItemEditorDrawer from './CatalogItemEditorDrawer';
import type { CatalogItem } from '../../lib/api/catalog';
import * as catalogApi from '../../lib/api/catalog';
import * as authScope from '../../lib/authScope';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

// Keep the real presentation helpers + constants; stub only the network calls.
vi.mock('../../lib/api/catalog', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/api/catalog')>();
  return {
    ...actual,
    getCatalogItem: vi.fn(),
    setOrgPriceOverride: vi.fn(),
    removeOrgPriceOverride: vi.fn(),
    setItemPrice: vi.fn(),
    removeItemPrice: vi.fn(),
    createCatalogItem: vi.fn(),
    updateCatalogItem: vi.fn(),
    setBundleComponents: vi.fn(),
    uploadCatalogItemImage: vi.fn(),
    importCatalogItemImageFromUrl: vi.fn(),
    deleteCatalogItemImageRequest: vi.fn(),
  };
});
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
// Raw fetches the drawer makes outside the catalog client: GET /orgs/partners/me
// (partner currency, via usePartnerCurrency) and the product-image preview.
vi.mock('../../stores/auth', async (importActual) => {
  const actual = await importActual<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: vi.fn() };
});
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: () => ({
    organizations: [{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Beta' }],
  }),
}));
// Per-org pricing is gated on partner scope, read from the JWT claims (not from
// useOrgStore().partners, which is system-scope-only — #1368). Default to a
// partner-scope user; individual tests override the scope as needed.
vi.mock('../../lib/authScope', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/authScope')>();
  return { ...actual, getJwtClaims: vi.fn() };
});

const getMock = vi.mocked(catalogApi.getCatalogItem);
const setMock = vi.mocked(catalogApi.setOrgPriceOverride);
const delMock = vi.mocked(catalogApi.removeOrgPriceOverride);
const claimsMock = vi.mocked(authScope.getJwtClaims);
const rawFetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

/** Partner currency fetch (+ image preview 404). Never 'USD' by default so a
 *  USD fallback anywhere in the drawer shows up as a failing assertion. */
const seedPartner = (currencyCode: string | null = 'EUR') => {
  rawFetchMock.mockImplementation(async (url) => {
    const u = String(url);
    if (u === '/orgs/partners/me') return currencyCode ? json({ id: 'p-1', currencyCode }) : json(null, false);
    return json(null, false, 404);
  });
};

const item = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  id: 'item-1', partnerId: 'p-1', itemType: 'service', name: 'Managed WS', sku: null, description: null,
  billingType: 'one_time', unitPrice: '100.00', costBasis: null, costCurrency: 'EUR', markupPercent: null, unitOfMeasure: 'each',
  taxable: false, taxCategory: null, isBundle: false, isActive: true, createdAt: '', updatedAt: '',
  prices: [{ currencyCode: 'EUR', unitPrice: '100.00' }], ...over,
});

const priceRow = (currencyCode: string, unitPrice: string) => ({ id: `pr-${currencyCode}`, itemId: 'item-1', currencyCode, unitPrice });

const detail = (overrides: Array<{ orgId: string; unitPrice: string; currencyCode?: string }>) =>
  json({ data: { item: item(), prices: [priceRow('EUR', '100.00')], components: [], overrides: overrides.map((o, i) => ({ id: `ov-${i}`, catalogItemId: 'item-1', currencyCode: 'EUR', ...o })) } });

describe('CatalogItemEditorDrawer — per-org pricing (#1368)', () => {
  beforeEach(() => {
    resetPartnerCurrencyCache(); // module-level cache must not leak the previous test's partner currency
    vi.clearAllMocks();
    seedPartner('EUR');
    // Default: a partner-scope user (the audience for per-org pricing).
    claimsMock.mockReturnValue({ scope: 'partner', partnerId: 'p-1', orgId: null });
    getMock.mockResolvedValue(detail([{ orgId: 'org-1', unitPrice: '80.00' }]));
    setMock.mockResolvedValue(json({ data: { id: 'ov-new', catalogItemId: 'item-1', orgId: 'org-2', currencyCode: 'EUR', unitPrice: '70.00' } }));
    delMock.mockResolvedValue(json({ data: { id: 'ov-0', catalogItemId: 'item-1', orgId: 'org-1', unitPrice: '80.00' } }));
  });

  const renderDrawer = (props: Partial<React.ComponentProps<typeof CatalogItemEditorDrawer>> = {}) =>
    render(<CatalogItemEditorDrawer open item={item()} allItems={[]} onClose={vi.fn()} onSaved={vi.fn()} {...props} />);

  it('loads and lists existing overrides for an existing item', async () => {
    renderDrawer();
    await waitFor(() => expect(screen.getByTestId('catalog-org-pricing')).toBeInTheDocument());
    const row = await screen.findByTestId('catalog-override-row-org-1');
    expect(row).toHaveTextContent('Acme');
    expect(screen.getByTestId('catalog-override-price-org-1')).toHaveTextContent('EUR 80.00');
  });

  it('sets a new override (PUT with a numeric price + currency) and a removable existing one (DELETE)', async () => {
    renderDrawer();
    await screen.findByTestId('catalog-override-row-org-1');
    await screen.findByTestId('catalog-form-price-row-EUR');

    // Only orgs without an override are offered (org-1 already has one). The
    // mocked org list carries no currencyCode, so the override currency falls
    // back to the partner's (EUR) — never a hard-coded USD.
    fireEvent.change(screen.getByTestId('catalog-override-org'), { target: { value: 'org-2' } });
    expect(screen.getByTestId('catalog-override-currency')).toHaveValue('EUR');
    fireEvent.change(screen.getByTestId('catalog-override-price-input'), { target: { value: '70' } });
    fireEvent.click(screen.getByTestId('catalog-override-add'));
    await waitFor(() => expect(setMock).toHaveBeenCalledWith('item-1', 'org-2', 70, 'EUR'));

    fireEvent.click(screen.getByTestId('catalog-override-remove-org-1'));
    await waitFor(() => expect(delMock).toHaveBeenCalledWith('item-1', 'org-1'));
  });

  it('hides the section for a new (unsaved) item', async () => {
    renderDrawer({ item: null });
    await waitFor(() => expect(screen.getByTestId('catalog-item-editor')).toBeInTheDocument());
    expect(screen.queryByTestId('catalog-org-pricing')).not.toBeInTheDocument();
  });

  it('hides the section for a bundle (price derives from components)', async () => {
    getMock.mockResolvedValue(json({ data: { item: item({ isBundle: true }), components: [], overrides: [] } }));
    renderDrawer({ item: item({ isBundle: true }) });
    await waitFor(() => expect(screen.getByTestId('catalog-bundle-builder')).toBeInTheDocument());
    expect(screen.queryByTestId('catalog-org-pricing')).not.toBeInTheDocument();
  });

  it('hides the section for an org-scope (non-partner) user', async () => {
    claimsMock.mockReturnValue({ scope: 'organization', partnerId: null, orgId: 'org-1' });
    renderDrawer();
    await waitFor(() => expect(screen.getByTestId('catalog-item-editor')).toBeInTheDocument());
    expect(screen.queryByTestId('catalog-org-pricing')).not.toBeInTheDocument();
  });

  it('hides the section for a partner-scope user with a null partnerId', async () => {
    claimsMock.mockReturnValue({ scope: 'partner', partnerId: null, orgId: null });
    renderDrawer();
    await waitFor(() => expect(screen.getByTestId('catalog-item-editor')).toBeInTheDocument());
    expect(screen.queryByTestId('catalog-org-pricing')).not.toBeInTheDocument();
  });
});

// #1944 — a failed detail load must NOT masquerade as "this bundle has no
// components": empty `components` saved back would wipe the real bundle.
describe('CatalogItemEditorDrawer — detail load failure (#1944)', () => {
  const toastMock = vi.mocked(showToast);
  const createMock = vi.mocked(catalogApi.createCatalogItem);
  const updateMock = vi.mocked(catalogApi.updateCatalogItem);
  const bundleMock = vi.mocked(catalogApi.setBundleComponents);

  beforeEach(() => {
    resetPartnerCurrencyCache(); // module-level cache must not leak the previous test's partner currency
    vi.clearAllMocks();
    seedPartner('EUR');
    claimsMock.mockReturnValue({ scope: 'partner', partnerId: 'p-1', orgId: null });
    updateMock.mockResolvedValue(json({ data: item({ isBundle: true }) }));
    createMock.mockResolvedValue(json({ data: item({ isBundle: true }) }));
    bundleMock.mockResolvedValue(json({ data: {} }));
  });

  const renderBundle = () =>
    render(
      <CatalogItemEditorDrawer
        open
        item={item({ isBundle: true })}
        allItems={[]}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

  it('toasts and flags an inline error when the bundle detail load returns non-401 failure', async () => {
    getMock.mockResolvedValue(json(null, false)); // status 500
    renderBundle();
    expect(await screen.findByTestId('catalog-bundle-load-error')).toBeInTheDocument();
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('treats a malformed (no data) body as a failure, not an empty bundle', async () => {
    getMock.mockResolvedValue(json({ notData: true }));
    renderBundle();
    expect(await screen.findByTestId('catalog-bundle-load-error')).toBeInTheDocument();
    expect(screen.queryByTestId('catalog-bundle-empty')).not.toBeInTheDocument();
  });

  it('treats a rejected detail fetch as a failure', async () => {
    getMock.mockRejectedValue(new Error('network'));
    renderBundle();
    expect(await screen.findByTestId('catalog-bundle-load-error')).toBeInTheDocument();
  });

  it('disables Save and never calls setBundleComponents after a failed bundle load', async () => {
    getMock.mockResolvedValue(json(null, false));
    renderBundle();
    await screen.findByTestId('catalog-bundle-load-error');

    const saveBtn = screen.getByTestId('catalog-form-save') as HTMLButtonElement;
    expect(saveBtn).toBeDisabled();

    // Even if invoked directly (e.g. enabled by other state), the guard holds.
    fireEvent.click(saveBtn);
    await waitFor(() => expect(screen.getByTestId('catalog-bundle-load-error')).toBeInTheDocument());
    expect(bundleMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('still saves normally when the detail load succeeds (no false positive)', async () => {
    getMock.mockResolvedValue(
      json({ data: { item: item({ isBundle: true }), prices: [priceRow('EUR', '100.00')], components: [{ componentItemId: 'c-1', quantity: '2', showOnInvoice: false }], overrides: [] } }),
    );
    render(
      <CatalogItemEditorDrawer
        open
        item={item({ isBundle: true })}
        allItems={[{ ...item(), id: 'c-1', name: 'Component', isBundle: false, isActive: true }]}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    // Loaded component renders, no error banner.
    await screen.findByTestId('catalog-bundle-row-0');
    expect(screen.queryByTestId('catalog-bundle-load-error')).not.toBeInTheDocument();

    await screen.findByTestId('catalog-form-price-row-EUR');
    const saveBtn = screen.getByTestId('catalog-form-save') as HTMLButtonElement;
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);
    await waitFor(() => expect(bundleMock).toHaveBeenCalled());
    expect(bundleMock).toHaveBeenCalledWith('item-1', [
      { componentItemId: 'c-1', quantity: 2, showOnInvoice: false },
    ]);
  });
});

// Product image "Import from URL" — the server downloads + validates the remote
// bytes (SSRF-guarded, 5 MB cap), so the client just posts the URL. Mirrors the
// quote line/image-block URL source.
describe('CatalogItemEditorDrawer — product image from URL', () => {
  const importUrlMock = vi.mocked(catalogApi.importCatalogItemImageFromUrl);
  const toastMock = vi.mocked(showToast);

  beforeEach(() => {
    resetPartnerCurrencyCache(); // module-level cache must not leak the previous test's partner currency
    vi.clearAllMocks();
    seedPartner('EUR');
    claimsMock.mockReturnValue({ scope: 'partner', partnerId: 'p-1', orgId: null });
    getMock.mockResolvedValue(json({ data: { item: item(), prices: [], components: [], overrides: [] } }));
  });

  const renderDrawer = () =>
    render(<CatalogItemEditorDrawer open item={item()} allItems={[]} onClose={vi.fn()} onSaved={vi.fn()} />);

  it('posts the URL to the import endpoint and reports success', async () => {
    importUrlMock.mockResolvedValue(json({ data: { imageId: 'img-1' } }));
    renderDrawer();
    await screen.findByTestId('catalog-form-image-url');

    fireEvent.change(screen.getByTestId('catalog-form-image-url'), { target: { value: 'https://cdn.example.com/p.png' } });
    fireEvent.click(screen.getByTestId('catalog-form-image-url-btn'));

    await waitFor(() => expect(importUrlMock).toHaveBeenCalledWith('item-1', 'https://cdn.example.com/p.png'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ message: 'Image imported' })));
  });

  it('disables Import from URL until a URL is entered', async () => {
    renderDrawer();
    await screen.findByTestId('catalog-form-image-url-btn');
    expect(screen.getByTestId('catalog-form-image-url-btn')).toBeDisabled();
    fireEvent.change(screen.getByTestId('catalog-form-image-url'), { target: { value: 'https://x/y.png' } });
    expect(screen.getByTestId('catalog-form-image-url-btn')).toBeEnabled();
  });

  it('a failed import toasts an error', async () => {
    importUrlMock.mockResolvedValue(json(null, false));
    renderDrawer();
    await screen.findByTestId('catalog-form-image-url');

    fireEvent.change(screen.getByTestId('catalog-form-image-url'), { target: { value: 'https://internal/p.png' } });
    fireEvent.click(screen.getByTestId('catalog-form-image-url-btn'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  });

  it('hides the image controls for a new (unsaved) item until it is saved', async () => {
    render(<CatalogItemEditorDrawer open item={null} allItems={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('catalog-item-editor')).toBeInTheDocument());
    expect(screen.queryByTestId('catalog-form-image-url')).not.toBeInTheDocument();
    expect(screen.getByTestId('catalog-form-image-hint')).toBeInTheDocument();
  });
});

// Multi-currency wave 3 (#3775): sell prices live in a per-currency price book.
// The partner currency comes ONLY from GET /orgs/partners/me — no USD fallback.
describe('CatalogItemEditorDrawer — price book + cost currency', () => {
  const createMock = vi.mocked(catalogApi.createCatalogItem);
  const updateMock = vi.mocked(catalogApi.updateCatalogItem);
  const setPriceMock = vi.mocked(catalogApi.setItemPrice);
  const removePriceMock = vi.mocked(catalogApi.removeItemPrice);

  beforeEach(() => {
    resetPartnerCurrencyCache(); // module-level cache must not leak the previous test's partner currency
    vi.clearAllMocks();
    seedPartner('EUR');
    claimsMock.mockReturnValue({ scope: 'partner', partnerId: 'p-1', orgId: null });
    createMock.mockResolvedValue(json({ data: item({ id: 'new-1' }) }));
    updateMock.mockResolvedValue(json({ data: item() }));
    setPriceMock.mockResolvedValue(json({ data: priceRow('CAD', '12.00') }));
    removePriceMock.mockResolvedValue(json({ data: { ok: true } }));
  });

  const renderDrawer = (props: Partial<React.ComponentProps<typeof CatalogItemEditorDrawer>> = {}) =>
    render(<CatalogItemEditorDrawer open item={item()} allItems={[]} onClose={vi.fn()} onSaved={vi.fn()} {...props} />);

  it('renders one price row per detail.prices row for an existing item', async () => {
    getMock.mockResolvedValue(json({ data: {
      item: item(), prices: [priceRow('CAD', '140.00'), priceRow('EUR', '100.00')], components: [], overrides: [],
    } }));
    renderDrawer();
    await screen.findByTestId('catalog-form-price-row-CAD');
    expect(screen.getByTestId('catalog-form-price-row-EUR')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-form-price-0')).toHaveValue('140.00');
    expect(screen.getByTestId('catalog-form-price-1')).toHaveValue('100.00');
    expect(screen.getByTestId('catalog-form-cost-currency')).toHaveValue('EUR');
  });

  it('seeds a new item with a single row in the partner currency (EUR, never USD) and disables Create until it resolves', async () => {
    let resolvePartner!: (r: Response) => void;
    rawFetchMock.mockImplementation((url) => {
      if (String(url) === '/orgs/partners/me') return new Promise<Response>((res) => { resolvePartner = res; });
      return Promise.resolve(json(null, false, 404));
    });
    renderDrawer({ item: null });
    await screen.findByTestId('catalog-form-price-book-loading');
    fireEvent.change(screen.getByTestId('catalog-form-name'), { target: { value: 'Thing' } });
    expect(screen.getByTestId('catalog-form-save')).toBeDisabled();
    expect(screen.queryByTestId('catalog-form-price-row-USD')).not.toBeInTheDocument();

    resolvePartner(json({ id: 'p-1', currencyCode: 'EUR' }));
    await screen.findByTestId('catalog-form-price-row-EUR');
    expect(screen.queryByTestId('catalog-form-price-row-USD')).not.toBeInTheDocument();
    expect(screen.getByTestId('catalog-form-cost-currency')).toHaveValue('EUR');

    fireEvent.change(screen.getByTestId('catalog-form-price-0'), { target: { value: '25' } });
    await waitFor(() => expect(screen.getByTestId('catalog-form-save')).toBeEnabled());
    fireEvent.click(screen.getByTestId('catalog-form-save'));
    await waitFor(() => expect(createMock).toHaveBeenCalled());
    const body = createMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toMatchObject({ name: 'Thing', prices: [{ currencyCode: 'EUR', unitPrice: 25 }], costCurrency: 'EUR' });
    expect(body).not.toHaveProperty('unitPrice');
  });

  it('"Add currency" adds an EUR row under a GBP partner; the added row is posted on create', async () => {
    seedPartner('GBP');
    renderDrawer({ item: null });
    await screen.findByTestId('catalog-form-price-row-GBP');
    fireEvent.change(screen.getByTestId('catalog-form-price-add'), { target: { value: 'EUR' } });
    await screen.findByTestId('catalog-form-price-row-EUR');
    fireEvent.change(screen.getByTestId('catalog-form-name'), { target: { value: 'Thing' } });
    fireEvent.change(screen.getByTestId('catalog-form-price-0'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('catalog-form-price-1'), { target: { value: '12' } });
    fireEvent.click(screen.getByTestId('catalog-form-save'));
    await waitFor(() => expect(createMock).toHaveBeenCalled());
    expect(createMock.mock.calls[0]![0]).toMatchObject({
      prices: [{ currencyCode: 'GBP', unitPrice: 10 }, { currencyCode: 'EUR', unitPrice: 12 }],
      costCurrency: 'GBP',
    });
  });

  it('shows the "cost in X — margin unavailable" copy when the cost currency differs from the partner currency', async () => {
    renderDrawer({ item: null });
    await screen.findByTestId('catalog-form-price-row-EUR');
    fireEvent.change(screen.getByTestId('catalog-form-price-0'), { target: { value: '100' } });
    fireEvent.change(screen.getByTestId('catalog-form-cost'), { target: { value: '50' } });
    expect(screen.getByTestId('catalog-form-margin')).toHaveTextContent('50.0%');
    fireEvent.change(screen.getByTestId('catalog-form-cost-currency'), { target: { value: 'CAD' } });
    expect(screen.getByTestId('catalog-form-margin')).toHaveTextContent('Cost in CAD — margin unavailable');
  });

  it('edit: PATCHes non-price fields (costCurrency included, no unitPrice) and diffs rows via setItemPrice / removeItemPrice', async () => {
    getMock.mockResolvedValue(json({ data: {
      item: item(), prices: [priceRow('CAD', '140.00'), priceRow('EUR', '100.00')], components: [], overrides: [],
    } }));
    renderDrawer();
    await screen.findByTestId('catalog-form-price-row-CAD');
    // change CAD, leave EUR untouched, remove nothing yet, add GBP, then remove CAD? — keep it
    // simple: bump CAD, add GBP, remove EUR.
    fireEvent.change(screen.getByTestId('catalog-form-price-0'), { target: { value: '150' } });
    fireEvent.change(screen.getByTestId('catalog-form-price-add'), { target: { value: 'GBP' } });
    await screen.findByTestId('catalog-form-price-row-GBP');
    fireEvent.change(screen.getByTestId('catalog-form-price-2'), { target: { value: '90' } });
    fireEvent.click(screen.getByTestId('catalog-form-price-remove-EUR'));
    fireEvent.change(screen.getByTestId('catalog-form-cost-currency'), { target: { value: 'CAD' } });

    fireEvent.click(screen.getByTestId('catalog-form-save'));
    await waitFor(() => expect(removePriceMock).toHaveBeenCalledWith('item-1', 'EUR'));
    const patch = updateMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch).toMatchObject({ name: 'Managed WS', costCurrency: 'CAD' });
    expect(patch).not.toHaveProperty('unitPrice');
    expect(patch).not.toHaveProperty('prices');
    expect(setPriceMock).toHaveBeenCalledWith('item-1', 'CAD', 150);
    expect(setPriceMock).toHaveBeenCalledWith('item-1', 'GBP', 90);
    expect(setPriceMock).not.toHaveBeenCalledWith('item-1', 'EUR', expect.anything());
    expect(setPriceMock).toHaveBeenCalledTimes(2);
  });

  it('blocks save with an empty price book and surfaces a partner-currency load failure with retry', async () => {
    seedPartner(null);
    renderDrawer({ item: null });
    await screen.findByTestId('catalog-form-price-book-error');
    expect(screen.getByTestId('catalog-form-save')).toBeDisabled();

    seedPartner('EUR');
    fireEvent.click(screen.getByText('Retry'));
    await screen.findByTestId('catalog-form-price-row-EUR');

    fireEvent.click(screen.getByTestId('catalog-form-price-remove-EUR'));
    await screen.findByTestId('catalog-form-price-book-empty');
    fireEvent.change(screen.getByTestId('catalog-form-name'), { target: { value: 'Thing' } });
    expect(screen.getByTestId('catalog-form-save')).toBeDisabled();
    expect(createMock).not.toHaveBeenCalled();
  });
});
