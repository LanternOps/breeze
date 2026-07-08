import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CatalogItemEditorDrawer from './CatalogItemEditorDrawer';
import type { CatalogItem } from '../../lib/api/catalog';
import * as catalogApi from '../../lib/api/catalog';
import * as authScope from '../../lib/authScope';
import { showToast } from '../shared/Toast';

// Keep the real presentation helpers + constants; stub only the network calls.
vi.mock('../../lib/api/catalog', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/api/catalog')>();
  return {
    ...actual,
    getCatalogItem: vi.fn(),
    setOrgPriceOverride: vi.fn(),
    removeOrgPriceOverride: vi.fn(),
    createCatalogItem: vi.fn(),
    updateCatalogItem: vi.fn(),
    setBundleComponents: vi.fn(),
    uploadCatalogItemImage: vi.fn(),
    importCatalogItemImageFromUrl: vi.fn(),
    deleteCatalogItemImageRequest: vi.fn(),
  };
});
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
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
const json = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const item = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  id: 'item-1', partnerId: 'p-1', itemType: 'service', name: 'Managed WS', sku: null, description: null,
  billingType: 'one_time', unitPrice: '100.00', costBasis: null, markupPercent: null, unitOfMeasure: 'each',
  taxable: false, taxCategory: null, isBundle: false, isActive: true, createdAt: '', updatedAt: '', ...over,
});

const detail = (overrides: Array<{ orgId: string; unitPrice: string }>) =>
  json({ data: { item: item(), components: [], overrides: overrides.map((o, i) => ({ id: `ov-${i}`, catalogItemId: 'item-1', ...o })) } });

describe('CatalogItemEditorDrawer — per-org pricing (#1368)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: a partner-scope user (the audience for per-org pricing).
    claimsMock.mockReturnValue({ scope: 'partner', partnerId: 'p-1', orgId: null });
    getMock.mockResolvedValue(detail([{ orgId: 'org-1', unitPrice: '80.00' }]));
    setMock.mockResolvedValue(json({ data: { id: 'ov-new', catalogItemId: 'item-1', orgId: 'org-2', unitPrice: '70.00' } }));
    delMock.mockResolvedValue(json({ data: { id: 'ov-0', catalogItemId: 'item-1', orgId: 'org-1', unitPrice: '80.00' } }));
  });

  const renderDrawer = (props: Partial<React.ComponentProps<typeof CatalogItemEditorDrawer>> = {}) =>
    render(<CatalogItemEditorDrawer open item={item()} allItems={[]} onClose={vi.fn()} onSaved={vi.fn()} {...props} />);

  it('loads and lists existing overrides for an existing item', async () => {
    renderDrawer();
    await waitFor(() => expect(screen.getByTestId('catalog-org-pricing')).toBeInTheDocument());
    const row = await screen.findByTestId('catalog-override-row-org-1');
    expect(row).toHaveTextContent('Acme');
    expect(screen.getByTestId('catalog-override-price-org-1')).toHaveTextContent('80.00');
  });

  it('sets a new override (PUT with a numeric price) and a removable existing one (DELETE)', async () => {
    renderDrawer();
    await screen.findByTestId('catalog-override-row-org-1');

    // Only orgs without an override are offered (org-1 already has one).
    fireEvent.change(screen.getByTestId('catalog-override-org'), { target: { value: 'org-2' } });
    fireEvent.change(screen.getByTestId('catalog-override-price-input'), { target: { value: '70' } });
    fireEvent.click(screen.getByTestId('catalog-override-add'));
    await waitFor(() => expect(setMock).toHaveBeenCalledWith('item-1', 'org-2', 70));

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
    vi.clearAllMocks();
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
      json({ data: { item: item({ isBundle: true }), components: [{ componentItemId: 'c-1', quantity: '2', showOnInvoice: false }], overrides: [] } }),
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

    const saveBtn = screen.getByTestId('catalog-form-save') as HTMLButtonElement;
    expect(saveBtn).not.toBeDisabled();
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
    vi.clearAllMocks();
    claimsMock.mockReturnValue({ scope: 'partner', partnerId: 'p-1', orgId: null });
    getMock.mockResolvedValue(json({ data: { item: item(), components: [], overrides: [] } }));
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
