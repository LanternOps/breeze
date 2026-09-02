import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const pax8Import = vi.fn();
const pax8Search = vi.fn();
const pax8Pricing = vi.fn();
vi.mock('../../lib/api/distributors', () => ({
  pax8Import: (...a: unknown[]) => pax8Import(...a),
  pax8Search: (...a: unknown[]) => pax8Search(...a),
  pax8Pricing: (...a: unknown[]) => pax8Pricing(...a),
}));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
// Controllable partner currency — the drawer's sell price is a PARTNER-currency
// price-book write, so the lookup is gated on it (#3775 review #3).
const partnerCurrency = { currency: 'USD' as string | null, failed: false, retry: vi.fn() };
vi.mock('../../lib/usePartnerCurrency', () => ({ usePartnerCurrency: () => ({ ...partnerCurrency }) }));

import Pax8CatalogDrawer from './Pax8CatalogDrawer';

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

const term = (currencyCode: string | null) =>
  ({ commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', suggestedRetailPrice: '22.00', currencyCode });

beforeEach(() => {
  pax8Import.mockReset(); pax8Search.mockReset(); pax8Pricing.mockReset(); showToast.mockReset();
  partnerCurrency.currency = 'USD'; partnerCurrency.failed = false; partnerCurrency.retry = vi.fn();
  pax8Search.mockResolvedValue(ok([{ pax8ProductId: 'p1', name: 'Microsoft 365', vendorName: 'Microsoft', vendorSku: 'CFQ7', shortDescription: null, raw: {} }]));
  pax8Pricing.mockResolvedValue(ok([term('USD')]));
  pax8Import.mockResolvedValue(ok({ id: 'item-1', name: 'Microsoft 365' }));
});

const openAndSearch = async () => {
  fireEvent.change(screen.getByTestId('pax8-product-search-pax8-catalog'), { target: { value: 'micro' } });
  fireEvent.click(screen.getByTestId('pax8-product-search-btn-pax8-catalog'));
  await waitFor(() => screen.getByTestId('pax8-product-term-p1'));
};

describe('Pax8CatalogDrawer', () => {
  it('imports the selected product and reports the new item', async () => {
    const onImported = vi.fn();
    render(<Pax8CatalogDrawer open onClose={vi.fn()} onImported={onImported} />);
    await openAndSearch();
    fireEvent.click(screen.getByTestId('pax8-product-add-p1'));
    await waitFor(() => expect(pax8Import).toHaveBeenCalled());
    const body = pax8Import.mock.calls[0][0];
    expect(body.product.source).toBe('pax8');
    expect(body.item).toMatchObject({ unitPrice: 22, costBasis: 18.5 });
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ id: 'item-1' })));
  });

  // #3775 review #3: a re-import of a SKU already in the catalog must not reset a
  // hand-adjusted price-book row. The server now preserves it — the drawer has to
  // SAY so, or the operator reads a plain "Imported" and assumes their price moved.
  it('warns which currencies were left alone when the server preserved existing rows', async () => {
    pax8Import.mockResolvedValue(ok({
      id: 'item-1', name: 'Microsoft 365',
      attributes: { pax8: { aiEnriched: true } },
      pricingApplied: { added: ['EUR'], preserved: ['USD'] },
    }));
    render(<Pax8CatalogDrawer open onClose={vi.fn()} onImported={vi.fn()} />);
    await openAndSearch();
    fireEvent.click(screen.getByTestId('pax8-product-add-p1'));
    await waitFor(() => expect(showToast).toHaveBeenCalled());

    const toast = showToast.mock.calls[0][0] as { message: string; type: string };
    expect(toast.type).toBe('warning');
    expect(toast.message).toContain('USD');
    expect(toast.message).toContain('Microsoft 365');
  });

  it('reports a plain success when every requested currency was added', async () => {
    pax8Import.mockResolvedValue(ok({
      id: 'item-1', name: 'Microsoft 365',
      attributes: { pax8: { aiEnriched: true } },
      pricingApplied: { added: ['USD'], preserved: [] },
    }));
    render(<Pax8CatalogDrawer open onClose={vi.fn()} onImported={vi.fn()} />);
    await openAndSearch();
    fireEvent.click(screen.getByTestId('pax8-product-add-p1'));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect((showToast.mock.calls[0][0] as { type: string }).type).toBe('success');
  });

  it('prefills the sell price from the feed only when the term is in the PARTNER currency', async () => {
    partnerCurrency.currency = 'EUR';
    pax8Pricing.mockResolvedValue(ok([term('EUR')]));
    render(<Pax8CatalogDrawer open onClose={vi.fn()} onImported={vi.fn()} />);
    await openAndSearch();
    expect((screen.getByTestId('pax8-product-price-p1') as HTMLInputElement).value).toBe('22.00');
    expect(screen.queryByTestId('pax8-product-currency-note-p1')).toBeNull();
    expect((screen.getByTestId('pax8-product-add-p1') as HTMLButtonElement).disabled).toBe(false);
  });

  it('never relabels a foreign-currency feed price as the partner price: sell stays blank and Add is disabled', async () => {
    pax8Pricing.mockResolvedValue(ok([term('CAD')]));
    render(<Pax8CatalogDrawer open onClose={vi.fn()} onImported={vi.fn()} />);
    await openAndSearch();
    expect((screen.getByTestId('pax8-product-price-p1') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('pax8-product-currency-note-p1')).toBeTruthy();
    expect((screen.getByTestId('pax8-product-add-p1') as HTMLButtonElement).disabled).toBe(true);
    expect(pax8Import).not.toHaveBeenCalled();
  });

  const importWithTerm = async (currencyCode: string | null) => {
    pax8Pricing.mockResolvedValue(ok([term(currencyCode)]));
    render(<Pax8CatalogDrawer open onClose={vi.fn()} onImported={vi.fn()} />);
    await openAndSearch();
    // Feed currency ≠ partner currency: the operator types the partner-currency sell price.
    fireEvent.change(screen.getByTestId('pax8-product-price-p1'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('pax8-product-add-p1'));
    await waitFor(() => expect(pax8Import).toHaveBeenCalled());
    return pax8Import.mock.calls[0][0] as { product: Record<string, unknown>; item: Record<string, unknown> };
  };

  it('posts the Pax8 term currency uppercased, never coerced to USD', async () => {
    const body = await importWithTerm('cad');
    expect(body.product.currency).toBe('CAD');
    expect(body.item.unitPrice).toBe(30);
  });

  it('posts an explicit null currency when the Pax8 term has none', async () => {
    const body = await importWithTerm(null);
    expect(Object.prototype.hasOwnProperty.call(body.product, 'currency')).toBe(true);
    expect(body.product.currency).toBeNull();
  });

  it('does not render the lookup until the partner currency resolves (no USD fallback)', () => {
    partnerCurrency.currency = null;
    render(<Pax8CatalogDrawer open onClose={vi.fn()} onImported={vi.fn()} />);
    expect(screen.getByTestId('pax8-catalog-currency-loading')).toBeTruthy();
    expect(screen.queryByTestId('pax8-product-search-pax8-catalog')).toBeNull();
  });

  it('shows an error with retry when the partner currency fails to load', () => {
    partnerCurrency.currency = null; partnerCurrency.failed = true;
    render(<Pax8CatalogDrawer open onClose={vi.fn()} onImported={vi.fn()} />);
    expect(screen.getByTestId('pax8-catalog-currency-error')).toBeTruthy();
    expect(screen.queryByTestId('pax8-product-search-pax8-catalog')).toBeNull();
    fireEvent.click(screen.getByText('Retry'));
    expect(partnerCurrency.retry).toHaveBeenCalled();
  });
});
