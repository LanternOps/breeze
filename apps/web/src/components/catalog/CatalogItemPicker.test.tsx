import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import CatalogItemPicker from './CatalogItemPicker';
import type { CatalogItem } from '../../lib/api/catalog';

function item(over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: 'cat-1', partnerId: 'p1', itemType: 'hardware', name: 'NVMe 1TB', sku: 'NV-1', description: null,
    billingType: 'one_time', costBasis: null, costCurrency: 'USD', markupPercent: null,
    unitOfMeasure: 'each', taxable: false, taxCategory: null, isBundle: false, isActive: true,
    createdAt: '', updatedAt: '', prices: [{ currencyCode: 'EUR', unitPrice: '120.00' }],
    ...over,
  };
}

describe('CatalogItemPicker (multi-currency #3775)', () => {
  it('shows the price-book row in the document currency — never any other price', async () => {
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

describe('CatalogItemPicker (dropdown escapes clipping ancestors)', () => {
  // The quote editor's block collapse shell is `overflow-hidden` (grid-rows
  // animation); an `absolute` listbox inside it was cut off below the input.
  it('portals the listbox out of an overflow-hidden ancestor with fixed positioning', async () => {
    render(
      <div data-testid="clip" style={{ overflow: 'hidden' }}>
        <CatalogItemPicker items={[item()]} onSelect={vi.fn()} currencyCode="EUR" />
      </div>,
    );
    fireEvent.change(screen.getByTestId('catalog-picker-input'), { target: { value: 'NV' } });
    const list = await screen.findByTestId('catalog-picker-list');
    expect(screen.getByTestId('clip').contains(list)).toBe(false);
    expect(list.style.position).toBe('fixed');
  });

  it('portals the no-results note too', async () => {
    render(
      <div data-testid="clip" style={{ overflow: 'hidden' }}>
        <CatalogItemPicker items={[item()]} onSelect={vi.fn()} currencyCode="EUR" />
      </div>,
    );
    fireEvent.change(screen.getByTestId('catalog-picker-input'), { target: { value: 'zzz' } });
    const note = await screen.findByTestId('catalog-picker-noresults');
    expect(screen.getByTestId('clip').contains(note)).toBe(false);
    expect(note.style.position).toBe('fixed');
  });

  it('selects a portalled option on click (outside-click guard must not close it first)', async () => {
    const onSelect = vi.fn();
    render(<CatalogItemPicker items={[item()]} onSelect={onSelect} currencyCode="EUR" />);
    fireEvent.change(screen.getByTestId('catalog-picker-input'), { target: { value: 'NV' } });
    const option = await screen.findByTestId('catalog-picker-option-cat-1');
    fireEvent.mouseDown(option);
    fireEvent.click(screen.getByTestId('catalog-picker-option-cat-1'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'cat-1' }));
  });

  it('still closes on a mousedown outside both the input and the portalled list', async () => {
    render(<CatalogItemPicker items={[item()]} onSelect={vi.fn()} currencyCode="EUR" />);
    fireEvent.change(screen.getByTestId('catalog-picker-input'), { target: { value: 'NV' } });
    await screen.findByTestId('catalog-picker-list');
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('catalog-picker-list')).toBeNull();
  });
});
