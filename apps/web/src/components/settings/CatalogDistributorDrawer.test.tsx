import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const ecExpressImport = vi.fn();
const ecExpressLookup = vi.fn();
const tdSynnexSftpProducts = vi.fn();
vi.mock('../../lib/api/distributors', async (orig) => ({
  ...(await orig<typeof import('../../lib/api/distributors')>()),
  ecExpressImport: (...a: unknown[]) => ecExpressImport(...a),
  ecExpressLookup: (...a: unknown[]) => ecExpressLookup(...a),
  tdSynnexSftpProducts: (...a: unknown[]) => tdSynnexSftpProducts(...a),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
// Controllable partner currency — the drawer's sell price is a PARTNER-currency
// price-book write, so the lookup is gated on it (#3775 review #3).
const partnerCurrency = { currency: 'USD' as string | null, failed: false, retry: vi.fn() };
vi.mock('../../lib/usePartnerCurrency', () => ({ usePartnerCurrency: () => ({ ...partnerCurrency }) }));

import CatalogDistributorDrawer from './CatalogDistributorDrawer';
import type { EcProduct } from '../../lib/api/distributors';

const product = (currency: string | null): EcProduct => ({
  source: 'td_synnex_ec_express', synnexSku: 'ABC123', mfgPartNo: 'MFG-1', manufacturer: 'HPE Aruba', status: 'Active',
  name: 'Widget', description: 'A widget', currency, cost: 80, msrp: 100, discount: null,
  totalQty: 5, warehouses: [], weight: null, parcelShippable: null, raw: {},
});

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

beforeEach(() => {
  ecExpressImport.mockReset(); ecExpressLookup.mockReset(); tdSynnexSftpProducts.mockReset();
  partnerCurrency.currency = 'USD'; partnerCurrency.failed = false; partnerCurrency.retry = vi.fn();
  tdSynnexSftpProducts.mockResolvedValue(ok([]));
  ecExpressLookup.mockResolvedValue(ok([product('USD')]));
  ecExpressImport.mockResolvedValue(ok({ id: 'item-1', name: 'Widget' }));
});

const search = async () => {
  fireEvent.change(screen.getByTestId('quote-distributor-search-catalog-import'), { target: { value: 'ABC123' } });
  fireEvent.click(screen.getByTestId('quote-distributor-search-btn-catalog-import'));
  await waitFor(() => screen.getByTestId('quote-distributor-result-ABC123'));
};

describe('CatalogDistributorDrawer', () => {
  it('prefills MSRP and imports when the feed row is in the partner currency', async () => {
    const onImported = vi.fn();
    render(<CatalogDistributorDrawer open onClose={vi.fn()} onImported={onImported} />);
    await search();
    expect((screen.getByTestId('quote-distributor-price-ABC123') as HTMLInputElement).value).toBe('100.00');
    fireEvent.click(screen.getByTestId('quote-distributor-add-ABC123'));
    await waitFor(() => expect(ecExpressImport).toHaveBeenCalled());
    const body = ecExpressImport.mock.calls[0][0];
    expect(body.product.currency).toBe('USD');
    expect(body.item).toMatchObject({ unitPrice: 100, costBasis: 80 });
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ id: 'item-1' })));
  });

  it('gates on the PARTNER currency, not USD: an EUR partner prefills from an EUR row', async () => {
    partnerCurrency.currency = 'EUR';
    ecExpressLookup.mockResolvedValue(ok([product('EUR')]));
    render(<CatalogDistributorDrawer open onClose={vi.fn()} onImported={vi.fn()} />);
    await search();
    expect((screen.getByTestId('quote-distributor-price-ABC123') as HTMLInputElement).value).toBe('100.00');
    expect(screen.queryByTestId('quote-distributor-currency-note-ABC123')).toBeNull();
  });

  it('never relabels a foreign-currency MSRP as the partner price: sell stays blank, Add disabled', async () => {
    ecExpressLookup.mockResolvedValue(ok([product('CAD')]));
    render(<CatalogDistributorDrawer open onClose={vi.fn()} onImported={vi.fn()} />);
    await search();
    expect((screen.getByTestId('quote-distributor-price-ABC123') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('quote-distributor-currency-note-ABC123')).toBeTruthy();
    expect((screen.getByTestId('quote-distributor-add-ABC123') as HTMLButtonElement).disabled).toBe(true);
    // The operator types the partner-currency price; the feed currency still travels as-is.
    fireEvent.change(screen.getByTestId('quote-distributor-price-ABC123'), { target: { value: '120' } });
    fireEvent.click(screen.getByTestId('quote-distributor-add-ABC123'));
    await waitFor(() => expect(ecExpressImport).toHaveBeenCalled());
    const body = ecExpressImport.mock.calls[0][0];
    expect(body.product.currency).toBe('CAD');
    expect(body.item.unitPrice).toBe(120);
  });

  it('does not render the lookup until the partner currency resolves (no USD fallback)', () => {
    partnerCurrency.currency = null;
    render(<CatalogDistributorDrawer open onClose={vi.fn()} onImported={vi.fn()} />);
    expect(screen.getByTestId('catalog-distributor-currency-loading')).toBeTruthy();
    expect(screen.queryByTestId('quote-distributor-search-catalog-import')).toBeNull();
  });

  it('shows an error with retry when the partner currency fails to load', () => {
    partnerCurrency.currency = null; partnerCurrency.failed = true;
    render(<CatalogDistributorDrawer open onClose={vi.fn()} onImported={vi.fn()} />);
    expect(screen.getByTestId('catalog-distributor-currency-error')).toBeTruthy();
    fireEvent.click(screen.getByText('Retry'));
    expect(partnerCurrency.retry).toHaveBeenCalled();
  });
});
