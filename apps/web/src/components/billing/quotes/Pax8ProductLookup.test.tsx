import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const pax8Search = vi.fn();
const pax8Pricing = vi.fn();
vi.mock('../../../lib/api/distributors', () => ({
  pax8Search: (...a: unknown[]) => pax8Search(...a),
  pax8Pricing: (...a: unknown[]) => pax8Pricing(...a),
}));

const partnerCurrency = vi.fn(() => 'USD');
vi.mock('../../../lib/usePartnerCurrency', () => ({ usePartnerCurrency: () => ({ currency: partnerCurrency(), failed: false, retry: () => {} }) }));

import Pax8ProductLookup from './Pax8ProductLookup';

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

beforeEach(() => {
  pax8Search.mockReset(); pax8Pricing.mockReset();
  partnerCurrency.mockReset(); partnerCurrency.mockReturnValue('USD');
  pax8Search.mockResolvedValue(ok([{ pax8ProductId: 'p1', name: 'Microsoft 365 Business Premium', vendorName: 'Microsoft', vendorSku: 'CFQ7', shortDescription: null, raw: {} }]));
  pax8Pricing.mockResolvedValue(ok([{ commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', suggestedRetailPrice: '22.00', currencyCode: 'USD' }]));
});

describe('Pax8ProductLookup', () => {
  it('searches, loads pricing, defaults the sell price to list, and emits on import', async () => {
    const onImportAdd = vi.fn();
    render(<Pax8ProductLookup blockId="b1" busy={false} onImportAdd={onImportAdd} />);
    fireEvent.change(screen.getByTestId('pax8-product-search-b1'), { target: { value: 'micro' } });
    fireEvent.click(screen.getByTestId('pax8-product-search-btn-b1'));
    await waitFor(() => screen.getByTestId('pax8-product-result-p1'));
    // term dropdown populated from pricing
    await waitFor(() => screen.getByTestId('pax8-product-term-p1'));
    const price = screen.getByTestId('pax8-product-price-p1') as HTMLInputElement;
    expect(price.value).toBe('22.00'); // defaults to suggested retail
    fireEvent.click(screen.getByTestId('pax8-product-add-p1'));
    expect(onImportAdd).toHaveBeenCalledTimes(1);
    const [product, term, sell] = onImportAdd.mock.calls[0];
    expect(product.pax8ProductId).toBe('p1');
    expect(term.partnerBuyRate).toBe('18.50');
    expect(sell).toBe(22);
  });

  it('term switch re-defaults sell price', async () => {
    pax8Pricing.mockResolvedValue(ok([
      { commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', suggestedRetailPrice: '22.00', currencyCode: 'USD' },
      { commitmentTerm: 'Monthly', billingTerm: 'Monthly', partnerBuyRate: '20.00', suggestedRetailPrice: '30.00', currencyCode: 'USD' },
    ]));
    render(<Pax8ProductLookup blockId="b1" busy={false} onImportAdd={() => {}} />);
    fireEvent.change(screen.getByTestId('pax8-product-search-b1'), { target: { value: 'micro' } });
    fireEvent.click(screen.getByTestId('pax8-product-search-btn-b1'));
    await waitFor(() => screen.getByTestId('pax8-product-result-p1'));
    const select = screen.getByTestId('pax8-product-term-p1') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '1' } });
    const price = screen.getByTestId('pax8-product-price-p1') as HTMLInputElement;
    expect(price.value).toBe('30.00');
  });

  it('pricing failure keeps the product visible', async () => {
    pax8Pricing.mockRejectedValue(new Error('boom'));
    render(<Pax8ProductLookup blockId="b1" busy={false} onImportAdd={() => {}} />);
    fireEvent.change(screen.getByTestId('pax8-product-search-b1'), { target: { value: 'micro' } });
    fireEvent.click(screen.getByTestId('pax8-product-search-btn-b1'));
    await waitFor(() => screen.getByTestId('pax8-product-result-p1'));
    expect(screen.queryByTestId('pax8-product-error-b1')).not.toBeInTheDocument();
  });

  describe('margin guard (multi-currency wave 3)', () => {
    const search = async (currencyCode: string | null) => {
      pax8Pricing.mockResolvedValue(ok([{ commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', suggestedRetailPrice: '22.00', currencyCode }]));
      render(<Pax8ProductLookup blockId="b1" busy={false} onImportAdd={vi.fn()} />);
      fireEvent.change(screen.getByTestId('pax8-product-search-b1'), { target: { value: 'micro' } });
      fireEvent.click(screen.getByTestId('pax8-product-search-btn-b1'));
      await waitFor(() => screen.getByTestId('pax8-product-term-p1'));
    };

    it('hides the margin and names the cost currency when the term currency differs from the partner currency', async () => {
      await search('CAD');
      const guard = await screen.findByTestId('pax8-product-margin-unavailable-p1');
      expect(guard.textContent).toContain('Cost in CAD');
      expect(screen.queryByTestId('pax8-product-margin-p1')).toBeNull();
    });

    it('shows the margin in the partner currency when the term currency matches', async () => {
      await search('usd');
      const margin = await screen.findByTestId('pax8-product-margin-p1');
      expect(margin.textContent).toContain('Profit USD 3.50');
      expect(screen.queryByTestId('pax8-product-margin-unavailable-p1')).toBeNull();
    });

    it('shows the margin when the term has no currency (assumes the partner currency)', async () => {
      await search(null);
      const margin = await screen.findByTestId('pax8-product-margin-p1');
      expect(margin.textContent).toContain('Profit USD 3.50');
    });

    it('renders neither the margin nor the guard while the partner currency is unknown', async () => {
      partnerCurrency.mockReturnValue(null as unknown as string);
      await search('USD');
      expect(screen.queryByTestId('pax8-product-margin-p1')).toBeNull();
      expect(screen.queryByTestId('pax8-product-margin-unavailable-p1')).toBeNull();
    });
  });
});
