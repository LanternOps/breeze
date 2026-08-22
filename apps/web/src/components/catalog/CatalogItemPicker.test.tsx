import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import CatalogItemPicker from './CatalogItemPicker';
import type { CatalogItem } from '../../lib/api/catalog';

function item(over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: 'cat-1', partnerId: 'p1', itemType: 'hardware', name: 'NVMe 1TB', sku: 'NV-1', description: null,
    billingType: 'one_time', unitPrice: '999.00', costBasis: null, costCurrency: 'USD', markupPercent: null,
    unitOfMeasure: 'each', taxable: false, taxCategory: null, isBundle: false, isActive: true,
    createdAt: '', updatedAt: '', prices: [{ currencyCode: 'EUR', unitPrice: '120.00' }],
    ...over,
  };
}

describe('CatalogItemPicker (multi-currency #3775)', () => {
  it('shows the price-book row in the document currency — never the unitPrice mirror', async () => {
    render(<CatalogItemPicker items={[item()]} onSelect={vi.fn()} currencyCode="EUR" />);
    fireEvent.change(screen.getByTestId('catalog-picker-input'), { target: { value: 'NV' } });
    const price = await screen.findByTestId('catalog-picker-price-cat-1');
    expect(price).toHaveTextContent('120.00');
    expect(price).not.toHaveTextContent('999');
    expect(screen.queryByTestId('catalog-picker-noprice-cat-1')).toBeNull();
  });

  it('shows the no-price note when the book has no row in that currency, and keeps the item selectable', async () => {
    const onSelect = vi.fn();
    render(<CatalogItemPicker items={[item()]} onSelect={onSelect} currencyCode="CAD" />);
    fireEvent.change(screen.getByTestId('catalog-picker-input'), { target: { value: 'NV' } });
    expect(await screen.findByTestId('catalog-picker-noprice-cat-1')).toHaveTextContent('No CAD price');
    expect(screen.queryByTestId('catalog-picker-price-cat-1')).toBeNull();
    fireEvent.click(screen.getByTestId('catalog-picker-option-cat-1'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'cat-1' }));
  });

  it('tolerates a list payload without a price book (treated as a gap)', async () => {
    render(<CatalogItemPicker items={[item({ prices: undefined as unknown as CatalogItem['prices'] })]} onSelect={vi.fn()} currencyCode="USD" />);
    fireEvent.change(screen.getByTestId('catalog-picker-input'), { target: { value: 'NV' } });
    expect(await screen.findByTestId('catalog-picker-noprice-cat-1')).toHaveTextContent('No USD price');
  });
});
