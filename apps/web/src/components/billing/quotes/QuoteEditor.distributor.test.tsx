import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const ecExpressStatus = vi.fn();
const ecExpressLookup = vi.fn();
const ecExpressImport = vi.fn();
const addCatalogLine = vi.fn();
const listCatalog = vi.fn();

vi.mock('../../../lib/api/distributors', async (orig) => ({
  ...(await orig<typeof import('../../../lib/api/distributors')>()),
  ecExpressStatus: (...a: unknown[]) => ecExpressStatus(...a),
  ecExpressLookup: (...a: unknown[]) => ecExpressLookup(...a),
  ecExpressImport: (...a: unknown[]) => ecExpressImport(...a),
}));
vi.mock('../../../lib/api/quotes', async (orig) => ({
  ...(await orig<typeof import('../../../lib/api/quotes')>()),
  addCatalogLine: (...a: unknown[]) => addCatalogLine(...a),
}));
vi.mock('../../../lib/api/catalog', async (orig) => ({
  ...(await orig<typeof import('../../../lib/api/catalog')>()),
  listCatalog: (...a: unknown[]) => listCatalog(...a),
}));
const canMock = vi.fn((_resource: string, _action: string) => true);
vi.mock('../../../lib/permissions', () => ({ usePermissions: () => ({ can: (r: string, a: string) => canMock(r, a) }) }));

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail } from './quoteTypes';

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
const newItem = { id: 'cat-1', sku: 'ABC123', name: 'Widget', unitPrice: '120.00', isBundle: false };

// Minimal detail with one line_items block.
const detail: QuoteDetail = {
  quote: { id: 'q1', orgId: 'org-1', currencyCode: 'USD', termsAndConditions: '', status: 'draft' } as never,
  blocks: [{ id: 'blk1', blockType: 'line_items', sortOrder: 0, content: {} } as never],
  lines: [],
};

beforeEach(() => {
  ecExpressStatus.mockReset();
  ecExpressLookup.mockReset();
  ecExpressImport.mockReset();
  addCatalogLine.mockReset();
  listCatalog.mockReset();
  canMock.mockReset();
  canMock.mockImplementation(() => true);
  ecExpressStatus.mockResolvedValue(ok({ configured: true, enabled: true }));
  listCatalog.mockResolvedValue(ok([]));
  ecExpressImport.mockResolvedValue(ok(newItem));
  addCatalogLine.mockResolvedValue(ok({ id: 'line-1' }));
});

const lookupOne = () => ecExpressLookup.mockResolvedValue(ok([{
  source: 'td_synnex_ec_express', synnexSku: 'ABC123', mfgPartNo: null, status: 'Active',
  name: 'Widget', description: null, currency: 'USD', cost: 80, msrp: 100, discount: null,
  totalQty: 5, warehouses: [], weight: null, parcelShippable: null, raw: {},
}]));

describe('QuoteEditor distributor mode', () => {
  it('shows the distributor mode when EC Express is active', async () => {
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => screen.getByTestId('quote-line-mode-blk1-distributor'));
  });

  it('full import & add flow from the distributor panel', async () => {
    ecExpressLookup.mockResolvedValue(ok([{
      source: 'td_synnex_ec_express', synnexSku: 'ABC123', mfgPartNo: null, status: 'Active',
      name: 'Widget', description: null, currency: 'USD', cost: 80, msrp: 100, discount: null,
      totalQty: 5, warehouses: [], weight: null, parcelShippable: null, raw: {},
    }]));
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => screen.getByTestId('quote-line-mode-blk1-distributor'));
    fireEvent.click(screen.getByTestId('quote-line-mode-blk1-distributor'));
    fireEvent.change(screen.getByTestId('quote-distributor-search-blk1'), { target: { value: 'ABC123' } });
    fireEvent.click(screen.getByTestId('quote-distributor-search-btn-blk1'));
    await waitFor(() => screen.getByTestId('quote-distributor-add-ABC123'));
    fireEvent.click(screen.getByTestId('quote-distributor-add-ABC123'));
    await waitFor(() => expect(ecExpressImport).toHaveBeenCalled());
    expect(addCatalogLine).toHaveBeenCalledWith('q1', expect.objectContaining({ catalogItemId: 'cat-1', blockId: 'blk1' }));
  });

  it('hides the distributor mode when EC Express is inactive', async () => {
    ecExpressStatus.mockResolvedValue(ok({ configured: true, enabled: false }));
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => screen.getByTestId('quote-block-add-line-blk1'));
    expect(screen.queryByTestId('quote-line-mode-blk1-distributor')).toBeNull();
  });

  it('hides the distributor mode without catalog:write even when EC is active', async () => {
    // EC configured+enabled, but the user lacks catalog write permission.
    canMock.mockImplementation((r: string, a: string) => !(r === 'catalog' && a === 'write'));
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => screen.getByTestId('quote-block-add-line-blk1'));
    expect(screen.queryByTestId('quote-line-mode-blk1-distributor')).toBeNull();
  });

  it('sends the mapped import payload (sell price, cost basis, sku)', async () => {
    lookupOne();
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => screen.getByTestId('quote-line-mode-blk1-distributor'));
    fireEvent.click(screen.getByTestId('quote-line-mode-blk1-distributor'));
    fireEvent.change(screen.getByTestId('quote-distributor-search-blk1'), { target: { value: 'ABC123' } });
    fireEvent.click(screen.getByTestId('quote-distributor-search-btn-blk1'));
    await waitFor(() => screen.getByTestId('quote-distributor-price-ABC123'));
    fireEvent.change(screen.getByTestId('quote-distributor-price-ABC123'), { target: { value: '150.00' } });
    fireEvent.click(screen.getByTestId('quote-distributor-add-ABC123'));
    await waitFor(() => expect(ecExpressImport).toHaveBeenCalled());
    expect(ecExpressImport).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({ sku: 'ABC123', unitPrice: 150, costBasis: 80 }),
    }));
  });

  it('adds the existing catalog item without re-importing when the SKU is already in the catalog', async () => {
    lookupOne();
    // The catalog search resolves the SKU to an existing item, so import must be skipped.
    listCatalog.mockResolvedValue(ok([{ id: 'cat-existing', sku: 'ABC123', name: 'Widget', unitPrice: '99.00', isBundle: false }]));
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => screen.getByTestId('quote-line-mode-blk1-distributor'));
    fireEvent.click(screen.getByTestId('quote-line-mode-blk1-distributor'));
    fireEvent.change(screen.getByTestId('quote-distributor-search-blk1'), { target: { value: 'ABC123' } });
    fireEvent.click(screen.getByTestId('quote-distributor-search-btn-blk1'));
    await waitFor(() => screen.getByTestId('quote-distributor-add-ABC123'));
    fireEvent.click(screen.getByTestId('quote-distributor-add-ABC123'));
    await waitFor(() => expect(addCatalogLine).toHaveBeenCalledWith('q1', expect.objectContaining({ catalogItemId: 'cat-existing', blockId: 'blk1' })));
    expect(ecExpressImport).not.toHaveBeenCalled();
  });
});
