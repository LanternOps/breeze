import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CatalogItemEditorDrawer from './CatalogItemEditorDrawer';
import type { CatalogItem } from '../../lib/api/catalog';
import * as catalogApi from '../../lib/api/catalog';

// Keep the real presentation helpers + constants; stub only the network calls.
vi.mock('../../lib/api/catalog', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/api/catalog')>();
  return {
    ...actual,
    getCatalogItem: vi.fn(),
    setOrgPriceOverride: vi.fn(),
    removeOrgPriceOverride: vi.fn(),
  };
});
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: () => ({
    partners: [{ id: 'p-1', name: 'MSP' }],
    organizations: [{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Beta' }],
  }),
}));

const getMock = vi.mocked(catalogApi.getCatalogItem);
const setMock = vi.mocked(catalogApi.setOrgPriceOverride);
const delMock = vi.mocked(catalogApi.removeOrgPriceOverride);
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
});
