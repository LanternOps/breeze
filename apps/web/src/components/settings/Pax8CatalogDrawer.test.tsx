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
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/usePartnerCurrency', () => ({ usePartnerCurrency: () => ({ currency: 'USD', failed: false, retry: () => {} }) }));

import Pax8CatalogDrawer from './Pax8CatalogDrawer';

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

beforeEach(() => {
  pax8Import.mockReset(); pax8Search.mockReset(); pax8Pricing.mockReset();
  pax8Search.mockResolvedValue(ok([{ pax8ProductId: 'p1', name: 'Microsoft 365', vendorName: 'Microsoft', vendorSku: 'CFQ7', shortDescription: null, raw: {} }]));
  pax8Pricing.mockResolvedValue(ok([{ commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', suggestedRetailPrice: '22.00', currencyCode: 'USD' }]));
  pax8Import.mockResolvedValue(ok({ id: 'item-1', name: 'Microsoft 365' }));
});

describe('Pax8CatalogDrawer', () => {
  it('imports the selected product and reports the new item', async () => {
    const onImported = vi.fn();
    render(<Pax8CatalogDrawer open onClose={vi.fn()} onImported={onImported} />);
    fireEvent.change(screen.getByTestId('pax8-product-search-pax8-catalog'), { target: { value: 'micro' } });
    fireEvent.click(screen.getByTestId('pax8-product-search-btn-pax8-catalog'));
    await waitFor(() => screen.getByTestId('pax8-product-add-p1'));
    fireEvent.click(screen.getByTestId('pax8-product-add-p1'));
    await waitFor(() => expect(pax8Import).toHaveBeenCalled());
    const body = pax8Import.mock.calls[0][0];
    expect(body.product.source).toBe('pax8');
    expect(body.item).toMatchObject({ unitPrice: 22, costBasis: 18.5 });
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ id: 'item-1' })));
  });

  const importWithTerm = async (currencyCode: string | null) => {
    pax8Pricing.mockResolvedValue(ok([{ commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', suggestedRetailPrice: '22.00', currencyCode }]));
    render(<Pax8CatalogDrawer open onClose={vi.fn()} onImported={vi.fn()} />);
    fireEvent.change(screen.getByTestId('pax8-product-search-pax8-catalog'), { target: { value: 'micro' } });
    fireEvent.click(screen.getByTestId('pax8-product-search-btn-pax8-catalog'));
    await waitFor(() => screen.getByTestId('pax8-product-term-p1'));
    fireEvent.click(screen.getByTestId('pax8-product-add-p1'));
    await waitFor(() => expect(pax8Import).toHaveBeenCalled());
    return pax8Import.mock.calls[0][0] as { product: Record<string, unknown> };
  };

  it('posts the Pax8 term currency uppercased, never coerced to USD', async () => {
    const body = await importWithTerm('cad');
    expect(body.product.currency).toBe('CAD');
  });

  it('posts an explicit null currency when the Pax8 term has none', async () => {
    const body = await importWithTerm(null);
    expect(Object.prototype.hasOwnProperty.call(body.product, 'currency')).toBe(true);
    expect(body.product.currency).toBeNull();
  });
});
